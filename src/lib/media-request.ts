import { AppError } from "@/lib/errors";
import { inferMediaMimeFromUrl } from "@/lib/ssrf";
import {
  DEFAULT_MODEL_ID,
  IMAGE_MODEL_CATALOG,
  VIDEO_MODEL_CATALOG,
  isImageProviderAlias,
  isSeedanceProviderAlias,
  isVideoModel,
  isVideoProviderAlias,
  resolveImageModel,
  resolveVideoModel,
  SUPPORTED_RATIOS,
  type ImageModel,
  type VideoModel,
} from "@/lib/catalog";

export type MediaProtocol = "openai-images" | "openai-edits" | "openai-chat" | "gemini" | "sora" | "kling";
export type MediaKind = "image" | "video";

/** Provider options which have a stable Adobe payload representation. */
export type ImageProviderOptions = {
  background?: "auto" | "transparent" | "opaque";
  output_format?: "png" | "jpeg" | "webp";
  output_compression?: number;
  input_fidelity?: "low" | "high";
  moderation?: "auto" | "low";
};

export type VideoProviderOptions = {
  mode?: string;
  cfg_scale?: number;
  camera_control?: Record<string, unknown>;
  width?: number;
  height?: number;
  watermark?: boolean;
  loop?: boolean;
  transparent_background?: boolean;
};

export type NormalizedMediaRequest = {
  protocol: MediaProtocol;
  kind: MediaKind;
  model: string;
  prompt: string;
  n: number;
  aspect_ratio?: string;
  output_resolution?: string;
  resolution?: string;
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  quality?: string;
  response_format?: "url" | "b64_json";
  background?: ImageProviderOptions["background"];
  output_format?: ImageProviderOptions["output_format"];
  output_compression?: number;
  input_fidelity?: ImageProviderOptions["input_fidelity"];
  moderation?: ImageProviderOptions["moderation"];
  images: string[];
  videos: string[];
  audios: string[];
  mask?: string;
  generate_audio?: boolean;
  negative_prompt?: string;
  reference_mode?: string;
  mode?: string;
  cfg_scale?: number;
  camera_control?: Record<string, unknown>;
  watermark?: boolean;
  loop?: boolean;
  transparent_background?: boolean;
  seed?: number;
  [key: string]: unknown;
};

type RecordValue = Record<string, unknown>;
type MediaKindHint = "image" | "video" | "audio" | undefined;

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

const modalityKeys = ["response_modalities", "responseModalities", "modalities"] as const;
const nestedProtocolKeys = [
  "extra_body",
  "extraBody",
  "google",
  "Google",
  "generationConfig",
  "generation_config",
  "imageConfig",
  "image_config",
  "videoConfig",
  "video_config",
  "provider_options",
  "providerOptions",
  "openai",
  "OpenAI",
  "kling",
  "Kling",
  "sora",
  "Sora",
  "seedance",
  "Seedance",
] as const;

/** Read modality declarations from OpenAI, Gemini and relay extension shapes. */
export function responseModalitiesFromBody(value: unknown): string[] {
  const values: string[] = [];
  const queue: unknown[] = [value];
  const seen = new Set<RecordValue>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const item = current as RecordValue;
    if (seen.has(item)) continue;
    seen.add(item);
    for (const key of modalityKeys) {
      const declared = item[key];
      if (Array.isArray(declared)) values.push(...declared.map((entry) => String(entry).toLowerCase()));
      else if (declared !== undefined && declared !== null) values.push(String(declared).toLowerCase());
    }
    for (const key of nestedProtocolKeys) {
      const child = item[key];
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return [...new Set(values)];
}

export function isVideoRequested(value: unknown): boolean {
  const input = record(value);
  if (stringValue(input.media_type)?.toLowerCase() === "video" || responseModalitiesFromBody(value).some((modality) => modality.includes("video"))) return true;
  const queue: unknown[] = [value];
  const seen = new Set<RecordValue>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const item = current as RecordValue;
    if (seen.has(item)) continue;
    seen.add(item);
    if (Object.prototype.hasOwnProperty.call(item, "videoConfig") || Object.prototype.hasOwnProperty.call(item, "video_config")) return true;
    for (const key of nestedProtocolKeys) {
      const child = item[key];
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return false;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

const nestedOptionKeys = [
  "extra_body",
  "extraBody",
  "provider_options",
  "providerOptions",
  "openai",
  "OpenAI",
  "google",
  "Google",
  "kling",
  "Kling",
  "sora",
  "Sora",
  "seedance",
  "Seedance",
  "generationConfig",
  "generation_config",
  "imageConfig",
  "image_config",
  "videoConfig",
  "video_config",
] as const;

/**
 * Flatten the extension containers accepted by OpenAI-compatible relays and
 * Gemini. Direct request fields are appended last and therefore win over all
 * nested provider defaults.
 */
function optionLayers(input: RecordValue): RecordValue[] {
  const layers: RecordValue[] = [];
  const queue: unknown[] = nestedOptionKeys.map((key) => input[key]);
  const seen = new Set<RecordValue>();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as RecordValue;
    if (seen.has(item)) continue;
    seen.add(item);
    layers.push(item);
    for (const key of nestedOptionKeys) queue.push(item[key]);
  }
  layers.push(input);
  return layers;
}

function optionValue(layers: RecordValue[], keys: string[]): unknown {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index]!;
    for (const key of keys) {
      if (layer[key] !== undefined && layer[key] !== null && layer[key] !== "") return layer[key];
    }
  }
  return undefined;
}

