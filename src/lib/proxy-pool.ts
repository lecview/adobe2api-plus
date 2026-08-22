import { fetch as undiciFetch, ProxyAgent } from "undici";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";
import { db } from "@/lib/db";
import { proxyNode, proxyRotationState, systemSetting, type ProxyProtocol } from "@/lib/db/schema";
import { asc, eq, sql } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { config } from "@/lib/config";

export type ProxySnapshotEntry = {
  id: string;
  version: number;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  encryptedUsername?: string | null;
  encryptedPassword?: string | null;
};

export type ProxySnapshot = { mode: "direct" | "proxy"; entries: ProxySnapshotEntry[]; selectedIndex: number };

// 部分代理服务商（如 hideip）导出的代理串是 host:port:user:pass 顺序，
// 不是标准 user:password@host:port，无法被 URL 直接解析。
// 解析前先归一化成标准顺序。host/user/pass 各自排除 / : @ ? #，
// 避免重组后与 URL 语法产生歧义；pass 是末位字段，允许含冒号。
const COLON_ORDER_PROXY = /^([^/@:?#[\]]+):(\d{1,5}):([^/@:?#]+):([^/@?#]+)$/;

function normalizeProxyRaw(raw: string): string {
  const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  const scheme = schemeMatch?.[1] ?? "";
  const rest = schemeMatch?.[2] ?? raw;
  const match = COLON_ORDER_PROXY.exec(rest);
  if (!match) return raw;
  const [, host, port, username, password] = match;
  return `${scheme ? `${scheme}://` : ""}${username}:${password}@${host}:${port}`;
}

export function parseProxyUrl(value: string): { protocol: ProxyProtocol; host: string; port: number; username?: string; password?: string } {
  const raw = normalizeProxyRaw(value.trim());
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    throw new AppError("invalid_proxy", "Proxy URL is invalid", 400);
  }
  const protocol: ProxyProtocol | null = url.protocol.toLowerCase() === "socks5:" || url.protocol.toLowerCase() === "socks5h:" ? "SOCKS5" : url.protocol.toLowerCase() === "http:" || url.protocol.toLowerCase() === "https:" ? "HTTP" : null;
  if (!protocol || !url.hostname || (url.pathname && url.pathname !== "/") || url.search || url.hash) throw new AppError("invalid_proxy", "Unsupported proxy protocol, host, or URL path", 400);
  const port = Number(url.port || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError("invalid_proxy", "Proxy port must be between 1 and 65535", 400);
  try {
    return { protocol, host: url.hostname, port, username: url.username ? decodeURIComponent(url.username) : undefined, password: url.password ? decodeURIComponent(url.password) : undefined };
  } catch {
    throw new AppError("invalid_proxy", "Proxy credentials contain invalid URL encoding", 400);
  }
}

export async function getProxySettings() {
  const [setting, nodes] = await Promise.all([
    db.select().from(systemSetting).where(eq(systemSetting.id, "singleton")).limit(1),
    db.select().from(proxyNode).orderBy(asc(proxyNode.displayOrder), asc(proxyNode.version)),
  ]);
  return { enabled: setting[0]?.proxyEnabled ?? false, nodes };
}

export async function allocateProxySnapshot(): Promise<ProxySnapshot> {
  return db.transaction(async (tx) => {
    // MySQL 无独立 upsert，用 INSERT ... ON DUPLICATE KEY UPDATE 保证 singleton 存在。
    await tx.insert(systemSetting).values({ id: "singleton", mediaRoot: config.mediaRoot() }).onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
    const [setting] = await tx.select().from(systemSetting).where(eq(systemSetting.id, "singleton")).limit(1);
    if (!setting?.proxyEnabled) return { mode: "direct", entries: [], selectedIndex: -1 };
    const nodes = await tx.select().from(proxyNode).where(eq(proxyNode.enabled, true)).orderBy(asc(proxyNode.displayOrder), asc(proxyNode.version));
    if (!nodes.length) throw new AppError("proxy_pool_empty", "Proxy pool is enabled but has no active nodes", 503);
    await tx.insert(proxyRotationState).values({ id: "singleton", nextOrder: nodes[0].displayOrder }).onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
    // 这里必须使用锁定读直接取得游标值。MariaDB/MySQL 默认的
    // REPEATABLE READ 下，锁定读之后再用普通查询可能读到旧快照，
    // 导致并发 Worker 重复拿到同一个首选代理。
    const [lockedRow] = await tx.select({ nextOrder: proxyRotationState.nextOrder }).from(proxyRotationState).where(eq(proxyRotationState.id, "singleton")).for("update");
    const nextOrder = Number(lockedRow?.nextOrder ?? nodes[0].displayOrder);
    let start = nodes.findIndex((node) => node.displayOrder >= nextOrder);
    if (start < 0) start = 0;
    const ordered = [...nodes.slice(start), ...nodes.slice(0, start)];
    const next = nodes[(nodes.findIndex((node) => node.id === ordered[0].id) + 1) % nodes.length];
    await tx.update(proxyRotationState).set({ nextOrder: next.displayOrder, version: sql`${proxyRotationState.version} + 1`, updatedAt: new Date() }).where(eq(proxyRotationState.id, "singleton"));
    return { mode: "proxy", entries: ordered.map(toSnapshotEntry), selectedIndex: 0 };
  });
}

function toSnapshotEntry(node: { id: string; version: number; protocol: ProxyProtocol; host: string; port: number; encryptedUsername: string | null; encryptedPassword: string | null }): ProxySnapshotEntry {
  return { id: node.id, version: node.version, protocol: node.protocol, host: node.host, port: node.port, encryptedUsername: node.encryptedUsername, encryptedPassword: node.encryptedPassword };
}

export function getSnapshotProxy(snapshot: ProxySnapshot, index: number): ProxySnapshotEntry | null {
  return snapshot.mode === "proxy" ? snapshot.entries[index] ?? null : null;
}

export function proxyCredentials(entry: ProxySnapshotEntry): { username?: string; password?: string } {
  return { username: entry.encryptedUsername ? decryptSecret(entry.encryptedUsername) : undefined, password: entry.encryptedPassword ? decryptSecret(entry.encryptedPassword) : undefined };
}

// 管理员后台需要完整回显凭据（复制代理 URL、编辑回显）。这是内部管理系统，
// 由 requireAdminRequest 保护；解密失败（密文损坏）时按无凭据处理，不阻塞列表。
export function serializeProxy(node: { id: string; protocol: ProxyProtocol; host: string; port: number; enabled: boolean; displayOrder: number; version: number; createdAt: Date | string; updatedAt: Date | string; encryptedUsername: string | null; encryptedPassword: string | null }) {
  return {
    id: node.id,
    protocol: node.protocol,
    host: node.host,
    port: node.port,
    enabled: node.enabled,
    displayOrder: node.displayOrder,
    version: node.version,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    username: node.encryptedUsername ? (() => { try { return decryptSecret(node.encryptedUsername); } catch { return null; } })() : null,
    password: node.encryptedPassword ? (() => { try { return decryptSecret(node.encryptedPassword); } catch { return null; } })() : null,
  };
}

export function proxyCreateData(input: { raw: string; displayOrder: number; enabled?: boolean }): typeof proxyNode.$inferInsert {
  const parsed = parseProxyUrl(input.raw);
  return { protocol: parsed.protocol, host: parsed.host, port: parsed.port, encryptedUsername: parsed.username ? encryptSecret(parsed.username) : null, encryptedPassword: parsed.password ? encryptSecret(parsed.password) : null, enabled: input.enabled ?? true, displayOrder: input.displayOrder };
}

export function isProxyEligibleFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /proxy|connect|socket|timeout|gateway/i.test(message);
}

export type ProxyTestResult = { ok: boolean; status: number; latencyMs: number; error?: string };

// 管理员后台测试单个代理的连通性：经代理请求稳定目标，返回状态码与往返延迟。
// HTTP/HTTPS 代理走 undici ProxyAgent（与 FetchAdobeTransport 共用同一套规则），
// SOCKS5 走 axios + socks-proxy-agent（undici 不支持 SOCKS5）。
const undiciProxyAgents = new Map<string, ProxyAgent>();
function getUndiciProxyAgent(url: string): ProxyAgent {
  const cached = undiciProxyAgents.get(url);
  if (cached) return cached;
  const agent = new ProxyAgent(url);
  undiciProxyAgents.set(url, agent);
  return agent;
}

function buildProxyUrlValue(entry: ProxySnapshotEntry): string {
  const credentials = proxyCredentials(entry);
  const encodedUser = credentials.username ? encodeURIComponent(credentials.username) : "";
  const encodedPass = credentials.password ? encodeURIComponent(credentials.password) : "";
  const auth = encodedUser ? `${encodedUser}${encodedPass ? `:${encodedPass}` : ""}@` : "";
  // socks5h：远端 DNS 解析，避免本地解析后按 IP 连接被代理拒绝（HostUnreachable）。
  return `${entry.protocol === "SOCKS5" ? "socks5h" : "http"}://${auth}${entry.host}:${entry.port}`;
}

export async function testProxy(entry: ProxySnapshotEntry, targetUrl = "https://www.google.com/generate_204"): Promise<ProxyTestResult> {
  const start = Date.now();
  const proxyUrlValue = buildProxyUrlValue(entry);
  if (entry.protocol === "SOCKS5") {
    const agent = new SocksProxyAgent(proxyUrlValue);
    try {
      const response = await axios.get(targetUrl, {
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        timeout: 10_000,
        validateStatus: () => true,
        maxRedirects: 0,
      });
      const latencyMs = Date.now() - start;
      const ok = response.status >= 200 && response.status < 400;
      return { ok, status: response.status, latencyMs };
    } catch (error) {
      return { ok: false, status: 0, latencyMs: Date.now() - start, error: error instanceof Error ? error.message : "连接失败" };
    }
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await undiciFetch(targetUrl, { dispatcher: getUndiciProxyAgent(proxyUrlValue), signal: controller.signal, redirect: "manual" });
      const latencyMs = Date.now() - start;
      const ok = response.status >= 200 && response.status < 400;
      return { ok, status: response.status, latencyMs };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { ok: false, status: 0, latencyMs: Date.now() - start, error: error instanceof Error ? error.message : "连接失败" };
  }
}
