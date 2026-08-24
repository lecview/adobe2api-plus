/**
 * fingerprint-chromium sherlockToken PoC
 * 目标：验证「fingerprint-chromium 148 铸造 sherlockToken → 生图提交」的 200 / 408 结论。
 *
 * 流程：
 *  1. 从代理池取第一个启用节点（随机 IP），同一条代理既给浏览器铸 token 又给提交请求用，保证 IP 一致。
 *  2. 启动 /Volumes/Chromium/Chromium.app（fingerprint-chromium 148），
 *     --fingerprint=<随机seed> --fingerprint-platform=windows --fingerprint-brand=Chrome，
 *     开 CDP 端口，全新 user-data-dir（无任何账号 cookie = 匿名环境）。
 *  3. puppeteer-core 连 CDP → 打开 firefly.adobe.com/generate/image →
 *     注入 commerce sherlock SDK → initAsync 铸出 sherlockToken（sid/ftr/ark/bfp）。
 *  4. 从 adobetoken 随机抽一个账号解密出 access token。
 *  5. AdobeClient.submitImage 提交生图（x-arp-session-id=铸出的 token，UA 对齐铸造浏览器的 navigator.userAgent）。
 *  6. 打印提交 HTTP 状态 / 上游状态码（200 成功 vs 408 风控拒绝）与响应体摘要，随后清理浏览器。
 *
 * 运行：npx tsx --env-file-if-exists=.env.development src/scripts/sherlock-fp-poc.ts [--no-proxy] [--headful]
 */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SocksClient } from "socks";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { adobeAccount, adobeToken, proxyNode } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { asc, eq, sql } from "drizzle-orm";
import { ADOBE_ENDPOINTS, AdobeClient, type AdobeUpstreamError } from "@/lib/adobe/client";
import { FetchAdobeTransport } from "@/lib/adobe/transport";
import { buildImagePayloads } from "@/lib/adobe/payloads";
import { resolveImageModel } from "@/lib/catalog";
import { getSystemSettings } from "@/lib/system-settings";
import type { ProxySnapshotEntry } from "@/lib/proxy-pool";
import type { Page } from "puppeteer-core";

// 注意：不能直接从只读 dmg 卷运行（network service 会崩溃），需先 ditto 拷贝到本地目录
const CHROME_BIN = process.env.FP_CHROME_BIN ?? path.resolve(process.cwd(), ".sherlock-test/Chromium.app/Contents/MacOS/Chromium");
const CDP_PORT = Number(process.env.FP_CDP_PORT ?? 19333);
const MINT_PAGE = "https://firefly.adobe.com/generate/image";
const SHERLOCK_SDK = "https://commerce.adobe.com/amsterdam/sdk/sherlock.min.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCdp(port: number, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch { /* 还未就绪 */ }
    await sleep(500);
  }
  throw new Error(`CDP ${port} 在 30s 内未就绪`);
}

async function launchChromium(seed: number, proxyServerUrl: string, headful: boolean, profileDir: string): Promise<ChildProcess> {
  const args = [
    `--fingerprint=${seed}`,
    "--fingerprint-platform=windows",
    "--fingerprint-brand=Chrome",
    "--no-sandbox",
    `--remote-debugging-port=${CDP_PORT}`,
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
  if (process.env.FP_TZ) args.push(`--timezone=${process.env.FP_TZ}`);
  if (!headful) args.push("--headless=new");
  if (proxyServerUrl) {
    args.push(`--proxy-server=${proxyServerUrl}`);
    // 域名不本地解析，交给中继/上游做远端 DNS（保持 CDN 边缘节点与出口 IP 一致）
    args.push("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1");
  }
  const child = spawn(CHROME_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    // 只打印关键启动错误，过滤设备枚举类噪音
    if (/error|fail|denied|crash/i.test(text) && !/GetVSyncParametersIfAvailable|gpu|sandbox/i.test(text)) {
      console.error("[chrome-stderr]", text.trim().slice(0, 400));
    }
  });
  try {
    await waitForCdp(CDP_PORT);
  } catch (error) {
    // 启动失败立即终止子进程，避免 tsx 被管道挂起
    child.kill("SIGKILL");
    throw error;
  }
  return child;
}

