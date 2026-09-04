import { eq, and, or, gt, lt, lte, isNull, desc, asc, sql, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  adobeAccount,
  adobeToken,
  refreshProfile as refreshProfileTable,
  type AdobeAccountStatus,
  type AdobeTokenStatus,
  type RefreshProfileStatus,
} from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { deleteAdobeAccount } from "@/lib/adobe/account";
import { browserSecurityHeaders } from "@/lib/adobe/client";
import { FetchAdobeTransport } from "@/lib/adobe/transport";
import { allocateProxySnapshot, getSnapshotProxy, isProxyEligibleFailure, type ProxySnapshot, type ProxySnapshotEntry } from "@/lib/proxy-pool";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { getSystemSettings } from "@/lib/system-settings";

const REFRESH_URL = "https://adobeid-na1.services.adobe.com/ims/check/v6/token?jslVersion=v2-v0.48.0-1-g1e322cb";
const REFRESH_SCOPE = "AdobeID,firefly_api,openid,pps.read,pps.write,additional_info.projectedProductContext,additional_info.ownerOrg,uds_read,uds_write,ab.manage,read_organizations,additional_info.roles,account_cluster.read,creative_production,profile";
// drizzle(mysql2) 的 update/delete/insert 解析为原始结果元组 [ResultSetHeader, FieldPacket[]]，
// affectedRows 在第 0 个元素上（与 jobs.ts 的 `const [result] = await db.update(...)` 一致）；
// 直接在元组上读 affectedRows 永远得到 0，导致 claimRefreshProfile 把成功认领判为失败。
function affectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  if (!header || typeof header !== "object" || !("affectedRows" in header)) return 0;
  const value = (header as { affectedRows?: unknown }).affectedRows;
  return typeof value === "number" ? value : 0;
}

export function isRefreshProxyEligibleFailure(error: unknown): boolean {
  if (error instanceof AppError) {
    const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
    if (typeof details.proxyEligible === "boolean") return details.proxyEligible;
    return error.code === "adobe_transport_error";
  }
  return isProxyEligibleFailure(error);
}

function refreshStatusProxyEligible(status: number): boolean {
  return [408, 425, 502, 503, 504].includes(status);
}

export function accountIdFromToken(value: string): string {
  const part = value.split(".")[1];
  if (!part) return "";
  try {
    const parsed = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="), "base64").toString("utf8")) as Record<string, unknown>;
    return String(parsed.user_id ?? parsed.aa_id ?? parsed.sub ?? "").trim();
  } catch { return ""; }
}

type LockedRefreshProfile = { id: string; accountId: string; externalAccountId: string | null };

function refreshLeaseLost(profileId: string): AppError {
  return new AppError("refresh_lease_lost", "Refresh lease was lost", 409, { profile_id: profileId });
}

/**
 * 刷新请求可能比默认租约更久。续租只允许当前 owner 且租约尚未过期的
 * profile 延长租期；一旦 CAS 失败，调用方必须放弃本次刷新结果。
 */
export async function renewRefreshProfileLease(profileId: string, workerId: string): Promise<boolean> {
  const now = new Date();
  const leaseMs = (await getSystemSettings()).jobLeaseMs;
  const updated = await db
    .update(refreshProfileTable)
    .set({
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(refreshProfileTable.id, profileId),
        eq(refreshProfileTable.status, "ACTIVE" as RefreshProfileStatus),
        eq(refreshProfileTable.leaseOwner, workerId),
        gt(refreshProfileTable.leaseExpiresAt, now),
      ),
    );
  return affectedRows(updated) === 1;
}

