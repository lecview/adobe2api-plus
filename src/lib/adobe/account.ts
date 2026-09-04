import { eq, and, ne, or, gt, isNull, isNotNull, desc, asc, sql, count, notInArray, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { adobeAccount, adobeToken, entity, generationJob, refreshProfile, type AdobeAccountStatus, type AdobeTokenStatus, type RefreshProfileStatus } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { getSystemSettings } from "@/lib/system-settings";
import { completeSherlockFromCookie } from "@/lib/adobe/arp";

export type AdobeAccountContext = { accountId: string; tokenId: string; token: string };
export type AdobeGenerationAccountContext = AdobeAccountContext & { refreshProfileId: string | null; arpSessionId: string };

// 构造 token 过滤条件的公共谓词：ACTIVE 且未过期
function activeTokenPredicate(now: Date) {
  return and(
    eq(adobeToken.status, "ACTIVE" as AdobeTokenStatus),
    or(isNull(adobeToken.expiresAt), gt(adobeToken.expiresAt, now)),
  );
}

// 查询指定账号的最新有效 token（等价于原 include.tokens 子查询 take:1）
async function findFirstActiveToken(accountId: string, now: Date) {
  const [token] = await db
    .select()
    .from(adobeToken)
    .where(and(eq(adobeToken.accountId, accountId), activeTokenPredicate(now)))
    .orderBy(desc(adobeToken.updatedAt))
    .limit(1);
  return token ?? null;
}

// 终态任务不计入账号并发占用
const TERMINAL_JOB_STATUSES = ["SUCCEEDED", "FAILED", "CANCELLED", "SUBMISSION_UNKNOWN"] as const;

/** 统计每个账号当前进行中的任务数（含排队中与执行中，排除终态和当前任务）。 */
async function accountRunningCounts(currentJobId?: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ accountId: generationJob.adobeAccountId, count: count() })
    .from(generationJob)
    .where(and(
      isNotNull(generationJob.adobeAccountId),
      notInArray(generationJob.status, TERMINAL_JOB_STATUSES as unknown as typeof generationJob.status),
      currentJobId ? ne(generationJob.id, currentJobId) : undefined,
    ))
    .groupBy(generationJob.adobeAccountId);
  return new Map(rows.map((row) => [String(row.accountId), Number(row.count)]));
}

