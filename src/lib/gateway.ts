import { createJob, waitForJob } from "@/lib/jobs";
import { allocateProxySnapshot } from "@/lib/proxy-pool";
import { AppError, safeErrorMessage, statusForErrorCode } from "@/lib/errors";
import { config } from "@/lib/config";
import { assertSafeRemoteUrl } from "@/lib/ssrf";
import { inspectInlineDataUrl } from "@/lib/adobe/input";
import { getSystemSettings } from "@/lib/system-settings";
import { extractConversation } from "@/lib/media-request";
import { db } from "@/lib/db";
import { generationJob } from "@/lib/db/schema";
import { isVideoModel } from "@/lib/catalog";
import { eq } from "drizzle-orm";

export async function enqueueGeneration(input: { apiPath: string; model?: string; payload: Record<string, unknown>; adobeAccountId?: string; entityId?: string }) {
  const prompt = typeof input.payload.prompt === "string" ? input.payload.prompt : "";
  const entityMentions = [...prompt.matchAll(/@entity:([A-Za-z0-9_.-]+)/g)].map((match) => match[1]).filter(Boolean);
  if (entityMentions.length > 0) throw new AppError("entity_cache_disabled", "Entity references are disabled because local entity caching is not enabled", 400);
  const proxySnapshot = await allocateProxySnapshot();
  return createJob({ apiPath: input.apiPath, model: input.model, requestPayload: input.payload, adobeAccountId: input.adobeAccountId, entityId: input.entityId, proxySnapshot });
}

export async function waitForGeneration(jobId: string) {
  // 同步等待超时 = 后台配置的「图片生成超时」或「视频生成超时」，按 job 的 model 决定，
  // 不再用独立的 syncTimeoutMs（之前图片/视频都卡 120s，与生成超时 5min 不一致）。
  const settings = await getSystemSettings();
  const [row] = await db.select({ model: generationJob.model }).from(generationJob).where(eq(generationJob.id, jobId)).limit(1);
  const timeoutMs = (isVideoModel(row?.model ?? null) ? settings.videoGenerateTimeoutSeconds : settings.generateTimeoutSeconds) * 1000;
  const job = await waitForJob(jobId, timeoutMs);
  if (job.status !== "SUCCEEDED") {
    const code = job.errorCode ?? "generation_failed";
    const status = statusForErrorCode(code);
    throw new AppError(code, safeErrorMessage(code, status), status, { job_id: job.id });
  }
  const media = job.media[0];
  if (!media) throw new AppError("media_missing", "Generation completed without media", 500, { job_id: job.id });
  return { job, media, medias: job.media };
}

export async function mediaUrl(request: Request, objectKey: string): Promise<string> {
  const settings = await getSystemSettings();
  const origin = settings.publicBaseUrl || new URL(request.url).origin;
  return `${origin}${config.mediaPublicPrefix()}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
}

export function extractPrompt(messages: unknown): string {
  return extractConversation(messages).prompt;
}

export function openAiError(message: string, type = "invalid_request_error", code?: string) {
  return { error: { message, type, ...(code ? { code } : {}) } };
}

export type ReferenceLimits = {
  total?: number;
  image?: number;
  video?: number;
  audio?: number;
  audioRequiresVisual?: boolean;
};

function normalizeReferenceLimits(limits: number | ReferenceLimits): Required<Pick<ReferenceLimits, "total" | "image" | "video" | "audio">> & Pick<ReferenceLimits, "audioRequiresVisual"> {
  if (typeof limits === "number") return { total: limits, image: limits, video: limits, audio: limits, audioRequiresVisual: false };
  return {
    total: limits.total ?? Number.POSITIVE_INFINITY,
    image: limits.image ?? Number.POSITIVE_INFINITY,
    video: limits.video ?? Number.POSITIVE_INFINITY,
    audio: limits.audio ?? Number.POSITIVE_INFINITY,
    audioRequiresVisual: limits.audioRequiresVisual ?? false,
  };
}

function referenceLimitError(kind: "total" | "image" | "video" | "audio", count: number, limit: number): AppError {
  const label = kind === "total" ? "reference media" : `${kind} reference`;
  const unit = limit === 1 ? "item" : "items";
  return new AppError("invalid_reference_count", `At most ${limit} ${label} ${unit} are allowed`, 400, { field: kind === "total" ? "references" : `${kind}_references`, count, limit });
}

export async function validateReferenceUrls(value: unknown, limits: number | ReferenceLimits = 4): Promise<void> {
  const urls: Array<{ value: string; kind: "image" | "video" | "audio" }> = [];
  const visit = (node: unknown, key = "", hint = "", purpose?: "mask") => {
    const currentPurpose: "mask" | undefined = key.trim().toLowerCase().replace(/[_-]/g, "") === "mask" ? "mask" : purpose;
    if (typeof node === "string" && (/(?:image|video|audio|media|reference).*url|url.*(?:image|video|audio|media|reference)/i.test(key) || hint || currentPurpose)) {
      const kind = (key.match(/image|video|audio/i)?.[0] ?? hint.match(/image|video|audio/i)?.[0] ?? "image").toLowerCase() as "image" | "video" | "audio";
      if (/^https?:\/\//i.test(node) || node.startsWith("data:")) urls.push({ value: node, kind });
    }
    else if (Array.isArray(node)) node.forEach((child) => visit(child, key, hint, currentPurpose));
    else if (node && typeof node === "object") Object.entries(node).forEach(([childKey, child]) => visit(child, childKey, /image|video|audio/i.test(childKey) ? childKey : hint, currentPurpose));
  };
  visit(value);
  const normalized = normalizeReferenceLimits(limits);
  const counts = { image: 0, video: 0, audio: 0 };
  for (const item of urls) counts[item.kind] += 1;
  if (urls.length > normalized.total) throw referenceLimitError("total", urls.length, normalized.total);
  for (const kind of ["image", "video", "audio"] as const) {
    if (counts[kind] > normalized[kind]) throw referenceLimitError(kind, counts[kind], normalized[kind]);
  }
  if (normalized.audioRequiresVisual && counts.audio > 0 && counts.image + counts.video === 0) {
    throw new AppError("invalid_reference_count", "Audio references require at least one image or video reference", 400, { field: "audio_references" });
  }
  for (const item of urls) {
    if (/^https?:\/\//i.test(item.value)) await assertSafeRemoteUrl(item.value);
    else {
      const descriptor = inspectInlineDataUrl(item.value, item.kind);
      const byteSize = descriptor.byteSize;
      // 图片参考放宽到 30MB（覆盖 2K/4K 大源图转 base64 的膨胀；edits 上传限制已是 20MB）
      const maxBytes = item.kind === "image" ? 30 * 1024 * 1024 : item.kind === "video" ? 100 * 1024 * 1024 : 25 * 1024 * 1024;
      if (byteSize > maxBytes) throw new AppError("media_too_large", "Reference media exceeds the configured size limit", 400);
    }
  }
}