export async function assertRefreshProfileLease(profileId: string, workerId: string): Promise<void> {
  const [lease] = await db
    .select({ id: refreshProfileTable.id })
    .from(refreshProfileTable)
    .where(
      and(
        eq(refreshProfileTable.id, profileId),
        eq(refreshProfileTable.status, "ACTIVE" as RefreshProfileStatus),
        eq(refreshProfileTable.leaseOwner, workerId),
        gt(refreshProfileTable.leaseExpiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!lease) throw refreshLeaseLost(profileId);
}

type RefreshLeaseHeartbeat = { lost: boolean; stop: () => void };

function startRefreshLeaseHeartbeat(profileId: string, workerId: string, leaseMs: number): RefreshLeaseHeartbeat {
  const state: { lost: boolean; renewing: boolean } = { lost: false, renewing: false };
  const intervalMs = Math.max(1_000, Math.floor(leaseMs / 3));
  const timer = setInterval(() => {
    if (state.renewing || state.lost) return;
    state.renewing = true;
    void renewRefreshProfileLease(profileId, workerId)
      .then((ok) => { if (!ok) state.lost = true; })
      .catch(() => { state.lost = true; })
      .finally(() => { state.renewing = false; });
  }, intervalMs);
  return { get lost() { return state.lost; }, stop: () => clearInterval(timer) };
}

async function lockRefreshProfile(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  profileId: string,
  workerId: string,
): Promise<LockedRefreshProfile> {
  const now = new Date();
  const rows = await tx
    .select({
      id: refreshProfileTable.id,
      accountId: refreshProfileTable.accountId,
      externalAccountId: refreshProfileTable.externalAccountId,
    })
    .from(refreshProfileTable)
    .where(
      and(
        eq(refreshProfileTable.id, profileId),
        eq(refreshProfileTable.status, "ACTIVE" as RefreshProfileStatus),
        eq(refreshProfileTable.leaseOwner, workerId),
        gt(refreshProfileTable.leaseExpiresAt, now),
      ),
    )
    .for("update");
  if (!rows[0]) throw refreshLeaseLost(profileId);
  return rows[0];
}

export type RefreshSuccessInput = {
  profileId: string;
  workerId: string;
  accessToken: string;
  expiresAt: Date | null;
  externalAccountId?: string | null;
  displayName?: string | null;
  email?: string | null;
};

/**
 * 在一个事务中写入 Token、账号状态和刷新资料，并以 owner + 未过期作为
 * 最终 CAS。CAS 失败会回滚 Token/账号写入，防止旧 Worker 覆盖新结果。
 */
export async function persistRefreshSuccess(input: RefreshSuccessInput): Promise<void> {
  const settings = await getSystemSettings();
  await db.transaction(async (tx) => {
    const profile = await lockRefreshProfile(tx, input.profileId, input.workerId);
    const externalId = input.externalAccountId || profile.externalAccountId || null;
    const [token] = await tx
      .select()
      .from(adobeToken)
      .where(and(eq(adobeToken.accountId, profile.accountId), eq(adobeToken.refreshProfileId, profile.id)))
      .orderBy(desc(adobeToken.updatedAt))
      .limit(1);
    if (token) {
      await tx
        .update(adobeToken)
        .set({
          encryptedAccessToken: encryptSecret(input.accessToken),
          expiresAt: input.expiresAt,
          status: "ACTIVE" as AdobeTokenStatus,
          source: "auto_refresh",
          autoRefreshEnabled: true,
          failureCount: 0,
          errorUntil: null,
          lastError: null,
          refreshProfileId: profile.id,
          updatedAt: new Date(),
        })
        .where(eq(adobeToken.id, token.id));
    } else {
      await tx.insert(adobeToken).values({
        accountId: profile.accountId,
        encryptedAccessToken: encryptSecret(input.accessToken),
        expiresAt: input.expiresAt,
        status: "ACTIVE" as AdobeTokenStatus,
        source: "auto_refresh",
        autoRefreshEnabled: true,
        refreshProfileId: profile.id,
      });
    }
    await tx
      .update(adobeAccount)
      .set({
        externalId: externalId || undefined,
        displayName: input.displayName || undefined,
        email: input.email || undefined,
        status: "AVAILABLE" as AdobeAccountStatus,
        lastRefreshAt: new Date(),
        lastRefreshError: null,
        updatedAt: new Date(),
      })
      .where(eq(adobeAccount.id, profile.accountId));
    // 最终 CAS：更新 refreshProfile 作为提交检查
    const committed = await tx
      .update(refreshProfileTable)
      .set({
        externalAccountId: externalId,
        nextRefreshAt: new Date(Date.now() + settings.refreshIntervalHours * 60 * 60 * 1000),
        lastError: null,
        lastSuccessAt: new Date(),
        consecutiveFailures: 0,
        lastHttpStatus: 200,
        enabled: true,
        status: "ACTIVE" as RefreshProfileStatus,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(refreshProfileTable.id, input.profileId),
          eq(refreshProfileTable.status, "ACTIVE" as RefreshProfileStatus),
          eq(refreshProfileTable.leaseOwner, input.workerId),
          gt(refreshProfileTable.leaseExpiresAt, new Date()),
        ),
      );
    if (affectedRows(committed) !== 1) throw refreshLeaseLost(input.profileId);
  });
}

type RefreshFailureInput = { profileId: string; workerId: string; message: string };

async function persistRefreshFailure(input: RefreshFailureInput): Promise<boolean> {
  const settings = await getSystemSettings();
  return db.transaction(async (tx) => {
    const profile = await lockRefreshProfile(tx, input.profileId, input.workerId).catch(() => null);
    if (!profile) return false;
    const message = input.message.slice(0, 500);
    const now = new Date();
    const committed = await tx
      .update(refreshProfileTable)
      .set({
        lastError: message,
        lastAttemptAt: now,
        consecutiveFailures: sql`${refreshProfileTable.consecutiveFailures} + 1`,
        nextRefreshAt: new Date(Date.now() + Math.min(settings.refreshIntervalHours * 60 * 60 * 1000, 60 * 60 * 1000)),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(refreshProfileTable.id, input.profileId),
          eq(refreshProfileTable.status, "ACTIVE" as RefreshProfileStatus),
          eq(refreshProfileTable.leaseOwner, input.workerId),
          gt(refreshProfileTable.leaseExpiresAt, now),
        ),
      );
    if (affectedRows(committed) !== 1) return false;
    await tx
      .update(adobeAccount)
      .set({
        lastRefreshError: message,
        updatedAt: new Date(),
      })
      .where(eq(adobeAccount.id, profile.accountId));
    return true;
  });
}

/**
 * Cookie 已失效（自动刷新返回 401/403）时删除该刷新资料（连同其中存储的 Cookie 密文），
 * 并解绑对应 Token 的自动刷新，避免后台持续用失效 Cookie 重试。
 * 注意：cookie 失效不代表 access token 已失效，因此**不**改动 token 自身的 status——
 * token 仍可用于生成/查积分；若其真正失效，由实际调用 Adobe 时的 401 自然处理。
 * 管理员需重新登录该 Adobe 账号后导入新 Cookie。
 */
export async function deleteRefreshProfileWithCookie(profileId: string, accountId: string, reason: string): Promise<void> {
  const message = reason.slice(0, 500);
  await db.transaction(async (tx) => {
    await tx
      .update(adobeToken)
      .set({
        refreshProfileId: null,
        autoRefreshEnabled: false,
        lastError: message,
        updatedAt: new Date(),
      })
      .where(eq(adobeToken.refreshProfileId, profileId));
    await tx
      .update(adobeAccount)
      .set({ lastRefreshError: message, updatedAt: new Date() })
      .where(eq(adobeAccount.id, accountId));
    await tx.delete(refreshProfileTable).where(eq(refreshProfileTable.id, profileId));
  });
}

export async function claimRefreshProfile(profileId: string, workerId: string) {
  const leaseExpiresAt = new Date(Date.now() + (await getSystemSettings()).jobLeaseMs);
  const now = new Date();
  const claimed = await db
    .update(refreshProfileTable)
    .set({
      leaseOwner: workerId,
      leaseExpiresAt,
      lastAttemptAt: now,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(refreshProfileTable.id, profileId),
        eq(refreshProfileTable.status, "ACTIVE" as RefreshProfileStatus),
        eq(refreshProfileTable.enabled, true),
        or(isNull(refreshProfileTable.leaseOwner), lt(refreshProfileTable.leaseExpiresAt, now)),
        or(isNull(refreshProfileTable.nextRefreshAt), lte(refreshProfileTable.nextRefreshAt, now)),
      ),
    );
  if (affectedRows(claimed) !== 1) return null;
  const [profile] = await db.select().from(refreshProfileTable).where(eq(refreshProfileTable.id, profileId)).limit(1);
  return profile ?? null;
}

/** 管理员手动刷新会把资料标记为立即到期，再复用同一套租约/CAS 流程。 */
export async function refreshProfileNow(profileId: string, workerId = `admin-${crypto.randomUUID()}`): Promise<boolean> {
  await db
    .update(refreshProfileTable)
    .set({
      status: "ACTIVE" as RefreshProfileStatus,
      enabled: true,
      nextRefreshAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(refreshProfileTable.id, profileId));
  return refreshProfile(profileId, workerId);
}

export async function setRefreshProfileEnabled(profileId: string, enabled: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    const [profile] = await tx
      .select({ id: refreshProfileTable.id })
      .from(refreshProfileTable)
      .where(eq(refreshProfileTable.id, profileId))
      .limit(1);
    if (!profile) throw new AppError("refresh_profile_not_found", "Refresh profile not found", 404);
    await tx
      .update(refreshProfileTable)
      .set({
        enabled,
        status: enabled ? ("ACTIVE" as RefreshProfileStatus) : ("DISABLED" as RefreshProfileStatus),
        nextRefreshAt: enabled ? new Date() : null,
        lastError: enabled ? null : "Disabled by administrator",
        updatedAt: new Date(),
      })
      .where(eq(refreshProfileTable.id, profileId));
    await tx
      .update(adobeToken)
      .set({
        autoRefreshEnabled: enabled,
        status: enabled ? ("ACTIVE" as AdobeTokenStatus) : ("DISABLED" as AdobeTokenStatus),
        updatedAt: new Date(),
      })
      .where(eq(adobeToken.refreshProfileId, profileId));
  });
}

export async function refreshProfile(profileId: string, workerId: string): Promise<boolean> {
  const profile = await claimRefreshProfile(profileId, workerId);
  if (!profile) return false;
  const settings = await getSystemSettings();
  const heartbeat = startRefreshLeaseHeartbeat(profile.id, workerId, settings.jobLeaseMs);
  try {
    await assertRefreshProfileLease(profile.id, workerId);
    const cookie = decryptSecret(profile.encryptedCookie);
    const body = new URLSearchParams({ client_id: "clio-playground-web", guest_allowed: "true", scope: REFRESH_SCOPE }).toString();
    const snapshot = await allocateProxySnapshot();
    const transport = new FetchAdobeTransport(settings.adobeBaseUrl);
    const entries = snapshot.mode === "proxy" ? snapshot.entries : [null];
    let lastError = "Adobe refresh failed";
    for (let index = 0; index < entries.length; index += 1) {
      const proxy = getSnapshotProxy(snapshot, index);
      try {
        if (heartbeat.lost) throw refreshLeaseLost(profile.id);
        await assertRefreshProfileLease(profile.id, workerId);
        const response = await transport.request<Record<string, unknown>>({ method: "POST", path: REFRESH_URL, body, proxy, headers: { ...browserSecurityHeaders(), Accept: "*/*", "Accept-Language": "en-US,en;q=0.9", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Cookie: cookie, Origin: "https://firefly.adobe.com", Referer: "https://firefly.adobe.com/" }, timeoutMs: settings.adobeTimeoutMs });
        if (response.status < 200 || response.status >= 300) {
          lastError = `Adobe refresh returned HTTP ${response.status}`;
          // Cookie 已失效（401/403）：删除该 Cookie 及其刷新资料，解绑自动刷新，
          // 避免反复用失效 Cookie 重试；管理员需重新登录导入新凭据。
          if (response.status === 401 || response.status === 403) {
            await deleteRefreshProfileWithCookie(profile.id, profile.accountId, `${lastError}：Cookie 已失效，已自动删除该 Cookie`);
            return false;
          }
          if (snapshot.mode !== "proxy" || !refreshStatusProxyEligible(response.status) || index === entries.length - 1) break;
          continue;
        }
        const accessToken = String(response.data.access_token ?? response.data.accessToken ?? "").trim();
        if (!accessToken) throw new Error("Adobe refresh response did not include an access token");
        const externalId = accountIdFromToken(accessToken) || profile.externalAccountId;
        const profileInfo = await fetchAdobeProfile(transport, accessToken, proxy, settings.adobeTimeoutMs);
        if (heartbeat.lost) throw refreshLeaseLost(profile.id);
        await persistRefreshSuccess({ profileId: profile.id, workerId, accessToken, expiresAt: Number.isFinite(Number(response.data.expires_in ?? response.data.expiresIn ?? 3600)) ? new Date(Date.now() + Math.max(60, Number(response.data.expires_in ?? response.data.expiresIn ?? 3600)) * 1000) : null, externalAccountId: externalId, displayName: profileInfo.displayName, email: profileInfo.email });
        return true;
      } catch (error) {
        if (error instanceof AppError && error.code === "refresh_lease_lost") throw error;
        lastError = error instanceof Error ? error.message : lastError;
        if (snapshot.mode !== "proxy" || !isRefreshProxyEligibleFailure(error) || index === entries.length - 1) break;
      }
    }
    await persistRefreshFailure({ profileId: profile.id, workerId, message: lastError }).catch(() => false);
    return false;
  } catch (error) {
    if (!(error instanceof AppError && error.code === "refresh_lease_lost")) {
      await persistRefreshFailure({ profileId: profile.id, workerId, message: error instanceof Error ? error.message : "Adobe refresh failed" }).catch(() => false);
    }
    return false;
  } finally {
    heartbeat.stop();
  }
}

type AdobeProfileInfo = { displayName?: string; email?: string; userId?: string };

async function fetchAdobeProfile(transport: FetchAdobeTransport, token: string, proxy: ReturnType<typeof getSnapshotProxy>, timeoutMs: number): Promise<AdobeProfileInfo> {
  const urls = ["https://ims-na1.adobelogin.com/ims/profile/v1", "https://adobeid-na1.services.adobe.com/ims/profile/v1"];
  for (const path of urls) {
    try {
      const response = await transport.request<Record<string, unknown>>({ method: "GET", path, token, proxy, timeoutMs, headers: { Accept: "application/json" } });
      if (response.status < 200 || response.status >= 300) continue;
      const data = response.data && typeof response.data === "object" ? response.data : {};
      const displayName = String(data.displayName ?? data.name ?? data.fullName ?? "").trim();
      const email = String(data.email ?? "").trim();
      const userId = String(data.userId ?? data.authId ?? "").trim();
      if (displayName || email || userId) return { displayName, email, userId };
    } catch {
      // 账号信息仅用于后台展示，失败不应使 Token 刷新失败。
    }
  }
  return {};
}

function creditNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type CreditBalance = { total: number | null; used: number | null; available: number | null; availableUntil: string | null; updatedAt: Date };

type CreditFailureInput = {
  tokenId: string;
  accountId: string;
  refreshProfileId: string | null;
  message: string;
  unauthorized: boolean;
};

function creditUpstreamStatus(error: unknown): number | null {
  if (!(error instanceof AppError)) return null;
  const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : {};
  return typeof details.upstreamStatus === "number" ? details.upstreamStatus : null;
}

async function persistCreditFailure(input: CreditFailureInput): Promise<void> {
  const message = input.message.slice(0, 500);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(adobeToken)
      .set({
        creditsError: message,
        creditsUpdatedAt: now,
        ...(input.unauthorized
          ? {
              status: "DISABLED" as AdobeTokenStatus,
              autoRefreshEnabled: false,
              failureCount: sql`${adobeToken.failureCount} + 1`,
              errorUntil: null,
              lastError: message,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(adobeToken.id, input.tokenId));
    if (!input.unauthorized) return;
    await tx
      .update(adobeAccount)
      .set({ status: "UNAVAILABLE" as AdobeAccountStatus, lastRefreshError: message, updatedAt: now })
      .where(eq(adobeAccount.id, input.accountId));
    if (input.refreshProfileId) {
      await tx
        .update(refreshProfileTable)
        .set({ status: "DISABLED" as RefreshProfileStatus, enabled: false, lastError: message, updatedAt: now })
        .where(eq(refreshProfileTable.id, input.refreshProfileId));
    }
  });
  // 401 只停用 Token/账号/刷新资料，保留密文记录供管理员重新导入后恢复；
  // 不因一次上游认证失败自动删除账号数据。
}

/**
 * 轻量查询账号当前已用积分（不写库，失败返回 null）。
 * 用于任务完成后记录单次积分消耗：本次消耗 = 当前已用 - 任务执行前已知已用。
 */
export async function queryCreditsUsed(input: { token: string; accountId: string; timeoutMs?: number; proxy?: ProxySnapshotEntry | null }): Promise<number | null> {
  try {
    const settings = await getSystemSettings();
    const transport = new FetchAdobeTransport(settings.adobeBaseUrl);
    const response = await transport.request<Record<string, unknown>>({ method: "GET", path: "https://firefly.adobe.io/v1/credits/balance", token: input.token, proxy: input.proxy ?? null, timeoutMs: input.timeoutMs ?? settings.adobeTimeoutMs, headers: { "x-api-key": config.adobeApiKey(), "x-account-id": input.accountId, Origin: "https://firefly.adobe.com", Referer: "https://firefly.adobe.com/", Accept: "application/json", "Content-Type": "application/json" } });
    if (response.status < 200 || response.status >= 300) return null;
    const total = response.data?.total && typeof response.data.total === "object" ? response.data.total as Record<string, unknown> : {};
    const quota = total.quota && typeof total.quota === "object" ? total.quota as Record<string, unknown> : {};
    return creditNumber(quota.used);
  } catch {
    return null;
  }
}

type CreditBalanceWithProxy = CreditBalance & { proxyId: string | null; proxyHost: string | null };

function proxyHostLabel(proxy: ProxySnapshotEntry | null): string | null {
  return proxy ? `${proxy.protocol} ${proxy.host}:${proxy.port}` : null;
}

/** 查询单个账号积分余额（含代理快照与故障转移），失败抛出带 upstreamStatus 的 AppError。 */
async function fetchCreditBalance(accessToken: string, accountId: string, settings: Awaited<ReturnType<typeof getSystemSettings>>, snapshot?: ProxySnapshot): Promise<CreditBalanceWithProxy> {
  // 批量刷新时共享同一份代理快照（调用方传入），避免每个账号各自 allocateProxySnapshot
  // 抢 proxyrotationstate 行锁导致并发被串行化；单账号场景仍自行取快照。
  const usedSnapshot = snapshot ?? await allocateProxySnapshot();
  const transport = new FetchAdobeTransport(settings.adobeBaseUrl);
  const entries = usedSnapshot.mode === "proxy" ? usedSnapshot.entries : [null];
  let lastError: unknown;
  for (let index = 0; index < entries.length; index += 1) {
    const proxy = getSnapshotProxy(usedSnapshot, index);
    try {
      const response = await transport.request<Record<string, unknown>>({ method: "GET", path: "https://firefly.adobe.io/v1/credits/balance", token: accessToken, proxy, timeoutMs: settings.adobeTimeoutMs, headers: { "x-api-key": config.adobeApiKey(), "x-account-id": accountId, Origin: "https://firefly.adobe.com", Referer: "https://firefly.adobe.com/", Accept: "application/json", "Content-Type": "application/json" } });
      if (response.status < 200 || response.status >= 300) {
        lastError = new AppError("credits_request_failed", `Credits request returned ${response.status}`, response.status === 401 ? 401 : response.status >= 500 ? 503 : 400, { proxyEligible: refreshStatusProxyEligible(response.status), upstreamStatus: response.status, proxyId: proxy?.id ?? null, proxyHost: proxyHostLabel(proxy), stage: "credits_balance" });
        if (usedSnapshot.mode !== "proxy" || !refreshStatusProxyEligible(response.status) || index === entries.length - 1) break;
        continue;
      }
      const total = response.data?.total && typeof response.data.total === "object" ? response.data.total as Record<string, unknown> : {};
      const quota = total.quota && typeof total.quota === "object" ? total.quota as Record<string, unknown> : {};
      return { total: creditNumber(quota.total), used: creditNumber(quota.used), available: creditNumber(quota.available), availableUntil: typeof total.availableUntil === "string" ? total.availableUntil : null, updatedAt: new Date(), proxyId: proxy?.id ?? null, proxyHost: proxyHostLabel(proxy) };
    } catch (error) {
      lastError = error;
      if (usedSnapshot.mode !== "proxy" || !isRefreshProxyEligibleFailure(error) || index === entries.length - 1) break;
    }
  }
  throw lastError instanceof AppError ? lastError : new AppError("credits_request_failed", "Credits request failed", 503);
}

/** 以固定并发上限并行执行任务，保持输入顺序输出；单个失败不阻塞其他任务。 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: safeLimit }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function persistCreditBalance(tokenId: string, balance: CreditBalance): Promise<void> {
  await db
    .update(adobeToken)
    .set({
      creditsTotal: balance.total,
      creditsUsed: balance.used,
      creditsAvailable: balance.available,
      creditsAvailableUntil: balance.availableUntil,
      creditsUpdatedAt: balance.updatedAt,
      creditsError: null,
      updatedAt: new Date(),
    })
    .where(eq(adobeToken.id, tokenId));
}

/**
 * 读取老后台的 Firefly credits/balance 数据，并只持久化额度元数据。
 * 401（token 失效）且该 token 绑定了自动刷新 Cookie 时：先尝试用 Cookie 刷新 Token，
 * 刷新成功则用新 Token 重查积分；只有刷新 Token 失败（或没有 Cookie）才标记账号不生效。
 */
export async function refreshTokenCredits(tokenId: string, options: { snapshot?: ProxySnapshot } = {}): Promise<CreditBalanceWithProxy> {
  const rows = await db
    .select({
      token: adobeToken,
      account: adobeAccount,
    })
    .from(adobeToken)
    .innerJoin(adobeAccount, eq(adobeToken.accountId, adobeAccount.id))
    .where(eq(adobeToken.id, tokenId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AppError("token_not_found", "Token not found", 404);
  const tokenRow = row.token;
  const accountRow = row.account;
  let accessToken: string;
  try {
    accessToken = decryptSecret(tokenRow.encryptedAccessToken);
  } catch {
    await persistCreditFailure({ tokenId: tokenRow.id, accountId: accountRow.id, refreshProfileId: tokenRow.refreshProfileId, message: "Token secret is unavailable", unauthorized: false }).catch(() => undefined);
    throw new AppError("token_secret_unavailable", "Token secret is unavailable", 409);
  }
  const accountId = accountRow.externalId || accountIdFromToken(accessToken);
  if (!accountId) {
    await persistCreditFailure({ tokenId: tokenRow.id, accountId: accountRow.id, refreshProfileId: tokenRow.refreshProfileId, message: "Token account id is unavailable", unauthorized: false }).catch(() => undefined);
    throw new AppError("token_account_id_missing", "Token account id is unavailable", 400);
  }
  const settings = await getSystemSettings();
  try {
    const result = await fetchCreditBalance(accessToken, accountId, settings, options.snapshot);
    await persistCreditBalance(tokenRow.id, result);
    // 剩余积分低于阈值 → 自动删除账号（释放无效账号资源）
    if (settings.minCreditsThreshold > 0 && (result.available ?? Infinity) < settings.minCreditsThreshold) {
      await deleteAdobeAccount(accountRow.id).catch((error) => console.error(`[credits] 低积分删除账号失败 account=${accountRow.id} credits=${result.available}`, error instanceof Error ? error.message : error));
    }
    return result;
  } catch (error) {
    let finalError = error;
    // 401 且绑定了自动刷新 Cookie：先尝试用 Cookie 刷新 Token（复用租约/CAS 流程），
    // 成功则用新 Token 重查积分；仅当刷新失败或没有 Cookie 时才走持久化失效。
    if (creditUpstreamStatus(finalError) === 401 && tokenRow.refreshProfileId) {
      const refreshed = await refreshProfileNow(tokenRow.refreshProfileId);
      if (refreshed) {
        const [latest] = await db.select({ token: adobeToken }).from(adobeToken).where(eq(adobeToken.id, tokenRow.id)).limit(1);
        if (latest?.token.encryptedAccessToken) {
          try {
            const newAccessToken = decryptSecret(latest.token.encryptedAccessToken);
            const refreshedBalance = await fetchCreditBalance(newAccessToken, accountId, settings, options.snapshot);
            await persistCreditBalance(tokenRow.id, refreshedBalance);
            return refreshedBalance;
          } catch (secondError) {
            finalError = secondError; // 以刷新后的新结果决定最终状态
          }
        }
      }
    }
    const safeMessage = finalError instanceof AppError ? finalError.message : "Credits request failed";
    await persistCreditFailure({ tokenId: tokenRow.id, accountId: accountRow.id, refreshProfileId: tokenRow.refreshProfileId, message: safeMessage, unauthorized: creditUpstreamStatus(finalError) === 401 }).catch(() => undefined);
    throw finalError instanceof AppError ? finalError : new AppError("credits_request_failed", "Credits request failed", 503);
  }
}

/** 把积分刷新失败的具体原因映射为管理员可理解的中文提示（含上游状态码与所用代理）。 */
export function creditFailureMessage(error: AppError): string {
  if (error.status === 401) return "积分刷新失败：token 已失效（401），请重新登录该 Adobe 账号";
  if (error.code === "token_secret_unavailable") return "积分刷新失败：Token 加密数据不可用，请重新导入该账号";
  if (error.code === "token_account_id_missing") return "积分刷新失败：无法确定账号 ID，请重新导入该账号";
  const details = error.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details as Record<string, unknown> : {};
  const upstreamStatus = typeof details.upstreamStatus === "number" ? details.upstreamStatus : null;
  const proxyHost = typeof details.proxyHost === "string" ? details.proxyHost : null;
  const proxySuffix = proxyHost ? `（代理 ${proxyHost}）` : "";
  if (upstreamStatus !== null) return `积分刷新失败：Adobe 返回 HTTP ${upstreamStatus}${proxySuffix}`;
  if (error.status === 503) return `积分刷新失败：Adobe 上游服务暂时不可用${proxySuffix}`;
  return `积分刷新失败（${error.code}）`;
}

export type BatchCreditsResult = {
  id: string;
  status: "ok" | "failed" | "unauthorized";
  message: string | null;
  credits: { total: number | null; used: number | null; available: number | null; availableUntil: string | null } | null;
  proxy: { id: string; host: string } | null;
  elapsedMs: number;
};

/** 单个事务内批量更新多个 token 的积分字段（每 batchSize 个一批，减少远端 DB 往返）。 */
async function persistCreditBalanceBatch(items: Array<{ tokenId: string; balance: CreditBalance }>): Promise<void> {
  if (!items.length) return;
  await db.transaction(async (tx) => {
    for (const item of items) {
      await tx
        .update(adobeToken)
        .set({
          creditsTotal: item.balance.total,
          creditsUsed: item.balance.used,
          creditsAvailable: item.balance.available,
          creditsAvailableUntil: item.balance.availableUntil,
          creditsUpdatedAt: item.balance.updatedAt,
          creditsError: null,
          updatedAt: new Date(),
        })
        .where(eq(adobeToken.id, item.tokenId));
    }
  });
}

/**
 * 批量刷新积分（内存优先）：
 * 1. 预加载：一次查询把所有账号数据读进内存，不再每个账号各自读库；
 * 2. 并发池只做内存解密 + HTTP 查积分，全程不写库，DB 连接占用极低；
 * 3. 结果攒在内存里，每 batchSize（默认 10）个用一个事务批量写回。
 * 401 且绑定了 Cookie 的少数账号走 refreshProfileNow（完整租约/CAS 流程）单独处理。
 * onStart / onResult 回调用于 SSE 实时推送每个账号的开始与完成。
 */
export async function refreshTokenCreditsBatch(
  tokenIds: string[],
  options: { snapshot?: ProxySnapshot; concurrency?: number; batchSize?: number; onStart?: (id: string) => void; onResult?: (result: BatchCreditsResult) => void } = {},
): Promise<BatchCreditsResult[]> {
  const settings = await getSystemSettings();
  const snapshot = options.snapshot ?? await allocateProxySnapshot();
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const batchSize = Math.max(1, options.batchSize ?? 10);

  // 1. 预加载：一次查询把所有账号数据读进内存。
  const rows = tokenIds.length
    ? await db
        .select({ token: adobeToken, account: adobeAccount })
        .from(adobeToken)
        .innerJoin(adobeAccount, eq(adobeToken.accountId, adobeAccount.id))
        .where(inArray(adobeToken.id, tokenIds))
    : [];
  const accountByTokenId = new Map(rows.map((row) => [row.token.id, row]));

  // 2. 并发处理（内存 + HTTP，不写库）；结果攒到内存，最后批量写回。
  const results = await mapWithConcurrency(tokenIds, concurrency, async (id) => {
    const started = Date.now();
    options.onStart?.(id);
    const row = accountByTokenId.get(id);
    if (!row) return { id, status: "failed" as const, message: "Token not found", credits: null, proxy: null, elapsedMs: Date.now() - started };
    const tokenRow = row.token;
    const accountRow = row.account;
    let accessToken: string;
    try {
      accessToken = decryptSecret(tokenRow.encryptedAccessToken);
    } catch {
      return { id, status: "failed" as const, message: "Token secret is unavailable", credits: null, proxy: null, elapsedMs: Date.now() - started };
    }
    const accountId = accountRow.externalId || accountIdFromToken(accessToken);
    if (!accountId) return { id, status: "failed" as const, message: "Token account id is unavailable", credits: null, proxy: null, elapsedMs: Date.now() - started };

    const settle = (result: BatchCreditsResult): BatchCreditsResult => {
      options.onResult?.(result);
      return result;
    };
    try {
      const fetched = await fetchCreditBalance(accessToken, accountId, settings, snapshot);
      return settle({
        id,
        status: "ok",
        message: null,
        credits: { total: fetched.total, used: fetched.used, available: fetched.available, availableUntil: fetched.availableUntil },
        proxy: fetched.proxyId && fetched.proxyHost ? { id: fetched.proxyId, host: fetched.proxyHost } : null,
        elapsedMs: Date.now() - started,
      });
    } catch (error) {
      let finalError = error;
      // 401 且有 Cookie：刷新 Token（少数账号，走 DB）；成功则用新 Token 重查积分。
      if (creditUpstreamStatus(finalError) === 401 && tokenRow.refreshProfileId) {
        const refreshed = await refreshProfileNow(tokenRow.refreshProfileId);
        if (refreshed) {
          const [latest] = await db.select({ token: adobeToken }).from(adobeToken).where(eq(adobeToken.id, tokenRow.id)).limit(1);
          if (latest?.token.encryptedAccessToken) {
            try {
              const newAccessToken = decryptSecret(latest.token.encryptedAccessToken);
              const refreshedBalance = await fetchCreditBalance(newAccessToken, accountId, settings, snapshot);
              return settle({
                id,
                status: "ok",
                message: null,
                credits: { total: refreshedBalance.total, used: refreshedBalance.used, available: refreshedBalance.available, availableUntil: refreshedBalance.availableUntil },
                proxy: refreshedBalance.proxyId && refreshedBalance.proxyHost ? { id: refreshedBalance.proxyId, host: refreshedBalance.proxyHost } : null,
                elapsedMs: Date.now() - started,
              });
            } catch (secondError) {
              finalError = secondError;
            }
          }
        }
      }
      const appError = finalError instanceof AppError ? finalError : new AppError("credits_request_failed", "Credits request failed", 503);
      const details = appError.details && typeof appError.details === "object" && !Array.isArray(appError.details) ? appError.details as Record<string, unknown> : {};
      const proxyHost = typeof details.proxyHost === "string" ? details.proxyHost : null;
      const unauthorized = appError.status === 401;
      return settle({
        id,
        status: unauthorized ? "unauthorized" : "failed",
        message: creditFailureMessage(appError),
        credits: null,
        proxy: proxyHost ? { id: String(details.proxyId ?? ""), host: proxyHost } : null,
        elapsedMs: Date.now() - started,
      });
    }
  });

  // 3. 写库：ok 结果每 batchSize 个一个事务批量更新；失败结果逐个持久化。
  //    401（unauthorized）只标记 Token/账号/刷新资料失效，不自动删除数据。
  const okItems: Array<{ tokenId: string; balance: CreditBalance }> = [];
  for (const result of results) {
    const row = accountByTokenId.get(result.id);
    if (!row) continue;
    if (result.status === "ok" && result.credits) {
      okItems.push({
        tokenId: result.id,
        balance: {
          total: result.credits.total,
          used: result.credits.used,
          available: result.credits.available,
          availableUntil: result.credits.availableUntil,
          updatedAt: new Date(),
        },
      });
      // 剩余积分低于阈值 → 自动删除账号（释放无效账号资源）
      if (settings.minCreditsThreshold > 0 && (result.credits!.available ?? Infinity) < settings.minCreditsThreshold) {
        await deleteAdobeAccount(row.account.id).catch((error) => console.error(`[credits-batch] 低积分删除账号失败 account=${row.account.id} credits=${result.credits!.available}`, error instanceof Error ? error.message : error));
      }
      continue;
    }
    if (result.status === "unauthorized") {
      // 401：标记 token DISABLED / 账号 UNAVAILABLE / 资料 DISABLED，但保留记录。
      await persistCreditFailure({
        tokenId: row.token.id,
        accountId: row.account.id,
        refreshProfileId: row.token.refreshProfileId,
        message: result.message ?? "Credits request returned 401",
        unauthorized: true,
      }).catch((error) => console.error(`[credits-batch] 标记 401 失败 token=${row.token.id}`, error instanceof Error ? error.message : error));
    } else {
      // 非 401 失败：只记录 creditsError，不动账号状态
      await persistCreditFailure({
        tokenId: row.token.id,
        accountId: row.account.id,
        refreshProfileId: row.token.refreshProfileId,
        message: result.message ?? "Credits request failed",
        unauthorized: false,
      }).catch((error) => console.error(`[credits-batch] 记录失败信息失败 token=${row.token.id}`, error instanceof Error ? error.message : error));
    }
  }
  for (let offset = 0; offset < okItems.length; offset += batchSize) {
    await persistCreditBalanceBatch(okItems.slice(offset, offset + batchSize));
  }

  return results;
}

export async function refreshDueProfiles(workerId: string, limit = 1): Promise<number> {
  const now = new Date();
  const profiles = await db
    .select({ id: refreshProfileTable.id })
    .from(refreshProfileTable)
    .where(and(eq(refreshProfileTable.status, "ACTIVE" as RefreshProfileStatus), or(isNull(refreshProfileTable.nextRefreshAt), lte(refreshProfileTable.nextRefreshAt, now))))
    .orderBy(asc(refreshProfileTable.nextRefreshAt), asc(refreshProfileTable.createdAt))
    .limit(limit);
  let refreshed = 0;
  for (const profile of profiles) if (await refreshProfile(profile.id, workerId)) refreshed += 1;
  return refreshed;
}

