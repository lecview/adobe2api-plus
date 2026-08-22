import { mediaUrl } from "@/lib/gateway";
import { readMediaBytes } from "@/lib/media";
import { fileToDataUrl, isVideoRequested, responseModalitiesFromBody } from "@/lib/media-request";
import { inferMediaMimeFromUrl } from "@/lib/ssrf";
import { IMAGE_MODEL_CATALOG, VIDEO_MODEL_CATALOG, isSeedanceProviderAlias, isVideoProviderAlias } from "@/lib/catalog";

export type MediaRecord = { objectKey: string; url?: string | null; mimeType: string };

/** 返回原地址（returnOriginalUrl）：media 带 url 时直接给原地址，否则给本地存储地址 */
export async function mediaItemUrl(request: Request, item: MediaRecord): Promise<string> {
  return item.url && item.url.length ? item.url : mediaUrl(request, item.objectKey);
}

/** 远程（未下载到本地）媒体读取字节：仅 b64_json 等确实需要原始字节时使用 */
async function remoteMediaBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { Accept: "*/*" } });
  if (!response.ok) throw new Error(`failed to fetch remote media: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export type OpenAiChatContentPart =
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } }
  | { type: "audio_url"; audio_url: { url: string } };

type ProtocolBody = Record<string, unknown>;

export async function mediaUrls(request: Request, media: MediaRecord[]): Promise<string[]> {
  return Promise.all(media.map((item) => mediaItemUrl(request, item)));
}

export async function openAiImageData(request: Request, media: MediaRecord[], responseFormat: "url" | "b64_json" = "url") {
  if (responseFormat === "b64_json") {
    return Promise.all(media.map(async (item) => {
      const bytes = item.url && item.url.length ? await remoteMediaBytes(item.url) : (await readMediaBytes(item.objectKey)).bytes;
      return { b64_json: Buffer.from(bytes).toString("base64") };
    }));
  }
  return (await mediaUrls(request, media)).map((url) => ({ url }));
}

/**
 * Chat Completions accepts assistant content as multimodal content parts.
 * Keep the URL shape deliberately close to the OpenAI input shape so clients
 * can render more than one generated asset without parsing markdown.
 */
export async function openAiChatContentParts(request: Request, media: MediaRecord[]): Promise<OpenAiChatContentPart[]> {
  return Promise.all(media.map(async (item) => {
    const url = await mediaItemUrl(request, item);
    if (item.mimeType.startsWith("video/")) return { type: "video_url", video_url: { url } };
    if (item.mimeType.startsWith("audio/")) return { type: "audio_url", audio_url: { url } };
    return { type: "image_url", image_url: { url } };
  }));
}

export function openAiChatText(part: OpenAiChatContentPart): string {
  if (part.type === "image_url") return `![Generated Image](${part.image_url.url})`;
  if (part.type === "video_url") return `<video src="${part.video_url.url}" controls></video>`;
  return `[Generated audio](${part.audio_url.url})`;
}

export async function geminiImageParts(media: MediaRecord[]) {
  return Promise.all(media.map(async (item) => {
    const stored = await readMediaBytes(item.objectKey);
    return { inlineData: { mimeType: stored.mimeType, data: Buffer.from(stored.bytes).toString("base64") } };
  }));
}

/** Return inline image bytes while keeping non-image assets addressable. */
export async function geminiMediaParts(request: Request, media: MediaRecord[]) {
  return Promise.all(media.map(async (item) => {
    if (item.mimeType.startsWith("image/")) {
      const bytes = item.url && item.url.length ? await remoteMediaBytes(item.url) : (await readMediaBytes(item.objectKey)).bytes;
      return { inlineData: { mimeType: item.mimeType, data: Buffer.from(bytes).toString("base64") } };
    }
    return { fileData: { fileUri: await mediaItemUrl(request, item), mimeType: item.mimeType } };
  }));
}

function objectBody(value: unknown): ProtocolBody {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ProtocolBody : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const parsed = stringValue(value);
    if (parsed) return parsed;
  }
  return "";
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function configObject(value: unknown, keys: string[]): ProtocolBody {
  const source = objectBody(value);
  return keys.reduce<ProtocolBody>((merged, key) => ({ ...merged, ...objectBody(source[key]) }), {});
}

/**
 * Flatten relay and provider configuration in increasing precedence order.
 * Direct request fields win over nested provider defaults, while a provider's
 * more specific videoConfig wins over its containing generationConfig.
 */
function protocolConfig(body: ProtocolBody): ProtocolBody {
  const layers: ProtocolBody[] = [];
  const add = (value: unknown) => {
    const item = objectBody(value);
    if (Object.keys(item).length) layers.push(item);
  };
  const extras = [body.extra_body, body.extraBody].map((value) => objectBody(value));
  extras.forEach(add);
  const google = extras.map((extra) => configObject(extra, ["google", "Google"]));
  google.forEach(add);
  const generations = [
    ...extras.map((extra) => configObject(extra, ["generationConfig", "generation_config"])),
    ...google.map((item) => configObject(item, ["generationConfig", "generation_config"])),
    configObject(body, ["generationConfig", "generation_config"]),
  ];
  generations.forEach(add);
  const videos = [
    ...extras.map((extra) => configObject(extra, ["videoConfig", "video_config"])),
    ...google.map((item) => configObject(item, ["videoConfig", "video_config"])),
    ...generations.map((generation) => configObject(generation, ["videoConfig", "video_config"])),
    configObject(body, ["videoConfig", "video_config"]),
  ];
  videos.forEach(add);
  add(body);
  return layers.reduce<ProtocolBody>((merged, layer) => ({ ...merged, ...layer }), {});
}

function ratioFromBody(body: ProtocolBody, candidate = ""): string {
  const config = protocolConfig(body);
  const direct = firstString(config.aspect_ratio, config.aspectRatio);
  if (direct) return direct;
  const candidateRatio = candidate.match(/(?:^|-)(1x1|1x8|1x4|4x1|8x1|5x4|9x16|21x9|4x3|3x2|4x5|3x4|2x3|16x9)(?:-|$)/i)?.[1];
  if (candidateRatio) return candidateRatio.replace("x", ":");
  const size = firstString(config.size);
  const match = size.match(/^(\d+)x(\d+)$/i);
  if (!match) return "16:9";
  const width = Number(match[1]);
  const height = Number(match[2]);
  const candidates: Array<[number, string]> = [[16 / 9, "16:9"], [9 / 16, "9:16"], [4 / 3, "4:3"], [3 / 4, "3:4"], [1, "1:1"], [21 / 9, "21:9"]];
  return candidates.sort((left, right) => Math.abs(left[0] - width / height) - Math.abs(right[0] - width / height))[0]?.[1] ?? "16:9";
}

function ratioSuffix(ratio: string): string {
  return ratio.replace(":", "x");
}

function modelHints(body: ProtocolBody, candidate: string) {
  const config = protocolConfig(body);
  const durationMatch = candidate.match(/(?:^|-)(\d+)s(?:-|$)/i);
  const duration = Math.max(1, Math.round(firstNumber(config.duration, config.seconds, config.duration_seconds, config.durationSeconds) ?? Number(durationMatch?.[1] ?? 8)));
  const resolutionMatch = candidate.match(/(?:^|-)(480p|720p|1080p)(?:-|$)/i);
  const size = firstString(config.size).match(/^(\d+)x(\d+)$/i);
  const sizeResolution = size ? (Math.max(Number(size[1]), Number(size[2])) >= 1900 ? "1080p" : Math.max(Number(size[1]), Number(size[2])) >= 1200 ? "720p" : "480p") : "";
  const resolution = firstString(config.resolution, config.videoResolution, config.video_resolution) || resolutionMatch?.[1] || sizeResolution || "720p";
  return { duration, ratio: ratioFromBody(config, candidate), resolution: resolution.toLowerCase() };
}

function existingModel(value: string): string | undefined {
  if (IMAGE_MODEL_CATALOG[value] || VIDEO_MODEL_CATALOG[value]) return value;
  const withoutLegacyPrefix = value.replace(/^firefly-/i, "");
  return IMAGE_MODEL_CATALOG[withoutLegacyPrefix] || VIDEO_MODEL_CATALOG[withoutLegacyPrefix] ? withoutLegacyPrefix : undefined;
}

/**
 * The legacy service published `firefly-*` IDs while the rebuilt catalog uses
 * provider-neutral IDs. Protocol endpoints accept both, plus provider aliases
 * such as `seedance` and `sora`, and always persist one canonical ID.
 */
export function canonicalProtocolModelId(value: unknown, body: unknown, protocol: "image" | "video" | "gemini" = "video"): string | undefined {
  const candidate = stringValue(value);
  if (!candidate) return undefined;
  const bodyRecord = objectBody(body);
  const exact = existingModel(candidate);
  if (exact) return exact;
  const responseModalities = responseModalitiesFromBody(bodyRecord);
  const explicitlyVideo = isVideoRequested(bodyRecord) || responseModalities.some((item) => item.includes("video"));
  if (protocol === "image" || (protocol === "gemini" && !explicitlyVideo && !isVideoProviderAlias(candidate) && !/veo|omni|video|seedance|kling|sora/i.test(candidate))) {
    if (/^(?:firefly-)?gpt-image-/i.test(candidate)) return candidate.replace(/^firefly-/i, "");
    if (/^(?:firefly-)?(?:nano-banana|nano-banana2)/i.test(candidate)) return candidate.replace(/^firefly-/i, "");
    return candidate;
  }

  const hints = modelHints(bodyRecord, candidate);
  const lower = candidate.toLowerCase();
  const ratio = ratioSuffix(hints.ratio);
  if (isSeedanceProviderAlias(candidate)) {
    const fast = lower.includes("fast");
    const duration = Math.min(15, Math.max(4, hints.duration));
    const model = `seedance20${fast ? "-fast" : ""}-${duration}s-${ratio}-${hints.resolution}`;
    if (VIDEO_MODEL_CATALOG[model]) return model;
  }
  if (lower.includes("sora")) {
    const duration = [4, 8, 12].includes(hints.duration) ? hints.duration : 8;
    const model = `sora2${lower.includes("pro") ? "-pro" : ""}-${duration}s-${ratio}`;
    if (VIDEO_MODEL_CATALOG[model]) return model;
  }
  if (lower.includes("kling")) {
    const durations = lower.includes("o3") ? [5, 15] : [5, 10, 15];
    const duration = durations.includes(hints.duration) ? hints.duration : durations[0]!;
    const model = `${lower.includes("o3") ? "kling-o3" : "kling3"}-${duration}s-${ratio}`;
    if (VIDEO_MODEL_CATALOG[model]) return model;
  }
  if (lower.includes("veo")) {
    const duration = [4, 6, 8].includes(hints.duration) ? hints.duration : 4;
    const model = `veo31-${duration}s-${ratio}-${hints.resolution}`;
    if (VIDEO_MODEL_CATALOG[model]) return model;
  }
  if (lower.includes("omni") || (lower.includes("gemini") && (explicitlyVideo || /video/i.test(candidate)))) {
    const duration = [4, 6, 8, 10].includes(hints.duration) ? hints.duration : 4;
    const model = `gemini-omni-${duration}s-${ratio}-${hints.resolution}`;
    if (VIDEO_MODEL_CATALOG[model]) return model;
  }
  return candidate;
}

export function withCanonicalProtocolModel(body: unknown, protocol: "image" | "video" | "gemini" = "video"): ProtocolBody {
  const input = objectBody(body);
  const model = input.model ?? input.model_name ?? input.model_id;
  const canonical = canonicalProtocolModelId(model, input, protocol);
  if (!canonical) return input;
  return { ...input, model: canonical, ...(input.model_name !== undefined ? { model_name: canonical } : {}), ...(input.model_id !== undefined ? { model_id: canonical } : {}) };
}

function parsedFormValue(key: string, value: string): unknown {
  const lower = key.toLowerCase();
  if (["messages", "contents", "input", "metadata", "generation_config", "generationconfig", "image", "images", "image_url", "video", "videos", "video_url", "audio", "audios", "audio_url", "input_reference"].includes(lower) && /^[\[{]/.test(value.trim())) {
    try { return JSON.parse(value) as unknown; } catch { return value; }
  }
  if (["generate_audio", "generateaudio", "loop", "transparent_background"].includes(lower)) {
    if (/^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
  }
  if (["n", "duration", "seconds", "duration_seconds", "fps", "seed"].includes(lower)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value;
}

function fileKind(key: string, file: File): "image" | "video" | "audio" {
  const mime = file.type.toLowerCase();
  const inferredMime = inferMediaMimeFromUrl(file.name) ?? "";
  const genericMime = ["application/octet-stream", "application/binary", "binary/octet-stream"].includes(mime);
  const effectiveMime = genericMime ? inferredMime : mime;
  if (effectiveMime.startsWith("video/")) return "video";
  if (effectiveMime.startsWith("audio/")) return "audio";
  if (effectiveMime.startsWith("image/")) return "image";
  const lower = key.toLowerCase();
  if (lower.includes("video")) return "video";
  if (lower.includes("audio")) return "audio";
  return "image";
}

function appendFormValue(target: ProtocolBody, key: string, value: unknown): void {
  if (target[key] === undefined) {
    target[key] = value;
    return;
  }
  target[key] = Array.isArray(target[key]) ? [...target[key] as unknown[], value] : [target[key], value];
}

/** Parse Sora/Kling multipart fields without changing the normalized request contract. */
export async function parseVideoMultipartBody(request: Request): Promise<ProtocolBody> {
  const form = await request.formData();
  const body: ProtocolBody = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      appendFormValue(body, key, parsedFormValue(key, value));
      continue;
    }
    const kind = fileKind(key, value);
    const dataUrl = await fileToDataUrl(value, { kind, maxBytes: kind === "image" ? 10 * 1024 * 1024 : kind === "video" ? 100 * 1024 * 1024 : 25 * 1024 * 1024 });
    appendFormValue(body, key, dataUrl);
  }
  return body;
}

export function jobStatusForVideo(status: string): "queued" | "in_progress" | "completed" | "failed" {
  if (status === "SUCCEEDED") return "completed";
  if (["FAILED", "CANCELLED", "SUBMISSION_UNKNOWN"].includes(status)) return "failed";
  if (status === "QUEUED") return "queued";
  return "in_progress";
}
