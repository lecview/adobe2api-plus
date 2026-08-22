import { randomInt } from "node:crypto";
import { DEFAULT_MODEL_ID, resolveImageModel, SUPPORTED_RATIOS, type VideoModel } from "@/lib/catalog";
import type { ImageProviderOptions, VideoProviderOptions } from "@/lib/media-request";

// 官网 aspectRatioSizeMap（bundle 模块 790139 nA / 915772 gW）：
// 1K/2K 取新版变体，4K 含 8:1/4:1/1:4/1:8 极端比例（模块 769775）。
const IMAGE_SIZES: Record<string, Record<string, { width: number; height: number }>> = {
  "1K": {
    "1:1": { width: 1024, height: 1024 },
    "4:3": { width: 1200, height: 896 },
    "3:4": { width: 896, height: 1200 },
    "16:9": { width: 1376, height: 768 },
    "9:16": { width: 768, height: 1376 },
    "21:9": { width: 1584, height: 672 },
    "3:2": { width: 1264, height: 848 },
    "5:4": { width: 1152, height: 928 },
    "4:5": { width: 928, height: 1152 },
    "2:3": { width: 848, height: 1264 },
  },
  "2K": {
    "1:1": { width: 2048, height: 2048 },
    "4:3": { width: 2400, height: 1792 },
    "3:4": { width: 1792, height: 2400 },
    "16:9": { width: 2752, height: 1536 },
    "9:16": { width: 1536, height: 2752 },
    "21:9": { width: 3168, height: 1344 },
    "3:2": { width: 2528, height: 1696 },
    "5:4": { width: 2304, height: 1856 },
    "4:5": { width: 1856, height: 2304 },
    "2:3": { width: 1696, height: 2528 },
  },
  "4K": {
    "1:1": { width: 4096, height: 4096 },
    "1:8": { width: 1536, height: 12288 },
    "1:4": { width: 2048, height: 8192 },
    "16:9": { width: 5504, height: 3072 },
    "9:16": { width: 3072, height: 5504 },
    "4:1": { width: 8192, height: 2048 },
    "4:3": { width: 4800, height: 3584 },
    "3:4": { width: 3584, height: 4800 },
    "8:1": { width: 12288, height: 1536 },
    "5:4": { width: 4608, height: 3712 },
    "21:9": { width: 6336, height: 2688 },
    "3:2": { width: 5056, height: 3392 },
    "4:5": { width: 3712, height: 4608 },
    "2:3": { width: 3392, height: 5056 },
  },
};

// nano-banana 系（gemini-flash upstream）官方发送方形分桶尺寸：
// size 只表达分辨率档位，比例由 modelSpecificPayload.aspectRatio 承担（bundle 模块 857781 x() + 928909 bN）。
const NANO_BANANA_SIZES: Record<string, { width: number; height: number }> = {
  "1K": { width: 1024, height: 1024 },
  "2K": { width: 2048, height: 2048 },
  "4K": { width: 4096, height: 4096 },
};

const VIDEO_SIZES: Record<string, Record<string, { width: number; height: number }>> = {
  "480p": { "21:9": { width: 1120, height: 480 }, "16:9": { width: 854, height: 480 }, "4:3": { width: 640, height: 480 }, "1:1": { width: 480, height: 480 }, "3:4": { width: 480, height: 640 }, "9:16": { width: 480, height: 854 } },
  "720p": { "21:9": { width: 1680, height: 720 }, "16:9": { width: 1280, height: 720 }, "4:3": { width: 960, height: 720 }, "1:1": { width: 720, height: 720 }, "3:4": { width: 720, height: 960 }, "9:16": { width: 720, height: 1280 } },
  "1080p": { "21:9": { width: 2520, height: 1080 }, "16:9": { width: 1920, height: 1080 }, "4:3": { width: 1440, height: 1080 }, "1:1": { width: 1080, height: 1080 }, "3:4": { width: 1080, height: 1440 }, "9:16": { width: 1080, height: 1920 } },
};

function imageSize(aspectRatio: string, resolution: string) {
  const map = IMAGE_SIZES[resolution.toUpperCase()] ?? IMAGE_SIZES["2K"];
  return map[aspectRatio] ?? map["16:9"];
}

