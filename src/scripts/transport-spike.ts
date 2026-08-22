import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { FetchAdobeTransport } from "@/lib/adobe/transport";
import { encryptSecret } from "@/lib/crypto";
import { parseProxyUrl, type ProxySnapshotEntry } from "@/lib/proxy-pool";

type SpikeResult = { name: string; ok: boolean; duration_ms: number; status?: number; error_code?: string; kind?: string };
type SpikeResponse = { status?: number; data?: unknown };

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = argument(`--${name}`) ?? process.env[`SPIKE_${name.toUpperCase().replace(/-/g, "_")}`];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredPositiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

function proxyEntry(raw: string | undefined, id: string): ProxySnapshotEntry | null {
  if (!raw) return null;
  const parsed = parseProxyUrl(raw);
  return {
    id,
    version: 1,
    protocol: parsed.protocol,
    host: parsed.host,
    port: parsed.port,
    encryptedUsername: parsed.username ? encryptSecret(parsed.username) : null,
    encryptedPassword: parsed.password ? encryptSecret(parsed.password) : null,
  };
}

async function main() {
  const baseUrl = required("base-url").replace(/\/$/, "");
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.protocol !== "https:" && process.env.SPIKE_ALLOW_HTTP !== "1") {
    throw new Error("base-url must use https (set SPIKE_ALLOW_HTTP=1 only for a local fixture)");
  }
  const cookie = required("cookie");
  const token = argument("--token") ?? process.env.SPIKE_TOKEN;
  const userAgent = process.env.SPIKE_USER_AGENT ?? "Adobe2API-Node-Transport-Spike/1.0";
  const testHeader = required("test-header");
  const headers = { "User-Agent": userAgent, Cookie: cookie, "x-transport-test": testHeader, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const transport = new FetchAdobeTransport(baseUrl);
  const httpProxy = proxyEntry(argument("--http-proxy") ?? process.env.SPIKE_HTTP_PROXY, "spike-http");
  const socksProxy = proxyEntry(argument("--socks5-proxy") ?? process.env.SPIKE_SOCKS5_PROXY, "spike-socks5");
  if (!httpProxy || !socksProxy) throw new Error("both http-proxy and socks5-proxy are required for the compatibility gate");
  const results: SpikeResult[] = [];

  async function check(name: string, callback: () => Promise<SpikeResponse>, expectedErrorKind?: string) {
    const started = Date.now();
    try {
      const response = await callback();
      results.push({ name, ok: expectedErrorKind === undefined && (response.status === undefined || (response.status >= 200 && response.status < 400)), duration_ms: Date.now() - started, status: response.status });
    } catch (error) {
      const details = error && typeof error === "object" && "details" in error ? (error as { details?: unknown }).details : undefined;
      const record = details && typeof details === "object" ? details as Record<string, unknown> : {};
      const kind = typeof record.kind === "string" ? record.kind : undefined;
      results.push({ name, ok: expectedErrorKind !== undefined && kind === expectedErrorKind, duration_ms: Date.now() - started, error_code: error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "transport_error", kind });
    }
  }

  const jsonPath = process.env.SPIKE_JSON_PATH ?? "/";
  const redirectPath = process.env.SPIKE_REDIRECT_PATH ?? "/redirect";
  const compressedPath = process.env.SPIKE_COMPRESSED_PATH ?? "/compressed";
  const uploadPath = process.env.SPIKE_UPLOAD_PATH ?? "/upload";
  const downloadPath = process.env.SPIKE_DOWNLOAD_PATH ?? "/bytes";
  const timeoutPath = process.env.SPIKE_TIMEOUT_PATH ?? "/slow";
  const timeoutMs = requiredPositiveInteger("timeout-ms");
  const requestWith = (proxy: ProxySnapshotEntry | null, pathValue: string) => transport.request({ path: pathValue, headers, token, proxy, timeoutMs });
  const expectCookie = required("expect-cookie");
  const expectHeader = required("expect-header");
  const expectUploadBytes = requiredPositiveInteger("expect-upload-bytes");
  const expectDownloadSha256 = required("expect-download-sha256");
  const expectedRedirectStatus = Number(process.env.SPIKE_EXPECT_REDIRECT_STATUS ?? 200);
  if (!Number.isInteger(expectedRedirectStatus) || expectedRedirectStatus < 200 || expectedRedirectStatus >= 400) {
    throw new Error("SPIKE_EXPECT_REDIRECT_STATUS must be an integer from 200 through 399");
  }

  const assertEcho = (data: unknown) => {
    const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
    if (expectCookie && record.cookie !== expectCookie) throw new Error("cookie_echo_mismatch");
    if (expectHeader && record.test_header !== expectHeader) throw new Error("header_echo_mismatch");
    return record;
  };

  const readDownload = async (response: SpikeResponse & { data: ArrayBuffer }): Promise<SpikeResponse> => {
    const bytes = Buffer.from(response.data);
    if (expectDownloadSha256 && createHash("sha256").update(bytes).digest("hex") !== expectDownloadSha256) throw new Error("download_checksum_mismatch");
    return { status: response.status, data: { byte_length: bytes.byteLength } };
  };

  await check("json_headers_cookie_tls", async () => {
    const response = await requestWith(null, jsonPath);
    assertEcho(response.data);
    return response;
  });
  await check("redirect_follow", async () => {
    const response = await requestWith(null, redirectPath);
    if (response.status !== expectedRedirectStatus) throw new Error("redirect_status_mismatch");
    return response;
  });
  await check("compressed_response", async () => {
    const response = await requestWith(null, compressedPath);
    const record = response.data && typeof response.data === "object" ? response.data as Record<string, unknown> : {};
    if (record.compressed !== true) throw new Error("compressed_body_mismatch");
    return response;
  });
  await check("upload", async () => {
    const body = new TextEncoder().encode("transport-spike");
    if (body.byteLength !== expectUploadBytes) throw new Error("configured_upload_fixture_length_mismatch");
    const response = await transport.upload(uploadPath, body, { headers, token });
    const record = response.data && typeof response.data === "object" ? response.data as Record<string, unknown> : {};
    if (Number(record.byte_length ?? record.byteLength) !== expectUploadBytes) throw new Error("upload_length_mismatch");
    return response;
  });
  await check("download", () => transport.download(new URL(downloadPath, `${baseUrl}/`).toString(), { headers, token }).then(readDownload));
  await check("download_stream", async () => {
    const response = await transport.downloadStream(new URL(downloadPath, `${baseUrl}/`).toString(), { headers, token });
    const chunks: Buffer[] = [];
    for await (const chunk of response.data) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (expectDownloadSha256 && createHash("sha256").update(bytes).digest("hex") !== expectDownloadSha256) throw new Error("download_checksum_mismatch");
    return { status: response.status, data: { byte_length: bytes.byteLength } };
  });
  await check("timeout", async () => {
    const response = await transport.request({ path: timeoutPath, headers, token, timeoutMs });
    return { status: response.status };
  }, "timeout");
  await check("http_proxy", async () => { const response = await requestWith(httpProxy, jsonPath); assertEcho(response.data); return response; });
  await check("socks5_proxy", async () => { const response = await requestWith(socksProxy, jsonPath); assertEcho(response.data); return response; });

  const output = { generated_at: new Date().toISOString(), base_url: safeUrl(baseUrl), proxy_protocols: [httpProxy && "HTTP", socksProxy && "SOCKS5"].filter(Boolean), results, gate: results.every((result) => result.ok) ? "passed" : "blocked" };
  const outputPath = argument("--output") ?? process.env.SPIKE_OUTPUT;
  if (outputPath) {
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o640 });
  }
  console.log(JSON.stringify(output, null, 2));
  if (output.gate !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "transport spike failed");
  process.exitCode = 1;
});
