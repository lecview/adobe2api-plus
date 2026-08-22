import { gzipSync } from "node:zlib";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect, createServer as createNetServer, type Server as NetServer } from "node:net";
import { Readable } from "node:stream";
import { encryptSecret } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { FetchAdobeTransport } from "@/lib/adobe/transport";
import type { ProxySnapshotEntry } from "@/lib/proxy-pool";

type TargetRecord = { path: string; headers: IncomingMessage["headers"]; body: Buffer };

function listen(server: Server | NetServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("server did not expose a TCP port"));
      else resolve(address.port);
    });
  });
}

function close(server: Server | NetServer): Promise<void> {
  const closable = server as Server & { closeAllConnections?: () => void };
  closable.closeAllConnections?.();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function makeTarget(records: TargetRecord[]): Server {
  return createServer(async (request, response) => {
    const body = await bodyOf(request);
    records.push({ path: request.url ?? "", headers: request.headers, body });
    const pathname = new URL(request.url ?? "/", "http://target.local").pathname;
    if (pathname === "/slow") {
      setTimeout(() => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ slow: true })); }, 100);
      return;
    }
    if (pathname === "/redirect") {
      response.writeHead(302, { Location: "/json" });
      response.end();
      return;
    }
    if (pathname === "/compressed") {
      const payload = gzipSync(Buffer.from(JSON.stringify({ compressed: true })));
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      response.end(payload);
      return;
    }
    if (pathname === "/bytes") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from("binary-content"));
      return;
    }
    if (pathname === "/upload") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ byte_length: body.length }));
      return;
    }
    if (pathname === "/json-body") {
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ parsed, content_type: request.headers["content-type"] ?? null }));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_json" }));
      }
      return;
    }
    if (pathname === "/upload-redirect") {
      response.writeHead(307, { Location: "/upload" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, cookie: request.headers.cookie ?? null, test_header: request.headers["x-transport-test"] ?? null }));
  });
}

