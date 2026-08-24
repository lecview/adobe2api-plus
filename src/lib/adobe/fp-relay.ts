/**
 * 本地 HTTP CONNECT → 上游 SOCKS5 中继（供 fingerprint-chromium 使用）。
 *
 * Chromium 对 `--proxy-server=socks5://user:pass@host` 存在已知缺陷
 * （页面导航报 net::ERR_NO_SUPPORTED_PROXIES），因此 SOCKS5 节点无法直接
 * 传给浏览器。这里在 127.0.0.1 起一个无认证 HTTP CONNECT 代理，把隧道带
 * 认证转发到上游 SOCKS5 节点（远端 DNS），浏览器侧只看到普通 http 代理。
 */
import { createServer, type Server, type Socket } from "node:net";
import { SocksClient } from "socks";
import { decryptSecret } from "@/lib/crypto";
import type { ProxySnapshotEntry } from "@/lib/proxy-pool";

export type FpRelay = { port: number; close: () => Promise<void> };

export async function startSocksRelay(entry: ProxySnapshotEntry): Promise<FpRelay> {
  const username = entry.encryptedUsername ? decryptSecret(entry.encryptedUsername) : "";
  const password = entry.encryptedPassword ? decryptSecret(entry.encryptedPassword) : "";
  const proxyInfo = {
    host: entry.host,
    port: entry.port,
    type: 5 as const,
    userId: username || undefined,
    password: password || undefined,
  };

  const server: Server = createServer((client: Socket) => {
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
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
