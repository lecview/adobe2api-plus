import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { adminSession, adminUser, loginThrottle } from "@/lib/db/schema";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import { config } from "@/lib/config";
import { createOpaqueToken, hashSecret, hashToken, verifySecret } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { issueSessionToken, verifySessionToken } from "@/lib/session-token";
import { AUTH_COOKIE_NAME } from "@/lib/auth-constants";

const SESSION_TTL_SECONDS = 60 * 60 * 8;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 10;
// 远程 MySQL 单次查询延迟高（实测 ~460ms）。lastSeenAt 只是"最后活跃"展示数据，
// 用内存节流合并写库：同会话 5 分钟内最多落库一次，避免每个管理请求都多一次写。
const lastSeenWriteTimes = new Map<string, number>();
const LAST_SEEN_WRITE_INTERVAL_MS = 300_000;

export async function createSessionToken(userId: string, username: string): Promise<string> {
  const sessionId = createOpaqueToken(18);
  const token = await issueSessionToken(sessionId, userId, username, SESSION_TTL_SECONDS);

  await db.insert(adminSession).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
  });
  return token;
}

/** 查询当前会话对应的管理员（独立函数便于失败重试）。 */
async function queryCurrentSession(token: string) {
  const rows = await db
    .select({
      id: adminSession.id,
      tokenHash: adminSession.tokenHash,
      userId: adminSession.userId,
      expiresAt: adminSession.expiresAt,
      revokedAt: adminSession.revokedAt,
      createdAt: adminSession.createdAt,
      lastSeenAt: adminSession.lastSeenAt,
      user: {
        id: adminUser.id,
        username: adminUser.username,
        status: adminUser.status,
        lastLoginAt: adminUser.lastLoginAt,
      },
    })
    .from(adminSession)
    .innerJoin(adminUser, eq(adminSession.userId, adminUser.id))
    .where(and(eq(adminSession.tokenHash, hashToken(token)), isNull(adminSession.revokedAt), gt(adminSession.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function getCurrentAdmin() {
  const token = (await cookies()).get(AUTH_COOKIE_NAME)?.value;
  const payload = await verifySessionToken(token);
  if (!payload || !token) return null;

  // 远端 MySQL 可能瞬时断连（"Failed query: ..."）：重试一次再降级，
  // 避免后台整个页面抛 Runtime Error 崩溃。重试仍失败按未登录处理（跳登录页）。
  let session: Awaited<ReturnType<typeof queryCurrentSession>> | null = null;
  try {
    session = await queryCurrentSession(token);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      session = await queryCurrentSession(token);
    } catch {
      return null;
    }
  }
  if (!session || session.user.status !== "ACTIVE") return null;

  // lastSeenAt 只是会话元数据，不应阻塞后台列表等高频读请求；更新失败也不能
  // 让一个仍然有效的会话变成 500。远程 MySQL 单次查询延迟高（实测 ~460ms），
  // 用内存节流把同会话的写库合并为每 5 分钟最多一次，降低连接池与服务器负载。
  const now = Date.now();
  const lastWrite = lastSeenWriteTimes.get(session.id) ?? 0;
  if (now - lastWrite >= LAST_SEEN_WRITE_INTERVAL_MS) {
    lastSeenWriteTimes.set(session.id, now);
    void db.update(adminSession).set({ lastSeenAt: new Date() }).where(eq(adminSession.id, session.id)).catch(() => undefined);
  }
  return session.user;
}

export async function requireAdmin() {
  const user = await getCurrentAdmin();
  if (!user) throw new AppError("unauthorized", "Unauthorized", 401);
  return user;
}

export async function revokeCurrentSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(AUTH_COOKIE_NAME)?.value;
  if (token) {
    await db.update(adminSession).set({ revokedAt: new Date() }).where(and(eq(adminSession.tokenHash, hashToken(token)), isNull(adminSession.revokedAt)));
  }
  store.delete(AUTH_COOKIE_NAME);
}

export async function bootstrapAdminIfNeeded(): Promise<void> {
  const [{ value }] = await db.select({ value: count() }).from(adminUser);
  if (Number(value) > 0) return;
  const username = config.optional("ADMIN_BOOTSTRAP_USERNAME");
  const password = config.optional("ADMIN_BOOTSTRAP_PASSWORD");
  if (!username || !password) throw new AppError("admin_not_initialized", "Admin account is not initialized", 503);
  await db.insert(adminUser).values({ username, passwordHash: await hashSecret(password) });
}

export async function authenticateAdmin(username: string, password: string) {
  await bootstrapAdminIfNeeded();
  const [user] = await db.select().from(adminUser).where(eq(adminUser.username, username)).limit(1);
  const valid = user ? await verifySecret(password, user.passwordHash) : false;
  if (!user || !valid || user.status !== "ACTIVE") throw new AppError("invalid_credentials", "Invalid username or password", 401);
  await db.update(adminUser).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(adminUser.id, user.id));
  return user;
}

function throttleKey(key: string): string {
  return hashToken(key);
}

export async function assertLoginRateLimit(key: string): Promise<void> {
  const keyHash = throttleKey(key);
  const now = new Date();
  const blocked = await db.transaction(async (tx) => {
    const [row] = await tx.select({ windowStartedAt: loginThrottle.windowStartedAt, attempts: loginThrottle.attempts, blockedUntil: loginThrottle.blockedUntil }).from(loginThrottle).where(eq(loginThrottle.keyHash, keyHash)).for("update");
    if (!row) return false;
    if (row.blockedUntil && row.blockedUntil > now) return true;
    if (now.getTime() - row.windowStartedAt.getTime() >= LOGIN_WINDOW_MS) {
      await tx.delete(loginThrottle).where(eq(loginThrottle.keyHash, keyHash));
    }
    return false;
  });
  if (blocked) throw new AppError("rate_limited", "Too many login attempts", 429);
}

export async function recordLoginFailure(key: string): Promise<boolean> {
  const keyHash = throttleKey(key);
  const now = new Date();
  const blocked = await db.transaction(async (tx) => {
    await tx.insert(loginThrottle).values({ keyHash, windowStartedAt: now, attempts: 0 }).onDuplicateKeyUpdate({ set: { updatedAt: now } });
    const [row] = await tx.select({ windowStartedAt: loginThrottle.windowStartedAt, attempts: loginThrottle.attempts, blockedUntil: loginThrottle.blockedUntil }).from(loginThrottle).where(eq(loginThrottle.keyHash, keyHash)).for("update");
    if (!row || now.getTime() - row.windowStartedAt.getTime() >= LOGIN_WINDOW_MS) {
      await tx.update(loginThrottle).set({ windowStartedAt: now, attempts: 1, blockedUntil: null, updatedAt: now }).where(eq(loginThrottle.keyHash, keyHash));
      return false;
    }
    if (row.blockedUntil && row.blockedUntil > now) return true;
    const attempts = row.attempts + 1;
    const shouldBlock = attempts > LOGIN_MAX_FAILURES;
    await tx.update(loginThrottle).set({ attempts, blockedUntil: shouldBlock ? new Date(now.getTime() + LOGIN_WINDOW_MS) : null, updatedAt: now }).where(eq(loginThrottle.keyHash, keyHash));
    return shouldBlock;
  });
  return blocked;
}

export async function clearLoginFailures(key: string): Promise<void> {
  await db.delete(loginThrottle).where(eq(loginThrottle.keyHash, throttleKey(key)));
}

export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/admin";
  return value;
}
