import { AppError } from "@/lib/errors";
import { imageSpecFromSize, type ImageResolutionTier } from "@/lib/image-size-map";
import { IMAGE_MODEL_CATALOG, VIDEO_MODEL_CATALOG, type ImageModel, type VideoModel } from "@/lib/catalog";

export const PUBLIC_IMAGE_MODELS = ["gpt-image-2", "nano-banana", "nano-banana-pro", "nano-banana2"] as const;
export const PUBLIC_VIDEO_MODELS = ["sora2", "sora2-pro", "veo31", "veo31-ref", "gemini-omni", "kling3", "kling-o3", "seedance20", "seedance20-fast"] as const;
export const PUBLIC_MEDIA_MODELS = [...PUBLIC_IMAGE_MODELS, ...PUBLIC_VIDEO_MODELS] as const;
export type PublicMediaModel = typeof PUBLIC_MEDIA_MODELS[number];

const familyPrefixes: Array<[string, PublicMediaModel]> = [
  ["nano-banana-pro", "nano-banana-pro"], ["nano-banana2", "nano-banana2"], ["nano-banana", "nano-banana"],
  ["gpt-image-2", "gpt-image-2"], ["gpt-image", "gpt-image-2"],
  ["sora2-pro", "sora2-pro"], ["sora2", "sora2"], ["veo31-ref", "veo31-ref"], ["veo31", "veo31"],
  ["gemini-omni", "gemini-omni"], ["kling-o3", "kling-o3"], ["kling3", "kling3"],
  ["seedance20-fast", "seedance20-fast"], ["seedance20", "seedance20"],
];

export function normalizePublicModelId(value: unknown): PublicMediaModel | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toLowerCase().replace(/_/g, "-").replace(/^firefly-/, "");
  for (const [prefix, family] of familyPrefixes) if (id === prefix || id.startsWith(`${prefix}-`)) return family;
  if (["gptimage", "gpt-image-1", "gpt-image-1.5", "gpt-image-1-mini", "gpt-image-2-mini"].includes(id)) return "gpt-image-2";
  if (["gemini", "gemini-2.0-flash-exp", "gemini-2.5-flash", "gemini-2.5-flash-image", "gemini-2.5-flash-image-preview", "gemini-3-pro-image-preview", "gemini-3.1-flash-image-preview"].includes(id)) return "gpt-image-2";
  if (["kling", "kling-3"].includes(id)) return "kling3";
  return undefined;
}

export function normalizePublicModels(values: unknown): PublicMediaModel[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(normalizePublicModelId).filter((value): value is PublicMediaModel => Boolean(value)))];
}

type RoutingInput = {
  model?: unknown; aspect_ratio?: unknown; aspectRatio?: unknown; size?: unknown;
  output_resolution?: unknown; outputResolution?: unknown; quality?: unknown;
  duration?: unknown; seconds?: unknown; resolution?: unknown; generate_audio?: unknown;
};

export type ResolvedMediaRouting = {
  requestedModel: PublicMediaModel;
  resolvedModel: string;
  kind: "image" | "video";
  aspectRatio: string;
  outputResolution?: ImageResolutionTier;
  quality?: "low" | "medium" | "high";
  duration?: number;
  resolution?: string;
  generateAudio?: boolean;
  imageModel?: ImageModel;
  videoModel?: VideoModel;
};

const imageDefaults: Record<typeof PUBLIC_IMAGE_MODELS[number], { tier: ImageResolutionTier; ratio: string }> = {
  "gpt-image-2": { tier: "1K", ratio: "16:9" },
  "nano-banana": { tier: "2K", ratio: "16:9" },
  "nano-banana-pro": { tier: "2K", ratio: "16:9" },
  "nano-banana2": { tier: "2K", ratio: "16:9" },
};
const baseRatios = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "5:4", "4:5", "3:2", "2:3", "21:9"]);
const longRatios = new Set(["1:8", "1:4", "4:1", "8:1"]);
const suffixByRatio: Record<string, string> = Object.fromEntries([...baseRatios, ...longRatios].map((ratio) => [ratio, ratio.replace(":", "x")]));