/** 从池中随机取一个启用节点（随机 IP） */
async function randomEnabledProxy(allEnabled: ProxySnapshotEntry[]): Promise<ProxySnapshotEntry | null> {
  if (!allEnabled.length) return null;
  return allEnabled[Math.floor(Math.random() * allEnabled.length)];
}

async function enabledProxies(): Promise<ProxySnapshotEntry[]> {
  const nodes = await db.select().from(proxyNode).where(eq(proxyNode.enabled, true)).orderBy(asc(proxyNode.displayOrder));
  return nodes.map((node) => ({
    id: node.id,
    version: node.version,
    protocol: node.protocol,
    host: node.host,
    port: node.port,
    encryptedUsername: node.encryptedUsername,
    encryptedPassword: node.encryptedPassword,
  }));
}

/** 与 proxy-pool.ts 的 buildProxyUrlValue 保持一致，用于 --proxy-server 直传（仅 HTTP 类协议） */
function httpProxyServerUrl(entry: ProxySnapshotEntry): string {
  const user = entry.encryptedUsername ? decryptSecret(entry.encryptedUsername) : "";
  const pass = entry.encryptedPassword ? decryptSecret(entry.encryptedPassword) : "";
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
  return `http://${auth}${entry.host}:${entry.port}`;
}

/**
 * Chromium 对 socks5://user:pass@host 的 --proxy-server 存在已知缺陷（ERR_NO_SUPPORTED_PROXIES），
 * 因此 SOCKS5 节点走本地中继：127.0.0.1 启动无认证 HTTP CONNECT 代理，中继用 socks 库带认证
 * 转发到上游节点（远端 DNS）。浏览器看到的是普通 http 代理，兼容性最好。
 */
