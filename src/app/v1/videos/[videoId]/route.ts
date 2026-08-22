import { requireServiceApiKey } from "@/lib/service-auth";
import { getRequestId, toErrorResponse } from "@/lib/errors";
import { findVideoJob, videoObject } from "@/lib/video-response";

export async function GET(request: Request, { params }: { params: Promise<unknown> }) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const task = await findVideoJob(((await params) as { videoId: string }).videoId);
    return Response.json(await videoObject(request, task), { headers: { "x-request-id": requestId } });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