function optionEnum<T extends string>(layers: RecordValue[], keys: string[], allowed: readonly T[], label: string): T | undefined {
  const value = optionValue(layers, keys);
  if (value === undefined) return undefined;
  const normalized = stringValue(value)?.toLowerCase();
  if (!normalized || !allowed.includes(normalized as T)) {
    throw new AppError("unsupported_media_parameter", `${label} is not supported`, 400, { field: keys[0] });
  }
  return normalized as T;
}

function optionNumber(layers: RecordValue[], keys: string[], label: string, bounds?: { min?: number; max?: number; integer?: boolean }): number | undefined {
  const value = optionValue(layers, keys);
  if (value === undefined) return undefined;
  const parsed = numberValue(value);
  if (parsed === undefined || (bounds?.integer && !Number.isInteger(parsed)) || (bounds?.min !== undefined && parsed < bounds.min) || (bounds?.max !== undefined && parsed > bounds.max)) {
    throw new AppError("unsupported_media_parameter", `${label} is not supported`, 400, { field: keys[0] });
  }
  return parsed;
}

function optionBoolean(layers: RecordValue[], keys: string[], label: string): boolean | undefined {
  const value = optionValue(layers, keys);
  if (value === undefined) return undefined;
  const parsed = booleanValue(value);
  if (parsed === undefined) throw new AppError("unsupported_media_parameter", `${label} is not supported`, 400, { field: keys[0] });
  return parsed;
}

function optionObject(layers: RecordValue[], keys: string[], label: string): Record<string, unknown> | undefined {
  const value = optionValue(layers, keys);
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("unsupported_media_parameter", `${label} is not supported`, 400, { field: keys[0] });
  }
  return value as Record<string, unknown>;
}

function imageOptions(input: RecordValue): ImageProviderOptions {
  const layers = optionLayers(input);
  return {
    background: optionEnum(layers, ["background"], ["auto", "transparent", "opaque"], "background"),
    output_format: optionEnum(layers, ["output_format", "outputFormat"], ["png", "jpeg", "webp"], "output_format"),
    output_compression: optionNumber(layers, ["output_compression", "outputCompression"], "output_compression", { min: 0, max: 100, integer: true }),
    input_fidelity: optionEnum(layers, ["input_fidelity", "inputFidelity"], ["low", "high"], "input_fidelity"),
    moderation: optionEnum(layers, ["moderation"], ["auto", "low"], "moderation"),
  };
}

function videoOptions(input: RecordValue): VideoProviderOptions & { negative_prompt?: string; generate_audio?: boolean; reference_mode?: string; seed?: number; fps?: number; duration?: number; resolution?: string; aspect_ratio?: string } {
  const layers = optionLayers(input);
  return {
    mode: stringValue(optionValue(layers, ["mode"])),
    cfg_scale: optionNumber(layers, ["cfg_scale", "cfgScale"], "cfg_scale", { min: 0, max: 30 }),
    camera_control: optionObject(layers, ["camera_control", "cameraControl"], "camera_control"),
    width: optionNumber(layers, ["width", "videoWidth", "video_width"], "width", { min: 1, max: 8192, integer: true }),
    height: optionNumber(layers, ["height", "videoHeight", "video_height"], "height", { min: 1, max: 8192, integer: true }),
    watermark: optionBoolean(layers, ["watermark", "addWatermark", "addWaterMark"], "watermark"),
    loop: optionBoolean(layers, ["loop", "generateLoop"], "loop"),
    transparent_background: optionBoolean(layers, ["transparent_background", "transparentBackground"], "transparent_background"),
    negative_prompt: stringValue(optionValue(layers, ["negative_prompt", "negativePrompt"])),
    generate_audio: optionBoolean(layers, ["generate_audio", "generateAudio"], "generate_audio"),
    reference_mode: stringValue(optionValue(layers, ["reference_mode", "referenceMode", "videoReferenceMode"])),
    seed: optionNumber(layers, ["seed"], "seed", { min: 0, max: 999999999, integer: true }),
    fps: optionNumber(layers, ["fps", "frame_rate", "frameRate"], "fps", { min: 1, max: 120 }),
    duration: optionNumber(layers, ["duration", "seconds", "duration_seconds", "durationSeconds"], "duration", { min: 1, max: 15, integer: true }),
    resolution: stringValue(optionValue(layers, ["resolution", "videoResolution", "video_resolution"])),
    aspect_ratio: stringValue(optionValue(layers, ["aspect_ratio", "aspectRatio"])),
  };
}

function intValue(value: unknown): number | undefined {
  const number = numberValue(value);
  return number !== undefined && Number.isInteger(number) ? number : undefined;
}

function mediaKindFromMime(value: unknown): Exclude<MediaKindHint, undefined> | undefined {
  const mime = stringValue(value)?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return undefined;
}

function mediaKindFromDescriptor(value: unknown): MediaKindHint {
  const descriptor = stringValue(value)?.toLowerCase() ?? "";
  if (descriptor.includes("image")) return "image";
  if (descriptor.includes("video")) return "video";
  if (descriptor.includes("audio")) return "audio";
  return undefined;
}