export async function selectAdobeAccount(accountId?: string | null, currentJobId?: string): Promise<AdobeAccountContext> {
  const now = new Date();
  const settings = await getSystemSettings();
  const accountLimit = settings.accountMaxConcurrency;
  // 单账号并发限制：进行中任务数达到上限的账号不再参与选择，避免同一 Adobe
  // 账号被多个 Worker 同时占用触发上游风控。并发已满时抛专用错误，由任务侧
  // 释放任务回队列（而非直接失败），账号空闲后自动恢复执行。
  const running = await accountRunningCounts(currentJobId);
  const atLimit = (id: string) => (running.get(id) ?? 0) >= accountLimit;
  let account: typeof adobeAccount.$inferSelect | null = null;
  let eligibleAccountCount = 0;

  if (accountId) {
    // 指定账号：按 id + 状态过滤
    const [row] = await db
      .select()
      .from(adobeAccount)
      .where(and(eq(adobeAccount.id, accountId), ne(adobeAccount.status, "UNAVAILABLE" as AdobeAccountStatus), eq(adobeAccount.riskFlagged, false)))
      .limit(1);
    account = row ?? null;
    if (account && atLimit(account.id)) {
      throw new AppError("adobe_account_concurrency_limit", `Account is at its concurrency limit (${accountLimit})`, 429, { account_id: account.id, concurrency_limit: accountLimit });
    }
  } else if (settings.tokenRotationStrategy === "random") {
    // 随机策略：先取所有候选账号 id，再随机挑一个（过滤并发已满的账号）
    const candidates = await db
      .select({ id: adobeAccount.id })
      .from(adobeAccount)
      .innerJoin(adobeToken, eq(adobeAccount.id, adobeToken.accountId))
      .where(and(ne(adobeAccount.status, "UNAVAILABLE" as AdobeAccountStatus), eq(adobeAccount.riskFlagged, false), activeTokenPredicate(now)));
    // 去重（inner join 可能产生多行同一 account）
    const uniqueIds = [...new Set(candidates.map((c) => c.id))];
    eligibleAccountCount = uniqueIds.length;
    const availableIds = uniqueIds.filter((id) => !atLimit(id));
    const selectedId = availableIds[Math.floor(Math.random() * availableIds.length)];
    if (selectedId) {
      const [row] = await db
        .select()
        .from(adobeAccount)
        .where(eq(adobeAccount.id, selectedId))
        .limit(1);
      account = row ?? null;
    }
  } else {
    // 轮询策略：按 updatedAt 升序取第一个有有效 token 且未达并发上限的账号。
    // 选中后必须把 updatedAt 更新为当前时间（标记最近使用），否则永远停在最旧账号上不轮转。
    const candidates = await db
      .select({ id: adobeAccount.id })
      .from(adobeAccount)
      .innerJoin(adobeToken, eq(adobeAccount.id, adobeToken.accountId))
      .where(and(ne(adobeAccount.status, "UNAVAILABLE" as AdobeAccountStatus), eq(adobeAccount.riskFlagged, false), activeTokenPredicate(now)))
      .groupBy(adobeAccount.id)
      .orderBy(asc(adobeAccount.updatedAt))
      .limit(20);
    eligibleAccountCount = candidates.length;
    const selectedId = candidates.find((candidate) => !atLimit(candidate.id))?.id;
    if (selectedId) {
      // 标记最近使用，让下一批任务轮换到下一个最久未用的账号。
      await db.update(adobeAccount).set({ updatedAt: new Date() }).where(eq(adobeAccount.id, selectedId));
      const [row] = await db
        .select()
        .from(adobeAccount)
        .where(eq(adobeAccount.id, selectedId))
        .limit(1);
      account = row ?? null;
    }
  }

  const token = account ? await findFirstActiveToken(account.id, now) : null;
  if (!account && eligibleAccountCount > 0) {
    throw new AppError("adobe_account_concurrency_limit", `All eligible accounts are at their concurrency limit (${accountLimit})`, 429, { concurrency_limit: accountLimit });
  }
  if (!account || !token) throw new AppError("adobe_account_unavailable", "No Adobe account with an active token is available", 503);
  try {
    return { accountId: account.id, tokenId: token.id, token: decryptSecret(token.encryptedAccessToken) };
  } catch {
    throw new AppError("adobe_token_unreadable", "Adobe token cannot be decrypted", 503, { account_id: account.id });
  }
}

/**
 * 每个生图任务都重新从数据库构造合格账号池，并在池内随机选择一次。
 * Token 必须属于候选账号。全局 Sherlock 存在时允许纯手动 Token；
 * 全局 Sherlock 缺失时，才从该 Token 绑定的 Cookie 刷新档案中回退提取。
 * 明确 408 重试时可排除已尝试账号重新随机。
 */
