import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { adobeAccount, adobeToken, refreshProfile, type AdobeTokenStatus, type RefreshProfileStatus } from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { requireAdminRequest, handleAdminError } from "@/lib/admin-api";
import { AppError, getRequestId, safeErrorMessage, statusForErrorCode } from "@/lib/errors";
import { creditFailureMessage, refreshTokenCredits, refreshTokenCreditsBatch, setRefreshProfileEnabled } from "@/lib/adobe/refresh";
import { deleteAdobeAccount, unmarkAdobeAccountRiskFlagged } from "@/lib/adobe/account";
import { allocateProxySnapshot, getProxySettings } from "@/lib/proxy-pool";
import { getSystemSettings } from "@/lib/system-settings";

const inputSchema = z.object({
  action: z.string().optional(),
  cookie: z.unknown().optional(),
  cookies: z.array(z.unknown()).optional(),
  token: z.unknown().optional(),
  tokens: z.array(z.unknown()).optional(),
  accounts: z.array(z.unknown()).optional(),
  name: z.string().trim().max(255).optional(),
  id: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  tokenId: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  ids: z.array(z.string().min(1)).optional(),
  status: z.string().optional(),
  refreshProfileStatus: z.string().optional(),
  autoRefreshEnabled: z.boolean().optional(),
  sherlock_token: z.unknown().optional(),
});

type TokenPayload = Record<string, unknown>;

/** 以北京时间（UTC+8）格式化时间，用于默认账号名等展示。 */
function beijingTimestamp(date: Date = new Date()): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

type AccountImport = {
  token?: string;
  cookie?: string;
  name?: string;
  externalId?: string;
  email?: string;
  creditsTotal?: number;
  creditsUsed?: number;
  creditsAvailable?: number;
  creditsAvailableUntil?: string;
};

const REFRESH_PROFILE_STATUSES: readonly RefreshProfileStatus[] = ["ACTIVE", "INVALID", "DISABLED"];

function optionalText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decodeTokenPayload(value: string): TokenPayload {
  const part = value.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="), "base64").toString("utf8")) as TokenPayload;
  } catch {
    return {};
  }
}

function normalizeToken(value: unknown): string {
  const raw = typeof value === "string" ? value : value && typeof value === "object" ? String((value as { token?: unknown }).token ?? (value as { value?: unknown }).value ?? "") : "";
  const token = raw.trim();
  return token.toLowerCase().startsWith("bearer ") ? token.slice(7).trim() : token;
}

function tokenMetadata(value: string) {
  const payload = decodeTokenPayload(value);
  const externalId = String(payload.user_id ?? payload.aa_id ?? payload.sub ?? "").trim() || null;
  const displayName = String(payload.displayName ?? payload.name ?? payload.fullName ?? "").trim() || null;
  const email = String(payload.email ?? payload.emailAddress ?? "").trim() || null;
  const exp = Number(payload.exp);
  const expiresAt = Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000) : null;
  return { externalId, displayName, email, expiresAt };
}

function cookieText(value: unknown): string {
  if (typeof value === "string") {
    const text = value.trim();
    return text.toLowerCase().startsWith("cookie:") ? text.slice(7).trim() : text;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as { cookie?: unknown; cookies?: unknown };
    return cookieText(object.cookie ?? object.cookies);
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        const record = item as { name?: unknown; value?: unknown };
        const name = String(record.name ?? "").trim();
        const itemValue = String(record.value ?? "").trim();
        return name ? `${name}=${itemValue}` : "";
      }
      return "";
    }).filter(Boolean).join("; ");
  }
  return "";
}

function accountImportValues(value: unknown, inheritedEmail?: string): AccountImport[] {
  if (Array.isArray(value)) return value.flatMap((item) => accountImportValues(item, inheritedEmail));
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text) as unknown;
      return accountImportValues(parsed, inheritedEmail);
    } catch {
      const token = normalizeToken(text);
      return token ? [{ token, email: inheritedEmail }] : [];
    }
  }
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const email = optionalText(record.email) ?? inheritedEmail;
  if (Array.isArray(record.accounts)) return record.accounts.flatMap((item) => accountImportValues(item, email));

  const token = normalizeToken(record.token ?? record.access_token ?? "") || undefined;
  const cookie = cookieText(record.cookie ?? record.cookies) || (optionalText(record.ims_sid) ? `ims_sid=${optionalText(record.ims_sid)}` : undefined);
  if (!token && !cookie) return [];

  return [{
    token,
    cookie,
    name: optionalText(record.display_name) ?? optionalText(record.displayName) ?? optionalText(record.name),
    externalId: optionalText(record.account_id) ?? optionalText(record.accountId) ?? optionalText(record.externalAccountId),
    email,
    creditsTotal: optionalNumber(record.credits_total ?? record.creditsTotal),
    creditsUsed: optionalNumber(record.credits_used ?? record.creditsUsed),
    creditsAvailable: optionalNumber(record.credits_available ?? record.creditsAvailable),
    creditsAvailableUntil: optionalText(record.credits_available_until) ?? optionalText(record.creditsAvailableUntil),
  }];
}

type CookieImport = { cookie: string; name?: string };

function cookieImports(value: unknown, name?: string): CookieImport[] {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== text) return cookieImports(parsed, name);
    } catch {
      // Plain Cookie header.
    }
    const cookie = cookieText(text);
    return cookie ? [{ cookie, name }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => cookieImports(item, name));
  if (value && typeof value === "object") {
    const record = value as { name?: unknown; cookie?: unknown; cookies?: unknown };
    const itemName = String(record.name ?? name ?? "").trim() || undefined;
    if (record.cookie !== undefined) return cookieImports(record.cookie, itemName);
    if (record.cookies !== undefined) return cookieImports(record.cookies, itemName);
  }
  return [];
}

function lowerTokenStatus(status: AdobeTokenStatus): string {
  return status.toLowerCase();
}

