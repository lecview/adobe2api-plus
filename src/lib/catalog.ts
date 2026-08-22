export type ImageModel = {
  id: string;
  description: string;
  aspectRatio: string;
  outputResolution: string;
  upstreamModelId: string;
  upstreamModelVersion: string;
  /** 模型是否支持 groundSearch 字段（官网按 supportsGroundSearch 条件发送，见 bundle 模块 857781）。 */
  supportsGroundSearch?: boolean;
};

export type VideoModel = {
  id: string;
  description: string;
  duration: number;
  aspectRatio: string;
  resolution?: string;
  engine?: string;
  referenceMode?: string;
  upstreamModel?: string;
  upstreamModelId?: string;
  upstreamModelVersion?: string;
  generateAudio?: boolean;
};

export type VideoReferenceLimits = {
  total: number;
  image: number;
  video: number;
  audio: number;
  audioRequiresVisual?: boolean;
};

const imageRatios: Record<string, string> = {
  "1:1": "1x1", "16:9": "16x9", "9:16": "9x16", "4:3": "4x3", "3:4": "3x4",
  "5:4": "5x4", "4:5": "4x5", "3:2": "3x2", "2:3": "2x3", "21:9": "21x9",
};
const nanoRatios = { ...imageRatios, "1:8": "1x8", "1:4": "1x4", "4:1": "4x1", "8:1": "8x1" };

const imageModels: Record<string, ImageModel> = {};
function registerImageFamily(prefix: string, version: string, ratios: Record<string, string>, label: string) {
  for (const resolution of ["1K", "2K", "4K"]) {
    for (const [aspectRatio, suffix] of Object.entries(ratios)) {
      const id = `${prefix}-${resolution.toLowerCase()}-${suffix}`;
      imageModels[id] = { id, description: `${label} (${resolution} ${aspectRatio})`, aspectRatio, outputResolution: resolution, upstreamModelId: "gemini-flash", upstreamModelVersion: version, supportsGroundSearch: true };
    }
  }
}
registerImageFamily("nano-banana-pro", "nano-banana-2", imageRatios, "Firefly Nano Banana Pro");
registerImageFamily("nano-banana", "nano-banana-2", imageRatios, "Firefly Nano Banana");
registerImageFamily("nano-banana2", "nano-banana-3", nanoRatios, "Firefly Nano Banana 2");
for (const resolution of ["1K", "2K", "4K"]) {
  for (const [aspectRatio, suffix] of Object.entries(imageRatios)) {
    const id = `gpt-image-${resolution.toLowerCase()}-${suffix}`;
    imageModels[id] = { id, description: `Firefly GPT Image (${resolution} ${aspectRatio})`, aspectRatio, outputResolution: resolution, upstreamModelId: "gpt-image", upstreamModelVersion: "2" };
  }
}

const videoModels: Record<string, VideoModel> = {};
for (const duration of [4, 8, 12]) {
  for (const aspectRatio of ["9:16", "16:9"]) {
    const suffix = imageRatios[aspectRatio];
    const id = `sora2-${duration}s-${suffix}`;
    videoModels[id] = { id, duration, aspectRatio, description: `Firefly Sora2 video model (${duration}s ${aspectRatio})`, engine: "sora2", upstreamModel: "openai:firefly:colligo:sora2" };
    const proId = `sora2-pro-${duration}s-${suffix}`;
    videoModels[proId] = { id: proId, duration, aspectRatio, description: `Firefly Sora2 Pro video model (${duration}s ${aspectRatio})`, engine: "sora2-pro", upstreamModel: "openai:firefly:colligo:sora2-pro" };
  }
}
for (const duration of [4, 6, 8]) {
  for (const aspectRatio of ["16:9", "9:16"]) {
    for (const resolution of ["720p", "1080p"]) {
      const id = `veo31-${duration}s-${imageRatios[aspectRatio]}-${resolution}`;
      videoModels[id] = { id, duration, aspectRatio, resolution, description: `Firefly Veo31 video model (${duration}s ${aspectRatio} ${resolution})`, engine: "veo31-standard", upstreamModel: "google:firefly:colligo:veo31", upstreamModelVersion: "3.1-generate" };
      const referenceId = `veo31-ref-${duration}s-${imageRatios[aspectRatio]}-${resolution}`;
      videoModels[referenceId] = { id: referenceId, duration, aspectRatio, resolution, description: `Firefly Veo31 reference video model (${duration}s ${aspectRatio} ${resolution})`, engine: "veo31-standard", referenceMode: "image", upstreamModel: "google:firefly:colligo:veo31", upstreamModelVersion: "3.1-generate" };
    }
  }
}