export async function selectAdobeGenerationAccount(
  accountId?: string | null,
  currentJobId?: string,
  excludedAccountIds: ReadonlySet<string> = new Set(),
): Promise<AdobeGenerationAccountContext> {
  const now = new Date();
  const settings = await getSystemSettings();
  const running = await accountRunningCounts(currentJobId);
  const atLimit = (id: string) => (running.get(id) ?? 0) >= settings.accountMaxConcurrency;

  const rows = await db
    .select({
      accountId: adobeAccount.id,
      tokenId: adobeToken.id,
      encryptedAccessToken: adobeToken.encryptedAccessToken,
      refreshProfileId: refreshProfile.id,
      profileAccountId: refreshProfile.accountId,
      profileStatus: refreshProfile.status,
      profileEnabled: refreshProfile.enabled,
      encryptedCookie: refreshProfile.encryptedCookie,
      sherlockToken: refreshProfile.sherlockToken,
    })
    .from(adobeAccount)
    .innerJoin(adobeToken, eq(adobeAccount.id, adobeToken.accountId))
    .leftJoin(refreshProfile, eq(adobeToken.refreshProfileId, refreshProfile.id))
    .where(and(
      eq(adobeAccount.status, "AVAILABLE" as AdobeAccountStatus),
      eq(adobeAccount.riskFlagged, false),
      activeTokenPredicate(now),
      accountId ? eq(adobeAccount.id, accountId) : undefined,
    ))
    .orderBy(desc(adobeToken.updatedAt), desc(refreshProfile.updatedAt));

  let globalToken = "";
  try {
    const { getGlobalSherlockStatus } = await import("@/lib/adobe/sherlock");
    globalToken = (await getGlobalSherlockStatus()).token?.trim() ?? "";
  } catch {
    // 全局单例不可用时，下方仍可回退到账号自身 Cookie。
  }

  const candidates = new Map<string, AdobeGenerationAccountContext>();
  for (const row of rows) {
    if ((accountId && row.accountId !== accountId) || excludedAccountIds.has(row.accountId) || candidates.has(row.accountId)) continue;
    const hasProfile = Boolean(row.refreshProfileId);
    if (hasProfile && (
      row.profileAccountId !== row.accountId
      || row.profileStatus !== ("ACTIVE" as RefreshProfileStatus)
      || row.profileEnabled !== true
      || !row.encryptedCookie
    )) continue;
    try {
      const token = decryptSecret(row.encryptedAccessToken);
      const arpSessionId = globalToken || (row.encryptedCookie ? completeSherlockFromCookie(decryptSecret(row.encryptedCookie)) : "");
      if (!arpSessionId) continue;
      candidates.set(row.accountId, {
        accountId: row.accountId,
        tokenId: row.tokenId,
        token,
        refreshProfileId: row.refreshProfileId,
        arpSessionId,
      });
    } catch {
      // 单条 Token 或 Cookie 不可解密时继续检查其他账号。
    }
  }

  const eligible = [...candidates.values()];
  const available = eligible.filter((candidate) => !atLimit(candidate.accountId));
  const selected = accountId ? available[0] : available[Math.floor(Math.random() * available.length)];
  if (!selected) {
    if (eligible.length > 0) {
      throw new AppError("adobe_account_concurrency_limit", `All eligible accounts are at their concurrency limit (${settings.accountMaxConcurrency})`, 429, { account_id: accountId ?? undefined, concurrency_limit: settings.accountMaxConcurrency });
    }
    throw new AppError("adobe_account_unavailable", "No Adobe account with an active token and complete Sherlock session is available", 503);
  }
  return selected;
}