/**
 * 管理员后台需要可诊断的错误信息（区别于公开接口的安全模糊化）：
 * - 401/403 等认证授权类错误是账号级问题，保留明确描述便于定位与处置
 * - 429/5xx 及网络类临时错误仍模糊为"上游暂时不可用"，避免泄露代理/URL 细节
 */
function safeLastError(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/returned (\d{3})/);
  if (match) {
    const status = Number(match[1]);
    if (status === 401) return "401 未授权：token 已失效，请重新登录该 Adobe 账号并导入新凭据";
    if (status === 403) return "403 拒绝访问：Adobe 账号可能已被风控或封禁";
    if (status === 429) return "429 请求过于频繁，请稍后重试";
    if (status >= 500) return `Adobe 上游服务暂时不可用 (HTTP ${status})`;
    return `积分查询失败 (HTTP ${status})`;
  }
  return safeErrorMessage("adobe_upstream_temporary", statusForErrorCode("adobe_upstream_temporary"));
}

function tokenExpiry(expiresAt: Date | null) {
  const expires = expiresAt?.getTime() ?? null;
  const remaining = expires === null ? null : Math.floor((expires - Date.now()) / 1000);
  return { expiresAt, expiresAtText: expiresAt?.toISOString() ?? null, remainingSeconds: remaining, isExpired: remaining !== null && remaining <= 0 };
}

