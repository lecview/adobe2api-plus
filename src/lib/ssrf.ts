import axios from "axios";
import dns from "node:dns/promises";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, rename, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { AppError } from "@/lib/errors";
import { decryptSecret } from "@/lib/crypto";
import type { ProxySnapshotEntry } from "@/lib/proxy-pool";

const MEDIA_MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "image/x-ms-bmp": "image/bmp",
  "image/vnd.microsoft.icon": "image/x-icon",
  "video/mov": "video/quicktime",
  "video/x-m4v": "video/mp4",
  "video/mkv": "video/x-matroska",
  "video/avi": "video/x-msvideo",
  "video/wmv": "video/x-ms-wmv",
  "video/flv": "video/x-flv",
  "video/mpeg2": "video/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/oga": "audio/ogg",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-aac": "audio/aac",
  "audio/x-flac": "audio/flac",
  "audio/x-opus": "audio/opus",
  "audio/x-matroska": "audio/matroska",
  "audio/x-caf": "audio/caf",
  "audio/mid": "audio/midi",
};

const MEDIA_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  dib: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  icns: "image/icns",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  ogv: "video/ogg",
  oggvideo: "video/ogg",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  avi: "video/x-msvideo",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  ts: "video/mp2t",
  m2ts: "video/mp2t",
  mts: "video/mp2t",
  flv: "video/x-flv",
  wmv: "video/x-ms-wmv",
  asf: "video/x-ms-asf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  wave: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/opus",
  amr: "audio/amr",
  mid: "audio/midi",
  midi: "audio/midi",
  caf: "audio/caf",
  mka: "audio/matroska",
};

export function normalizeMediaMime(value: unknown): string {
  const normalized = typeof value === "string" ? value.split(";", 1)[0]?.trim().toLowerCase() ?? "" : "";
  return MEDIA_MIME_ALIASES[normalized] ?? normalized;
}

export function inferMediaMimeFromUrl(input: string): string | undefined {
  try {
    const url = new URL(input, "https://media.invalid");
    const pathname = decodeURIComponent(url.pathname);
    const extension = pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    return extension ? MEDIA_MIME_BY_EXTENSION[extension] : undefined;
  } catch {
    return undefined;
  }
}

