/**
 * sherlockToken（x-arp-session-id）全局单例服务。
 *
 * 关键事实（2026-08-18 实测定论）：sherlockToken 是**浏览器会话级**产物，
 * 内部只有 sid/ark/bfp/ftr 浏览器环境信息，**不含 Adobe 账号标识**，与账号无关。
 * 因此全局存一份、所有账号共用；提交 3p 时从全局读取，不需要按账号逐个拉取。
 *
 * 生命周期（实测）：sid 组件 30 分钟 → token 实际寿命约 30min。
 * 刷新周期 = 系统设置 sherlockRefreshMinutes（试验期 5 分钟：每次全新随机环境拉取，
 * 环境新鲜度是 3p 风控的决定性变量——随机 IP + 随机指纹 + 铸后删窗口）。
 *
 * 来源（sherlockSource）："browser" RoxyBrowser 自动拉取 / "manual" 手动输入。
 *
 * ── 浏览器一行命令（管理员手动获取，在已登录 firefly.adobe.com 的浏览器控制台执行）──
 * 复制完整 token：
 *   copy(document.cookie.match(/(?:^|;\s*)sherlockToken=([^;]+)/)?.[1] ?? "")
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { systemSetting } from "@/lib/db/schema";
import { getSystemSettings } from "@/lib/system-settings";

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

/** RoxyBrowser API 拉取：铸造全新 sherlockToken（四字段完整），完成后关闭浏览器窗口 */
export async function pullSherlockFromRoxyBrowser(): Promise<string> {
  const { default: puppeteer } = await import("puppeteer-core");
  const config = await getRoxyBrowserConfig();
  // 自动获取 workspace + 自动创建窗口（无需手动配置 WORKSPACE_ID / DIR_ID）
  const workspaceId = await resolveWorkspaceId(config.apiBase, config.apiToken);
  const dirId = await createRoxyWindow(config.apiBase, config.apiToken, workspaceId);
  try {
    const openRes = await fetch(`${config.apiBase}/browser/open`, {
      method: "POST",
      headers: { token: config.apiToken, "Content-Type": "application/json" },
      // --remote-debugging-address=0.0.0.0：让 Chrome CDP 监听所有网卡，
      // 容器才能通过宿主机 IP 直连 CDP（默认只绑 127.0.0.1，容器够不到）。
      // 注意：--remote-debugging-port 是 Roxy 内置参数改不了，但 address 可改。
      body: JSON.stringify({ workspaceId, dirId, forceOpen: true, headless: true, args: ["--remote-debugging-address=0.0.0.0"] }),
    });
    const openJson = (await openRes.json()) as { code?: number; data?: { ws?: string } };
    let ws = openJson.data?.ws ?? "";
    if (!ws) throw new Error("RoxyBrowser open 未返回 ws 连接地址");
    // 容器内运行时，RoxyBrowser 返回的 ws 是宿主机 127.0.0.1，需替换为容器可达的宿主机地址
    if (config.cdpHost && ws.startsWith("ws://")) {
      ws = ws.replace(/ws:\/\/127\.0\.0\.1(:\d+)/, `ws://${config.cdpHost}$1`);
    }

    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    try {
      const page = (await browser.pages())[0];
      if (!page.url().startsWith("https://firefly.adobe.com")) {
        await page.goto("https://firefly.adobe.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      }
      await page.addScriptTag({ url: "https://commerce.adobe.com/amsterdam/sdk/sherlock.min.js" });
      // 用字符串形式执行 evaluate，避免 esbuild 把回调转换成引用 __name 的产物（浏览器端无此辅助函数）
      const minted = await page.evaluate(`(() => {
        return new Promise((resolve, reject) => {
          let best = null;
          const tryDone = (t) => {
            best = t;
            let d = null;
            try { d = JSON.parse(atob(t)); } catch {}
            if (d && d.sid && d.ftr && d.ark && d.bfp) { clearTimeout(timer); resolve({ token: t, decoded: d }); }
          };
          const timer = setTimeout(() => {
            if (best) { try { resolve({ token: best, decoded: JSON.parse(atob(best)) }); } catch {} }
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
      const mintedValue = minted as { token: string };
      return mintedValue.token;
    } finally {
      await browser.disconnect();
      // 拉取完成立即关闭浏览器窗口，避免常驻占 CPU
      await fetch(`${config.apiBase}/browser/close`, {
        method: "POST",
        headers: { token: config.apiToken, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, dirId }),
      }).catch(() => undefined);
    }
  } finally {
    // 无论成败都先关窗再删窗：Roxy 要求 close 后才能 delete，
    // 否则 puppeteer.connect 等中间步骤失败时会残留窗口、耗尽窗口额度。
    await fetch(`${config.apiBase}/browser/close`, {
      method: "POST",
      headers: { token: config.apiToken, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, dirId }),
    }).catch(() => undefined);
    await deleteRoxyWindow(config.apiBase, config.apiToken, workspaceId, dirId);
  }
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

/** 保存全局 sherlockToken（RoxyBrowser 拉取 / 手动输入 / 导入覆盖共用） */
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

/** 拉取新 token 并保存全局（worker 定时刷新与手动拉取共用） */
export async function refreshGlobalSherlockToken(): Promise<{ token: string; expiresAt: Date }> {
  const token = await pullSherlockFromRoxyBrowser();
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

// ── RoxyBrowser 配置（环境变量，不再写死默认值）──
// workspaceId / dirId 不再需要手动配置：
//   workspaceId 通过 GET /browser/workspace 自动获取第一个团队，
//   dirId 每次铸造前通过 POST /browser/create 自动创建、铸完删除。
type RoxyConfig = { apiBase: string; apiToken: string; cdpHost: string };

async function getRoxyBrowserConfig(): Promise<RoxyConfig> {
  const apiBase = process.env.ROXYBROWSER_API_BASE?.trim() || "";
  const apiToken = process.env.ROXYBROWSER_API_TOKEN?.trim() || "";
  // 容器内访问宿主机 RoxyBrowser：CDP ws 地址的 127.0.0.1 替换为该值（宿主机局域网 IP，如 192.168.50.80）。
  // 不能用 host.docker.internal：Docker Desktop 网关对其转发宿主机 CDP 端口会返回 500（实测）。
  const cdpHost = process.env.ROXYBROWSER_CDP_HOST?.trim() || "";

  const missing: string[] = [];
  if (!apiBase) missing.push("ROXYBROWSER_API_BASE（Roxy 浏览器 API 地址）");
  if (!apiToken) missing.push("ROXYBROWSER_API_TOKEN（Roxy 浏览器 API Key）");
  if (missing.length > 0) {
    throw new Error(`RoxyBrowser 配置缺失，请在环境变量中设置：${missing.join("、")}`);
  }

  return { apiBase, apiToken, cdpHost };
}

/** GET /browser/workspace 自动获取第一个团队（workspace）id */
async function resolveWorkspaceId(apiBase: string, apiToken: string): Promise<number> {
  const res = await fetch(`${apiBase}/browser/workspace`, { headers: { token: apiToken } });
  const json = (await res.json().catch(() => ({}))) as {
    code?: number;
    data?: Array<{ id?: number }> | { rows?: Array<{ id?: number }>; total?: number };
  };
  // Roxy 新版返回 data.rows[].id，旧版返回 data[].id，两种结构都兼容
  const list = Array.isArray(json.data) ? json.data : (json.data?.rows ?? []);
  const id = list[0]?.id;
  if (!id || !Number.isInteger(id) || id <= 0) {
    throw new Error("RoxyBrowser 未返回任何团队（workspace），请先在客户端创建团队");
  }
  return id;
}

/** POST /browser/create 自动创建窗口，返回 dirId */
async function createRoxyWindow(apiBase: string, apiToken: string, workspaceId: number): Promise<string> {
  const res = await fetch(`${apiBase}/browser/create`, {
    method: "POST",
    headers: { token: apiToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      windowName: `mint-${Math.random().toString(36).slice(2, 10)}`,
      coreType: "Chrome",
      os: "Windows",
      osVersion: "10",
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { code?: number; data?: { dirId?: string } };
  const dirId = json.data?.dirId ?? "";
  if (!dirId) throw new Error("RoxyBrowser create 未返回 dirId");
  return dirId;
}

/** POST /browser/delete 删除窗口（铸造完成后清理） */
async function deleteRoxyWindow(apiBase: string, apiToken: string, workspaceId: number, dirId: string): Promise<void> {
  await fetch(`${apiBase}/browser/delete`, {
    method: "POST",
    headers: { token: apiToken, "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, dirIds: [dirId] }),
  }).catch(() => undefined);
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