function normalizedIds(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  return (values ?? []).map((value) => String(value ?? "").trim()).filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function normalizedImageRatio(value: string | undefined, fallback = "16:9"): string {
  const candidate = String(value ?? "").trim().toLowerCase();
  if (candidate === "auto") return "1:1";
  return SUPPORTED_RATIOS.has(candidate) ? candidate : fallback;
}

function normalizedImageResolution(value: string | undefined, fallback = "2K"): string {
  const candidate = String(value ?? "").trim().toUpperCase();
  return /^(1|2|4)K$/.test(candidate) ? candidate : fallback;
}

type MediaDimensions = { width: number; height: number };
const MAX_PAYLOAD_DIMENSION = 8192;
const SAFE_IMAGE_OUTPUT_FORMATS = new Set(["png", "jpeg", "webp"]);

function explicitDimensions(width: number | undefined, height: number | undefined): MediaDimensions | undefined {
  if (typeof width !== "number" || typeof height !== "number" || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > MAX_PAYLOAD_DIMENSION || height > MAX_PAYLOAD_DIMENSION) return undefined;
  return { width, height };
}

function safeImageOutputFormat(value: unknown): "png" | "jpeg" | "webp" {
  const candidate = String(value ?? "").trim().toLowerCase();
  return SAFE_IMAGE_OUTPUT_FORMATS.has(candidate) ? candidate as "png" | "jpeg" | "webp" : "png";
}

function maskReference(maskId: string) {
  return { id: maskId, usage: "mask" };
}

function imageProviderParameters(input: ImageProviderOptions): Record<string, unknown> {
  return {
    ...(input.background ? { background: input.background } : {}),
    ...(input.input_fidelity ? { inputFidelity: input.input_fidelity } : {}),
    ...(input.moderation ? { moderation: input.moderation } : {}),
  };
}

function applyImageProviderOptions(payload: Record<string, unknown>, input: ImageProviderOptions): Record<string, unknown> {
  const parameters = imageProviderParameters(input);
  const hasParameters = Object.keys(parameters).length > 0;
  const hasOutputFormat = input.output_format !== undefined;
  const outputFormat = hasOutputFormat ? safeImageOutputFormat(input.output_format) : undefined;
  const requestedCompression = input.output_compression;
  const outputCompression = requestedCompression !== undefined && Number.isInteger(requestedCompression) && requestedCompression >= 0 && requestedCompression <= 100 ? requestedCompression : undefined;
  if (!hasParameters && !hasOutputFormat && outputCompression === undefined) return payload;
  const existingModelSpecific = payload.modelSpecificPayload && typeof payload.modelSpecificPayload === "object" && !Array.isArray(payload.modelSpecificPayload)
    ? payload.modelSpecificPayload as Record<string, unknown>
    : {};
  const existingParameters = existingModelSpecific.parameters && typeof existingModelSpecific.parameters === "object" && !Array.isArray(existingModelSpecific.parameters)
    ? existingModelSpecific.parameters as Record<string, unknown>
    : {};
  const existingOutput = payload.output && typeof payload.output === "object" && !Array.isArray(payload.output)
    ? payload.output as Record<string, unknown>
    : {};
  return {
    ...payload,
    ...(hasParameters ? { modelSpecificPayload: { ...existingModelSpecific, parameters: { ...existingParameters, ...parameters } } } : {}),
    ...((hasOutputFormat || outputCompression !== undefined) ? {
      output: {
        ...existingOutput,
        ...(outputFormat ? { format: outputFormat } : {}),
        ...(outputCompression !== undefined ? { compression: outputCompression } : {}),
      },
    } : {}),
  };
}

function applyVideoProviderOptions(payload: Record<string, unknown>, input: VideoProviderOptions): Record<string, unknown> {
  const generationSettings = payload.generationSettings && typeof payload.generationSettings === "object" && !Array.isArray(payload.generationSettings)
    ? payload.generationSettings as Record<string, unknown>
    : {};
  const modelSpecificPayload = payload.modelSpecificPayload && typeof payload.modelSpecificPayload === "object" && !Array.isArray(payload.modelSpecificPayload)
    ? payload.modelSpecificPayload as Record<string, unknown>
    : {};
  const existingParameters = modelSpecificPayload.parameters && typeof modelSpecificPayload.parameters === "object" && !Array.isArray(modelSpecificPayload.parameters)
    ? modelSpecificPayload.parameters as Record<string, unknown>
    : {};
  const parameters = {
    ...(input.camera_control ? { cameraControl: input.camera_control } : {}),
    ...(input.watermark !== undefined ? { addWaterMark: input.watermark } : {}),
  };
  const hasSettings = input.mode !== undefined || input.cfg_scale !== undefined;
  const hasParameters = Object.keys(parameters).length > 0;
  if (input.loop === undefined && input.transparent_background === undefined && !hasSettings && !hasParameters) return payload;
  return {
    ...payload,
    ...(input.loop !== undefined ? { generateLoop: input.loop } : {}),
    ...(input.transparent_background !== undefined ? { transparentBackground: input.transparent_background } : {}),
    ...(hasSettings ? {
      generationSettings: {
        ...generationSettings,
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.cfg_scale !== undefined ? { cfgScale: input.cfg_scale } : {}),
      },
    } : {}),
    ...(hasParameters ? { modelSpecificPayload: { ...modelSpecificPayload, parameters: { ...existingParameters, ...parameters } } } : {}),
  };
}