for (const duration of [4, 6, 8, 10]) {
  for (const aspectRatio of ["16:9", "9:16"]) {
    const suffix = imageRatios[aspectRatio];
    const base = `gemini-omni-${duration}s-${suffix}`;
    for (const resolution of ["720p", "1080p"]) {
      const id = `${base}-${resolution}`;
      videoModels[id] = { id, duration, aspectRatio, resolution, description: `Firefly Gemini Omni video model (${duration}s ${aspectRatio} ${resolution})`, engine: "gemini-omni", upstreamModel: "google:firefly:gemini-omni", upstreamModelId: "gemini-omni", upstreamModelVersion: "omni-flash" };
    }
    videoModels[base] = { ...videoModels[`${base}-720p`], id: base };
  }
}

for (const duration of [5, 15]) {
  for (const aspectRatio of ["16:9", "9:16"]) {
    const base = `kling-o3-${duration}s-${imageRatios[aspectRatio]}`;
    for (const resolution of ["720p", "1080p"]) {
      const id = `${base}-${resolution}`;
      videoModels[id] = { id, duration, aspectRatio, resolution, description: `Firefly Kling O3 video model (${duration}s ${aspectRatio} ${resolution})`, engine: "kling-o3", upstreamModel: "kling:firefly:colligo:o3" };
    }
    // Keep the historical alias at its previous 1080p behavior.
    videoModels[base] = { ...videoModels[`${base}-1080p`], id: base };
  }
}

for (const duration of [5, 10, 15]) {
  for (const aspectRatio of ["16:9", "9:16"]) {
    const base = `kling3-${duration}s-${imageRatios[aspectRatio]}`;
    for (const resolution of ["720p", "1080p"]) {
      const id = `${base}-${resolution}`;
      videoModels[id] = { id, duration, aspectRatio, resolution, description: `Firefly Kling 3.0 video model (${duration}s ${aspectRatio} ${resolution})`, engine: "kling3", upstreamModel: "kling:firefly:colligo:3.0", generateAudio: true };
    }
    // Keep the historical alias at its previous 720p behavior.
    videoModels[base] = { ...videoModels[`${base}-720p`], id: base };
  }
}

for (const duration of Array.from({ length: 12 }, (_, index) => index + 4)) {
  for (const aspectRatio of ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]) {
    for (const resolution of ["480p", "720p", "1080p"]) {
      for (const fast of [false, true]) {
        const id = `seedance20${fast ? "-fast" : ""}-${duration}s-${imageRatios[aspectRatio] ?? aspectRatio.replace(":", "x")}-${resolution}`;
        videoModels[id] = { id, duration, aspectRatio, resolution, description: `Firefly Seedance 2.0${fast ? " Fast" : ""} video model (${duration}s ${aspectRatio} ${resolution})`, engine: fast ? "seedance-fast" : "seedance", upstreamModel: fast ? "bytedance:firefly:seedance-fast" : "bytedance:firefly:seedance", upstreamModelId: "seedance", upstreamModelVersion: fast ? "seedance_2.0_fast" : "seedance_2.0", generateAudio: true };
      }
    }
  }
}

export const DEFAULT_MODEL_ID = "nano-banana-pro-2k-16x9";
export const SUPPORTED_RATIOS = new Set(["1:1", "1:8", "1:4", "5:4", "9:16", "21:9", "4:1", "16:9", "4:3", "3:2", "4:5", "3:4", "8:1", "2:3"]);
export const IMAGE_MODEL_CATALOG = imageModels;
export const VIDEO_MODEL_CATALOG = videoModels;

/**
 * Provider names are accepted at protocol boundaries and normalized to the
 * canonical catalog IDs before a task is persisted.  These aliases are
 * intentionally narrow: a generic `gemini` model may still be an image
 * model, while the explicit video providers below are unambiguous.
 */
export function isSeedanceProviderAlias(value?: string | null): boolean {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s_.\-/]+/g, "");
  return normalized.includes("seedance")
    || normalized.includes("bytedance")
    || normalized.includes("jimeng")
    || normalized.includes("dreamina")
    || normalized.includes("doubao")
    || normalized.includes("volcengine")
    || normalized.includes("即梦")
    || normalized.includes("火山引擎");
}

/**
 * Image protocol callers commonly send provider model IDs instead of one of
 * the catalog's dimensioned IDs. Keep this allow-list narrow so a typo such
 * as `banana-fake` does not silently become a GPT Image request.
 */
export function isImageProviderAlias(value?: string | null): boolean {
  const candidate = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!candidate) return false;
  if ([
    "gpt-image",
    "gptimage",
    "gpt-image-1",
    "gpt-image-1.5",
    "gpt-image-2",
    "gpt-image-1-mini",
    "gpt-image-2-mini",
    "gemini",
    "gemini-2.0-flash-exp",
    "gemini-2.5-flash",
    "gemini-2.5-flash-image",
    "gemini-2.5-flash-image-preview",
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview",
    "nano-banana",
    "nano-banana-pro",
    "nano-banana2",
  ].includes(candidate)) return true;
  return false;
}

