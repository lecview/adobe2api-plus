/**
 * sherlockToken（x-arp-session-id）全局单例服务。
 *
 * 关键事实（2026-08-18 实测定论）：sherlockToken 是**浏览器会话级**产物，
 * 内部只有 sid/ark/bfp/ftr 浏览器环境信息，**不含 Adobe 账号标识**，与账号无关。
 * 因此全局存一份、所有账号共用；提交 3p 时从全局读取，不需要按账号逐个拉取。
 *
 * 生命周期（实测）：sid 组件 30 分钟 → token 实际寿命约 30min。
 * 刷新周期 = 系统设置 sherlockRefreshMinutes（试验期 5 分钟：每次全新随机环境拉取，
 * 环境新鲜度是 3p 风控的决定性变量）。
 *
 * 铸造引擎（2026-08-23 换代，不再使用 RoxyBrowser）：
 *   1. SHERLOCK_MINT_API       → 远程 fingerprint-chromium 铸造服务（Docker 一键部署的 mint sidecar）
 *   2. FP_CHROME_BIN           → 本进程直启 fingerprint-chromium 铸造（本地开发）
 *   铸造必须「有头」：实测 headless token 提交几乎全 408，有头才是可用 token。
 *
 * 来源（sherlockSource）："browser" 自动铸造 / "manual" 手动输入。
 *
 * ── 浏览器一行命令（管理员手动获取，在已登录 firefly.adobe.com 的浏览器控制台执行）──
 * 复制完整 token：
 *   copy(document.cookie.match(/(?:^|;\s*)sherlockToken=([^;]+)/)?.[1] ?? "")
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { proxyNode, systemSetting } from "@/lib/db/schema";
import { getSystemSettings } from "@/lib/system-settings";
import { startSocksRelay, type FpRelay } from "@/lib/adobe/fp-relay";
import { decryptSecret } from "@/lib/crypto";
import type { ProxySnapshotEntry } from "@/lib/proxy-pool";

/** token 有效寿命（sid 组件 30 分钟）；拉取周期由系统设置 sherlockRefreshMinutes 控制（试验期 5 分钟） */
export const SHERLOCK_TTL_MS = 30 * 60 * 1000;

export type SherlockStatus = {
  token: string | null;
  expiresAt: Date | null;
  source: string | null;
  updatedAt: Date | null;
  /** 距过期剩余秒数（倒计时用） */
  remainingSeconds: number | null;
  /** 距下次拉取剩余秒数（按刷新周期倒计时） */
  nextRefreshSeconds: number | null;
  /** 拉取周期（分钟，系统设置 sherlockRefreshMinutes） */
  refreshMinutes: number | null;
};

// ── fingerprint-chromium 铸造引擎（2026-08-23 换代，原 RoxyBrowser 依赖已移除）──
// 实测结论：
//   - headless 铸造的 token 触发 408 比例极高（~0-10% 200），有头铸造才有质量
//   - 有头 + 提交层真实 Client Hints 对齐 → 200 率 ≈ 70-90%（好提交节点组合更稳）
//   - Chromium 对 socks5://user:pass@ --proxy-server 有缺陷 → SOCKS5 节点走 fp-relay 中继
const FP_MINT_PAGE = "https://firefly.adobe.com/generate/image";
const FP_SHERLOCK_SDK = "https://commerce.adobe.com/amsterdam/sdk/sherlock.min.js";

function fpChromeBin(): string {
  return process.env.FP_CHROME_BIN?.trim() || "";
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCdp(port: number, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch { /* 未就绪 */ }
    await sleepMs(500);
  }
  throw new Error(`fingerprint-chromium CDP ${port} 未就绪`);
}

async function randomEnabledProxyEntry(): Promise<ProxySnapshotEntry | null> {
  const nodes = await db.select().from(proxyNode).where(eq(proxyNode.enabled, true)).orderBy(asc(proxyNode.displayOrder));
  if (!nodes.length) return null;
  const node = nodes[Math.floor(Math.random() * nodes.length)];
  return {
    id: node.id,
    version: node.version,
    protocol: node.protocol,
    host: node.host,
    port: node.port,
    encryptedUsername: node.encryptedUsername,
    encryptedPassword: node.encryptedPassword,
  };
}

