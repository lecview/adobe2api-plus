import { requireServiceApiKey } from "@/lib/service-auth";
import { getRequestId, toErrorResponse } from "@/lib/errors";
import { enqueueGeneration, validateReferenceUrls } from "@/lib/gateway";
import { referenceLimitsForVideo, VIDEO_MODEL_CATALOG } from "@/lib/catalog";
import { normalizeChatRequest } from "@/lib/media-request";

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const input = normalizeChatRequest(await request.json());
    const video = input.kind === "video" ? VIDEO_MODEL_CATALOG[input.resolved_model] : undefined;
    await validateReferenceUrls(input, referenceLimitsForVideo(video));
    const job = await enqueueGeneration({ apiPath: "/api/v1/generate", model: input.requested_model, payload: input });
    return Response.json({ task_id: job.id, status: job.status.toLowerCase(), request_id: requestId }, { status: 202, headers: { "x-request-id": requestId } });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
