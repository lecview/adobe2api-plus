import { getRequestId } from "@/lib/errors";

export function jsonOk<T>(data: T, requestId?: string): Response {
  const id = requestId ?? crypto.randomUUID();
  return Response.json({ ...((data && typeof data === "object" ? data : { data }) as object), request_id: id }, { headers: { "x-request-id": id } });
}

export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export function requestId(request: Request): string {
  return getRequestId(request);
}