async function startSocksRelay(entry: ProxySnapshotEntry): Promise<{ port: number; close: () => Promise<void> }> {
  const username = entry.encryptedUsername ? decryptSecret(entry.encryptedUsername) : "";
  const password = entry.encryptedPassword ? decryptSecret(entry.encryptedPassword) : "";
  const proxyInfo = { host: entry.host, port: entry.port, type: 5 as const, userId: username || undefined, password: password || undefined };
  const server: Server = createServer((client) => {
    client.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (buffer.length > 16_384) client.destroy();
        return;
      }
      client.removeListener("data", onData);
      const header = buffer.subarray(0, headerEnd).toString("latin1");
      const match = /^CONNECT ([^:\s[\]]+):(\d{1,5})/.exec(header);
      if (!match) {
        client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      const host = match[1];
      const port = Number(match[2]);
      SocksClient.createConnection({ proxy: proxyInfo, destination: { host, port }, command: "connect", timeout: 20_000 })
        .then(({ socket }) => {
          client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: fp-socks-relay\r\n\r\n");
          if (buffer.length > headerEnd + 4) socket.write(buffer.subarray(headerEnd + 4));
          client.pipe(socket);
          socket.pipe(client);
          const teardown = () => {
            socket.destroy();
            client.destroy();
          };
          socket.on("error", teardown);
          client.on("error", teardown);
          socket.on("close", () => client.end());
          client.on("close", () => socket.end());
        })
        .catch(() => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    };
    client.on("data", onData);
    client.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

type MintMode = "inject" | "cookie";

type ChInfo = {
  ua: string;
  platform: string;
  hardwareConcurrency: number;
  brands: Array<{ brand: string; version: string }> | null;
  mobile: boolean;
  he: { platform?: string; platformVersion?: string; model?: string; bitness?: string; architecture?: string; uaFullVersion?: string; fullVersionList?: Array<{ brand: string; version: string }> } | null;
};

type MintResult = { token: string; userAgent: string; platform: string; hardwareConcurrency: number; ch: ChInfo };

async function captureClientHints(page: Page): Promise<ChInfo> {
  return await page.evaluate(`(async () => {
    let he = null;
    try {
      he = navigator.userAgentData && navigator.userAgentData.getHighEntropyValues
        ? await navigator.userAgentData.getHighEntropyValues(["platform", "platformVersion", "fullVersionList", "model", "bitness", "architecture", "uaFullVersion"])
        : null;
    } catch {}
    return {
      ua: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      brands: navigator.userAgentData ? (navigator.userAgentData.brands ?? null) : null,
      mobile: navigator.userAgentData ? !!navigator.userAgentData.mobile : false,
      he: he,
    };
  })()`) as unknown as ChInfo;
}

async function mintSherlockToken(wsEndpoint: string, pageUrl: string, mode: MintMode): Promise<MintResult> {
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    if (mode === "cookie") {
      // 页面自然铸造：等待站点自身 SDK 铸出「四字段齐全」的 sherlockToken 并写进 document.cookie。
      // 早期 cookie 只有 sid（半成品），必须等 ftr/ark/bfp 齐了再取（成熟 token 质量更高）。
      const cookieToken = await page.evaluate(`(() => new Promise((resolve, reject) => {
        const started = Date.now();
        const read = () => {
          const match = document.cookie.match(/(?:^|;\\s*)sherlockToken=([^;]+)/);
          if (match && match[1]) {
            try {
              const d = JSON.parse(atob(match[1]));
              if (d && d.ftr && d.ark && d.bfp) return resolve(match[1].trim());
            } catch {}
          }
          if (Date.now() - started >= 150000) return reject(new Error("页面 150s 内未铸出四字段 sherlockToken"));
          setTimeout(read, 2000);
        };
        read();
      }))()`);
      const ch = await captureClientHints(page);
      console.log("[mint] mode=cookie(页面自然铸造) ✅");
      console.log("[mint] browser env:", JSON.stringify({ userAgent: ch.ua, platform: ch.platform, hardwareConcurrency: ch.hardwareConcurrency }));
      return { token: String(cookieToken), userAgent: ch.ua, platform: ch.platform, hardwareConcurrency: ch.hardwareConcurrency, ch };
    }

    await page.addScriptTag({ url: SHERLOCK_SDK });
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
    const result = minted as { token: string; decoded?: { sid?: string; ftr?: string; ark?: string; bfp?: string } };
    const ch = await captureClientHints(page);
    console.log("[mint] decoded fields:", JSON.stringify(result.decoded ? { sid: result.decoded.sid?.slice(0, 12) + "...", ftr: result.decoded.ftr?.slice(0, 12) + "...", ark: String(result.decoded.ark).slice(0, 12) + "...", bfp: String(result.decoded.bfp).slice(0, 12) + "..." } : null));
    console.log("[mint] browser env:", JSON.stringify({ userAgent: ch.ua, platform: ch.platform, hardwareConcurrency: ch.hardwareConcurrency }));
    console.log("[mint] ch brands:", JSON.stringify(ch.brands), "| he.platform:", String(ch.he?.platform ?? ""));
    return { token: result.token, userAgent: ch.ua, platform: ch.platform, hardwareConcurrency: ch.hardwareConcurrency, ch };
  } finally {
    await browser.disconnect();
  }
}

async function randomAccountToken(): Promise<{ tokenId: string; email: string | null; accessToken: string }> {
  const [row] = await db
    .select({ tokenId: adobeToken.id, email: adobeAccount.email, encryptedAccessToken: adobeToken.encryptedAccessToken })
    .from(adobeToken)
    .innerJoin(adobeAccount, eq(adobeAccount.id, adobeToken.accountId))
    .orderBy(sql`RAND()`)
    .limit(1);
  if (!row) throw new Error("无可用账号 token");
  return { tokenId: row.tokenId, email: row.email, accessToken: decryptSecret(row.encryptedAccessToken) };
}

function decodeJwtPayloadSimple(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="), "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function nonceFor(token: string, prompt: string): string | undefined {
  const claims = decodeJwtPayloadSimple(token);
  const userId = String(claims.user_id ?? claims.aa_id ?? claims.sub ?? "").trim();
  if (!userId || !prompt) return undefined;
  return createHash("sha256").update(`${userId}-${prompt.slice(0, 256)}`, "utf8").digest("hex");
}

/** 用铸造浏览器真实 Client Hints 重建 sec-ch-ua 头（品牌顺序＝浏览器实际顺序） */
function secChUa(ch: ChInfo): string {
  if (ch.brands?.length) return ch.brands.map((b) => `"${String(b.brand).replace(/"/g, "")}";v="${b.version}"`).join(", ");
  const list = ch.he?.fullVersionList;
  if (list?.length) return list.map((b) => `"${String(b.brand).replace(/"/g, "")}";v="${String(b.version).split(".")[0]}"`).join(", ");
  return "";
}

function fullVersionListHeader(ch: ChInfo): string | undefined {
  const list = ch.he?.fullVersionList;
  if (!list?.length) return undefined;
  return list.map((b) => `"${String(b.brand).replace(/"/g, "")}";v="${b.version}"`).join(", ");
}

type RawSubmitResult = { status: number; taskId?: string; body?: unknown; headers?: Record<string, string> };

/** 与 AdobeClient.submitImage 同 payload,但请求头完全对齐铸造浏览器 */
async function rawSubmitImage(transport: FetchAdobeTransport, settings: Awaited<ReturnType<typeof getSystemSettings>>, input: {
  token: string;
  proxy: ProxySnapshotEntry | null;
  arpSessionId: string;
  prompt: string;
  model: ReturnType<typeof resolveImageModel>;
  ch: ChInfo;
}): Promise<RawSubmitResult> {
  const payload = buildImagePayloads({ prompt: input.prompt, modelId: input.model.id })[0];
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.token}`,
    "x-api-key": config.adobeApiKey(),
    "Content-Type": "application/json",
    Accept: "*/*",
    Origin: "https://firefly.adobe.com",
    Referer: "https://firefly.adobe.com/",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": input.ch.ua,
    "x-arp-session-id": input.arpSessionId,
  };
  const sec = secChUa(input.ch);
  if (sec) headers["sec-ch-ua"] = sec;
  headers["sec-ch-ua-mobile"] = input.ch.mobile ? "?1" : "?0";
  headers["sec-ch-ua-platform"] = `"${String(input.ch.he?.platform ?? "Windows")}"`;
  const fullList = fullVersionListHeader(input.ch);
  if (fullList) headers["sec-ch-ua-full-version-list"] = fullList;
  headers["sec-fetch-site"] = "cross-site";
  headers["sec-fetch-mode"] = "cors";
  headers["sec-fetch-dest"] = "empty";
  const nonce = nonceFor(input.token, input.prompt);
  if (nonce) headers["x-nonce"] = nonce;

  const response = await transport.request<Record<string, unknown>>({
    method: "POST",
    path: ADOBE_ENDPOINTS.imageSubmit,
    body: payload,
    headers,
    token: input.token,
    proxy: input.proxy,
    timeoutMs: settings.adobeTimeoutMs,
  });
  if (response.status >= 200 && response.status < 300) {
    const data = response.data && typeof response.data === "object" ? response.data : {};
    const links = data.links && typeof data.links === "object" ? data.links as Record<string, unknown> : {};
    const result = links.result;
    const resultHref = typeof result === "string" ? result : result && typeof result === "object" ? String((result as Record<string, unknown>).href ?? "") : "";
    const taskId = resultHref ? (new URL(resultHref).pathname.split("/").at(-1) ?? "") : "";
    return { status: response.status, taskId, body: data, headers: response.headers };
  }
  return { status: response.status, body: response.data, headers: response.headers };
}

async function main() {
  config.validateRuntime();
  const useProxy = !process.argv.includes("--no-proxy");
  const headful = process.argv.includes("--headful");
  const pool = useProxy ? await enabledProxies() : [];
  const forcedProxy = process.env.FP_PROXY_FORCE?.trim();
  const node = useProxy
    ? forcedProxy
      ? (pool.find((item) => `${item.host}:${item.port}` === forcedProxy) ?? null)
      : await randomEnabledProxy(pool)
    : null;
  if (useProxy && forcedProxy && !node) throw new Error(`FP_PROXY_FORCE 节点不存在或未启用: ${forcedProxy}`);
  // FP_MINT_DIRECT=1：铸造走直连（不挑 IP 的王牌配方），提交仍走随机代理
  const mintNode = process.env.FP_MINT_DIRECT === "1" ? null : node;
  // FP_SUBMIT_FORCE=host:port：提交侧强制走指定节点（验证提交 IP 一票否决假设）
  const submitForce = process.env.FP_SUBMIT_FORCE?.trim();
  const submitNode = submitForce ? (useProxy && pool.find((item) => `${item.host}:${item.port}` === submitForce)) || null : node;
  if (submitForce && !submitNode) throw new Error(`FP_SUBMIT_FORCE 节点不存在或未启用: ${submitForce}`);
  console.log(`[setup] 代理池启用节点 ${pool.length} 个:`, pool.map((item) => `${item.protocol} ${item.host}:${item.port}`).join(", ") || "无");
  console.log("[setup] 本次随机命中:", node ? `${node.protocol} ${node.host}:${node.port}` : "直连(无代理)");
  console.log("[setup] headful:", headful, "| chrome:", CHROME_BIN);
  console.log("[setup] 提交路径:", submitNode ? `${submitNode.protocol} ${submitNode.host}:${submitNode.port}${submitForce ? "(强制)" : ""}` : "直连");

  // 浏览器代理：HTTP 类节点直传；SOCKS5 节点走本地 HTTP CONNECT 中继（Chromium socks+auth 有已知缺陷）
  let nodeUrl = "";
  let relay: { port: number; close: () => Promise<void> } | null = null;
  if (mintNode) {
    if (mintNode.protocol === "SOCKS5") {
      relay = await startSocksRelay(mintNode);
      nodeUrl = `http://127.0.0.1:${relay.port}`;
      console.log(`[setup] 铸造走中继 127.0.0.1:${relay.port} -> ${mintNode.host}:${mintNode.port}`);
    } else {
      nodeUrl = httpProxyServerUrl(mintNode);
      console.log(`[setup] 铸造走直传代理 ${mintNode.host}:${mintNode.port}`);
    }
  } else if (useProxy) {
    console.log("[setup] 铸造走直连(FP_MINT_DIRECT),提交仍走随机代理:", node ? `${node.protocol} ${node.host}:${node.port}` : "无");
  }

  const profileDir = await mkdtemp(path.join(tmpdir(), "fp-chrome-"));
  const seed = Math.floor(10000 + Math.random() * 90000);
  console.log("[setup] fingerprint seed:", seed, "| profile:", profileDir);

  const child = await launchChromium(seed, nodeUrl, headful, profileDir);
  try {
    const ws = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json() as { webSocketDebuggerUrl?: string };
    if (!ws.webSocketDebuggerUrl) throw new Error("CDP 未返回 webSocketDebuggerUrl");
    const mintMode: MintMode = process.env.FP_MINT === "cookie" ? "cookie" : "inject";
    const mint = await mintSherlockToken(ws.webSocketDebuggerUrl, MINT_PAGE, mintMode);
    console.log("[mint] sherlockToken:", mint.token.slice(0, 40) + `...(${mint.token.length} chars)`);
    // 解码打印四字段长度,观察铸造质量差异（字段偏短常意味着指纹信号未就绪）
    try {
      const decoded = JSON.parse(Buffer.from(mint.token, "base64").toString("utf8")) as Record<string, unknown>;
      console.log("[mint] fields:", JSON.stringify({ sid: String(decoded.sid ?? "").length, ftr: String(decoded.ftr ?? "").length, ark: String(decoded.ark ?? "").length, bfp: String(decoded.bfp ?? "").length, keys: Object.keys(decoded) }));
    } catch {
      console.log("[mint] fields: 解码失败(非标准 base64-json)");
    }

    // 提交请求 UA 与铸造浏览器一致，避免 x-arp-session-id 与 UA 指纹不匹配干扰判定
    process.env.ADOBE_USER_AGENT = mint.userAgent;
    const freshAccountPerAttempt = process.env.FP_FRESH_ACCOUNT === "1";
    let account = await randomAccountToken();
    console.log("[account] token:", account.tokenId, "| email:", account.email ?? "(无邮箱)", freshAccountPerAttempt ? "| 每次提交重新随机账号" : "");

    const settings = await getSystemSettings();
    const transport = new FetchAdobeTransport(settings.adobeBaseUrl);
    const client = new AdobeClient(transport, { baseUrl: settings.adobeBaseUrl, timeoutMs: settings.adobeTimeoutMs });
    const model = resolveImageModel(process.env.FP_MODEL ?? undefined);
    const chFidelity = process.env.FP_CH_FIDELITY === "1";
    console.log("[setup] model:", model.id, "| CH 透传:", chFidelity);
    const prompt = "a cute red panda reading a book in a cozy cabin, warm studio lighting, highly detailed";

    // 200 即成功（无需等图）。默认每轮 1 次提交 = 干净判定，
    // 需要重试策略实验时用 FP_MAX_ATTEMPTS 调整。
    const maxAttempts = Math.max(1, Number(process.env.FP_MAX_ATTEMPTS ?? 1));
    const backoffMs = Math.max(0, Number(process.env.FP_BACKOFF_MS ?? 4000));
    let successTask = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (freshAccountPerAttempt && attempt > 1) {
        account = await randomAccountToken();
        console.log(`[account] 第 ${attempt} 次提交换号:`, account.tokenId, "| email:", account.email ?? "(无邮箱)");
      }
      const started = Date.now();
      if (chFidelity) {
        try {
          const raw = await rawSubmitImage(transport, settings, { token: account.accessToken, proxy: submitNode, arpSessionId: mint.token, prompt, model, ch: mint.ch });
          if (raw.status >= 200 && raw.status < 300) {
            successTask = raw.taskId ?? "(accepted)";
            console.log(`[submit ${attempt}/${maxAttempts}] ✅ HTTP ${raw.status} | task=${successTask} | acct=${account.tokenId} | ${Date.now() - started}ms`);
            break;
          }
          const bodyText = JSON.stringify(raw.body ?? "").slice(0, 200);
          console.log(`[submit ${attempt}/${maxAttempts}] ❌ HTTP ${raw.status} | acct=${account.tokenId} | ${Date.now() - started}ms | ${bodyText}`);
          if (raw.status === 408 && attempt < maxAttempts) {
            await sleep(backoffMs);
            continue;
          }
          break;
        } catch (submitError) {
          console.log(`[submit ${attempt}/${maxAttempts}] ❌ 传输错误 | ${submitError instanceof Error ? submitError.message : String(submitError)}`);
          break;
        }
      } else {
        try {
          const submission = await client.submitImage(
            { token: account.accessToken, proxy: submitNode, arpSessionId: mint.token },
            { prompt, model },
          );
          successTask = submission.upstreamTaskId;
          console.log(`[submit ${attempt}/${maxAttempts}] ✅ HTTP 2xx | task=${successTask} | acct=${account.tokenId} | ${Date.now() - started}ms`);
          break;
        } catch (submitError) {
          const err = submitError as AdobeUpstreamError;
          const upstream = err.realUpstreamStatus ?? err.upstreamStatus;
          const details = (err.details ?? {}) as Record<string, unknown>;
          const bodyText = typeof details.body === "string" ? details.body.slice(0, 200) : JSON.stringify(details.body ?? "");
          console.log(`[submit ${attempt}/${maxAttempts}] ❌ ${err.code} | upstream=${upstream} | acct=${account.tokenId} | ${Date.now() - started}ms | ${bodyText}`);
          if (upstream === 408 && attempt < maxAttempts) {
            await sleep(backoffMs);
            continue;
          }
          break;
        }
      }
    }
    if (!successTask) process.exitCode = 1;
  } finally {
    child.kill("SIGKILL");
    if (relay) await relay.close();
    await sleep(800);
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    console.log("[cleanup] chromium 已停止,profile 已删除,中继已关闭");
    process.exit(process.exitCode ?? 0);
  }
}

main().catch(async (error) => {
  console.error("poc failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