function ipv4Parts(value: string): number[] | null {
  if (net.isIP(value) !== 4) return null;
  const parts = value.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function ipv6Words(value: string): number[] | null {
  if (net.isIP(value) !== 6) return null;
  const normalized = value.split("%", 1)[0]?.toLowerCase() ?? "";
  const sections = normalized.split("::");
  if (sections.length > 2) return null;

  const parseSection = (section: string): number[] | null => {
    if (!section) return [];
    const parts = section.split(":");
    const words: number[] = [];
    for (const part of parts) {
      if (part.includes(".")) {
        const ipv4 = part.split(".").map(Number);
        if (ipv4.length !== 4 || ipv4.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return null;
        words.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      words.push(Number.parseInt(part, 16));
    }
    return words;
  };

  const left = parseSection(sections[0] ?? "");
  const right = parseSection(sections[1] ?? "");
  if (!left || !right) return null;
  if (sections.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

export function isPrivateAddress(value: string): boolean {
  const normalizedValue = value.trim().replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = ipv4Parts(normalizedValue);
  if (ipv4) {
    const [a, b, c, d] = ipv4;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b! >= 64 && b! <= 127) || (a === 168 && b === 63 && c === 129 && d === 16) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113) || a! >= 224;
  }
  const ipv6 = ipv6Words(normalizedValue);
  if (ipv6) {
    const isIpv4Compatible = ipv6.slice(0, 6).every((word) => word === 0);
    const isIpv4Mapped = ipv6.slice(0, 5).every((word) => word === 0) && ipv6[5] === 0xffff;
    if (isIpv4Mapped || isIpv4Compatible) {
      const mapped = `${ipv6[6]! >> 8}.${ipv6[6]! & 255}.${ipv6[7]! >> 8}.${ipv6[7]! & 255}`;
      if (isIpv4Mapped || isPrivateAddress(mapped)) return isPrivateAddress(mapped);
    }
    const first = ipv6[0]!;
    return ipv6.every((word) => word === 0) || (first === 0 && ipv6.slice(0, 7).every((word) => word === 0) && ipv6[7] === 1) || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00 || (first === 0x0100 && ipv6[1] === 0 && ipv6[2] === 0 && ipv6[3] === 0) || (first === 0x2001 && ipv6[1] === 0x0002 && ipv6[2] === 0) || (first === 0x2001 && ipv6[1]! >= 0x0010 && ipv6[1]! <= 0x002f) || (first === 0x2001 && ipv6[1] === 0x0db8);
  }
  const hostname = normalizedValue.replace(/\.+$/, "");
  return hostname === "localhost" || hostname === "local" || hostname.endsWith(".localhost") || hostname.endsWith(".local");
}

type SafeAddress = { address: string; family: 4 | 6 };

async function resolveSafeRemoteUrl(input: string): Promise<{ url: URL; addresses: SafeAddress[] }> {
  let url: URL;
  try { url = new URL(input); } catch { throw new AppError("invalid_media_url", "Invalid media URL", 400); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AppError("invalid_media_url", "Only credential-free HTTP(S) media URLs are allowed", 400);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const normalizedHostname = hostname.replace(/\.+$/, "").toLowerCase();
  if (normalizedHostname === "metadata.google.internal" || normalizedHostname === "metadata.google.com" || normalizedHostname === "instance-data.ec2.internal" || normalizedHostname === "localhost" || normalizedHostname.endsWith(".localhost") || normalizedHostname.endsWith(".local") || normalizedHostname.endsWith(".internal")) {
    throw new AppError("blocked_media_url", "Remote media URL uses a reserved hostname", 400);
  }
  let addresses: SafeAddress[];
  try {
    addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }]
      : (await dns.lookup(hostname, { all: true })).map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
  } catch {
    throw new AppError("blocked_media_url", "Remote media hostname could not be resolved", 400);
  }
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new AppError("blocked_media_url", "Remote media URL resolves to a private address", 400);
  return { url, addresses };
}

export async function assertSafeRemoteUrl(input: string): Promise<URL> {
  return (await resolveSafeRemoteUrl(input)).url;
}

function pinnedLookup(addresses: SafeAddress[]) {
  return (_hostname: string, options: object, callback: (error: Error | null, address: string, family?: 4 | 6) => void) => {
    const requestedFamily = typeof options === "object" && options !== null && "family" in options ? Number((options as { family?: unknown }).family) : 0;
    const selected = addresses.find((entry) => !requestedFamily || entry.family === requestedFamily) ?? addresses[0];
    if (!selected) return callback(new Error("safe DNS resolution returned no address"), "");
    callback(null, selected.address, selected.family);
  };
}

type RemoteMediaFile = {
  filePath: string;
  byteSize: number;
  sha256: string;
  mimeType: string;
  finalUrl: string;
};

const REMOTE_MEDIA_PARENT = path.join(os.tmpdir(), "adobe2api-plus-remote-media");
const REMOTE_MEDIA_ENTRY_PREFIX = "entry-";

function writeChunk(output: ReturnType<typeof createWriteStream>, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      output.off("drain", onDrain);
      output.off("error", onError);
    };
    output.once("error", onError);
    if (output.write(bytes)) {
      cleanup();
      resolve();
    } else {
      output.once("drain", onDrain);
    }
  });
}

function closeStream(output: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onClose = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      output.off("close", onClose);
      output.off("error", onError);
    };
    output.once("close", onClose);
    output.once("error", onError);
    output.end();
  });
}

async function streamToTemporaryFile(source: Readable, maxBytes: number): Promise<Omit<RemoteMediaFile, "mimeType" | "finalUrl">> {
  await mkdir(REMOTE_MEDIA_PARENT, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(REMOTE_MEDIA_PARENT, REMOTE_MEDIA_ENTRY_PREFIX));
  const temporary = path.join(directory, "media.part");
  const target = path.join(directory, "media");
  const output = createWriteStream(temporary, { mode: 0o600 });
  const digest = createHash("sha256");
  let byteSize = 0;
  try {
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += bytes.byteLength;
      if (byteSize > maxBytes) {
        source.destroy();
        throw new AppError("media_too_large", "Remote media exceeds the configured size limit", 400);
      }
      digest.update(bytes);
      await writeChunk(output, bytes);
    }
    await closeStream(output);
    await rename(temporary, target);
    return { filePath: target, byteSize, sha256: digest.digest("hex") };
  } catch (error) {
    source.destroy();
    output.destroy();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError("media_download_failed", "Remote media stream could not be read", 400);
  }
}

export async function cleanupRemoteMedia(filePath: string): Promise<void> {
  const directory = path.resolve(path.dirname(filePath));
  const temporaryParent = path.resolve(REMOTE_MEDIA_PARENT);
  const directoryName = path.basename(directory);
  if (path.dirname(directory) !== temporaryParent || !directoryName.startsWith(REMOTE_MEDIA_ENTRY_PREFIX)) return;
  await rm(directory, { recursive: true, force: true });
}