function makeHttpProxy(): { server: Server; authHeaders: string[] } {
  const authHeaders: string[] = [];
  const server = createServer((request, response) => {
    const rawTarget = request.url ?? "/";
    const target = new URL(rawTarget, `http://${request.headers.host ?? "127.0.0.1"}`);
    authHeaders.push(String(request.headers["proxy-authorization"] ?? ""));
    const forwardedHeaders: Record<string, string | string[] | undefined> = { ...request.headers, host: target.host };
    delete forwardedHeaders["proxy-authorization"];
    delete forwardedHeaders["proxy-connection"];
    const upstream = httpRequest({ hostname: target.hostname, port: Number(target.port || 80), method: request.method, path: `${target.pathname}${target.search}`, headers: forwardedHeaders }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  // undici ProxyAgent 对包括 http:// 在内的所有目标都建立 CONNECT 隧道，
  // 因此代理需要支持 CONNECT 转发，与真实 HTTP 代理行为一致。
  server.on("connect", (request, clientSocket, head) => {
    authHeaders.push(String(request.headers["proxy-authorization"] ?? ""));
    const [host, portText] = (request.url ?? "").split(":");
    const upstream = netConnect({ host, port: Number(portText || 443) }, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  return { server, authHeaders };
}

function makeSocks5Proxy(): NetServer {
  return createNetServer((client) => {
    let buffer = Buffer.alloc(0);
    let stage: "greeting" | "request" = "greeting";
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting") {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]);
        client.write(Buffer.from([5, 0]));
        stage = "request";
      }
      if (stage !== "request" || buffer.length < 7) return;
      const addressType = buffer[3];
      let offset = 4;
      let host: string;
      if (addressType === 1) {
        if (buffer.length < 10) return;
        host = Array.from(buffer.subarray(offset, offset + 4)).join(".");
        offset += 4;
      } else if (addressType === 3) {
        const length = buffer[offset];
        if (buffer.length < offset + 1 + length + 2) return;
        offset += 1;
        host = buffer.subarray(offset, offset + length).toString("utf8");
        offset += length;
      } else if (addressType === 4) {
        if (buffer.length < 22) return;
        host = buffer.subarray(offset, offset + 16).toString("hex").match(/.{1,4}/g)?.join(":") ?? "::1";
        offset += 16;
      } else {
        client.destroy();
        return;
      }
      const port = buffer.readUInt16BE(offset);
      client.removeListener("data", onData);
      const upstream = netConnect({ host, port }, () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
    client.on("error", () => client.destroy());
  });
}

describe("local HTTP/SOCKS5 transport compatibility", () => {
  const records: TargetRecord[] = [];
  const originalKey = process.env.ENCRYPTION_KEY;
  let target: Server;
  let httpProxy: Server;
  let socksProxy: NetServer;
  let targetPort = 0;
  let httpPort = 0;
  let socksPort = 0;
  let httpAuthHeaders: string[] = [];

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
    target = makeTarget(records);
    const proxy = makeHttpProxy();
    httpProxy = proxy.server;
    httpAuthHeaders = proxy.authHeaders;
    socksProxy = makeSocks5Proxy();
    targetPort = await listen(target);
    httpPort = await listen(httpProxy);
    socksPort = await listen(socksProxy);
  });

  afterAll(async () => {
    await Promise.all([close(target), close(httpProxy), close(socksProxy)]);
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
  });

  it("handles headers, cookies, redirects, compression, upload and download over HTTP proxy", async () => {
    const proxy: ProxySnapshotEntry = { id: "http-local", version: 1, protocol: "HTTP", host: "127.0.0.1", port: httpPort, encryptedUsername: encryptSecret("proxy-user"), encryptedPassword: encryptSecret("proxy-password") };
    const transport = new FetchAdobeTransport(`http://127.0.0.1:${targetPort}`);
    const response = await transport.request<{ ok: boolean; cookie: string; test_header: string }>({ path: "/json", headers: { Cookie: "sid=fixture", "x-transport-test": "header-fixture" }, proxy });
    expect(response.data).toMatchObject({ ok: true, cookie: "sid=fixture", test_header: "header-fixture" });
    expect(httpAuthHeaders.at(-1)).toMatch(/^Basic /);
    expect((await transport.request<{ compressed: boolean }>({ path: "/compressed", proxy })).data.compressed).toBe(true);
    expect((await transport.request({ path: "/redirect", proxy })).status).toBe(200);
    expect((await transport.upload<{ byte_length: number }>("/upload", Buffer.from("upload-body"), { proxy })).data.byte_length).toBe(11);
    expect((await transport.upload<{ byte_length: number }>("/upload", Readable.from([Buffer.from("stream-body")]), { proxy, headers: { "Content-Type": "image/png", "Content-Length": "11" } })).data.byte_length).toBe(11);
    expect(records.at(-1)?.headers["content-length"]).toBe("11");
    expect((await transport.upload("/upload-redirect", Readable.from([Buffer.from("stream-body")]), { proxy })).status).toBe(307);
    const downloaded = await transport.download(`http://127.0.0.1:${targetPort}/bytes`, { proxy });
    expect(Buffer.from(downloaded.data).toString()).toBe("binary-content");
    const streamed = await transport.downloadStream(`http://127.0.0.1:${targetPort}/bytes`, { proxy });
    const streamChunks: Buffer[] = [];
    for await (const chunk of streamed.data) streamChunks.push(Buffer.from(chunk));
    expect(Buffer.concat(streamChunks).toString()).toBe("binary-content");
  });

  it("uses a SOCKS5 agent and preserves cancellation/timeout classification", async () => {
    const proxy: ProxySnapshotEntry = { id: "socks-local", version: 1, protocol: "SOCKS5", host: "127.0.0.1", port: socksPort };
    const transport = new FetchAdobeTransport(`http://127.0.0.1:${targetPort}`);
    expect((await transport.request<{ ok: boolean }>({ path: "/json", proxy })).data.ok).toBe(true);
    await expect(transport.request({ path: "/slow", proxy, timeoutMs: 20 })).rejects.toMatchObject({ code: "adobe_transport_error", details: { kind: "timeout" } });
    const controller = new AbortController();
    controller.abort();
    await expect(transport.request({ path: "/json", proxy, signal: controller.signal })).rejects.toBeInstanceOf(AppError);
  });

  it("serializes object and array bodies consistently across direct, HTTP and SOCKS5 requests", async () => {
    type JsonBodyResponse = { parsed: unknown; content_type: string | null };
    const objectBody = { prompt: "local fixture", options: { count: 2 } };
    const arrayBody = [{ id: 1 }, { id: 2 }];
    const transport = new FetchAdobeTransport(`http://127.0.0.1:${targetPort}`);
    const httpProxy: ProxySnapshotEntry = { id: "http-json", version: 1, protocol: "HTTP", host: "127.0.0.1", port: httpPort };
    const socksProxy: ProxySnapshotEntry = { id: "socks-json", version: 1, protocol: "SOCKS5", host: "127.0.0.1", port: socksPort };

    const direct = await transport.request<JsonBodyResponse>({ method: "POST", path: "/json-body", body: objectBody });
    expect(direct.data).toEqual({ parsed: objectBody, content_type: "application/json" });

    const viaHttp = await transport.request<JsonBodyResponse>({ method: "POST", path: "/json-body", body: arrayBody, proxy: httpProxy });
    expect(viaHttp.data).toEqual({ parsed: arrayBody, content_type: "application/json" });

    const viaSocks = await transport.request<JsonBodyResponse>({ method: "POST", path: "/json-body", body: objectBody, proxy: socksProxy });
    expect(viaSocks.data).toEqual({ parsed: objectBody, content_type: "application/json" });
  });

  it("passes binary, Blob and FormData bodies through unchanged", async () => {
    const transport = new FetchAdobeTransport(`http://127.0.0.1:${targetPort}`);
    const socksProxy: ProxySnapshotEntry = { id: "socks-raw", version: 1, protocol: "SOCKS5", host: "127.0.0.1", port: socksPort };
    const bytes = new Uint8Array(Buffer.from("typed-array-body"));
    await transport.request({ method: "POST", path: "/upload", body: bytes });
    expect(records.at(-1)?.body.equals(Buffer.from(bytes))).toBe(true);

    await transport.request({ method: "POST", path: "/upload", body: bytes, proxy: socksProxy });
    expect(records.at(-1)?.body.equals(Buffer.from(bytes))).toBe(true);

    const blob = new Blob(["blob-body"], { type: "text/plain" });
    await transport.request({ method: "POST", path: "/upload", body: blob });
    expect(records.at(-1)?.body.toString("utf8")).toBe("blob-body");
    expect(records.at(-1)?.headers["content-type"]).toBe("text/plain");

    const form = new FormData();
    form.set("fixture", "form-data-body");
    await transport.upload("/upload", form);
    expect(records.at(-1)?.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(records.at(-1)?.body.toString("utf8")).toContain('name="fixture"');
    expect(records.at(-1)?.body.toString("utf8")).toContain("form-data-body");

    const socksForm = new FormData();
    socksForm.set("fixture", "socks-form-data-body");
    await transport.upload("/upload", socksForm, { proxy: socksProxy });
    expect(records.at(-1)?.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(records.at(-1)?.body.toString("utf8")).toContain('name="fixture"');
    expect(records.at(-1)?.body.toString("utf8")).toContain("socks-form-data-body");
  });
});
