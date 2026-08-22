import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { AppError } from "@/lib/errors";
import type { ProxySnapshotEntry } from "@/lib/proxy-pool";
import { cleanupRemoteMedia, downloadRemoteMedia, inferMediaMimeFromUrl } from "@/lib/ssrf";

export type ReferencePurpose = "mask";
type ReferenceMediaBase = { kind: "image" | "video" | "audio"; byteSize: number; mimeType: string; source: string; purpose?: ReferencePurpose };
export type ReferenceMedia =
  | (ReferenceMediaBase & { sourceType: "inline"; bytes: Uint8Array })
  | (ReferenceMediaBase & { sourceType: "file"; filePath: string });

const INLINE_MIME_TYPES: Record<ReferenceMedia["kind"], readonly string[]> = {
  image: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/apng", "image/avif", "image/bmp", "image/x-ms-bmp", "image/tiff", "image/heic", "image/heif", "image/x-icon", "image/vnd.microsoft.icon"],
  video: ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v", "video/x-matroska", "video/mkv", "video/ogg", "video/mpeg", "video/x-msvideo", "video/avi", "video/3gpp", "video/3gpp2", "video/mp2t", "video/x-flv", "video/x-ms-wmv", "video/x-ms-asf"],
  audio: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/aac", "audio/flac", "audio/opus", "audio/webm", "audio/amr", "audio/3gpp", "audio/midi", "audio/x-midi", "audio/x-matroska", "audio/matroska", "audio/caf", "audio/x-caf"],
};

const MIME_ALIASES: Record<string, string> = {
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
  "audio/x-ogg": "audio/ogg",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-aac": "audio/aac",
  "audio/x-flac": "audio/flac",
  "audio/x-opus": "audio/opus",
  "audio/x-matroska": "audio/matroska",
  "audio/x-caf": "audio/caf",
  "audio/mid": "audio/midi",
};

const MAX_REFERENCE_BYTES: Record<ReferenceMedia["kind"], number> = {
  image: 30 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
};

function defaultMimeType(kind: ReferenceMedia["kind"]): string {
  return kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg";
}

function canonicalMimeType(value: string): string {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return MIME_ALIASES[normalized] ?? normalized;
}

type DataUrlDescriptor = { mimeType: string; encoded: string; base64: boolean; byteSize: number };
type ReferenceSource = { kind: ReferenceMedia["kind"]; source: string; purpose?: ReferencePurpose };
type DownloadedRemoteMedia = Pick<Awaited<ReturnType<typeof downloadRemoteMedia>>, "filePath" | "byteSize" | "mimeType">;
export type ReferenceDownloadOptions = { maxBytes: number; allowedMime: string[]; proxy?: ProxySnapshotEntry | null };
export type ReferenceLoadOptions = {
  proxy?: ProxySnapshotEntry | null;
  download?: (source: string, options: ReferenceDownloadOptions) => Promise<DownloadedRemoteMedia>;
};

const NON_PROXY_DOWNLOAD_CODES = new Set(["blocked_media_url", "invalid_media_url", "invalid_media_type", "media_too_large", "invalid_media_redirect", "too_many_media_redirects"]);