export async function cleanupStaleRemoteMedia(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  const entries = await readdir(REMOTE_MEDIA_PARENT, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(REMOTE_MEDIA_ENTRY_PREFIX)) continue;
    const directory = path.join(REMOTE_MEDIA_PARENT, entry.name);
    const details = await stat(directory).catch(() => null);
    if (!details || details.mtimeMs >= cutoff) continue;
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    removed += 1;
  }
  return removed;
}

function proxyUrl(proxy: ProxySnapshotEntry): string {
  const username = proxy.encryptedUsername ? encodeURIComponent(decryptSecret(proxy.encryptedUsername)) : "";
  const password = proxy.encryptedPassword ? encodeURIComponent(decryptSecret(proxy.encryptedPassword)) : "";
  const credentials = username ? `${username}${password ? `:${password}` : ""}@` : "";
  // socks5h keeps hostname resolution on the proxy. SSRF validation still
  // resolves the destination locally before any request is opened.
  return `${proxy.protocol === "SOCKS5" ? "socks5h" : "http"}://${credentials}${proxy.host}:${proxy.port}`;
}

function proxyAgent(proxy: ProxySnapshotEntry, targetProtocol: string) {
  const url = proxyUrl(proxy);
  if (proxy.protocol === "SOCKS5") return new SocksProxyAgent(url);
  return targetProtocol === "https:" ? new HttpsProxyAgent(url) : new HttpProxyAgent(url);
}

function isProxyGatewayStatus(status: number): boolean {
  return [407, 408, 502, 503, 504].includes(status);
}

export async function downloadRemoteMedia(input: string, options: { maxBytes: number; allowedMime?: string[]; maxRedirects?: number; proxy?: ProxySnapshotEntry | null }): Promise<RemoteMediaFile> {
  let current = input;
  const maxRedirects = options.maxRedirects ?? 3;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const resolved = await resolveSafeRemoteUrl(current);
    const url = resolved.url;
    const agent = options.proxy ? proxyAgent(options.proxy, url.protocol) : undefined;
    const response = await axios.get<Readable>(url.toString(), {
      responseType: "stream",
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      maxRedirects: 0,
      timeout: 20_000,
      validateStatus: () => true,
      ...(agent ? { httpAgent: agent, httpsAgent: agent, proxy: false } : { lookup: pinnedLookup(resolved.addresses) }),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      response.data.destroy();
      const location = response.headers.location;
      if (!location) throw new AppError("invalid_media_redirect", "Remote media redirect has no location", 400);
      current = new URL(location, url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      response.data.destroy();
      if (options.proxy && isProxyGatewayStatus(response.status)) {
        throw new AppError("media_download_failed", "Remote media proxy gateway failed", 503, { proxyEligible: true });
      }
      throw new AppError("media_download_failed", `Remote media returned HTTP ${response.status}`, 400);
    }
    const headerMime = normalizeMediaMime(response.headers["content-type"]);
    const extensionMime = inferMediaMimeFromUrl(url.toString());
    const mime = !headerMime || ["application/octet-stream", "application/binary", "binary/octet-stream", "*/*"].includes(headerMime) ? extensionMime ?? headerMime : headerMime;
    const allowedMime = options.allowedMime?.map((value) => normalizeMediaMime(value));
    if (allowedMime?.length && (!mime || !allowedMime.some((candidate) => candidate.endsWith("/*") ? mime.startsWith(candidate.slice(0, -1)) : candidate === mime))) {
      response.data.destroy();
      throw new AppError("invalid_media_type", "Remote media type is not allowed", 400);
    }
    const advertisedLength = Number(response.headers["content-length"] ?? "");
    if (Number.isFinite(advertisedLength) && advertisedLength > options.maxBytes) {
      response.data.destroy();
      throw new AppError("media_too_large", "Remote media exceeds the configured size limit", 400);
    }
    try {
      const file = await streamToTemporaryFile(response.data, options.maxBytes);
      return { ...file, mimeType: mime || "application/octet-stream", finalUrl: url.toString() };
    } catch (error) {
      response.data.destroy();
      if (error instanceof AppError) throw error;
      throw new AppError("media_download_failed", "Remote media stream could not be read", 400);
    }
  }
  throw new AppError("too_many_media_redirects", "Remote media exceeded redirect limit", 400);
}
