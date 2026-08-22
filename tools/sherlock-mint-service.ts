/**
 * 宿主机 sherlock 铸造服务（macOS/Docker Desktop 部署必需）。
 *
 * 为什么需要它：
 *   sherlockToken 铸造要 puppeteer 连 Roxy 打开的 Chrome（CDP WebSocket），
 *   而 Roxy 的 Chrome CDP 端口是随机端口、且只监听宿主机 127.0.0.1，
 *   Docker 容器无法通过 host.docker.internal 访问（Roxy 返回 500）。
 *   因此铸造必须在宿主机本地执行，本服务监听 0.0.0.0:50002，
 *   容器配 ROXYBROWSER_MINT_API=http://host.docker.internal:50002 后走 POST /mint 拿 token。
 *
 * 启动（宿主机，需 Roxy 客户端已在跑）：
 *   npm run mint-service
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// ── 关键：覆盖环境变量，确保走的铸造逻辑是「宿主机直连 127.0.0.1 CDP」──
// 1) 防递归：绝不让 pullSherlockFromRoxyBrowser 再走 mint 分支（否则死循环）
process.env.ROXYBROWSER_MINT_API = "";
// 2) 直连宿主机：不把 ws 地址里的 127.0.0.1 替换成 host.docker.internal
process.env.ROXYBROWSER_CDP_HOST = "";
// 3) API_BASE 用宿主机直连地址（把容器用的 host.docker.internal 换回 127.0.0.1）
const rawBase = process.env.ROXYBROWSER_API_BASE || "http://127.0.0.1:50000";
process.env.ROXYBROWSER_API_BASE = rawBase.replace(/host\.docker\.internal/g, "127.0.0.1");

const PORT = Number(process.env.ROXYBROWSER_MINT_PORT || "50002");

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 惰性加载铸造函数（动态 import 避免启动时就牵引整个 sherlock 依赖链） */
let pullFn: (() => Promise<string>) | null = null;
async function loadPull(): Promise<() => Promise<string>> {
  if (pullFn) return pullFn;
  const mod = (await import("@/lib/adobe/sherlock")) as { pullSherlockFromRoxyBrowser: () => Promise<string> };
  pullFn = mod.pullSherlockFromRoxyBrowser;
  return pullFn;
}

/** 并发锁：同一时刻只允许一次铸造，避免同时开一堆 Roxy 窗口 */
let minting: Promise<string> | null = null;
async function mintOnce(): Promise<string> {
  if (minting) return minting;
  const pull = await loadPull();
  minting = pull().finally(() => {
    minting = null;
  });
  return minting;
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "").split("?")[0];

  if (req.method === "GET" && (url === "/" || url === "/health")) {
    sendJson(res, 200, {
      ok: true,
      service: "sherlock-mint-service",
      apiBase: process.env.ROXYBROWSER_API_BASE,
      tokenConfigured: Boolean(process.env.ROXYBROWSER_API_TOKEN),
    });
    return;
  }

  if (req.method === "POST" && url === "/mint") {
    try {
      await readBody(req); // 目前无入参，读掉 body 避免连接悬挂
      const token = await mintOnce();
      sendJson(res, 200, { ok: true, token });
    } catch (error) {
      const message = error instanceof Error ? error.message : "mint failed";
      console.error(`[mint] 铸造失败: ${message}`);
      sendJson(res, 500, { ok: false, error: message });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[sherlock-mint-service] listening on 0.0.0.0:${PORT}`);
  console.log(`[sherlock-mint-service] apiBase = ${process.env.ROXYBROWSER_API_BASE}`);
  console.log(
    `[sherlock-mint-service] tokenConfigured = ${process.env.ROXYBROWSER_API_TOKEN ? "yes" : "NO（请设置 ROXYBROWSER_API_TOKEN）"}`,
  );
});
