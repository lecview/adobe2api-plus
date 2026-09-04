import { requireServiceApiKey } from "@/lib/service-auth";
import { AppError, errorType, getRequestId, toErrorResponse } from "@/lib/errors";
import { enqueueGeneration, openAiError, validateReferenceUrls } from "@/lib/gateway";
import { normalizeVideoRequest } from "@/lib/media-request";
import { referenceLimitsForVideo, VIDEO_MODEL_CATALOG } from "@/lib/catalog";
import { findVideoJob, videoObject } from "@/lib/video-response";
import { parseVideoMultipartBody, withCanonicalProtocolModel } from "@/lib/media-response";

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  const isMultipart = request.headers.get("content-type")?.toLowerCase().includes("multipart/form-data");
  const body = isMultipart ? await parseVideoMultipartBody(request) : await request.json();
  return withCanonicalProtocolModel(body, "video");
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const input = normalizeVideoRequest(await parseBody(request), "sora");
    await validateReferenceUrls(input, referenceLimitsForVideo(VIDEO_MODEL_CATALOG[input.resolved_model]));
    const job = await enqueueGeneration({ apiPath: new URL(request.url).pathname, model: input.requested_model, payload: input });
    const task = await findVideoJob(job.id);
    return Response.json(await videoObject(request, task), { status: 202, headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AppError && error.status < 500) return Response.json(openAiError(error.message, errorType(error), error.code), { status: error.status, headers: { "x-request-id": requestId } });
    return toErrorResponse(error, requestId);
  }
}