export function videoSize(aspectRatio: string, resolution = "720p") {
  const map = VIDEO_SIZES[resolution.toLowerCase()] ?? VIDEO_SIZES["720p"];
  return map[aspectRatio] ?? map["16:9"];
}

function gptPixels(aspectRatio: string, resolution: string) {
  const map: Record<string, Record<string, { width: number; height: number }>> = {
    "1K": { "1:1": { width: 1024, height: 1024 }, "5:4": { width: 1120, height: 896 }, "9:16": { width: 720, height: 1280 }, "21:9": { width: 1456, height: 624 }, "16:9": { width: 1280, height: 720 }, "4:3": { width: 1152, height: 864 }, "3:2": { width: 1248, height: 832 }, "4:5": { width: 896, height: 1120 }, "3:4": { width: 864, height: 1152 }, "2:3": { width: 832, height: 1248 } },
    "2K": { "1:1": { width: 2048, height: 2048 }, "5:4": { width: 2240, height: 1792 }, "9:16": { width: 1440, height: 2560 }, "21:9": { width: 3024, height: 1296 }, "16:9": { width: 2560, height: 1440 }, "4:3": { width: 2304, height: 1728 }, "3:2": { width: 2496, height: 1664 }, "4:5": { width: 1792, height: 2240 }, "3:4": { width: 1728, height: 2304 }, "2:3": { width: 1664, height: 2496 } },
    "4K": { "1:1": { width: 2880, height: 2880 }, "5:4": { width: 3200, height: 2560 }, "9:16": { width: 2160, height: 3840 }, "21:9": { width: 3696, height: 1584 }, "16:9": { width: 3840, height: 2160 }, "4:3": { width: 3264, height: 2448 }, "3:2": { width: 3504, height: 2336 }, "4:5": { width: 2560, height: 3200 }, "3:4": { width: 2448, height: 3264 }, "2:3": { width: 2336, height: 3504 } },
  };
  return (map[resolution.toUpperCase()] ?? map["2K"])[aspectRatio];
}