function mediaKindFromSource(value: string): MediaKindHint {
  const normalized = value.trim().toLowerCase();
  const dataMatch = normalized.match(/^data:(image|video|audio)\//);
  if (dataMatch) return dataMatch[1] as Exclude<MediaKindHint, undefined>;
  try {
    const pathname = new URL(normalized).pathname;
    const extension = pathname.match(/\.([a-z0-9]+)$/i)?.[1];
    if (!extension) return undefined;
    if (["jpg", "jpeg", "jpe", "png", "webp", "gif", "apng", "avif", "bmp", "dib", "tif", "tiff", "heic", "heif", "svg", "ico", "icns"].includes(extension)) return "image";
    if (["mp4", "webm", "mov", "m4v", "mkv", "avi", "mpeg", "mpg", "ogv", "ogg", "3gp", "3g2", "ts", "m2ts", "mts", "flv", "wmv", "asf"].includes(extension)) return "video";
    if (["mp3", "wav", "wave", "ogg", "oga", "m4a", "aac", "flac", "opus", "amr", "3gp", "3gpp", "mka", "caf", "mid", "midi"].includes(extension)) return "audio";
  } catch {
    // Invalid URL syntax is reported by pushMedia below with the normal API error.
  }
  return undefined;
}

function mediaKindFromKey(key: string): MediaKindHint {
  const normalized = key.trim().toLowerCase();
  const compact = normalized.replace(/[_-]/g, "");
  if (["mask", "inputreference", "image", "images", "imageurl", "imageurls", "photo", "photos", "inputimage", "inputimages", "reference", "references", "referenceimage", "referenceimages", "imagereferences", "sourceimage", "sourceimages"].includes(compact)) return "image";
  if (["audio", "audios", "audiourl", "audiourls", "inputaudio", "inputaudios", "referenceaudio", "referenceaudios", "audioreferences", "sourceaudio", "sourceaudios"].includes(compact)) return "audio";
  if (["video", "videos", "videourl", "videourls", "inputvideo", "inputvideos", "referencevideo", "referencevideos", "videoreferences", "sourcevideo", "sourcevideos"].includes(compact)) return "video";
  return undefined;
}

function asDataUrl(mimeType: string, data: string): string {
  if (data.trim().toLowerCase().startsWith("data:")) return data.trim();
  return `data:${mimeType || "application/octet-stream"};base64,${data}`;
}

function pushMedia(target: Record<"images" | "videos" | "audios", string[]>, value: unknown, hint: MediaKindHint, mimeType?: unknown, allowRawBase64 = false) {
  let source = stringValue(value);
  if (!source) return;
  // Multipart `input_reference` may contain mixed image/video files under one
  // image-oriented field name. Prefer the source MIME over that field hint so
  // the normalized reference buckets remain type-correct.
  const sourceKind = mediaKindFromMime(mimeType) ?? mediaKindFromSource(source) ?? hint;
  const kind = sourceKind;
  if (!kind) return;
  if (!/^(?:data:|https?:\/\/)/i.test(source)) {
    const normalizedMime = stringValue(mimeType)?.toLowerCase() ?? (kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/mpeg");
    if (!allowRawBase64 || !/^[A-Za-z0-9+/\s]+={0,2}$/.test(source)) {
      throw new AppError("invalid_media_url", "Media references must be data URLs or HTTP(S) URLs", 400);
    }
    source = asDataUrl(normalizedMime, source.replace(/\s/g, ""));
  }
  target[`${kind}s`].push(source);
}

function walkMedia(value: unknown, target: Record<"images" | "videos" | "audios", string[]>, hint?: MediaKindHint, key = "") {
  if (typeof value === "string") {
    pushMedia(target, value, mediaKindFromKey(key) ?? hint, undefined, Boolean(mediaKindFromKey(key) ?? hint));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkMedia(item, target, hint, key);
    return;
  }
  if (!value || typeof value !== "object") return;
  const item = value as RecordValue;

  const inline = record(item.inlineData ?? item.inline_data);
  const inlineData = stringValue(inline.data);
  if (inlineData) {
    const inlineKind = mediaKindFromMime(inline.mimeType ?? inline.mime_type) ?? mediaKindFromKey(key) ?? hint;
    const inlineMime = stringValue(inline.mimeType ?? inline.mime_type) ?? (inlineKind === "image" ? "image/png" : inlineKind === "video" ? "video/mp4" : inlineKind === "audio" ? "audio/mpeg" : "application/octet-stream");
    pushMedia(target, asDataUrl(inlineMime, inlineData), inlineKind);
  }

  const fileData = record(item.fileData ?? item.file_data);
  const fileUri = stringValue(fileData.fileUri ?? fileData.file_uri ?? fileData.uri ?? fileData.url);
  if (fileUri) pushMedia(target, fileUri, mediaKindFromMime(fileData.mimeType ?? fileData.mime_type) ?? mediaKindFromKey(key) ?? hint);

  const imageUrlValue = item.image_url ?? item.imageUrl;
  if (typeof imageUrlValue === "string") pushMedia(target, imageUrlValue, "image");
  else {
    const imageUrl = record(imageUrlValue);
    if (imageUrl.url) pushMedia(target, imageUrl.url, "image");
  }
  const videoUrlValue = item.video_url ?? item.videoUrl;
  if (typeof videoUrlValue === "string") pushMedia(target, videoUrlValue, "video");
  else {
    const videoUrl = record(videoUrlValue);
    if (videoUrl.url) pushMedia(target, videoUrl.url, "video");
  }
  const audioUrlValue = item.audio_url ?? item.audioUrl;
  if (typeof audioUrlValue === "string") pushMedia(target, audioUrlValue, "audio");
  else {
    const audioUrl = record(audioUrlValue);
    if (audioUrl.url) pushMedia(target, audioUrl.url, "audio");
  }

  // Accept provider-specific `{ url|uri, mimeType }` wrappers in addition to
  // the OpenAI/Gemini shapes handled above. The key hint still gates generic
  // URLs so fields such as `poll_url` cannot become media references.
  const objectMimeType = item.mimeType ?? item.mime_type ?? item.mediaType ?? item.media_type;
  const objectKind = mediaKindFromMime(objectMimeType) ?? mediaKindFromKey(key) ?? mediaKindFromDescriptor(item.kind ?? item.type) ?? hint;
  for (const field of ["url", "uri", "fileUri", "file_uri"]) {
    const source = stringValue(item[field]);
    if (source) pushMedia(target, source, objectKind, objectMimeType);
  }

  // Anthropic/Qwen-style content parts wrap media in `source`, while some
  // OpenAI-compatible relays expose `{ type, data, mime_type }` directly.
  const source = record(item.source);
  const sourceMimeType = source.mimeType ?? source.mime_type ?? source.mediaType ?? source.media_type ?? objectMimeType;
  const sourceKind = mediaKindFromMime(sourceMimeType) ?? mediaKindFromDescriptor(source.kind ?? source.type) ?? objectKind;
  for (const field of ["url", "uri", "fileUri", "file_uri"]) {
    const sourceUrl = stringValue(source[field]);
    if (sourceUrl) pushMedia(target, sourceUrl, sourceKind, sourceMimeType);
  }
  const sourceData = stringValue(source.data ?? source.base64);
  if (sourceData && sourceKind) {
    pushMedia(target, sourceData, sourceKind, sourceMimeType, true);
  }

  const directData = stringValue(item.data ?? item.base64);
  if (directData && objectKind) pushMedia(target, directData, objectKind, objectMimeType, true);

  for (const [childKey, child] of Object.entries(item)) {
    if (["inlineData", "inline_data", "fileData", "file_data", "image_url", "imageUrl", "video_url", "videoUrl", "audio_url", "audioUrl", "mimeType", "mime_type", "mediaType", "media_type", "type", "kind", "source", "data", "base64", "url", "uri", "fileUri", "file_uri"].includes(childKey)) continue;
    walkMedia(child, target, mediaKindFromKey(childKey) ?? hint, childKey);
  }
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function textFrom(value: unknown, chunks: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.trim()) chunks.push(value.trim());
    return chunks;
  }
  if (Array.isArray(value)) {
    for (const item of value) textFrom(item, chunks);
    return chunks;
  }
  if (!value || typeof value !== "object") return chunks;
  const item = value as RecordValue;
  if (typeof item.text === "string" && item.text.trim()) chunks.push(item.text.trim());
  if (item.content !== undefined) textFrom(item.content, chunks);
  if (item.parts !== undefined) textFrom(item.parts, chunks);
  return chunks;
}

export function extractConversation(value: unknown): { prompt: string; images: string[]; videos: string[]; audios: string[] } {
  const target = { images: [] as string[], videos: [] as string[], audios: [] as string[] };
  const chunks: string[] = [];
  if (Array.isArray(value)) {
    for (const message of value) {
      if (typeof message === "string") {
        textFrom(message, chunks);
        continue;
      }
      const item = record(message);
      textFrom(item.content ?? item.parts ?? item.text, chunks);
      // Walk the whole message so a provider's sibling `image`, `video`, or
      // `audio` fields are retained even when text is in `content`/`parts`.
      walkMedia(item, target);
    }
  } else {
    const item = record(value);
    textFrom(item, chunks);
    walkMedia(item, target);
  }
  return { prompt: unique(chunks).join("\n").trim(), images: unique(target.images), videos: unique(target.videos), audios: unique(target.audios) };
}

function topLevelMedia(body: RecordValue) {
  const target = { images: [] as string[], videos: [] as string[], audios: [] as string[] };
  for (const key of [
    "images", "image", "image_url", "image_urls", "imageUrl", "imageUrls", "input", "media", "assets", "input_image", "input_images", "inputImage", "inputImages", "input_reference", "inputReference", "reference_image", "reference_images", "referenceImage", "referenceImages", "image_references", "imageReferences",
    "videos", "video", "video_url", "video_urls", "videoUrl", "videoUrls", "input_video", "input_videos", "inputVideo", "inputVideos", "reference_video", "reference_videos", "referenceVideo", "referenceVideos", "video_references", "videoReferences",
    "audios", "audio", "audio_url", "audio_urls", "audioUrl", "audioUrls", "input_audio", "input_audios", "inputAudio", "inputAudios", "reference_audio", "reference_audios", "referenceAudio", "referenceAudios", "audio_references", "audioReferences",
  ]) {
    if (body[key] !== undefined) walkMedia(body[key], target, mediaKindFromKey(key), key);
  }
  return { images: unique(target.images), videos: unique(target.videos), audios: unique(target.audios) };
}

function normalizeRatio(value: unknown, fallback = "16:9"): string {
  const raw = stringValue(value)?.toLowerCase();
  // Adobe image/video payloads do not accept `auto`. The public contract
  // documents a deterministic 1:1 compatibility fallback.
  if (raw === "auto") return "1:1";
  const ratio = raw ?? fallback.toLowerCase();
  if (!SUPPORTED_RATIOS.has(ratio)) throw new AppError("invalid_aspect_ratio", "Unsupported aspect_ratio", 400);
  return ratio;
}

function resolutionFromSize(value: unknown, kind: "image" | "video" = "image"): { aspectRatio?: string; resolution?: string } {
  const size = stringValue(value);
  if (!size) return {};
  const normalized = size.toLowerCase();
  if (kind === "image" && /^(1|2|4)k$/.test(normalized)) return { resolution: normalized.toUpperCase() };
  if (kind === "video" && /^(480|720|1080)p$/.test(normalized)) return { resolution: normalized };
  if (normalized === "auto") return {};
  const match = size.match(/^(\d+)x(\d+)$/i);
  if (!match) {
    if (kind === "video") throw new AppError("invalid_resolution", "Video size must be 480p, 720p, 1080p or WIDTHxHEIGHT", 400);
    return { resolution: size.toUpperCase() };
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) return {};
  const ratio = width / height;
  // Keep the candidate list coupled to the catalog's accepted ratios, so a
  // future catalog change cannot accidentally create an invalid normalized
  // ratio.
  const candidates: Array<[number, string]> = [
    [1 / 8, "1:8"], [1 / 4, "1:4"], [2 / 3, "2:3"], [3 / 4, "3:4"], [4 / 5, "4:5"], [4 / 3, "4:3"],
    [3 / 2, "3:2"], [5 / 4, "5:4"], [4, "4:1"], [8, "8:1"], [21 / 9, "21:9"], [16 / 9, "16:9"], [9 / 16, "9:16"], [1, "1:1"],
  ];
  const supportedCandidates = candidates.filter(([, candidate]) => SUPPORTED_RATIOS.has(candidate));
  const aspectRatio = supportedCandidates.sort((a, b) => Math.abs(a[0] - ratio) - Math.abs(b[0] - ratio))[0]?.[1];
  const area = width * height;
  const videoResolution = Math.max(width, height) >= 1900 ? "1080p" : Math.max(width, height) >= 1200 ? "720p" : "480p";
  // OpenAI-compatible image sizes use 1024x1024 as 1K. Area thresholds also
  // cover the common 1024x1792/1792x1024 and GPT Image pixel dimensions.
  const imageResolution = area <= 2_000_000 ? "1K" : area <= 5_500_000 ? "2K" : "4K";
  return { aspectRatio, resolution: kind === "video" ? videoResolution : imageResolution };
}

function normalizeOutputResolution(value: unknown, fallback?: string): string | undefined {
  const raw = stringValue(value)?.toUpperCase();
  if (raw && /^(1|2|4)K$/.test(raw)) return raw;
  const fallbackValue = stringValue(fallback)?.toUpperCase();
  const normalizedFallback = fallbackValue && /^(1|2|4)K$/.test(fallbackValue) ? fallbackValue : undefined;
  if (raw === "AUTO") return normalizedFallback;
  return raw && /^(1|2|4)K$/.test(raw) ? raw : normalizedFallback;
}

function normalizeVideoResolution(value: unknown, fallback = "720p"): string {
  const raw = stringValue(value)?.toLowerCase();
  if (!raw || raw === "auto") return fallback.toLowerCase();
  if (!/^(480|720|1080)p$/.test(raw)) throw new AppError("invalid_resolution", "Video resolution must be 480p, 720p or 1080p", 400);
  return raw;
}

function explicitNumber(input: RecordValue, keys: string[], code: string, label: string): number | undefined {
  const value = keys.map((key) => input[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
  if (value === undefined) return undefined;
  const parsed = numberValue(value);
  if (parsed === undefined) throw new AppError(code, `${label} must be a number`, 400);
  return parsed;
}

function isConcreteVideoModel(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return Boolean(VIDEO_MODEL_CATALOG[normalized] || VIDEO_MODEL_CATALOG[normalized.replace(/^firefly-/, "")]);
}

function conversationValue(input: RecordValue): unknown {
  const values: unknown[] = [];
  for (const key of ["messages", "contents", "input"]) {
    const value = input[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) values.push(...value);
    else values.push(value);
  }
  return values.length ? values : input;
}

function extractMask(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const target = { images: [] as string[], videos: [] as string[], audios: [] as string[] };
  walkMedia(value, target, "image", "mask");
  if (target.videos.length || target.audios.length) throw new AppError("invalid_media_type", "Mask must be an image", 400);
  const masks = unique(target.images);
  if (masks.length > 1) throw new AppError("invalid_request_error", "mask must contain one image", 400);
  return masks[0];
}

function isStrictImageProviderAlias(value: string): boolean {
  return isImageProviderAlias(value);
}

function resolveImageForProtocol(modelId: string | undefined, fallback = DEFAULT_MODEL_ID): ImageModel {
  const candidate = stringValue(modelId);
  if (!candidate) return resolveImageModel(fallback);
  const normalized = candidate.toLowerCase();
  if (VIDEO_MODEL_CATALOG[normalized] || isVideoModel(candidate)) {
    throw new AppError("invalid_request_error", "Video models must use /v1/videos or /v1/chat/completions", 400);
  }
  if (IMAGE_MODEL_CATALOG[normalized]) return IMAGE_MODEL_CATALOG[normalized];
  const legacy = normalized.replace(/^firefly-/, "");
  if (IMAGE_MODEL_CATALOG[legacy]) return IMAGE_MODEL_CATALOG[legacy];
  if (isStrictImageProviderAlias(candidate) || isStrictImageProviderAlias(legacy)) {
    if (/^nano[-_]banana-pro$/i.test(legacy)) return resolveImageModel("nano-banana-pro-2k-16x9");
    if (/^nano[-_]banana2$/i.test(legacy)) return resolveImageModel("nano-banana2-2k-16x9");
    if (/^nano[-_]banana$/i.test(legacy)) return resolveImageModel("nano-banana-2k-16x9");
    return resolveImageModel("gpt-image-1k-16x9");
  }
  throw new AppError("invalid_model", "Unsupported image model", 400);
}

function resolveVideoForProtocol(modelId: string | undefined, fallback = "kling3-5s-16x9"): VideoModel {
  const candidate = stringValue(modelId);
  if (!candidate || candidate.toLowerCase() === "kling" || candidate.toLowerCase() === "kling-3" || candidate.toLowerCase() === "kling3") return resolveVideoModel(fallback);
  const normalized = candidate.toLowerCase();
  if (IMAGE_MODEL_CATALOG[normalized]) return resolveVideoModel(fallback);
  if (VIDEO_MODEL_CATALOG[normalized]) return VIDEO_MODEL_CATALOG[normalized];
  if (isSeedanceProviderAlias(candidate)) {
    const fast = /fast/i.test(candidate);
    return resolveVideoModel(`seedance20${fast ? "-fast" : ""}-8s-16x9-720p`);
  }
  if (isVideoProviderAlias(candidate)) return resolveVideoModel(fallback);
  throw new AppError("invalid_model", "Unsupported video model", 400);
}

function clampPositiveInt(value: unknown, fallback = 1, max = 10): number {
  const parsed = intValue(value) ?? fallback;
  if (parsed < 1 || parsed > max) throw new AppError("invalid_request_error", `n must be between 1 and ${max}`, 400);
  return parsed;
}

export function normalizeImageRequest(body: unknown, protocol: "openai-images" | "openai-edits" = "openai-images"): NormalizedMediaRequest {
  const input = record(body);
  const layers = optionLayers(input);
  const provider = imageOptions(input);
  const top = topLevelMedia(input);
  const prompt = stringValue(input.prompt) ?? "";
  if (!prompt) throw new AppError("invalid_request_error", "prompt is required", 400);
  const model = resolveImageForProtocol(stringValue(input.model));
  const size = resolutionFromSize(input.size, "image");
  const aspectRatio = normalizeRatio(input.aspect_ratio ?? input.aspectRatio ?? size.aspectRatio ?? model.aspectRatio, model.aspectRatio);
  // 分辨率档位由 model 决定：size 只当比例，不参与档位推断（用户传 2160x3840 配 2K 模型也输出 2K）
  const outputResolution = normalizeOutputResolution(input.output_resolution, model.outputResolution) ?? model.outputResolution;
  const mask = extractMask(input.mask);
  return {
    ...input,
    protocol,
    kind: "image",
    model: model.id,
    prompt,
    n: clampPositiveInt(input.n, 1, 10),
    aspect_ratio: aspectRatio,
    output_resolution: outputResolution,
    quality: stringValue(optionValue(layers, ["quality"])),
    // GPT Image clients, including Cherry Studio, consume base64 when the
    // caller does not specify a format. Keep explicit URL requests unchanged.
    response_format: input.response_format === "url" ? "url" : "b64_json",
    ...provider,
    images: top.images,
    videos: top.videos,
    audios: top.audios,
    ...(mask ? { mask } : {}),
  };
}

export function normalizeChatRequest(body: unknown): NormalizedMediaRequest {
  const input = record(body);
  const layers = optionLayers(input);
  const imageProvider = imageOptions(input);
  const videoProvider = videoOptions(input);
  const conversation = extractConversation(conversationValue(input));
  const top = topLevelMedia(input);
  const prompt = stringValue(input.prompt) ?? conversation.prompt;
  if (!prompt) throw new AppError("invalid_request_error", "messages, contents or prompt is required", 400);
  const requestedVideo = isVideoRequested(input);
  const modelId = stringValue(input.model);
  const videoModel = requestedVideo || Boolean(modelId && isVideoModel(modelId)) ? resolveVideoForProtocol(modelId) : undefined;
  const imageModel = videoModel ? undefined : resolveImageForProtocol(modelId);
  const width = videoModel ? videoProvider.width : undefined;
  const height = videoModel ? videoProvider.height : undefined;
  const requestedSize = input.size ?? (width !== undefined && height !== undefined ? `${width}x${height}` : undefined);
  const size = resolutionFromSize(requestedSize, videoModel ? "video" : "image");
  const aspectRatio = normalizeRatio(input.aspect_ratio ?? input.aspectRatio ?? size.aspectRatio ?? videoModel?.aspectRatio ?? imageModel?.aspectRatio, videoModel?.aspectRatio ?? imageModel?.aspectRatio ?? "16:9");
  const explicitDuration = explicitNumber(input, ["duration", "seconds", "duration_seconds", "durationSeconds"], "invalid_duration", "Video duration") ?? videoProvider.duration;
  if (videoModel && explicitDuration !== undefined && isConcreteVideoModel(modelId) && explicitDuration !== videoModel.duration) {
    throw new AppError("invalid_duration", `Model ${videoModel.id} requires ${videoModel.duration} seconds`, 400);
  }
  const videoResolution = videoModel ? normalizeVideoResolution(videoProvider.resolution ?? size.resolution, videoModel.resolution ?? "720p") : undefined;
  const generatedAudio = videoProvider.generate_audio;
  const media = {
    images: unique([...conversation.images, ...top.images]),
    videos: unique([...conversation.videos, ...top.videos]),
    audios: unique([...conversation.audios, ...top.audios]),
  };
  const mask = extractMask(input.mask);
  return {
    ...input,
    protocol: "openai-chat",
    kind: videoModel ? "video" : "image",
    model: videoModel?.id ?? imageModel!.id,
    prompt,
    n: clampPositiveInt(input.n, 1, videoModel ? 4 : 10),
    aspect_ratio: aspectRatio,
    output_resolution: imageModel ? normalizeOutputResolution(optionValue(layers, ["output_resolution", "outputResolution"]), imageModel.outputResolution) : undefined,
    resolution: videoModel ? videoResolution : stringValue(input.resolution ?? input.videoResolution ?? input.video_resolution) ?? size.resolution,
    width,
    height,
    duration: explicitDuration ?? videoModel?.duration,
    fps: videoProvider.fps,
    quality: stringValue(optionValue(layers, ["quality"])),
    ...imageProvider,
    images: media.images,
    videos: media.videos,
    audios: media.audios,
    generate_audio: generatedAudio === undefined ? videoModel?.generateAudio : generatedAudio,
    negative_prompt: videoProvider.negative_prompt,
    reference_mode: videoProvider.reference_mode,
    mode: videoProvider.mode,
    cfg_scale: videoProvider.cfg_scale,
    camera_control: videoProvider.camera_control,
    watermark: videoProvider.watermark,
    loop: videoProvider.loop,
    transparent_background: videoProvider.transparent_background,
    seed: videoProvider.seed,
    ...(mask ? { mask } : {}),
  };
}

export function normalizeGeminiRequest(modelName: string, body: unknown): NormalizedMediaRequest {
  const input = record(body);
  const layers = optionLayers(input);
  const imageProvider = imageOptions(input);
  const videoProvider = videoOptions(input);
  const extraBody = { ...record(input.extra_body), ...record(input.extraBody) };
  const googleBody = { ...record(extraBody.google), ...record(extraBody.Google) };
  const extraGenerationConfig = { ...record(googleBody.generation_config), ...record(googleBody.generationConfig) };
  const extraDirectGenerationConfig = { ...record(extraBody.generation_config), ...record(extraBody.generationConfig) };
  const directGenerationConfig = { ...record(input.generation_config), ...record(input.generationConfig) };
  const generationConfig = { ...extraDirectGenerationConfig, ...extraGenerationConfig, ...directGenerationConfig };
  const imageConfig = {
    ...record(googleBody.image_config),
    ...record(googleBody.imageConfig),
    ...record(generationConfig.image_config),
    ...record(generationConfig.imageConfig),
    ...record(input.image_config),
    ...record(input.imageConfig),
  };
  const wantsVideo = isVideoRequested(input);
  const conversation = extractConversation(conversationValue(input));
  const top = topLevelMedia(input);
  const prompt = stringValue(input.prompt) ?? conversation.prompt;
  if (!prompt) throw new AppError("invalid_request_error", "contents or prompt is required", 400);
  const videoModel = wantsVideo || isVideoModel(modelName) ? resolveVideoForProtocol(modelName) : undefined;
  const imageModel = videoModel ? undefined : resolveImageForProtocol(modelName, "gpt-image-1k-16x9");
  const videoConfig = {
    ...record(extraBody.video_config),
    ...record(extraBody.videoConfig),
    ...record(googleBody.video_config),
    ...record(googleBody.videoConfig),
    ...record(generationConfig.video_config),
    ...record(generationConfig.videoConfig),
    ...record(input.video_config),
    ...record(input.videoConfig),
  };
  const width = videoModel ? videoProvider.width : undefined;
  const height = videoModel ? videoProvider.height : undefined;
  const requestedSize = input.size ?? (width !== undefined && height !== undefined ? `${width}x${height}` : undefined);
  const sized = resolutionFromSize(requestedSize, videoModel ? "video" : "image");
  const aspectRatio = normalizeRatio(imageConfig.aspectRatio ?? imageConfig.aspect_ratio ?? videoConfig.aspectRatio ?? videoConfig.aspect_ratio ?? input.aspect_ratio ?? input.aspectRatio ?? sized.aspectRatio ?? imageModel?.aspectRatio ?? videoModel?.aspectRatio, imageModel?.aspectRatio ?? videoModel?.aspectRatio ?? "16:9");
  const imageSize = stringValue(imageConfig.imageSize ?? imageConfig.image_size);
  const outputResolution = imageModel ? normalizeOutputResolution(imageSize, imageModel.outputResolution) : undefined;
  const explicitDuration = explicitNumber({ ...videoConfig, ...input }, ["duration", "seconds", "duration_seconds", "durationSeconds"], "invalid_duration", "Video duration") ?? videoProvider.duration;
  if (videoModel && explicitDuration !== undefined && isConcreteVideoModel(modelName) && explicitDuration !== videoModel.duration) {
    throw new AppError("invalid_duration", `Model ${videoModel.id} requires ${videoModel.duration} seconds`, 400);
  }
  const videoResolution = videoModel ? normalizeVideoResolution(videoProvider.resolution ?? sized.resolution, videoModel.resolution ?? "720p") : undefined;
  const generatedAudio = videoProvider.generate_audio;
  const mask = extractMask(input.mask);
  return {
    ...input,
    protocol: "gemini",
    kind: videoModel ? "video" : "image",
    model: videoModel?.id ?? imageModel!.id,
    prompt,
    n: clampPositiveInt(input.n, 1, videoModel ? 4 : 10),
    aspect_ratio: aspectRatio,
    output_resolution: outputResolution,
    resolution: videoModel ? videoResolution : stringValue(optionValue(layers, ["resolution", "videoResolution", "video_resolution"])) ?? sized.resolution,
    width,
    height,
    duration: explicitDuration ?? videoModel?.duration,
    generate_audio: generatedAudio === undefined ? videoModel?.generateAudio : generatedAudio,
    quality: stringValue(optionValue(layers, ["quality"])),
    ...imageProvider,
    negative_prompt: videoProvider.negative_prompt,
    reference_mode: videoProvider.reference_mode,
    mode: videoProvider.mode,
    cfg_scale: videoProvider.cfg_scale,
    camera_control: videoProvider.camera_control,
    watermark: videoProvider.watermark,
    loop: videoProvider.loop,
    transparent_background: videoProvider.transparent_background,
    seed: videoProvider.seed,
    fps: videoProvider.fps,
    images: unique([...conversation.images, ...top.images]),
    videos: unique([...conversation.videos, ...top.videos]),
    audios: unique([...conversation.audios, ...top.audios]),
    ...(mask ? { mask } : {}),
  };
}

export function normalizeVideoRequest(body: unknown, protocol: "sora" | "kling", operation?: "text2video" | "image2video"): NormalizedMediaRequest {
  const input = record(body);
  const videoProvider = videoOptions(input);
  const conversation = extractConversation(conversationValue(input));
  const top = topLevelMedia(input);
  const prompt = stringValue(input.prompt) ?? conversation.prompt;
  if (!prompt) throw new AppError("invalid_request_error", "prompt is required", 400);
  const fallback = protocol === "sora" ? "sora2-8s-16x9" : "kling3-5s-16x9";
  const model = resolveVideoForProtocol(stringValue(input.model ?? input.model_name ?? input.model_id), fallback);
  const width = videoProvider.width;
  const height = videoProvider.height;
  const requestedSize = input.size ?? (width !== undefined && height !== undefined ? `${width}x${height}` : undefined);
  const size = resolutionFromSize(requestedSize, "video");
  const aspectRatio = normalizeRatio(videoProvider.aspect_ratio ?? size.aspectRatio ?? model.aspectRatio, model.aspectRatio);
  const images = unique([...conversation.images, ...top.images]);
  if (operation === "image2video" && images.length === 0) throw new AppError("invalid_request_error", "image is required for image2video", 400);
  const explicitDuration = explicitNumber(input, ["duration", "seconds", "duration_seconds", "durationSeconds"], "invalid_duration", "Video duration") ?? videoProvider.duration;
  const duration = explicitDuration ?? model.duration;
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new AppError("invalid_duration", "Video duration must be between 1 and 15 seconds", 400);
  if (explicitDuration !== undefined && isConcreteVideoModel(stringValue(input.model ?? input.model_name ?? input.model_id)) && explicitDuration !== model.duration) {
    throw new AppError("invalid_duration", `Model ${model.id} requires ${model.duration} seconds`, 400);
  }
  const resolution = normalizeVideoResolution(videoProvider.resolution ?? size.resolution, model.resolution ?? "720p");
  const generatedAudio = videoProvider.generate_audio;
  return {
    ...input,
    protocol,
    kind: "video",
    model: model.id,
    prompt,
    n: clampPositiveInt(input.n, 1, 4),
    aspect_ratio: aspectRatio,
    resolution,
    width,
    height,
    duration,
    fps: videoProvider.fps,
    images,
    videos: unique([...conversation.videos, ...top.videos]),
    audios: unique([...conversation.audios, ...top.audios]),
    negative_prompt: videoProvider.negative_prompt,
    generate_audio: generatedAudio === undefined ? model.generateAudio : generatedAudio,
    reference_mode: videoProvider.reference_mode,
    mode: videoProvider.mode,
    cfg_scale: videoProvider.cfg_scale,
    camera_control: videoProvider.camera_control,
    watermark: videoProvider.watermark,
    loop: videoProvider.loop,
    transparent_background: videoProvider.transparent_background,
    seed: videoProvider.seed,
  };
}

export async function fileToDataUrl(file: File, options: { kind: "image" | "video" | "audio"; maxBytes: number }): Promise<string> {
  if (!(file instanceof File)) throw new AppError("invalid_media", "Uploaded media is required", 400);
  if (file.size <= 0 || file.size > options.maxBytes) throw new AppError("media_too_large", "Uploaded media exceeds the configured size limit", 400);
  const declaredMime = file.type.trim().toLowerCase();
  const genericMime = !declaredMime || ["application/octet-stream", "application/binary", "binary/octet-stream"].includes(declaredMime);
  const inferredMime = inferMediaMimeFromUrl(file.name);
  const fallbackMime = options.kind === "image" ? "image/png" : options.kind === "video" ? "video/mp4" : "audio/mpeg";
  const mime = genericMime ? inferredMime ?? (declaredMime ? "" : fallbackMime) : declaredMime;
  if (!mime || !mime.startsWith(`${options.kind}/`)) throw new AppError("invalid_media_type", `Expected ${options.kind} media`, 400);
  const bytes = Buffer.from(await file.arrayBuffer());
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

export function modelForNormalizedRequest(request: NormalizedMediaRequest): ImageModel | VideoModel {
  return request.kind === "video" ? resolveVideoModel(request.model) : resolveImageModel(request.model);
}

export function isNormalizedMediaRequest(value: unknown): value is NormalizedMediaRequest {
  const item = record(value);
  return (item.kind === "image" || item.kind === "video") && typeof item.prompt === "string" && typeof item.model === "string";
}
