import { mediaResponse } from "@/lib/media";
import { getRequestId, toErrorResponse } from "@/lib/errors";

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const requestId = getRequestId(request);
  try {
    const { path } = await params;
    return await mediaResponse(path.join("/"));
  } catch (error) {
    const response = toErrorResponse(error, requestId);
    response.headers.set("x-request-id", requestId);
    return response;
  }
}