function httpProxyServerUrl(entry: ProxySnapshotEntry): string {
  const user = entry.encryptedUsername ? decryptSecret(entry.encryptedUsername) : "";
  const pass = entry.encryptedPassword ? decryptSecret(entry.encryptedPassword) : "";
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
  return `http://${auth}${entry.host}:${entry.port}`;
}

/** 启动 fingerprint-chromium（随机 seed 指纹 + 随机代理），返回 CDP ws 端点与清理句柄 */
async function launchFpChrome(proxyServerUrl: string): Promise<{ ws: string; cleanup: () => Promise<void> }> {
  const bin = fpChromeBin();
  if (!bin) throw new Error("FP_CHROME_BIN 未配置");
  const profileDir = await mkdtemp(path.join(tmpdir(), "fp-sherlock-"));
  const port = 20000 + Math.floor(Math.random() * 15000);
  const seed = Math.floor(10000 + Math.random() * 90000);
  const args = [
    `--fingerprint=${seed}`,
    "--fingerprint-platform=windows",
    "--fingerprint-brand=Chrome",
    "--no-sandbox",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-pings",
    "--lang=en-US",
    "--accept-lang=en-US,en;q=0.9",
  ];
  if (process.env.FP_CHROME_HEADLESS === "1") args.push("--headless=new");
  if (proxyServerUrl) {
    args.push(`--proxy-server=${proxyServerUrl}`);
    args.push("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1");
  }
  const child: ChildProcess = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (/error|fail|denied|crash/i.test(text) && !/GetVSyncParametersIfAvailable|gpu|sandbox/i.test(text)) {
      console.error("[fp-chrome]", text.trim().slice(0, 300));
    }
  });
  const cleanup = async () => {
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    await sleepMs(500);
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    await waitForCdp(port);
  } catch (error) {
    await cleanup();
    throw error;
  }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) {
    await cleanup();
    throw new Error("fingerprint-chromium CDP 未返回 webSocketDebuggerUrl");
  }
  return { ws: version.webSocketDebuggerUrl, cleanup };
}