function proxyDownloadFailure(error: unknown): boolean {
  if (error instanceof AppError) {
    const details = error.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details as Record<string, unknown> : {};
    if (typeof details.proxyEligible === "boolean") return details.proxyEligible;
    if (NON_PROXY_DOWNLOAD_CODES.has(error.code)) return false;
    if (error.code !== "media_download_failed") return false;
    const status = error.message.match(/HTTP\s+(\d{3})/i)?.[1];
    return status === undefined;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /aborted|connect|dns|eai_|econn|enet|host unreachable|network|proxy|socket|timeout/i.test(message);
}

function rethrowDownloadError(error: unknown, proxy: ProxySnapshotEntry | null | undefined): never {
  if (!proxy || !proxyDownloadFailure(error)) throw error;
  if (error instanceof AppError) throw new AppError(error.code, error.message, error.status, { proxyEligible: true });
  throw new AppError("media_download_failed", "Remote media download failed", 503, { proxyEligible: true });
}

function strictBase64Size(value: string): number {
  const compact = value.replace(/\s/g, "");
  if (!compact || compact.length % 4 === 1) throw new AppError("invalid_media_url", "Invalid base64 media reference", 400);
  const firstPadding = compact.indexOf("=");
  const padding = firstPadding < 0 ? 0 : compact.length - firstPadding;
  if (padding > 2 || (firstPadding >= 0 && /[^=]/.test(compact.slice(firstPadding)))) throw new AppError("invalid_media_url", "Invalid base64 media reference", 400);
  const content = padding ? compact.slice(0, -padding) : compact;
  if (!content || /[^A-Za-z0-9+/]/.test(content) || content.length % 4 === 1) throw new AppError("invalid_media_url", "Invalid base64 media reference", 400);
  if (padding === 1 && content.length % 4 !== 3) throw new AppError("invalid_media_url", "Invalid base64 media reference", 400);
  if (padding === 2 && content.length % 4 !== 2) throw new AppError("invalid_media_url", "Invalid base64 media reference", 400);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const trailing = alphabet.indexOf(content[content.length - 1] ?? "");
  if ((padding === 1 && (trailing & 3) !== 0) || (padding === 2 && (trailing & 15) !== 0)) throw new AppError("invalid_media_url", "Invalid base64 media reference", 400);
  return Math.floor(compact.length / 4) * 3 - padding;
}

export function inspectInlineDataUrl(value: string, kind: ReferenceMedia["kind"]): DataUrlDescriptor {
  const normalized = value.trim();
  if (!normalized.toLowerCase().startsWith("data:")) throw new AppError("invalid_media_url", "Invalid data URL media reference", 400);
  const comma = normalized.indexOf(",");
  if (comma < 5) throw new AppError("invalid_media_url", "Invalid data URL media reference", 400);
  const headerParts = normalized.slice(5, comma).split(";").map((part) => part.trim()).filter(Boolean);
  const rawMimeType = canonicalMimeType(headerParts.shift() || defaultMimeType(kind));
  const parameters = headerParts.map((parameter) => parameter.trim().toLowerCase());
  const base64Parameters = parameters.filter((parameter) => parameter === "base64");
  if (base64Parameters.length > 1 || parameters.some((parameter) => parameter !== "base64" && !/^[!#$&^_.+\-\w]+=([^\s;,]+)$/.test(parameter))) throw new AppError("invalid_media_url", "Invalid data URL media reference", 400);
  if (!INLINE_MIME_TYPES[kind].includes(rawMimeType)) throw new AppError("invalid_media_type", "Inline media type is not allowed", 400);
  const encoded = normalized.slice(comma + 1);
  const base64 = base64Parameters.length === 1;
  const byteSize = base64 ? strictBase64Size(encoded) : (() => {
    try {
      const decoded = decodeURIComponent(encoded);
      if (!decoded) throw new Error("empty");
      return Buffer.byteLength(decoded, "utf8");
    } catch {
      throw new AppError("invalid_media_url", "Invalid data URL media reference", 400);
    }
  })();
  return { mimeType: rawMimeType, encoded, base64, byteSize };
}

function dataUrl(value: string, kind: ReferenceMedia["kind"], purpose?: ReferencePurpose): Extract<ReferenceMedia, { sourceType: "inline" }> | null {
  if (!value.trim().toLowerCase().startsWith("data:")) return null;
  const descriptor = inspectInlineDataUrl(value, kind);
  try {
    const bytes = descriptor.base64 ? new Uint8Array(Buffer.from(descriptor.encoded.replace(/\s/g, ""), "base64")) : new Uint8Array(Buffer.from(decodeURIComponent(descriptor.encoded), "utf8"));
    if (!bytes.byteLength) throw new Error("empty");
    return { kind, sourceType: "inline", bytes, byteSize: bytes.byteLength, mimeType: descriptor.mimeType, source: "data:", ...(purpose ? { purpose } : {}) };
  } catch {
    throw new AppError("invalid_media_url", "Invalid data URL media reference", 400);
  }
}

function mediaKindFromMime(value: unknown): ReferenceMedia["kind"] | undefined {
  const mime = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return undefined;
}

function mediaKindFromDescriptor(value: unknown): ReferenceMedia["kind"] | undefined {
  const descriptor = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (descriptor.includes("image")) return "image";
  if (descriptor.includes("video")) return "video";
  if (descriptor.includes("audio")) return "audio";
  return undefined;
}

function mediaKindFromSource(value: string): ReferenceMedia["kind"] | undefined {
  const normalized = value.trim().toLowerCase();
  const dataMime = normalized.match(/^data:([^;,]*)(?:;|,)/)?.[1];
  const mime = dataMime ? canonicalMimeType(dataMime) : inferMediaMimeFromUrl(normalized);
  return mediaKindFromMime(mime);
}

function mediaKindFromKey(key: string): ReferenceMedia["kind"] | undefined {
  const compact = key.trim().toLowerCase().replace(/[_-]/g, "");
  if (["image", "images", "imageurl", "imageurls", "input", "inputimage", "inputimages", "inputreference", "reference", "references", "media", "asset", "assets", "referenceimage", "referenceimages", "imagereferences", "sourceimage", "sourceimages", "mask"].includes(compact)) return "image";
  if (["video", "videos", "videourl", "videourls", "inputvideo", "inputvideos", "referencevideo", "referencevideos", "videoreferences", "sourcevideo", "sourcevideos"].includes(compact)) return "video";
  if (["audio", "audios", "audiourl", "audiourls", "inputaudio", "inputaudios", "referenceaudio", "referenceaudios", "audioreferences", "sourceaudio", "sourceaudios"].includes(compact)) return "audio";
  return undefined;
}

function purposeFromKey(key: string): ReferencePurpose | undefined {
  return key.trim().toLowerCase().replace(/[_-]/g, "") === "mask" ? "mask" : undefined;
}

function isMediaSource(value: string): boolean {
  return value.toLowerCase().startsWith("data:") || /^https?:\/\//i.test(value);
}

function collect(value: unknown, key = "", result: ReferenceSource[] = [], kindHint?: ReferenceMedia["kind"], purposeHint?: ReferencePurpose): ReferenceSource[] {
  if (typeof value === "string") {
    const normalized = value.trim();
    const kind = mediaKindFromSource(normalized) ?? mediaKindFromKey(key) ?? kindHint;
    const purpose = purposeFromKey(key) ?? purposeHint;
    if (kind && isMediaSource(normalized)) result.push({ kind, source: normalized, ...(purpose ? { purpose } : {}) });
    return result;
  }
  if (Array.isArray(value)) {
    for (const child of value) collect(child, key, result, kindHint, purposeHint);
    return result;
  }
  if (!value || typeof value !== "object") return result;

  const item = value as Record<string, unknown>;
  const purpose = purposeFromKey(key) ?? purposeHint;
  const mimeType = item.mimeType ?? item.mime_type;
  const objectKind = mediaKindFromMime(mimeType) ?? mediaKindFromKey(key) ?? mediaKindFromDescriptor(item.kind ?? item.type) ?? kindHint;
  const add = (source: unknown, kind = objectKind, sourcePurpose = purpose) => {
    const normalized = typeof source === "string" ? source.trim() : "";
    const sourceKind = mediaKindFromSource(normalized) ?? kind;
    if (sourceKind && isMediaSource(normalized)) result.push({ kind: sourceKind, source: normalized, ...(sourcePurpose ? { purpose: sourcePurpose } : {}) });
  };

  const inline = item.inlineData ?? item.inline_data;
  if (inline && typeof inline === "object" && !Array.isArray(inline)) {
    const descriptor = inline as Record<string, unknown>;
    const inlineKind = mediaKindFromMime(descriptor.mimeType ?? descriptor.mime_type) ?? objectKind;
    const data = typeof descriptor.data === "string" ? descriptor.data.trim() : "";
    if (data && inlineKind) {
      const inlineMime = typeof (descriptor.mimeType ?? descriptor.mime_type) === "string" ? String(descriptor.mimeType ?? descriptor.mime_type) : defaultMimeType(inlineKind);
      add(`data:${inlineMime};base64,${data}`, inlineKind);
    }
  }

  const fileData = item.fileData ?? item.file_data;
  if (fileData && typeof fileData === "object" && !Array.isArray(fileData)) {
    const descriptor = fileData as Record<string, unknown>;
    add(descriptor.fileUri ?? descriptor.file_uri ?? descriptor.uri ?? descriptor.url, mediaKindFromMime(descriptor.mimeType ?? descriptor.mime_type) ?? objectKind);
  }

  for (const [field, fieldKind] of [["image_url", "image"], ["imageUrl", "image"], ["video_url", "video"], ["videoUrl", "video"], ["audio_url", "audio"], ["audioUrl", "audio"]] as const) {
    const wrapper = item[field];
    if (wrapper && typeof wrapper === "object" && !Array.isArray(wrapper)) add((wrapper as Record<string, unknown>).url, fieldKind);
  }

  for (const field of ["url", "uri", "fileUri", "file_uri"]) add(item[field]);

  for (const [childKey, child] of Object.entries(item)) {
    if (["inlineData", "inline_data", "fileData", "file_data", "image_url", "imageUrl", "video_url", "videoUrl", "audio_url", "audioUrl", "mimeType", "mime_type", "url", "uri", "fileUri", "file_uri"].includes(childKey)) continue;
    collect(child, childKey, result, mediaKindFromKey(childKey) ?? objectKind, purposeFromKey(childKey) ?? purpose);
  }
  return result;
}

export function extractReferenceSources(payload: unknown, max = 12) {
  const candidates = collect(payload);
  const unique: typeof candidates = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    const key = `${item.kind}:${item.purpose ?? "reference"}:${item.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 12;
  // Reserve one slot for the mask so the cap remains a real resource bound
  // while a valid edit does not silently lose its mask.
  const masks = unique.filter((item) => item.purpose === "mask");
  const selectedMasks = masks.slice(0, Math.min(limit, masks.length));
  const references = unique.filter((item) => item.purpose !== "mask").slice(0, Math.max(0, limit - selectedMasks.length));
  return [...references, ...selectedMasks];
}

export async function loadReferenceSources(payload: unknown, max = 12, options: ReferenceLoadOptions = {}): Promise<ReferenceMedia[]> {
  const sources = extractReferenceSources(payload, max);
  const loaded: ReferenceMedia[] = [];
  const download = options.download ?? ((source: string, downloadOptions: ReferenceDownloadOptions) => downloadRemoteMedia(source, downloadOptions as Parameters<typeof downloadRemoteMedia>[1] & { proxy?: ProxySnapshotEntry | null }));
  try {
    for (const source of sources) {
      if (source.source.toLowerCase().startsWith("data:")) {
        const descriptor = inspectInlineDataUrl(source.source, source.kind);
        if (descriptor.byteSize > MAX_REFERENCE_BYTES[source.kind]) throw new AppError("media_too_large", "Reference media exceeds the configured size limit", 400);
      }
      const inline = dataUrl(source.source, source.kind, source.purpose);
      if (inline) {
        loaded.push(inline);
        continue;
      }
      const maxBytes = MAX_REFERENCE_BYTES[source.kind];
      const allowedMime = [...INLINE_MIME_TYPES[source.kind]];
      // The SSRF downloader owns DNS pinning and redirect revalidation. Pass the
      // current task proxy through without moving remote fetching outside the
      // worker's proxy-attempt boundary.
      let downloaded: DownloadedRemoteMedia;
      try {
        downloaded = await download(source.source, { maxBytes, allowedMime, proxy: options.proxy });
      } catch (error) {
        rethrowDownloadError(error, options.proxy);
      }
      loaded.push({ kind: source.kind, sourceType: "file", filePath: downloaded.filePath, byteSize: downloaded.byteSize, mimeType: downloaded.mimeType, source: source.source, ...(source.purpose ? { purpose: source.purpose } : {}) });
    }
  } catch (error) {
    await cleanupReferenceSources(loaded);
    throw error;
  }
  return loaded;
}

export function openReferenceMedia(media: ReferenceMedia): { body: Uint8Array | Readable; byteSize: number } {
  return media.sourceType === "file" ? { body: createReadStream(media.filePath), byteSize: media.byteSize } : { body: media.bytes, byteSize: media.byteSize };
}

export function closeReferenceMedia(body: Uint8Array | Readable): void {
  if (body instanceof Readable) body.destroy();
}

export async function cleanupReferenceSources(sources: ReferenceMedia[]): Promise<void> {
  await Promise.allSettled(sources.map((source) => source.sourceType === "file" ? cleanupRemoteMedia(source.filePath) : Promise.resolve()));
}