export function buildImagePayloads(input: {
  prompt: string;
  modelId?: string;
  aspectRatio?: string;
  outputResolution?: string;
  width?: number;
  height?: number;
  quality?: string;
  sourceImageIds?: string[];
  maskId?: string;
  sourceMaskId?: string;
  n?: number;
} & ImageProviderOptions) {
  const model = resolveImageModel(input.modelId || DEFAULT_MODEL_ID);
  const ratio = normalizedImageRatio(input.aspectRatio, model.aspectRatio || "16:9");
  const resolution = normalizedImageResolution(input.outputResolution, model.outputResolution || "2K");
  const sourceImageIds = normalizedIds(input.sourceImageIds);
  const maskId = String(input.maskId ?? input.sourceMaskId ?? "").trim() || undefined;
  const upstreamId = model.upstreamModelId;
  const upstreamVersion = model.upstreamModelVersion;
  // 官网 n = seeds.length（bundle 模块 857781 x()），n>1 时生成等量随机种子。
  const count = Math.max(1, Math.floor(input.n ?? 1));
  const seeds = Array.from({ length: count }, () => randomInt(0, 1_000_000));
  if (upstreamId === "gpt-image") {
    const pixels = explicitDimensions(input.width, input.height) ?? gptPixels(ratio, resolution);
    if (!pixels) throw new Error(`unsupported gpt-image ratio: ${ratio}`);
    // 官网 quality→detailLevel 映射 low:1 / medium:3 / high:5（bundle 模块 158002 Ag）；
    // 未传 quality 时按系统约定默认 high（原 gptImageQuality 配置已移除）。
    const detailLevel = input.quality?.toLowerCase() === "low" ? 1 : input.quality?.toLowerCase() === "medium" ? 3 : 5;
    const base = {
      modelId: upstreamId,
      modelVersion: upstreamVersion,
      n: count,
      prompt: input.prompt,
      seeds,
      output: { storeInputs: true },
      referenceBlobs: [],
      generationMetadata: { module: "text2image", submodule: "ff-image-generate" },
      modelSpecificPayload: { size: `${pixels.width}x${pixels.height}` },
      outputResolution: resolution,
      generationSettings: { detailLevel },
      size: pixels,
    } as Record<string, unknown>;
    if (!sourceImageIds.length && !maskId) return [applyImageProviderOptions(base, input)];
    const maskRef = maskId ? maskReference(maskId) : undefined;
    return [
      applyImageProviderOptions({ ...base, generationMetadata: { module: "image2image", submodule: "ff-image-generate" }, referenceBlobs: [...sourceImageIds.map((id) => ({ id, usage: "subject" })), ...(maskRef ? [maskRef] : [])] }, input),
      applyImageProviderOptions({ ...base, generationMetadata: { module: "image2image", submodule: "ff-image-generate" }, referenceBlobs: maskRef ? [maskRef] : [], referenceImages: sourceImageIds.map((id) => ({ id })) }, input),
      applyImageProviderOptions({ ...base, generationMetadata: { module: "image2image", submodule: "ff-image-generate" }, referenceBlobs: maskRef ? [maskRef] : [], referenceImages: sourceImageIds.map((id) => ({ localBlobRef: id })) }, input),
    ];
  }
  const dimensions = explicitDimensions(input.width, input.height);
  // nano-banana 系发方形分桶尺寸（1024/2048/4096 方），比例走 aspectRatio 字段（官网 bundle 模块 857781/928909）。
  const size = dimensions ?? (upstreamId === "gemini-flash" ? NANO_BANANA_SIZES[resolution] ?? NANO_BANANA_SIZES["2K"] : imageSize(ratio, resolution));
  const base: Record<string, unknown> = {
    modelId: upstreamId,
    modelVersion: upstreamVersion,
    n: count,
    prompt: input.prompt,
    size,
    seeds,
    ...(model.supportsGroundSearch ? { groundSearch: false } : {}),
    output: { storeInputs: true },
    generationMetadata: { module: "text2image", submodule: "ff-image-generate" },
    modelSpecificPayload: { parameters: { addWatermark: false }, ...(ratio && ratio !== "auto" ? { aspectRatio: ratio } : {}) },
    referenceBlobs: [...sourceImageIds.map((id) => ({ id, usage: "general" })), ...(maskId ? [maskReference(maskId)] : [])],
  };
  return [applyImageProviderOptions(sourceImageIds.length || maskId ? { ...base, generationMetadata: { module: "image2image", submodule: "ff-image-generate" } } : base, input)];
}