export function isVideoProviderAlias(value?: string | null): boolean {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s_.\-/]+/g, "");
  return isSeedanceProviderAlias(value)
    || normalized.includes("kling")
    || normalized.includes("sora")
    || normalized.includes("veo")
    || normalized.includes("omni")
    || (normalized.includes("gemini") && normalized.includes("video"));
}

export function referenceLimitsForVideo(model?: VideoModel): VideoReferenceLimits {
  if (!model) return { total: 4, image: 4, video: 0, audio: 0 };
  if (model.engine === "gemini-omni") return { total: 5, image: 4, video: 1, audio: 0 };
  if (model.engine === "seedance" || model.engine === "seedance-fast") return { total: 12, image: 9, video: 3, audio: 3, audioRequiresVisual: true };
  if (model.engine === "veo31-standard" && model.referenceMode === "image") return { total: 3, image: 3, video: 0, audio: 0 };
  if (model.engine === "veo31-standard" || model.engine === "veo31-fast" || model.engine === "kling-o3" || model.engine === "kling3") return { total: 2, image: 2, video: 0, audio: 0 };
  return { total: 1, image: 1, video: 0, audio: 0 };
}

export function resolveImageModel(modelId?: string | null): ImageModel {
  const resolved = modelId?.trim() || DEFAULT_MODEL_ID;
  const model = IMAGE_MODEL_CATALOG[resolved];
  if (!model) throw new Error(`Invalid model: ${resolved}`);
  return model;
}

export function resolveVideoModel(modelId?: string | null): VideoModel {
  const resolved = modelId?.trim() || "kling3-5s-16x9";
  const model = VIDEO_MODEL_CATALOG[resolved];
  if (!model) throw new Error(`Invalid video model: ${resolved}`);
  return model;
}

export function isVideoModel(modelId?: string | null): boolean {
  return Boolean(modelId && (VIDEO_MODEL_CATALOG[modelId] || isVideoProviderAlias(modelId)));
}

export function ratioFromSize(size: unknown): string {
  const mapping: Record<string, string> = { "1024x1024": "1:1", "1536x1536": "1:1", "2048x2048": "1:1", "1024x1792": "9:16", "1792x1024": "16:9", "2048x1536": "4:3", "1536x2048": "3:4" };
  return mapping[String(size ?? "").trim()] ?? "1:1";
}

export function resolveImageOptions(input: { model?: string; aspect_ratio?: string; size?: string; quality?: string; output_resolution?: string }) {
  const model = resolveImageModel(input.model);
  const requestedRatio = String(input.aspect_ratio ?? "").trim().toLowerCase();
  // 比例：显式 aspect_ratio > model 自带比例 > size 推断
  const ratio = SUPPORTED_RATIOS.has(requestedRatio) ? requestedRatio : model.aspectRatio || ratioFromSize(input.size);
  // 分辨率档位：以 model 为主（model 说几 K 就是几 K）。
  // size 只决定比例、不影响档位 —— 传 2160x3840 配 2K 模型也输出 2K 标准（1440x2560），
  // 不会因 size 长边 3840 被顶到 4K。
  let outputResolution: string = model.outputResolution;
  const requestedResolution = String(input.output_resolution ?? "").trim().toUpperCase();
  if (/^(1|2|4)K$/.test(requestedResolution)) outputResolution = requestedResolution;
  if (!input.model) {
    // 无明确模型时，模型解析可能落到 DEFAULT_MODEL_ID；此时若 size 提供了档位则按 size，
    // 否则按 quality 映射。
    const fromSizeRelative = inferredTier(String(input.size ?? ""));
    const quality = String(input.quality ?? "2k").toLowerCase();
    if (!/^(1|2|4)K$/.test(requestedResolution)) {
      outputResolution = fromSizeRelative ?? (quality === "4k" || quality === "ultra" ? "4K" : quality === "1k" ? "1K" : "2K");
    }
  }
  return { model, aspectRatio: ratio, outputResolution };
}

/** 仅当未提供明确 model 时，用 size 长边推断 1K/2K/4K；有明确 model 时此函数不被调用。 */
function inferredTier(size: string): string | null {
  const m = /^(\d+)[xX×](\d+)$/.exec(size.trim());
  if (!m) return null;
  const side = Math.max(Number(m[1]), Number(m[2]));
  if (side < 1500) return "1K";
  if (side < 2700) return "2K";
  return "4K";
}

export function publicModelList() {
  // `owned_by` 是旧 adobe2api 的可观察契约；应用内部虽已迁移为
  // adobe2api-plus，公开字段继续保持原值，避免下游按供应方筛选时发生破坏性变化。
  return [...Object.values(IMAGE_MODEL_CATALOG), ...Object.values(VIDEO_MODEL_CATALOG)].map((model) => ({ id: model.id, object: "model", owned_by: "adobe2api", description: model.description }));
}