/** 铸造一枚全新 sherlockToken：有头 + 随机指纹 + 随机代理 IP（铸后删窗口） */
export async function pullSherlockFromFingerprintChromium(): Promise<string> {
  // FP_MINT_DIRECT=1：铸造走直连（好 token 不挑铸造 IP，实测 100%），提交仍由代理池负责
  const node = process.env.FP_MINT_DIRECT === "1" ? null : await randomEnabledProxyEntry();
  let relay: FpRelay | null = null;
  let proxyServerUrl = "";
  if (node) {
    // SOCKS5 节点走本地中继；HTTP 类节点直传
    if (node.protocol === "SOCKS5") {
      relay = await startSocksRelay(node);
      proxyServerUrl = `http://127.0.0.1:${relay.port}`;
    } else {
      proxyServerUrl = httpProxyServerUrl(node);
    }
  }
  const { ws, cleanup } = await launchFpChrome(proxyServerUrl);
  try {
    const { default: puppeteer } = await import("puppeteer-core");
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    try {
      const page = (await browser.pages())[0] ?? (await browser.newPage());
      await page.goto(FP_MINT_PAGE, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.addScriptTag({ url: FP_SHERLOCK_SDK });
      const minted = await page.evaluate(`(() => {
        return new Promise((resolve, reject) => {
          let best = null;
          const tryDone = (t) => {
            best = t;
            let d = null;
            try { d = JSON.parse(atob(t)); } catch {}
            if (d && d.sid && d.ftr && d.ark && d.bfp) { clearTimeout(timer); resolve({ token: t }); }
          };
          const timer = setTimeout(() => {
            if (best) { try { const d = JSON.parse(atob(best)); if (d && d.ftr && d.ark && d.bfp) { resolve({ token: best }); return; } } catch {} }
            reject(new Error("sherlock 铸造超时 90s"));
          }, 90000);
          const sdk = window.SherlockSdk;
          if (!sdk) { clearTimeout(timer); reject(new Error("SherlockSdk 未加载")); return; }
          sdk.initAsync({
            clientId: "clio-playground-web",
            prodEnv: true,
            sessionId: crypto.randomUUID(),
            logging: false,
            tokenCallback: tryDone,
            errorCallback: () => {},
          });
        });
      })()`);
      const token = String((minted as { token?: unknown }).token ?? "");
      if (!token) throw new Error("fingerprint-chromium 未铸出 sherlockToken");
      // 提交层 UA 与铸造浏览器对齐（worker 进程内生效，降低 408）
      try {
        const ua = await page.evaluate(`navigator.userAgent`);
        if (typeof ua === "string" && ua) process.env.ADOBE_USER_AGENT = ua;
      } catch { /* 仅尽力而为 */ }
      return token;
    } finally {
      await browser.disconnect();
    }
  } finally {
    await cleanup();
    if (relay) await relay.close();
  }
}

/** 远程铸造服务（Docker 一键部署的 mint sidecar）：GET /mint 返回四字段 token；fresh=1 时跳过 mint 的 60s 缓存强制重铸 */
async function pullSherlockFromMintApi(options: { fresh?: boolean } = {}): Promise<string> {
  const base = process.env.SHERLOCK_MINT_API?.trim().replace(/\/$/, "");
  if (!base) throw new Error("SHERLOCK_MINT_API 未配置");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 170_000);
  try {
    const res = await fetch(`${base}/mint${options.fresh ? "?fresh=1" : ""}`, { signal: controller.signal, headers: { Accept: "application/json" } });
    const json = (await res.json().catch(() => ({}))) as { status?: string; token?: string; error?: string; ua?: string };
    if (res.ok && json.token && validateSherlockToken(json.token)) {
      // 提交层 UA 对齐铸造浏览器（进程内生效）
      if (json.ua) process.env.ADOBE_USER_AGENT = json.ua;
      return json.token;
    }
    throw new Error(`铸造服务失败(${res.status}): ${json.error ?? "无 token"}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 铸造引擎选择：远程 mint 服务 > 本进程 fingerprint-chromium > 明确报错（RoxyBrowser 已移除） */
async function pullSherlockPreferred(options: { fresh?: boolean } = {}): Promise<string> {
  if (process.env.SHERLOCK_MINT_API?.trim()) return await pullSherlockFromMintApi(options);
  if (fpChromeBin()) return await pullSherlockFromFingerprintChromium();
  throw new Error("未配置 sherlockToken 铸造引擎：Docker 部署需 mint 服务(SHERLOCK_MINT_API)；本地开发需 FP_CHROME_BIN 指向 fingerprint-chromium；或后台手动输入 token");
}

/** 浏览器一行命令产出的 token 校验（base64 JSON 四字段） */
export function validateSherlockToken(value: string): { sid: string; ftr: string; ark: string; bfp: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const fields = { sid: record.sid, ftr: record.ftr, ark: record.bfp, bfp: record.bfp };
    if (Object.values(fields).some((field) => typeof field !== "string" || !field)) return null;
    return fields as { sid: string; ftr: string; ark: string; bfp: string };
  } catch {
    return null;
  }
}

/** 保存全局 sherlockToken（自动铸造 / 手动输入 / 导入覆盖共用） */
export async function saveGlobalSherlockToken(token: string, source: "browser" | "manual"): Promise<Date> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SHERLOCK_TTL_MS);
  // upsert：singleton 行可能尚不存在（全新部署时系统设置未保存过），
  // 用 insert + onDuplicateKeyUpdate 确保 token 一定落库，否则 UPDATE 0 行导致 token 丢失。
  await db
    .insert(systemSetting)
    .values({ id: "singleton", sherlockToken: token, sherlockExpiresAt: expiresAt, sherlockSource: source, sherlockUpdatedAt: now, updatedAt: now })
    .onDuplicateKeyUpdate({
      set: { sherlockToken: token, sherlockExpiresAt: expiresAt, sherlockSource: source, sherlockUpdatedAt: now, updatedAt: now },
    });
  return expiresAt;
}

/** 读取全局 sherlockToken 状态（含倒计时信息） */
export async function getGlobalSherlockStatus(): Promise<SherlockStatus> {
  const [row] = await db
    .select({
      token: systemSetting.sherlockToken,
      expiresAt: systemSetting.sherlockExpiresAt,
      source: systemSetting.sherlockSource,
      updatedAt: systemSetting.sherlockUpdatedAt,
    })
    .from(systemSetting)
    .where(eq(systemSetting.id, "singleton"))
    .limit(1);
  const settings = await getSystemSettings();
  if (!row) return { token: null, expiresAt: null, source: null, updatedAt: null, remainingSeconds: null, nextRefreshSeconds: null, refreshMinutes: settings.sherlockRefreshMinutes };
  const now = Date.now();
  const expiresMs = row.expiresAt?.getTime() ?? null;
  const updatedMs = row.updatedAt?.getTime() ?? null;
  const remainingSeconds = expiresMs !== null ? Math.max(0, Math.floor((expiresMs - now) / 1000)) : null;
  // 距下次拉取 = 距上次拉取 + 刷新周期（sherlockRefreshMinutes 分钟）
  const nextRefreshSeconds = updatedMs !== null ? Math.max(0, Math.ceil(settings.sherlockRefreshMinutes * 60 - (now - updatedMs) / 1000)) : null;
  return {
    token: row.token,
    expiresAt: row.expiresAt,
    source: row.source,
    updatedAt: row.updatedAt,
    remainingSeconds,
    nextRefreshSeconds,
    refreshMinutes: settings.sherlockRefreshMinutes,
  };
}

/** 拉取新 token 并保存全局（worker 定时刷新与手动拉取共用；fresh=1 时强制重铸，用于 408 重试恢复） */
export async function refreshGlobalSherlockToken(options: { fresh?: boolean } = {}): Promise<{ token: string; expiresAt: Date }> {
  const token = await pullSherlockPreferred(options);
  const expiresAt = await saveGlobalSherlockToken(token, "browser");
  return { token, expiresAt };
}

/** 手动输入 token 并保存全局（校验四字段） */
export async function importGlobalSherlockToken(token: string): Promise<{ token: string; expiresAt: Date }> {
  const clean = token.trim();
  if (!validateSherlockToken(clean)) throw new Error("token 格式无效：需为 base64 JSON，含 sid/ftr/ark/bfp 四字段");
  const expiresAt = await saveGlobalSherlockToken(clean, "manual");
  return { token: clean, expiresAt };
}

/** 供 worker 主循环调用：按配置周期刷新（sherlockRefreshMinutes，试验期 5min） */
export async function refreshSherlockIfDue(): Promise<{ refreshed: boolean; token?: string; expiresAt?: Date }> {
  const settings = await getSystemSettings();
  if (!settings.sherlockAutoRefreshEnabled) return { refreshed: false };
  const status = await getGlobalSherlockStatus();
  const now = Date.now();
  // 无 token 或距上次拉取已满一个刷新周期 → 拉取（周期内不管过期与否）
  const ageMs = status.updatedAt ? now - status.updatedAt.getTime() : Infinity;
  if (!status.token || !status.updatedAt || ageMs >= settings.sherlockRefreshMinutes * 60 * 1000) {
    const { token, expiresAt } = await refreshGlobalSherlockToken();
    return { refreshed: true, token, expiresAt };
  }
  return { refreshed: false };
}

// 兼容旧引用（按账号存储已废弃，保留空实现避免破坏 import）
export type SherlockRefreshResult = { profileId: string; accountId: string; ok: boolean; source: "browser" | "manual"; expiresAt: Date | null; error?: string };
export async function listActiveProfiles(): Promise<Array<{ id: string; accountId: string; name: string | null }>> {
  return [];
}
export async function saveSherlockToken(_profileId: string, _token: string, _source: "browser" | "manual"): Promise<SherlockRefreshResult> { // eslint-disable-line @typescript-eslint/no-unused-vars
  throw new Error("按账号存储已废弃，请使用全局 saveGlobalSherlockToken");
}
export async function refreshAllSherlockTokens(): Promise<SherlockRefreshResult[]> {
  throw new Error("按账号批量刷新已废弃，请使用 refreshGlobalSherlockToken");
}
export async function importSherlockTokenManually(_profileId: string, _token: string): Promise<SherlockRefreshResult> { // eslint-disable-line @typescript-eslint/no-unused-vars
  throw new Error("按账号存储已废弃，请使用 importGlobalSherlockToken");
}
export async function sherlockStatusFor(_profileId: string): Promise<null> { // eslint-disable-line @typescript-eslint/no-unused-vars
  return null;
}
export async function sherlockNeedsRefresh(_profileId: string): Promise<boolean> { // eslint-disable-line @typescript-eslint/no-unused-vars
  return false;
}