export function buildVideoPayload(input: {
  prompt: string;
  model: VideoModel;
  aspectRatio?: string;
  duration?: number;
  resolution?: string;
  sourceImageIds?: string[];
  sourceVideoIds?: string[];
  sourceAudioIds?: string[];
  entityRefs?: Array<{ urn?: string; id?: string; mention_id?: string }>;
  negativePrompt?: string;
  generateAudio?: boolean;
  referenceMode?: string;
  n?: number;
  seed?: number;
  fps?: number;
} & VideoProviderOptions) {
  const aspectRatio = normalizedImageRatio(input.aspectRatio, input.model.aspectRatio || "16:9");
  const duration = input.duration ?? input.model.duration ?? 8;
  const resolution = input.resolution || input.model.resolution || "720p";
  const engine = input.model.engine || "sora2";
  const sourceImageIds = normalizedIds(input.sourceImageIds);
  const sourceVideoIds = normalizedIds(input.sourceVideoIds);
  const sourceAudioIds = normalizedIds(input.sourceAudioIds);
  const seed = input.seed ?? randomInt(0, 1_000_000);
  const dimensions = explicitDimensions(input.width, input.height);
  if (engine === "gemini-omni") {
    return applyVideoProviderOptions({ modelId: input.model.upstreamModelId || "gemini-omni", modelVersion: input.model.upstreamModelVersion || "omni-flash", n: input.n ?? 1, seeds: [seed], prompt: input.prompt, output: { storeInputs: true }, referenceBlobs: [...sourceImageIds.slice(0, 4).map((id) => ({ id, usage: "style" })), ...sourceVideoIds.slice(0, 1).map((id) => ({ id, usage: "source" }))], generationMetadata: { module: "aura" }, size: dimensions ?? videoSize(aspectRatio, resolution), duration, generationSettings: { aspectRatio } }, input);
  }
  if (engine === "seedance" || engine === "seedance-fast") {
    return applyVideoProviderOptions({ modelId: "seedance", modelVersion: input.model.upstreamModelVersion || (engine === "seedance-fast" ? "seedance_2.0_fast" : "seedance_2.0"), size: dimensions ?? videoSize(aspectRatio, resolution), seeds: [seed], n: input.n ?? 1, referenceBlobs: [...sourceImageIds.slice(0, 9).map((id) => ({ id, usage: "style" })), ...sourceVideoIds.slice(0, 3).map((id) => ({ id, usage: "source" })), ...sourceAudioIds.slice(0, 3).map((id) => ({ id, usage: "source" }))], prompt: input.prompt, negativePrompt: input.negativePrompt || "cartoon, vector art, & bad aesthetics & poor aesthetic", duration, generateAudio: input.generateAudio ?? true, generationMetadata: { module: "text2video", submodule: "ff-video-generate" }, generationSettings: { aspectRatio }, output: { storeInputs: true } }, input);
  }
  if (engine === "veo31-fast" || engine === "veo31-standard") {
    const refs = input.referenceMode === "image" && engine === "veo31-standard" ? sourceImageIds.slice(0, 3).map((id) => ({ id, usage: "asset" })) : sourceImageIds.slice(0, 2).map((id, index) => ({ id, usage: "general", promptReference: index + 1 }));
    return applyVideoProviderOptions({ n: input.n ?? 1, seeds: [seed], modelId: "veo", modelVersion: input.model.upstreamModelVersion || (engine === "veo31-fast" ? "3.1-fast-generate" : "3.1-generate"), output: { storeInputs: true }, prompt: input.prompt, size: dimensions ?? videoSize(aspectRatio, resolution), generateAudio: input.generateAudio ?? true, referenceBlobs: refs, generationMetadata: { module: "text2video" }, modelSpecificPayload: { parameters: { durationSeconds: duration, aspectRatio, addWaterMark: false } } }, input);
  }
  if (engine === "kling-o3" || engine === "kling3") {
    const refs = sourceImageIds.slice(0, 2).map((id, index) => ({ id, usage: "frame", order: index + 1 }));
    if (engine === "kling-o3") for (const ref of input.entityRefs ?? []) if (ref.urn || ref.id) refs.push({ id: ref.urn || ref.id || "", usage: "element", order: refs.length + 1 });
    const hasImageReference = sourceImageIds.length > 0;
    return applyVideoProviderOptions({ n: input.n ?? 1, seeds: [seed], modelId: "kling", modelVersion: engine === "kling-o3" ? "kling_o3_pro_reference_to_video" : hasImageReference ? "kling_v3_standard_i2v" : "kling_v3_standard_t2v", output: { storeInputs: true }, prompt: input.prompt, size: dimensions ?? videoSize(aspectRatio, resolution), generateAudio: input.generateAudio ?? true, generationMetadata: { module: hasImageReference ? "image2video" : "text2video" }, duration, generationSettings: { aspectRatio }, referenceBlobs: refs }, input);
  }
  return applyVideoProviderOptions({ n: input.n ?? 1, seeds: [seed], modelId: "sora", modelVersion: input.model.engine === "sora2-pro" ? "sora-2-pro" : "sora-2", size: dimensions ?? videoSize(aspectRatio, resolution), duration, fps: input.fps ?? 24, prompt: JSON.stringify({ id: 1, duration_sec: duration, prompt_text: input.prompt, ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}) }), generationMetadata: { module: sourceImageIds.length ? "image2video" : "text2video" }, model: input.model.upstreamModel || "openai:firefly:colligo:sora2", generateAudio: input.generateAudio ?? true, generateLoop: false, transparentBackground: false, seed: String(seed), locale: "en-US", negativePrompt: input.negativePrompt || "", jobMode: "standard", referenceBlobs: sourceImageIds.slice(0, 1).map((id) => ({ id, usage: "general", promptReference: 1 })), output: { storeInputs: true } }, input);
}
