import { requireServiceApiKey } from "@/lib/service-auth";
import { AppError, errorType, getRequestId, toErrorResponse } from "@/lib/errors";
import { referenceLimitsForVideo, VIDEO_MODEL_CATALOG } from "@/lib/catalog";
import { enqueueGeneration, openAiError, validateReferenceUrls } from "@/lib/gateway";
import { normalizeVideoRequest } from "@/lib/media-request";
import { findVideoJob, videoObject } from "@/lib/video-response";
import { parseVideoMultipartBody, withCanonicalProtocolModel } from "@/lib/media-response";

function klingStatus(status: string): string {
  if (status === "SUCCEEDED") return "succeed";
  if (["FAILED", "CANCELLED", "SUBMISSION_UNKNOWN"].includes(status)) return "failed";
  if (status === "QUEUED") return "submitted";
  return "processing";
}

async function klingResponse(request: Request, task: Awaited<ReturnType<typeof findVideoJob>>, requestId: string) {
  const object = await videoObject(request, task);
  return {
    code: 0,
    message: "Succeeded",
    request_id: requestId,
    data: {
      task_id: task.job.id,
      task_status: klingStatus(task.job.status),
      task_status_msg: task.job.errorMessage ?? "",
      // Kling's public response uses Unix milliseconds for these timestamps.
      created_at: task.job.createdAt.getTime(),
      updated_at: task.job.updatedAt.getTime(),
      task_result: object.outputs.length ? { videos: object.outputs.map((item, index) => ({ id: `${task.job.id}-${index + 1}`, url: item.url, duration: object.seconds })) } : null,
    },
  };
}

export async function POST(request: Request, { params }: { params: Promise<unknown> }) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const path = ((await params) as { path?: string[] }).path ?? [];
    const operation = path.at(-1);
    if (operation !== "text2video" && operation !== "image2video") throw new AppError("invalid_request_error", "Use text2video or image2video", 400);
    const isMultipart = request.headers.get("content-type")?.toLowerCase().includes("multipart/form-data");
    const body = isMultipart ? await parseVideoMultipartBody(request) : await request.json();
    const input = normalizeVideoRequest(withCanonicalProtocolModel(body, "video"), "kling", operation);
    await validateReferenceUrls(input, referenceLimitsForVideo(VIDEO_MODEL_CATALOG[input.model]));
    const job = await enqueueGeneration({ apiPath: `/kling/v1/videos/${operation}`, model: input.model, payload: input });
    const task = await findVideoJob(job.id);
    return Response.json(await klingResponse(request, task, requestId), { status: 200, headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AppError && error.status < 500) return Response.json(openAiError(error.message, errorType(error), error.code), { status: error.status, headers: { "x-request-id": requestId } });
    return toErrorResponse(error, requestId);
  }
}

export async function GET(request: Request, { params }: { params: Promise<unknown> }) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const path = ((await params) as { path?: string[] }).path ?? [];
    const taskId = path.at(-1);
    if (!taskId || taskId === "text2video" || taskId === "image2video") throw new AppError("invalid_request_error", "A task id is required", 400);
    return Response.json(await klingResponse(request, await findVideoJob(taskId), requestId), { headers: { "x-request-id": requestId } });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
