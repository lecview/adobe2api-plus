import { requireAdmin } from "@/lib/auth";
import { AppError, getRequestId, toErrorResponse } from "@/lib/errors";

/**
 * 校验后台写请求的同源证明。
 *
 * 浏览器会优先发送 Origin；没有 Origin 的同源客户端必须显式携带
 * 约定的 CSRF 头，避免仅依赖 Cookie 的请求被跨站伪造。
 */
export function assertTrustedMutation(request: Request): void {
  const origin = request.headers.get("origin");
  const requestUrl = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || requestUrl.protocol.replace(":", "");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host") || requestUrl.host;
  const trustedOrigins = new Set([requestUrl.origin, `${forwardedProto}://${forwardedHost}`]);
  if (origin && !trustedOrigins.has(origin)) {
    throw new AppError("csrf_rejected", "Request origin is not trusted", 403);
  }
  if (!origin && request.headers.get("x-csrf-token") !== "same-origin") {
    throw new AppError("csrf_rejected", "CSRF proof is required", 403);
  }
}

export async function requireAdminRequest(request: Request) {
  const user = await requireAdmin();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    assertTrustedMutation(request);
  }
  return user;
}

export function handleAdminError(error: unknown, request: Request) {
  return toErrorResponse(error, getRequestId(request));
}
