import { AppError } from "@/lib/errors";
import { inferMediaMimeFromUrl } from "@/lib/ssrf";
import { normalizePublicModelId, resolveMediaRouting } from "@/lib/media-model-routing";
import {
  isVideoModel,
  resolveImageModel,
  resolveVideoModel,
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
  requested_model: string;
  resolved_model: string;
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

function explicitNumber(input: RecordValue, keys: string[], code: string, label: string): number | undefined {
  const value = keys.map((key) => input[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
  if (value === undefined) return undefined;
  const parsed = numberValue(value);
  if (parsed === undefined) throw new AppError(code, `${label} must be a number`, 400);
  return parsed;
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
  const routing = resolveMediaRouting({
    model: input.model, size: input.size, aspect_ratio: input.aspect_ratio ?? input.aspectRatio,
    output_resolution: input.output_resolution ?? input.outputResolution,
    quality: optionValue(layers, ["quality"]),
  }, "image");
  const mask = extractMask(input.mask);
  return {
    ...input,
    protocol,
    kind: "image",
    model: routing.resolvedModel,
    requested_model: routing.requestedModel,
    resolved_model: routing.resolvedModel,
    prompt,
    n: clampPositiveInt(input.n, 1, 10),
    aspect_ratio: routing.aspectRatio,
    output_resolution: routing.outputResolution,
    quality: routing.quality,
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
  const normalizedFamily = normalizePublicModelId(modelId);
  const video = requestedVideo || Boolean(modelId && (isVideoModel(modelId) || normalizedFamily && ["sora2", "sora2-pro", "veo31", "veo31-ref", "gemini-omni", "kling3", "kling-o3", "seedance20", "seedance20-fast"].includes(normalizedFamily)));
  const width = video ? videoProvider.width : undefined;
  const height = video ? videoProvider.height : undefined;
  const requestedSize = input.size ?? (width !== undefined && height !== undefined ? `${width}x${height}` : undefined);
  const explicitDuration = explicitNumber(input, ["duration", "seconds", "duration_seconds", "durationSeconds"], "invalid_duration", "Video duration") ?? videoProvider.duration;
  const generatedAudio = videoProvider.generate_audio;
  const routing = resolveMediaRouting({ model: modelId, size: requestedSize, aspect_ratio: input.aspect_ratio ?? input.aspectRatio, output_resolution: optionValue(layers, ["output_resolution", "outputResolution"]), quality: optionValue(layers, ["quality"]), duration: explicitDuration, resolution: videoProvider.resolution, generate_audio: generatedAudio }, video ? "video" : "image");
  const media = {
    images: unique([...conversation.images, ...top.images]),
    videos: unique([...conversation.videos, ...top.videos]),
    audios: unique([...conversation.audios, ...top.audios]),
  };
  const mask = extractMask(input.mask);
  return {
    ...input,
    protocol: "openai-chat",
    kind: routing.kind,
    model: routing.resolvedModel,
    requested_model: routing.requestedModel,
    resolved_model: routing.resolvedModel,
    prompt,
    n: clampPositiveInt(input.n, 1, routing.kind === "video" ? 4 : 10),
    aspect_ratio: routing.aspectRatio,
    output_resolution: routing.outputResolution,
    resolution: routing.resolution,
    width,
    height,
    duration: routing.duration,
    fps: videoProvider.fps,
    quality: routing.quality,
    ...imageProvider,
    images: media.images,
    videos: media.videos,
    audios: media.audios,
    generate_audio: routing.generateAudio,
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
  const normalizedFamily = normalizePublicModelId(modelName);
  const video = wantsVideo || isVideoModel(modelName) || Boolean(normalizedFamily && ["sora2", "sora2-pro", "veo31", "veo31-ref", "gemini-omni", "kling3", "kling-o3", "seedance20", "seedance20-fast"].includes(normalizedFamily));
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
  const width = video ? videoProvider.width : undefined;
  const height = video ? videoProvider.height : undefined;
  const requestedSize = input.size ?? (width !== undefined && height !== undefined ? `${width}x${height}` : undefined);
  const imageSize = stringValue(imageConfig.imageSize ?? imageConfig.image_size ?? optionValue(layers, ["output_resolution", "outputResolution"]));
  const explicitDuration = explicitNumber({ ...videoConfig, ...input }, ["duration", "seconds", "duration_seconds", "durationSeconds"], "invalid_duration", "Video duration") ?? videoProvider.duration;
  const generatedAudio = videoProvider.generate_audio;
  const routing = resolveMediaRouting({ model: modelName, size: requestedSize, aspect_ratio: imageConfig.aspectRatio ?? imageConfig.aspect_ratio ?? videoConfig.aspectRatio ?? videoConfig.aspect_ratio ?? input.aspect_ratio ?? input.aspectRatio, output_resolution: imageSize, quality: optionValue(layers, ["quality"]), duration: explicitDuration, resolution: videoProvider.resolution, generate_audio: generatedAudio }, video ? "video" : "image");
  const mask = extractMask(input.mask);
  return {
    ...input,
    protocol: "gemini",
    kind: routing.kind,
    model: routing.resolvedModel,
    requested_model: routing.requestedModel,
    resolved_model: routing.resolvedModel,
    prompt,
    n: clampPositiveInt(input.n, 1, routing.kind === "video" ? 4 : 10),
    aspect_ratio: routing.aspectRatio,
    output_resolution: routing.outputResolution,
    resolution: routing.resolution,
    width,
    height,
    duration: routing.duration,
    generate_audio: routing.generateAudio,
    quality: routing.quality,
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
  const requestedModel = stringValue(input.model ?? input.model_name ?? input.model_id) ?? fallback;
  const width = videoProvider.width;
  const height = videoProvider.height;
  const requestedSize = input.size ?? (width !== undefined && height !== undefined ? `${width}x${height}` : undefined);
  const images = unique([...conversation.images, ...top.images]);
  if (operation === "image2video" && images.length === 0) throw new AppError("invalid_request_error", "image is required for image2video", 400);
  const explicitDuration = explicitNumber(input, ["duration", "seconds", "duration_seconds", "durationSeconds"], "invalid_duration", "Video duration") ?? videoProvider.duration;
  const generatedAudio = videoProvider.generate_audio;
  const routing = resolveMediaRouting({ model: requestedModel, size: requestedSize, aspect_ratio: videoProvider.aspect_ratio, duration: explicitDuration, resolution: videoProvider.resolution, generate_audio: generatedAudio }, "video");
  return {
    ...input,
    protocol,
    kind: "video",
    model: routing.resolvedModel,
    requested_model: routing.requestedModel,
    resolved_model: routing.resolvedModel,
    prompt,
    n: clampPositiveInt(input.n, 1, 4),
    aspect_ratio: routing.aspectRatio,
    resolution: routing.resolution,
    width,
    height,
    duration: routing.duration,
    fps: videoProvider.fps,
    images,
    videos: unique([...conversation.videos, ...top.videos]),
    audios: unique([...conversation.audios, ...top.audios]),
    negative_prompt: videoProvider.negative_prompt,
    generate_audio: routing.generateAudio,
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
  return request.kind === "video" ? resolveVideoModel(request.resolved_model ?? request.model) : resolveImageModel(request.resolved_model ?? request.model);
}

export function isNormalizedMediaRequest(value: unknown): value is NormalizedMediaRequest {
  const item = record(value);
  return (item.kind === "image" || item.kind === "video") && typeof item.prompt === "string" && typeof item.model === "string";
}
