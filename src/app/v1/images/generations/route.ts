import { requireServiceApiKey } from "@/lib/service-auth";
import { errorType, getRequestId, toErrorResponse, AppError } from "@/lib/errors";
import { isVideoModel } from "@/lib/catalog";
import { enqueueGeneration, openAiError, validateReferenceUrls, waitForGeneration } from "@/lib/gateway";
import { normalizeImageRequest } from "@/lib/media-request";
import { openAiImageData } from "@/lib/media-response";

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const input = normalizeImageRequest(await request.json());
    await validateReferenceUrls(input, { total: 4, image: 4, video: 0, audio: 0 });
    if (isVideoModel(input.model)) throw new AppError("invalid_request_error", "Use /v1/videos or /v1/chat/completions for video generation", 400);
    // GPT Image 质量默认 high（原 gptImageQuality 系统配置已移除）。
    const quality = input.quality ?? "high";
    const job = await enqueueGeneration({ apiPath: "/v1/images/generations", model: input.requested_model, payload: { ...input, quality } });
    const result = await waitForGeneration(job.id);
    const data = await openAiImageData(request, result.medias, input.response_format);
    return Response.json({ created: Math.floor(Date.now() / 1000), model: input.requested_model, data }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AppError && error.status < 500) return Response.json(openAiError(error.message, errorType(error), error.code), { status: error.status, headers: { "x-request-id": requestId } });
    return toErrorResponse(error, requestId);
  }
}