const videoCapabilities: Record<typeof PUBLIC_VIDEO_MODELS[number], { durations: number[] | [number, number]; ratios: string[]; resolutions?: string[]; defaultDuration: number; defaultResolution?: string; audio?: boolean }> = {
  sora2: { durations: [4, 8, 12], ratios: ["16:9", "9:16"], defaultDuration: 8 },
  "sora2-pro": { durations: [4, 8, 12], ratios: ["16:9", "9:16"], defaultDuration: 8 },
  veo31: { durations: [4, 6, 8], ratios: ["16:9", "9:16"], resolutions: ["720p", "1080p"], defaultDuration: 4, defaultResolution: "720p" },
  "veo31-ref": { durations: [4, 6, 8], ratios: ["16:9", "9:16"], resolutions: ["720p", "1080p"], defaultDuration: 4, defaultResolution: "720p" },
  "gemini-omni": { durations: [4, 6, 8, 10], ratios: ["16:9", "9:16"], resolutions: ["720p", "1080p"], defaultDuration: 4, defaultResolution: "720p" },
  kling3: { durations: [5, 10, 15], ratios: ["16:9", "9:16"], resolutions: ["720p", "1080p"], defaultDuration: 5, defaultResolution: "720p", audio: true },
  "kling-o3": { durations: [5, 15], ratios: ["16:9", "9:16"], resolutions: ["720p", "1080p"], defaultDuration: 5, defaultResolution: "1080p" },
  seedance20: { durations: [4, 15], ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], resolutions: ["480p", "720p", "1080p"], defaultDuration: 8, defaultResolution: "720p", audio: true },
  "seedance20-fast": { durations: [4, 15], ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], resolutions: ["480p", "720p", "1080p"], defaultDuration: 8, defaultResolution: "720p", audio: true },
};

function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function invalid(code: string, message: string): never { throw new AppError(code, message, 400); }
function explicitNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) invalid("invalid_duration", "duration must be an integer");
  return parsed;
}

function videoSizeHint(value: unknown): { aspectRatio?: string; resolution?: string } {
  const valueText = text(value)?.toLowerCase();
  if (!valueText) return {};
  if (["480p", "720p", "1080p"].includes(valueText)) return { resolution: valueText };
  const match = /^(\d+)x(\d+)$/.exec(valueText);
  if (!match) invalid("invalid_resolution", "Unsupported video size");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const divisor = (a: number, b: number): number => b ? divisor(b, a % b) : a;
  const common = divisor(width, height);
  const aspectRatio = `${width / common}:${height / common}`;
  const resolution = Math.max(width, height) >= 1900 ? "1080p" : Math.max(width, height) >= 1200 ? "720p" : "480p";
  return { aspectRatio, resolution };
}