export async function markAdobeTokenFailure(tokenId: string, error: string) {
  await db
    .update(adobeToken)
    .set({
      status: "INVALID" as AdobeTokenStatus,
      failureCount: sql`${adobeToken.failureCount} + 1`,
      lastError: error.slice(0, 500),
      errorUntil: new Date(Date.now() + 180_000),
      updatedAt: new Date(),
    })
    .where(eq(adobeToken.id, tokenId))
    .catch(() => undefined);
  const [token] = await db
    .select({ accountId: adobeToken.accountId })
    .from(adobeToken)
    .where(eq(adobeToken.id, tokenId))
    .limit(1)
    .catch((): Array<{ accountId: string }> => []);
  if (token?.accountId) {
    await db
      .update(adobeAccount)
      .set({
        status: "UNAVAILABLE" as AdobeAccountStatus,
        lastRefreshError: error.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(adobeAccount.id, token.accountId))
      .catch(() => undefined);
  }
}

/**
 * 彻底删除账号：Token 401（永久失效）时调用，清理该账号的 token、Cookie 刷新资料
 * 与账号记录，避免失效账号反复被选中占用资源。
 *
 * 关联的 generationJob 不删除——把账号关键信息写入 accountSnapshot 快照后解绑
 * 外键（与 proxySnapshot 同思路），job 历史可独立存续。
 */
export async function deleteAdobeAccount(accountId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [account] = await tx
      .select({ email: adobeAccount.email, externalId: adobeAccount.externalId, displayName: adobeAccount.displayName, createdAt: adobeAccount.createdAt })
      .from(adobeAccount)
      .where(eq(adobeAccount.id, accountId))
      .limit(1);
    const snapshot = account
      ? { email: account.email, externalId: account.externalId, displayName: account.displayName, createdAt: account.createdAt }
      : undefined;
    // job 存账号快照后解绑外键，删除账号不影响任务历史
    if (snapshot) {
      await tx
        .update(generationJob)
        .set({ accountSnapshot: snapshot as unknown, adobeAccountId: null })
        .where(eq(generationJob.adobeAccountId, accountId));
    } else {
      await tx.update(generationJob).set({ adobeAccountId: null }).where(eq(generationJob.adobeAccountId, accountId));
    }
    // entity（项目/任务关联）也可能挂在账号下：先解绑 job 对 entity 的引用再删 entity，
    // 否则 entity.accountId 外键会让账号删除失败
    const entityIds = await tx
      .select({ id: entity.id })
      .from(entity)
      .where(eq(entity.accountId, accountId));
    const entityIdValues = entityIds.map((row) => row.id);
    if (entityIdValues.length) {
      await tx.update(generationJob).set({ entityId: null }).where(inArray(generationJob.entityId, entityIdValues));
      await tx.delete(entity).where(inArray(entity.id, entityIdValues));
    }
    const tokens = await tx
      .select({ id: adobeToken.id, refreshProfileId: adobeToken.refreshProfileId })
      .from(adobeToken)
      .where(eq(adobeToken.accountId, accountId));
    const tokenIds = tokens.map((token) => token.id);
    const profileIds = tokens.map((token) => token.refreshProfileId).filter((id): id is string => Boolean(id));
    if (tokenIds.length) await tx.delete(adobeToken).where(inArray(adobeToken.id, tokenIds));
    if (profileIds.length) await tx.delete(refreshProfile).where(inArray(refreshProfile.id, profileIds));
    // 无 token 的账号也可能残留孤儿 profile（历史 401 清理路径缺失的产物）
    await tx.delete(refreshProfile).where(eq(refreshProfile.accountId, accountId));
    await tx.delete(adobeAccount).where(eq(adobeAccount.id, accountId));
  });
}

/**
 * 标记账号为 3p 风控（408）：不删除账号（保留 token/profile 供人工排查/恢复），
 * 但 selectAdobeGenerationAccount 不再选中它；列表显示"已风控"。
 */
export async function markAdobeAccountRiskFlagged(accountId: string, reason: string): Promise<void> {
  await db
    .update(adobeAccount)
    .set({
      riskFlagged: true,
      riskFlaggedAt: new Date(),
      riskFlaggedReason: reason.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(adobeAccount.id, accountId))
    .catch(() => undefined);
}

/** 人工解除风控标记（账号可用性恢复后调用）。 */
export async function unmarkAdobeAccountRiskFlagged(accountId: string): Promise<void> {
  await db
    .update(adobeAccount)
    .set({ riskFlagged: false, riskFlaggedAt: null, riskFlaggedReason: null, updatedAt: new Date() })
    .where(eq(adobeAccount.id, accountId))
    .catch(() => undefined);
}

export async function markAdobeTokenSuccess(tokenId: string) {  await db
    .update(adobeToken)
    .set({
      status: "ACTIVE" as AdobeTokenStatus,
      failureCount: 0,
      lastError: null,
      errorUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(adobeToken.id, tokenId))
    .catch(() => undefined);
}

