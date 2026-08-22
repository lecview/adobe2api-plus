import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { generationJob, mediaAsset } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { mediaUrl } from "@/lib/gateway";
import { jobStatusForVideo } from "@/lib/media-response";

export type OutputMediaKind = "image" | "video" | "audio";

const SAFE_MEDIA_MIME_TYPES = new Set([
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
  "video/x-matroska",
  "video/mkv",
  "video/ogg",
  "video/mpeg",
  "video/x-msvideo",
  "video/avi",
  "video/3gpp",
  "video/3gpp2",
  "video/mp2t",
  "video/x-flv",
  "video/x-ms-wmv",
  "video/x-ms-asf",
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/opus",
  "audio/wav",
  "audio/webm",
  "audio/ogg",
  "audio/x-wav",
  "audio/amr",
  "audio/3gpp",
  "audio/midi",
  "audio/x-midi",
  "audio/matroska",
  "audio/caf",
]);

const DEFAULT_MEDIA_MIME: Record<OutputMediaKind, string> = {
  image: "image/png",
  video: "video/mp4",
  audio: "audio/mpeg",
};

export function safeMediaMimeType(value: unknown, fallbackKind: OutputMediaKind = "video"): string {
  const candidate = typeof value === "string" ? value.trim().toLowerCase().split(";", 1)[0]?.trim() : "";
  return candidate && SAFE_MEDIA_MIME_TYPES.has(candidate) ? candidate : DEFAULT_MEDIA_MIME[fallbackKind];
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = positiveNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function videoSize(payload: Record<string, unknown>): string {
  const width = positiveInteger(payload.width);
  const height = positiveInteger(payload.height);
  if (width !== undefined && height !== undefined && width <= 8192 && height <= 8192) return `${width}x${height}`;

  const size = payload.size;
  if (size && typeof size === "object" && !Array.isArray(size)) {
    const dimensions = size as Record<string, unknown>;
    const objectWidth = positiveInteger(dimensions.width);
    const objectHeight = positiveInteger(dimensions.height);
    if (objectWidth !== undefined && objectHeight !== undefined && objectWidth <= 8192 && objectHeight <= 8192) return `${objectWidth}x${objectHeight}`;
  }
  if (typeof size === "string") {
    const match = size.trim().match(/^([1-9]\d*)x([1-9]\d*)$/i);
    if (match && Number(match[1]) <= 8192 && Number(match[2]) <= 8192) return size.trim();
  }
  return /^(480|720|1080)p$/.test(String(payload.resolution ?? "").trim().toLowerCase()) ? String(payload.resolution).trim() : "";
}

function videoSeconds(payload: Record<string, unknown>): number | undefined {
  return positiveNumber(payload.duration ?? payload.seconds ?? payload.duration_seconds ?? payload.durationSeconds);
}

export async function findVideoJob(id: string) {
  const [job] = await db.select().from(generationJob).where(eq(generationJob.id, id)).limit(1);
  if (!job) throw new AppError("job_not_found", "Video not found", 404);
  const media = await db.select().from(mediaAsset).where(eq(mediaAsset.jobId, id)).orderBy(asc(mediaAsset.createdAt));
  return { job, media };
}

export async function videoObject(request: Request, input: Awaited<ReturnType<typeof findVideoJob>>) {
  const payload = input.job.requestPayload && typeof input.job.requestPayload === "object" && !Array.isArray(input.job.requestPayload) ? input.job.requestPayload as Record<string, unknown> : {};
  const media = await Promise.all(input.media.map(async (item) => ({ url: item.url && item.url.length ? item.url : await mediaUrl(request, item.objectKey), mime_type: safeMediaMimeType(item.mimeType, "video") })));
  const progress = input.job.status === "SUCCEEDED" ? 100 : input.job.status === "QUEUED" ? 0 : ["FAILED", "CANCELLED", "SUBMISSION_UNKNOWN"].includes(input.job.status) ? null : 50;
  return {
    id: input.job.id,
    object: "video",
    status: jobStatusForVideo(input.job.status),
    model: input.job.model,
    created_at: Math.floor(input.job.createdAt.getTime() / 1000),
    completed_at: input.job.completedAt ? Math.floor(input.job.completedAt.getTime() / 1000) : null,
    progress,
    seconds: videoSeconds(payload),
    size: videoSize(payload),
    error: input.job.errorCode ? { code: input.job.errorCode, message: input.job.errorMessage ?? "Video generation failed" } : null,
    output: media.length ? media[0] : null,
    outputs: media,
  };
}