export function resolveMediaRouting(input: RoutingInput, kindHint?: "image" | "video"): ResolvedMediaRouting {
  const rawModel = text(input.model);
  const normalizedRaw = rawModel?.toLowerCase().replace(/_/g, "-").replace(/^firefly-/, "");
  const legacyImage = normalizedRaw ? IMAGE_MODEL_CATALOG[normalizedRaw] : undefined;
  const legacyVideo = normalizedRaw ? VIDEO_MODEL_CATALOG[normalizedRaw] : undefined;
  const exactPublic = normalizedRaw && (PUBLIC_MEDIA_MODELS as readonly string[]).includes(normalizedRaw);
  const acceptedAlias = normalizedRaw && [
    "gpt-image", "gptimage", "gpt-image-1", "gpt-image-1.5", "gpt-image-1-mini", "gpt-image-2-mini",
    "gemini", "gemini-2.0-flash-exp", "gemini-2.5-flash", "gemini-2.5-flash-image", "gemini-2.5-flash-image-preview", "gemini-3-pro-image-preview", "gemini-3.1-flash-image-preview",
    "kling", "kling-3",
  ].includes(normalizedRaw);
  if (rawModel && !legacyImage && !legacyVideo && !exactPublic && !acceptedAlias) invalid("invalid_model", "Unsupported media model");
  const family = normalizePublicModelId(rawModel) ?? (!rawModel ? (kindHint === "video" ? "kling3" : "nano-banana-pro") : undefined);
  if (!family) invalid("invalid_model", "Unsupported media model");
  const isVideo = (PUBLIC_VIDEO_MODELS as readonly string[]).includes(family);
  if (kindHint && (kindHint === "video") !== isVideo) invalid("invalid_model", `A ${family} request cannot use the ${kindHint} endpoint`);

  if (!isVideo) {
    const imageFamily = family as typeof PUBLIC_IMAGE_MODELS[number];
    const defaults = imageDefaults[imageFamily];
    const sizeValue = text(input.size);
    const sizeSpec = sizeValue ? imageSpecFromSize(sizeValue) : undefined;
    if (sizeValue && !sizeSpec) invalid("invalid_size", "Unsupported image size");
    const explicitRatio = text(input.aspect_ratio ?? input.aspectRatio);
    const explicitTierText = text(input.output_resolution ?? input.outputResolution)?.toUpperCase();
    if (explicitTierText && !["1K", "2K", "4K"].includes(explicitTierText)) invalid("invalid_output_resolution", "Unsupported output_resolution");
    const fixedRatio = legacyImage?.aspectRatio;
    const fixedTier = legacyImage?.outputResolution as ImageResolutionTier | undefined;
    if (explicitRatio && fixedRatio && explicitRatio !== fixedRatio) invalid("invalid_aspect_ratio", "aspect_ratio conflicts with the legacy model ID");
    if (explicitTierText && fixedTier && explicitTierText !== fixedTier) invalid("invalid_output_resolution", "output_resolution conflicts with the legacy model ID");
    if (sizeSpec && fixedRatio && sizeSpec.aspectRatio !== fixedRatio) invalid("invalid_size", "size conflicts with the legacy model ID");
    if (sizeSpec && fixedTier && sizeSpec.outputResolution !== fixedTier) invalid("invalid_size", "size conflicts with the legacy model ID");
    if (sizeSpec && explicitRatio && sizeSpec.aspectRatio !== explicitRatio) invalid("invalid_size", "size conflicts with aspect_ratio");
    if (sizeSpec && explicitTierText && sizeSpec.outputResolution !== explicitTierText) invalid("invalid_size", "size conflicts with output_resolution");
    const aspectRatio = explicitRatio ?? sizeSpec?.aspectRatio ?? fixedRatio ?? defaults.ratio;
    const allowedRatios = imageFamily === "nano-banana2" ? new Set([...baseRatios, ...longRatios]) : baseRatios;
    if (!allowedRatios.has(aspectRatio)) invalid("invalid_aspect_ratio", `Unsupported aspect_ratio for ${imageFamily}`);
    const outputResolution = (explicitTierText ?? sizeSpec?.outputResolution ?? fixedTier ?? defaults.tier) as ImageResolutionTier;
    const qualityText = (text(input.quality) ?? "high").toLowerCase();
    if (!["low", "medium", "high"].includes(qualityText)) invalid("invalid_quality", "quality must be low, medium, or high");
    const internalPrefix = imageFamily === "gpt-image-2" ? "gpt-image" : imageFamily;
    const resolvedModel = `${internalPrefix}-${outputResolution.toLowerCase()}-${suffixByRatio[aspectRatio]}`;
    const imageModel = IMAGE_MODEL_CATALOG[resolvedModel];
    if (!imageModel) invalid("invalid_model", "The requested image variant is unavailable");
    return { requestedModel: imageFamily, resolvedModel, kind: "image", aspectRatio, outputResolution, quality: qualityText as "low" | "medium" | "high", imageModel };
  }

  const videoFamily = family as typeof PUBLIC_VIDEO_MODELS[number];
  const capability = videoCapabilities[videoFamily];
  const sizeHint = videoSizeHint(input.size);
  const explicitRatio = text(input.aspect_ratio ?? input.aspectRatio) ?? sizeHint.aspectRatio;
  const explicitDuration = explicitNumber(input.duration ?? input.seconds);
  const requestedResolution = text(input.resolution)?.toLowerCase();
  const explicitResolution = requestedResolution ?? (capability.resolutions ? sizeHint.resolution : undefined);
  if (explicitRatio && legacyVideo && explicitRatio !== legacyVideo.aspectRatio) invalid("invalid_aspect_ratio", "aspect_ratio conflicts with the legacy model ID");
  if (explicitDuration !== undefined && legacyVideo && explicitDuration !== legacyVideo.duration) invalid("invalid_duration", "duration conflicts with the legacy model ID");
  if (explicitResolution && legacyVideo?.resolution && explicitResolution !== legacyVideo.resolution) invalid("invalid_resolution", "resolution conflicts with the legacy model ID");
  const aspectRatio = explicitRatio ?? legacyVideo?.aspectRatio ?? "16:9";
  if (!capability.ratios.includes(aspectRatio)) invalid("invalid_aspect_ratio", `Unsupported aspect_ratio for ${videoFamily}`);
  const duration = explicitDuration ?? legacyVideo?.duration ?? capability.defaultDuration;
  const validDuration = videoFamily.startsWith("seedance20")
    ? duration >= capability.durations[0]! && duration <= capability.durations[1]!
    : capability.durations.includes(duration);
  if (!validDuration) invalid("invalid_duration", `Unsupported duration for ${videoFamily}`);
  if (requestedResolution && !capability.resolutions) invalid("invalid_resolution", `${videoFamily} does not accept resolution`);
  const resolution = explicitResolution ?? legacyVideo?.resolution ?? capability.defaultResolution;
  if (resolution && !capability.resolutions?.includes(resolution)) invalid("invalid_resolution", `Unsupported resolution for ${videoFamily}`);
  const resolvedModel = `${videoFamily}-${duration}s-${suffixByRatio[aspectRatio]}${resolution ? `-${resolution}` : ""}`;
  const videoModel = VIDEO_MODEL_CATALOG[resolvedModel];
  if (!videoModel) invalid("invalid_model", "The requested video variant is unavailable");
  const generateAudio = input.generate_audio === undefined ? capability.audio : Boolean(input.generate_audio);
  return { requestedModel: videoFamily, resolvedModel, kind: "video", aspectRatio, duration, resolution, generateAudio, videoModel };
}