async function mapToken(tokenId: string) {
  const [row] = await db
    .select({
      id: adobeToken.id,
      accountId: adobeToken.accountId,
      accountName: adobeAccount.displayName,
      accountEmail: adobeAccount.email,
      status: adobeToken.status,
      source: adobeToken.source,
      failureCount: adobeToken.failureCount,
      autoRefresh: adobeToken.autoRefreshEnabled,
      refreshProfileId: adobeToken.refreshProfileId,
      profileEnabled: refreshProfile.enabled,
      refreshProfileName: refreshProfile.name,
      creditsTotal: adobeToken.creditsTotal,
      creditsUsed: adobeToken.creditsUsed,
      creditsAvailable: adobeToken.creditsAvailable,
      creditsAvailableUntil: adobeToken.creditsAvailableUntil,
      creditsError: adobeToken.creditsError,
      riskFlagged: adobeAccount.riskFlagged,
      riskFlaggedAt: adobeAccount.riskFlaggedAt,
      riskFlaggedReason: adobeAccount.riskFlaggedReason,
      expiresAt: adobeToken.expiresAt,
      createdAt: adobeToken.createdAt,
    })
    .from(adobeToken)
    .innerJoin(adobeAccount, eq(adobeAccount.id, adobeToken.accountId))
    .leftJoin(refreshProfile, eq(refreshProfile.id, adobeToken.refreshProfileId))
    .where(eq(adobeToken.id, tokenId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.accountId,
    accountName: row.accountName,
    accountEmail: row.accountEmail,
    status: row.status.toLowerCase(),
    riskFlagged: Boolean(row.riskFlagged),
    riskFlaggedAt: row.riskFlaggedAt?.toISOString() ?? null,
    riskFlaggedReason: row.riskFlaggedReason ?? null,
    source: row.source,
    fails: row.failureCount,
    failureCount: row.failureCount,
    autoRefresh: Boolean(row.autoRefresh),
    autoRefreshEnabled: row.profileEnabled === null ? Boolean(row.autoRefresh) : Boolean(row.profileEnabled),
    refreshProfileId: row.refreshProfileId,
    refreshProfileName: row.refreshProfileName,
    creditsTotal: row.creditsTotal,
    creditsUsed: row.creditsUsed,
    creditsAvailable: row.creditsAvailable,
    creditsAvailableUntil: row.creditsAvailableUntil,
    creditsError: row.creditsError ? safeLastError(row.creditsError) : null,
    createdAt: row.createdAt,
    ...tokenExpiry(row.expiresAt),
  };
}

async function readableTokenValue(tokenId: string): Promise<string> {
  const [token] = await db.select({ encryptedAccessToken: adobeToken.encryptedAccessToken }).from(adobeToken).where(eq(adobeToken.id, tokenId)).limit(1);
  if (!token) throw new AppError("token_not_found", "Token not found", 404);
  try { return decryptSecret(token.encryptedAccessToken); } catch { throw new AppError("token_secret_unavailable", "Token secret is unavailable", 409); }
}

async function upsertManualToken(value: string, overrides: AccountImport = {}) {
  const metadata = tokenMetadata(value);
  const externalId = overrides.externalId || metadata.externalId;
  const displayName = overrides.name || metadata.displayName;
  const email = overrides.email || metadata.email;
  // 邮箱唯一：重复用户以 email 为准，同 email 导入时复用并覆盖更新该账号
  const [byEmail] = email ? await db.select().from(adobeAccount).where(eq(adobeAccount.email, email)).limit(1) : [null];
  let account = byEmail;
  if (!account && externalId) {
    const [byExternal] = await db.select().from(adobeAccount).where(eq(adobeAccount.externalId, externalId)).limit(1);
    account = byExternal ?? null;
  }
  // 仅当完全没有身份标识（无 email 且 token 无 externalId）时才按显示名兜底复用：
  // 导出源的 display_name 常为占位名（如 "c c"），同一占位名的不同账号若走显示名复用
  // 会被错误合并成一个账号，后续 token 互相覆盖并全部计入"重复"。
  if (!account && !email && !externalId && displayName) {
    const [byName] = await db.select().from(adobeAccount).where(eq(adobeAccount.displayName, displayName)).limit(1);
    account = byName ?? null;
  }
  if (!account) {
    const accountId = randomUUID();
    await db.insert(adobeAccount).values({ id: accountId, externalId, displayName: displayName || email || `Adobe account ${beijingTimestamp()}`, email });
    const [created] = await db.select().from(adobeAccount).where(eq(adobeAccount.id, accountId)).limit(1);
    account = created;
  } else if (displayName || email || externalId) {
    await db.update(adobeAccount).set({ externalId: externalId || undefined, displayName: displayName || undefined, email: email || undefined, updatedAt: new Date() }).where(eq(adobeAccount.id, account.id));
    const [updated] = await db.select().from(adobeAccount).where(eq(adobeAccount.id, account.id)).limit(1);
    account = updated;
  }

  const creditData = overrides.creditsTotal !== undefined || overrides.creditsUsed !== undefined || overrides.creditsAvailable !== undefined || overrides.creditsAvailableUntil !== undefined
    ? { creditsTotal: overrides.creditsTotal, creditsUsed: overrides.creditsUsed, creditsAvailable: overrides.creditsAvailable, creditsAvailableUntil: overrides.creditsAvailableUntil, creditsUpdatedAt: new Date() }
    : {};

  // 重复用户覆盖导入：该账号已有 token 时覆盖更新（替换 token 值/过期时间/积分），不累积多条
  const [existingToken] = await db.select({ id: adobeToken.id }).from(adobeToken).where(eq(adobeToken.accountId, account.id)).limit(1);
  if (existingToken) {
    await db.update(adobeToken)
      .set({ encryptedAccessToken: encryptSecret(value), expiresAt: metadata.expiresAt, status: "ACTIVE", source: "manual", autoRefreshEnabled: false, ...creditData, updatedAt: new Date() })
      .where(eq(adobeToken.id, existingToken.id));
    await db.update(adobeAccount).set({ status: "AVAILABLE", updatedAt: new Date() }).where(eq(adobeAccount.id, account.id));
    return { account, tokenId: existingToken.id, duplicate: true };
  }

  const existing = await db.select({ id: adobeToken.id, encryptedAccessToken: adobeToken.encryptedAccessToken }).from(adobeToken);
  for (const candidate of existing) {
    try {
      if (decryptSecret(candidate.encryptedAccessToken) === value) {
        if (Object.keys(creditData).length) await db.update(adobeToken).set({ ...creditData, updatedAt: new Date() }).where(eq(adobeToken.id, candidate.id));
        return { account, tokenId: candidate.id, duplicate: true };
      }
    }
    catch { /* 损坏旧密文不能阻塞新 Token 导入 */ }
  }
  const tokenId = randomUUID();
  await db.insert(adobeToken).values({ id: tokenId, accountId: account.id, encryptedAccessToken: encryptSecret(value), expiresAt: metadata.expiresAt, status: "ACTIVE", source: "manual", autoRefreshEnabled: false, ...creditData });
  await db.update(adobeAccount).set({ status: "AVAILABLE", updatedAt: new Date() }).where(eq(adobeAccount.id, account.id));
  return { account, tokenId, duplicate: false };
}

async function createRefreshProfile(value: CookieImport, options: { accountId?: string; externalAccountId?: string; email?: string } = {}) {
  const existing = await db.select({ id: refreshProfile.id, accountId: refreshProfile.accountId, encryptedCookie: refreshProfile.encryptedCookie }).from(refreshProfile);
  for (const candidate of existing) {
    try {
      if (decryptSecret(candidate.encryptedCookie) === value.cookie) {
        await db.update(refreshProfile).set({
          name: value.name || null,
          status: "ACTIVE",
          enabled: true,
          nextRefreshAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: new Date(),
        }).where(eq(refreshProfile.id, candidate.id));
        await db.update(adobeAccount).set({ status: "AVAILABLE", updatedAt: new Date() }).where(eq(adobeAccount.id, candidate.accountId));
        return { id: candidate.id, accountId: candidate.accountId, duplicate: true };
      }
    }
    catch { /* 损坏的旧密文不阻塞其他 Cookie 导入 */ }
  }
  let resolvedAccount = options.accountId
    ? (await db.select().from(adobeAccount).where(eq(adobeAccount.id, options.accountId)).limit(1))[0] ?? null
    : null;
  // 邮箱唯一：无指定账号时按 email 复用已有账号（重复用户覆盖导入）
  if (!resolvedAccount && options.email) {
    const [byEmail] = await db.select().from(adobeAccount).where(eq(adobeAccount.email, options.email)).limit(1);
    resolvedAccount = byEmail ?? null;
  }
  // 单 Cookie 导入通常没有 email/externalId，且 Cookie 自身会随登录刷新而变化。
  // 复用最近一次匿名 Cookie 档案，避免每次导入都制造一个无法识别的空账号。
  // 如需维护多个账号，可填写稳定名称；同名档案会定向覆盖。
  if (!resolvedAccount && !options.email && !options.externalAccountId) {
    const [anonymous] = await db
      .select({ account: adobeAccount })
      .from(refreshProfile)
      .innerJoin(adobeAccount, eq(adobeAccount.id, refreshProfile.accountId))
      .where(and(
        isNull(adobeAccount.email),
        isNull(adobeAccount.externalId),
        value.name ? eq(adobeAccount.displayName, value.name) : undefined,
      ))
      .orderBy(desc(refreshProfile.updatedAt))
      .limit(1);
    resolvedAccount = anonymous?.account ?? null;
  }
  if (!resolvedAccount) {
    const accountId = randomUUID();
    await db.insert(adobeAccount).values({ id: accountId, displayName: value.name || options.email || `Adobe refresh ${beijingTimestamp()}`, email: options.email });
    const [created] = await db.select().from(adobeAccount).where(eq(adobeAccount.id, accountId)).limit(1);
    resolvedAccount = created;
  } else if (value.name || options.email || options.externalAccountId) {
    await db.update(adobeAccount).set({ displayName: value.name || undefined, email: options.email || undefined, externalId: options.externalAccountId || undefined, updatedAt: new Date() }).where(eq(adobeAccount.id, resolvedAccount.id));
  }
  // 重复用户覆盖导入：该账号已有 profile 时覆盖 cookie（不累积多条）
  const [existingProfile] = await db.select({ id: refreshProfile.id }).from(refreshProfile).where(eq(refreshProfile.accountId, resolvedAccount.id)).limit(1);
  if (existingProfile) {
    await db.update(refreshProfile)
      .set({
        name: value.name || null,
        encryptedCookie: encryptSecret(value.cookie),
        externalAccountId: options.externalAccountId || null,
        status: "ACTIVE",
        enabled: true,
        nextRefreshAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(refreshProfile.id, existingProfile.id));
    return { id: existingProfile.id, accountId: resolvedAccount.id, duplicate: true };
  }
  const profileId = randomUUID();
  await db.insert(refreshProfile).values({ id: profileId, accountId: resolvedAccount.id, name: value.name || null, encryptedCookie: encryptSecret(value.cookie), externalAccountId: options.externalAccountId || null, status: "ACTIVE", enabled: true, nextRefreshAt: null });
  const [profile] = await db.select({ id: refreshProfile.id, accountId: refreshProfile.accountId }).from(refreshProfile).where(eq(refreshProfile.id, profileId)).limit(1);
  return { id: profile.id, accountId: profile.accountId, duplicate: false };
}

async function mapAccounts() {
  // 账号列表是高频读路径，使用同一 Drizzle 连接池完成单条 JOIN，只取元数据；
  // 绝不读取加密 Token/Cookie。
  const rows = await db
    .select({
      token_id: adobeToken.id,
      account_id: adobeToken.accountId,
      account_name: adobeAccount.displayName,
      account_external_id: adobeAccount.externalId,
      account_email: adobeAccount.email,
      account_status: adobeAccount.status,
      account_last_refresh_at: adobeAccount.lastRefreshAt,
      account_last_refresh_error: adobeAccount.lastRefreshError,
      account_risk_flagged: adobeAccount.riskFlagged,
      account_risk_flagged_at: adobeAccount.riskFlaggedAt,
      account_risk_flagged_reason: adobeAccount.riskFlaggedReason,
      token_status: adobeToken.status,
      token_source: adobeToken.source,
      token_auto_refresh: adobeToken.autoRefreshEnabled,
      token_refresh_profile_id: adobeToken.refreshProfileId,
      token_failure_count: adobeToken.failureCount,
      token_credits_total: adobeToken.creditsTotal,
      token_credits_used: adobeToken.creditsUsed,
      token_credits_available: adobeToken.creditsAvailable,
      token_credits_available_until: adobeToken.creditsAvailableUntil,
      token_credits_updated_at: adobeToken.creditsUpdatedAt,
      token_credits_error: adobeToken.creditsError,
      token_last_error: adobeToken.lastError,
      token_expires_at: adobeToken.expiresAt,
      token_created_at: adobeToken.createdAt,
      token_updated_at: adobeToken.updatedAt,
      profile_id: refreshProfile.id,
      profile_name: refreshProfile.name,
      profile_status: refreshProfile.status,
      profile_enabled: refreshProfile.enabled,
      profile_next_refresh_at: refreshProfile.nextRefreshAt,
      profile_last_attempt_at: refreshProfile.lastAttemptAt,
      profile_last_success_at: refreshProfile.lastSuccessAt,
      profile_consecutive_failures: refreshProfile.consecutiveFailures,
      profile_last_http_status: refreshProfile.lastHttpStatus,
      profile_last_error: refreshProfile.lastError,
    })
    .from(adobeToken)
    .innerJoin(adobeAccount, eq(adobeAccount.id, adobeToken.accountId))
    .leftJoin(refreshProfile, eq(refreshProfile.id, adobeToken.refreshProfileId))
    .orderBy(desc(adobeToken.updatedAt));

  const accountMap = new Map<string, {
    id: string;
    displayName: string;
    externalId: string | null;
    email: string | null;
    status: string;
    lastRefreshAt: Date | null;
    lastRefreshError: string | null;
    tokenCount: number;
    profileIds: Set<string>;
    refreshProfileDetails: Array<Record<string, unknown>>;
  }>();

  // 账号列表不能以 Token 表为入口：Cookie 刚导入、尚待 Worker 换取 Token 时，
  // 账号与 refreshProfile 已存在但 adobetoken 为空。先读取全部账号及其 Cookie
  // 档案，确保这类“待刷新”账号也可见，再叠加 Token 元数据。
  const accountRows = await db
    .select({
      id: adobeAccount.id,
      displayName: adobeAccount.displayName,
      externalId: adobeAccount.externalId,
      email: adobeAccount.email,
      status: adobeAccount.status,
      lastRefreshAt: adobeAccount.lastRefreshAt,
      lastRefreshError: adobeAccount.lastRefreshError,
      profileId: refreshProfile.id,
      profileName: refreshProfile.name,
      profileStatus: refreshProfile.status,
      profileEnabled: refreshProfile.enabled,
      profileNextRefreshAt: refreshProfile.nextRefreshAt,
      profileLastAttemptAt: refreshProfile.lastAttemptAt,
      profileLastSuccessAt: refreshProfile.lastSuccessAt,
      profileConsecutiveFailures: refreshProfile.consecutiveFailures,
      profileLastHttpStatus: refreshProfile.lastHttpStatus,
      profileLastError: refreshProfile.lastError,
    })
    .from(adobeAccount)
    .leftJoin(refreshProfile, eq(refreshProfile.accountId, adobeAccount.id))
    .orderBy(asc(adobeAccount.createdAt), asc(refreshProfile.createdAt));

  for (const row of accountRows) {
    const account = accountMap.get(row.id) ?? {
      id: row.id,
      displayName: row.displayName,
      externalId: row.externalId,
      email: row.email,
      status: row.status,
      lastRefreshAt: row.lastRefreshAt,
      lastRefreshError: row.lastRefreshError,
      tokenCount: 0,
      profileIds: new Set<string>(),
      refreshProfileDetails: [],
    };
    if (row.profileId && !account.profileIds.has(row.profileId)) {
      account.profileIds.add(row.profileId);
      account.refreshProfileDetails.push({
        id: row.profileId,
        name: row.profileName,
        status: row.profileStatus?.toLowerCase() ?? "active",
        enabled: Boolean(row.profileEnabled),
        nextRefreshAt: row.profileNextRefreshAt,
        lastAttemptAt: row.profileLastAttemptAt,
        lastSuccessAt: row.profileLastSuccessAt,
        consecutiveFailures: row.profileConsecutiveFailures ?? 0,
        lastHttpStatus: row.profileLastHttpStatus,
        lastError: row.profileLastError ? safeLastError(row.profileLastError) : null,
      });
    }
    accountMap.set(row.id, account);
  }

  const tokens = rows.map((row) => {
    const account = accountMap.get(row.account_id) ?? {
      id: row.account_id,
      displayName: row.account_name,
      externalId: row.account_external_id,
      email: row.account_email,
      status: row.account_status,
      lastRefreshAt: row.account_last_refresh_at,
      lastRefreshError: row.account_last_refresh_error,
      tokenCount: 0,
      profileIds: new Set<string>(),
      refreshProfileDetails: [],
    };
    account.tokenCount += 1;
    if (row.profile_id && !account.profileIds.has(row.profile_id)) {
      account.profileIds.add(row.profile_id);
      account.refreshProfileDetails.push({
        id: row.profile_id,
        name: row.profile_name,
        status: row.profile_status?.toLowerCase() ?? "active",
        enabled: Boolean(row.profile_enabled),
        nextRefreshAt: row.profile_next_refresh_at,
        lastAttemptAt: row.profile_last_attempt_at,
        lastSuccessAt: row.profile_last_success_at,
        consecutiveFailures: row.profile_consecutive_failures ?? 0,
        lastHttpStatus: row.profile_last_http_status,
        lastError: row.profile_last_error ? safeLastError(row.profile_last_error) : null,
      });
    }
    accountMap.set(row.account_id, account);

    const expiry = tokenExpiry(row.token_expires_at);
    return {
      id: row.token_id,
      accountId: row.account_id,
      accountName: row.account_name,
      accountEmail: row.account_email,
      status: row.token_status.toLowerCase(),
      source: row.token_source,
      fails: row.token_failure_count,
      failureCount: row.token_failure_count,
      autoRefresh: Boolean(row.token_auto_refresh),
      autoRefreshEnabled: row.profile_enabled === null ? Boolean(row.token_auto_refresh) : Boolean(row.profile_enabled),
      refreshProfileId: row.token_refresh_profile_id,
      refreshProfileName: row.profile_name,
      creditsTotal: row.token_credits_total,
      creditsUsed: row.token_credits_used,
      creditsAvailable: row.token_credits_available,
      creditsAvailableUntil: row.token_credits_available_until,
      creditsUpdatedAt: row.token_credits_updated_at,
      creditsError: row.token_credits_error ? safeLastError(row.token_credits_error) : null,
      lastError: row.token_last_error ? safeLastError(row.token_last_error) : null,
      riskFlagged: Boolean(row.account_risk_flagged),
      riskFlaggedAt: row.account_risk_flagged_at?.toISOString() ?? null,
      riskFlaggedReason: row.account_risk_flagged_reason ?? null,
      createdAt: row.token_created_at,
      updatedAt: row.token_updated_at,
      ...expiry,
    };
  });
  const creditsAvailableTotal = tokens.reduce((sum, token) => sum + (typeof token.creditsAvailable === "number" ? token.creditsAvailable : 0), 0);
  return {
    accounts: [...accountMap.values()].map((account) => ({
      id: account.id,
      displayName: account.displayName,
      externalId: account.externalId,
      email: account.email,
      status: account.status,
      lastRefreshAt: account.lastRefreshAt,
      lastRefreshError: safeLastError(account.lastRefreshError),
      tokenCount: account.tokenCount,
      refreshProfiles: account.refreshProfileDetails.length,
      refreshProfileDetails: account.refreshProfileDetails,
    })),
    tokens,
    summary: { total: tokens.length, active: tokens.filter((token) => token.status === "active").length, creditsAvailableTotal },
  };
}

/**
 * Cookie 导入只负责落库并把资料标为立即到期；真正的 Adobe 刷新只由具有
 * 独立 egress 的 Worker 执行，Web 容器不直接访问上游。
 */
async function queueRefresh(profileId: string): Promise<void> {
  await db.update(refreshProfile)
    .set({ nextRefreshAt: null, leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(eq(refreshProfile.id, profileId));
}

export async function GET(request: Request) {
  try { await requireAdminRequest(request); return Response.json({ ...(await mapAccounts()), request_id: getRequestId(request) }); }
  catch (error) { return handleAdminError(error, request); }
}

export async function POST(request: Request) {
  try {
    await requireAdminRequest(request);
    const parsed = inputSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new AppError("invalid_account_request", "Invalid account request", 400);
    const input = parsed.data;
    const action = input.action?.trim().toLowerCase();
    if (action === "refresh-token") {
      const tokenId = input.tokenId ?? input.id;
      let profileId = input.profileId;
      if (tokenId && !profileId) {
        const [token] = await db.select({ refreshProfileId: adobeToken.refreshProfileId }).from(adobeToken).where(eq(adobeToken.id, tokenId)).limit(1);
        if (!token) throw new AppError("token_not_found", "Token not found", 404);
        profileId = token.refreshProfileId ?? undefined;
      }
      if (!profileId) throw new AppError("refresh_profile_not_bound", "This account is not bound to an auto refresh profile", 400);
      await queueRefresh(profileId);
      return Response.json({ status: "pending", tokenId, profileId, request_id: getRequestId(request) });
    }
    if (action === "unmark-risk") {
      const accountId = input.accountId ?? input.id;
      if (!accountId) throw new AppError("account_id_required", "accountId is required", 400);
      await unmarkAdobeAccountRiskFlagged(accountId);
      return Response.json({ status: "ok", accountId, request_id: getRequestId(request) });
    }
    if (action === "refresh-credits") {
      const tokenId = input.tokenId ?? input.id;
      if (!tokenId) throw new AppError("token_id_required", "tokenId is required", 400);
      try {
        const result = await refreshTokenCredits(tokenId);
        const { proxyId, proxyHost, ...credits } = result;
        // 把本次查询所用的代理一并返回，弹窗可显示「哪个账号走了哪个代理」，便于排查上游拒绝。
        return Response.json({ status: "ok", tokenId, credits, proxy: proxyId ? { id: proxyId, host: proxyHost } : null, request_id: getRequestId(request) });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const message = creditFailureMessage(error);
        return Response.json({
          status: "failed",
          tokenId,
          token: await mapToken(tokenId),
          // status=401 表示 token 已明确失效；批量刷新弹窗据此把账号标记为"不生效"。
          error: { code: error.code, message, status: error.status, unauthorized: error.status === 401 },
          request_id: getRequestId(request),
        });
      }
    }
    if (action === "refresh-credits-stream") {
      const ids = input.ids ?? [];
      const tokenIds = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
      if (!tokenIds.length) throw new AppError("token_ids_required", "Select at least one token", 400);
      // 并发池容量 = 每代理并发 × 启用代理数（与弹窗展示语义一致），上限 100；
      // 后端并发不受浏览器同域连接数限制，才能真正跑满配置的并发。
      const settings = await getSystemSettings();
      const pool = await getProxySettings();
      const proxyCount = pool.enabled ? Math.max(1, pool.nodes.filter((node) => node.enabled).length) : 1;
      // 总并发 = 每代理并发 × 启用代理数（如 3×9=27）。
      // 配套：数据库连接池默认上限已从 10 提高到 30，避免高并发下的 DB 事务排队。
      const concurrency = Math.min(100, settings.creditsRefreshConcurrency * proxyCount);
      const encoder = new TextEncoder();
      // SSE：每刷新完一个账号立即推送 progress 事件，前端弹窗实时更新进度。
      const stream = new ReadableStream({
        async start(controller) {
          const total = tokenIds.length;
          let done = 0;
          let ok = 0;
          let failed = 0;
          let unauthorized = 0;
          const send = (data: unknown) => {
            try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { /* 客户端已断开 */ }
          };
          try {
            send({ type: "start", total, concurrency, perProxy: settings.creditsRefreshConcurrency, proxyCount });
            // 整个批次共享同一份代理快照；批量函数内部「预加载到内存 → 并发 HTTP 查积分（不写库）
            // → 每 10 个账号一个事务批量写回」，DB 连接占用极低。
            const snapshot = await allocateProxySnapshot();
            await refreshTokenCreditsBatch(tokenIds, {
              snapshot,
              concurrency,
              batchSize: 10,
              onStart: (id) => send({ type: "running", id }),
              onResult: (result) => {
                done += 1;
                if (result.status === "ok") ok += 1;
                else if (result.status === "unauthorized") unauthorized += 1;
                else failed += 1;
                send({ type: "progress", ...result, done, total, ok, failed, unauthorized });
              },
            });
            send({ type: "done", total, ok, failed, unauthorized });
          } catch (error) {
            send({ type: "error", message: error instanceof Error ? error.message : "批量刷新失败" });
          } finally {
            try { controller.close(); } catch { /* 已关闭 */ }
          }
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
    }
    if (action === "export-tokens") {
      const ids = input.ids ? new Set(input.ids) : null;
      const rows = await db.select({
        id: adobeToken.id,
        status: adobeToken.status,
        source: adobeToken.source,
        autoRefreshEnabled: adobeToken.autoRefreshEnabled,
        refreshProfileId: adobeToken.refreshProfileId,
        createdAt: adobeToken.createdAt,
        profileName: refreshProfile.name,
      }).from(adobeToken).leftJoin(refreshProfile, eq(refreshProfile.id, adobeToken.refreshProfileId)).orderBy(asc(adobeToken.createdAt));
      const exported = await Promise.all(rows.filter((row) => !ids || ids.has(row.id)).map(async (row) => ({ id: row.id, token: await readableTokenValue(row.id), status: lowerTokenStatus(row.status), source: row.source, auto_refresh: row.autoRefreshEnabled, refresh_profile_id: row.refreshProfileId, refresh_profile_name: row.profileName ?? null, added_at: row.createdAt })));
      return Response.json({ status: "ok", total: exported.length, selected: Boolean(ids), tokens: exported, request_id: getRequestId(request) });
    }
    if (action === "export-cookies") {
      const ids = input.ids ? new Set(input.ids) : null;
      const profiles = await db.select().from(refreshProfile).orderBy(asc(refreshProfile.createdAt));
      const items = await Promise.all(profiles.filter((profile) => !ids || ids.has(profile.id)).map(async (profile) => ({ id: profile.id, name: profile.name, cookie: decryptSecret(profile.encryptedCookie) })));
      return Response.json({ status: "ok", total: items.length, selected: Boolean(ids), items, request_id: getRequestId(request) });
    }

    if (action === "import-stream") {
      const accountValues = (input.accounts ?? []).flatMap((value) => accountImportValues(value));
      if (!accountValues.length) throw new AppError("credentials_required", "Cookie or token is required", 400);
      const BATCH_SIZE = 10;
      const encoder = new TextEncoder();
      // SSE：每处理完一批（10 个）立即推送进度事件，前端弹窗实时展示批次进度。
      // 与单条导入不同，批量导入不自动 queueRefresh —— 上千个账号同时触发 Adobe
      // 刷新会瞬间打满上游并触发风控；导入完成后由管理员用「刷新积分」按需批量执行。
      const stream = new ReadableStream({
        async start(controller) {
          const total = accountValues.length;
          let done = 0;
          let ok = 0;
          let failed = 0;
          let duplicate = 0;
          let refreshPending = 0;
          const send = (data: unknown) => {
            try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { /* 客户端已断开 */ }
          };
          try {
            send({ type: "start", total, batchSize: BATCH_SIZE });
            for (let index = 0; index < total; index += BATCH_SIZE) {
              const batch = accountValues.slice(index, index + BATCH_SIZE);
              const results: Array<{ ok: boolean; reason?: string; duplicate?: boolean }> = [];
              for (const accountValue of batch) {
                try {
                  const tokenResult = accountValue.token ? await upsertManualToken(accountValue.token, accountValue) : null;
                  let profileResult: { id: string; accountId: string; duplicate: boolean } | null = null;
                  if (accountValue.cookie) {
                    profileResult = await createRefreshProfile(
                      { cookie: accountValue.cookie, name: accountValue.name },
                      { accountId: tokenResult?.account.id, externalAccountId: accountValue.externalId || tokenResult?.account.externalId || undefined, email: accountValue.email },
                    );
                    if (tokenResult) {
                      await db.update(adobeToken).set({ refreshProfileId: profileResult.id, autoRefreshEnabled: true, source: "auto_refresh", updatedAt: new Date() }).where(eq(adobeToken.id, tokenResult.tokenId));
                    }
                    if (!profileResult.duplicate) refreshPending += 1;
                  }
                  const isDuplicate = Boolean(tokenResult?.duplicate || profileResult?.duplicate);
                  if (isDuplicate) duplicate += 1;
                  else ok += 1;
                  results.push({ ok: true, duplicate: isDuplicate });
                } catch (error) {
                  failed += 1;
                  results.push({ ok: false, reason: error instanceof Error ? error.message : "import_failed" });
                }
                done += 1;
              }
              send({ type: "progress", batch: Math.ceil(done / BATCH_SIZE), batchSize: BATCH_SIZE, done, total, ok, failed, duplicate, results });
            }
            send({ type: "done", total, ok, failed, duplicate, refreshPending });
          } catch (error) {
            send({ type: "error", message: error instanceof Error ? error.message : "批量导入失败" });
          } finally {
            try { controller.close(); } catch { /* 已关闭 */ }
          }
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
    }

    if (action === "export") {
      // 单个账号导出（导入格式）：email/display_name/account_id/credits_*/token/cookie/ims_sid
      const accountId = input.id ?? input.accountId;
      if (!accountId) throw new AppError("account_id_required", "id 是必需的", 400);
      const [account] = await db.select().from(adobeAccount).where(eq(adobeAccount.id, accountId)).limit(1);
      if (!account) throw new AppError("account_not_found", "账号不存在", 404);
      const [token] = await db.select().from(adobeToken).where(eq(adobeToken.accountId, accountId)).orderBy(desc(adobeToken.updatedAt)).limit(1);
      const [profile] = await db.select().from(refreshProfile).where(eq(refreshProfile.accountId, accountId)).limit(1);
      let tokenValue = "";
      let cookieValue = "";
      try { if (token) tokenValue = decryptSecret(token.encryptedAccessToken); } catch { /* 损坏密文跳过 */ }
      try { if (profile) cookieValue = decryptSecret(profile.encryptedCookie); } catch { /* 损坏密文跳过 */ }
      const exported = {
        email: account.email ?? null,
        display_name: account.displayName,
        account_id: account.externalId ?? null,
        source_host: null,
        credits_total: token?.creditsTotal ?? null,
        credits_used: token?.creditsUsed ?? null,
        credits_available: token?.creditsAvailable ?? null,
        credits_available_until: token?.creditsAvailableUntil ?? null,
        token: tokenValue,
        cookie: cookieValue || null,
        ims_sid: cookieValue.match(/(?:^|;\s*)ims_sid=([^;]+)/)?.[1] ?? null,
        password: null,
        // 附加：全局 sherlock 状态（导出兼容字段外，便于回导后直接可用）
        sherlock_token: (await (await import("@/lib/adobe/sherlock")).getGlobalSherlockStatus()).token ?? null,
        sherlock_expires_at: (await (await import("@/lib/adobe/sherlock")).getGlobalSherlockStatus()).expiresAt?.toISOString() ?? null,
      };
      return Response.json(exported);
    }

    const accountValues = (input.accounts ?? []).flatMap((value) => accountImportValues(value));
    const cookieValues = [...(input.cookies ?? []), ...(input.cookie === undefined ? [] : [input.cookie])].flatMap((value) => cookieImports(value, input.name));
    const tokenValues = [...(input.tokens ?? []), ...(input.token === undefined ? [] : [input.token])].map(normalizeToken).filter(Boolean);
    // sherlock_token 不使用导入文件的值：sherlockToken 只取系统全局单例（提交时获取）
    if (!accountValues.length && !cookieValues.length && !tokenValues.length) throw new AppError("credentials_required", "Cookie or token is required", 400);
    const tokenResults = [];
    const cookieResults = [];
    const accountResults: Array<Record<string, unknown>> = [];
    let refreshPendingCount = 0;

    for (const accountValue of accountValues) {
      try {
        const tokenResult = accountValue.token ? await upsertManualToken(accountValue.token, accountValue) : null;
        let profileResult: { id: string; accountId: string; duplicate: boolean } | null = null;
        let refreshPending = false;
        if (accountValue.cookie) {
          profileResult = await createRefreshProfile(
            { cookie: accountValue.cookie, name: accountValue.name },
            { accountId: tokenResult?.account.id, externalAccountId: accountValue.externalId || tokenResult?.account.externalId || undefined, email: accountValue.email },
          );
          if (tokenResult) {
            await db.update(adobeToken).set({ refreshProfileId: profileResult.id, autoRefreshEnabled: true, source: "auto_refresh", updatedAt: new Date() }).where(eq(adobeToken.id, tokenResult.tokenId));
          }
          refreshPending = true;
          refreshPendingCount += 1;
          await queueRefresh(profileResult.id);
        }
        accountResults.push({ ok: true, tokenId: tokenResult?.tokenId, profileId: profileResult?.id, duplicate: Boolean(tokenResult?.duplicate || profileResult?.duplicate), refreshed: false, refreshPending });
      } catch (error) {
        accountResults.push({ ok: false, reason: error instanceof Error ? error.message : "import_failed" });
      }
    }

    for (const value of [...new Set(tokenValues)]) tokenResults.push(await upsertManualToken(value, { name: input.name }));
    for (const value of cookieValues) {
      if (!value.cookie) { cookieResults.push({ ok: false, reason: "empty_cookie" }); continue; }
      try {
        const profile = await createRefreshProfile(value);
        const refreshPending = true;
        refreshPendingCount += 1;
        await queueRefresh(profile.id);
        cookieResults.push({ ok: true, profileId: profile.id, duplicate: profile.duplicate, refreshed: false, refreshPending });
      } catch (error) {
        cookieResults.push({ ok: false, reason: error instanceof Error ? error.message : "import_failed" });
      }
    }
    const hasFailure = accountResults.some((item) => item.ok === false) || cookieResults.some((item) => !item.ok);
    return Response.json({ status: hasFailure ? "partial" : "ok", account_count: accountResults.filter((item) => item.ok).length, account_results: accountResults, token_count: tokenResults.length + accountValues.filter((item) => Boolean(item.token)).length, token_results: tokenResults.map((item) => ({ ...item, account: { id: item.account.id, displayName: item.account.displayName, email: item.account.email } })), cookie_results: cookieResults, refresh_pending_count: refreshPendingCount, request_id: getRequestId(request) }, { status: 201 });
  } catch (error) { return handleAdminError(error, request); }
}

export async function PATCH(request: Request) {
  try {
    await requireAdminRequest(request);
    const parsed = inputSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new AppError("invalid_account_request", "Invalid account request", 400);
    const input = parsed.data;
    if (input.autoRefreshEnabled !== undefined || input.refreshProfileStatus) {
      const profileId = input.profileId;
      if (!profileId) throw new AppError("refresh_profile_id_required", "profileId is required", 400);
      if (input.autoRefreshEnabled !== undefined) await setRefreshProfileEnabled(profileId, input.autoRefreshEnabled);
      if (input.refreshProfileStatus) {
        const status = input.refreshProfileStatus.toUpperCase();
        if (!REFRESH_PROFILE_STATUSES.includes(status as RefreshProfileStatus)) throw new AppError("invalid_refresh_profile_status", "Invalid refresh profile status", 400);
        await db.update(refreshProfile).set({ status: status as RefreshProfileStatus, enabled: status === "ACTIVE", updatedAt: new Date() }).where(eq(refreshProfile.id, profileId));
      }
      if (input.tokenId) {
        const token = await mapToken(input.tokenId);
        if (!token) throw new AppError("token_not_found", "Token not found", 404);
        return Response.json({ token, request_id: getRequestId(request) });
      }
      return Response.json({ ...(await mapAccounts()), request_id: getRequestId(request) });
    }
    if (input.tokenId) {
      const [token] = await db.select().from(adobeToken).where(eq(adobeToken.id, input.tokenId)).limit(1);
      if (!token) throw new AppError("token_not_found", "Token not found", 404);
      const data: { autoRefreshEnabled?: boolean } = {};
      if (input.autoRefreshEnabled !== undefined) {
        if (!token.refreshProfileId) throw new AppError("refresh_profile_not_bound", "This token is not bound to an auto refresh profile", 400);
        await setRefreshProfileEnabled(token.refreshProfileId, input.autoRefreshEnabled);
        data.autoRefreshEnabled = input.autoRefreshEnabled;
      }
      await db.update(adobeToken).set({ ...data, updatedAt: new Date() }).where(eq(adobeToken.id, token.id));
      const [updated] = await db.select({ id: adobeToken.id, status: adobeToken.status, autoRefreshEnabled: adobeToken.autoRefreshEnabled, refreshProfileId: adobeToken.refreshProfileId }).from(adobeToken).where(eq(adobeToken.id, token.id)).limit(1);
      return Response.json({ token: updated, request_id: getRequestId(request) });
    }
    if (!input.id || !input.status) throw new AppError("account_update_required", "Account status update is required", 400);
    const status = input.status.toUpperCase();
    if (!["AVAILABLE", "UNAVAILABLE", "REFRESHING"].includes(status)) throw new AppError("invalid_account_status", "Invalid account status", 400);
    await db.update(adobeAccount).set({ status: status as "AVAILABLE" | "UNAVAILABLE" | "REFRESHING", updatedAt: new Date() }).where(eq(adobeAccount.id, input.id));
    const [account] = await db.select({ id: adobeAccount.id, displayName: adobeAccount.displayName, status: adobeAccount.status }).from(adobeAccount).where(eq(adobeAccount.id, input.id)).limit(1);
    return Response.json({ account, request_id: getRequestId(request) });
  } catch (error) { return handleAdminError(error, request); }
}

export async function DELETE(request: Request) {
  try {
    await requireAdminRequest(request);
    const parsed = inputSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new AppError("invalid_account_request", "Invalid account request", 400);
    const input = parsed.data;
    const tokenIds = input.ids ?? (input.tokenId ? [input.tokenId] : []);
    if (tokenIds.length) {
      const tokens = await db.select({ id: adobeToken.id, accountId: adobeToken.accountId }).from(adobeToken).where(inArray(adobeToken.id, tokenIds));
      if (!tokens.length) throw new AppError("token_not_found", "Token not found", 404);
      const accountIds = [...new Set(tokens.map((token) => token.accountId))];
      for (const accountId of accountIds) await deleteAdobeAccount(accountId);
      return Response.json({ deleted: true, deletedIds: tokens.map((token) => token.id), deletedAccountIds: accountIds, request_id: getRequestId(request) });
    }
    if (!input.id) throw new AppError("account_id_required", "Account id is required", 400);
    const [account] = await db.select({ id: adobeAccount.id }).from(adobeAccount).where(eq(adobeAccount.id, input.id)).limit(1);
    if (!account) throw new AppError("account_not_found", "Adobe account not found", 404);
    await deleteAdobeAccount(input.id);
    return Response.json({ deleted: true, deletedAccountIds: [input.id], request_id: getRequestId(request) });
  } catch (error) { return handleAdminError(error, request); }
}

