export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 500, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function getRequestId(request?: Request): string {
  return request?.headers.get("x-request-id")?.slice(0, 96) || crypto.randomUUID();
}

/**
 * 公开接口只允许返回稳定的错误分类，不回显 Worker/上游的原始异常。
 * 这组消息刻意不包含 URL、响应体、代理地址或凭据。
 */
export function safeErrorMessage(code: string, status: number): string {
  if (code === "adobe_auth_failed") return "Adobe authentication failed";
  if (code === "adobe_quota_exhausted" || code === "adobe_rate_limited" || status === 429) return "Adobe rate limit or quota exceeded";
  if (code === "proxy_exhausted" || code === "proxy_pool_empty" || code === "adobe_upstream_temporary" || status === 503) return "Upstream service temporarily unavailable";
  if (code === "job_timeout" || code === "adobe_generation_timeout" || status === 504) return "Generation timed out";
  if (code === "submission_unknown") return "Submission outcome requires reconciliation";
  if (code === "media_missing") return "Generated media is unavailable";
  return "Internal server error";
}

export function statusForErrorCode(code: string): number {
  if (code === "adobe_auth_failed") return 401;
  if (code === "adobe_quota_exhausted" || code === "adobe_rate_limited") return 429;
  if (code === "adobe_generation_timeout" || code === "job_timeout") return 504;
  if (code === "proxy_exhausted" || code === "proxy_pool_empty" || code === "adobe_upstream_temporary") return 503;
  return 502;
}

export function toErrorResponse(error: unknown, requestId: string): Response {
  const appError = error instanceof AppError ? error : new AppError("internal_error", "Internal server error");
  const details = appError.details && typeof appError.details === "object" && !Array.isArray(appError.details)
    ? Object.fromEntries(Object.entries(appError.details as Record<string, unknown>).filter(([key]) => ["job_id", "active_jobs", "entity_count", "after_sequence", "retry_after"].includes(key)))
    : undefined;
  const type = errorType(appError);
  const message = appError.status >= 500 ? safeErrorMessage(appError.code, appError.status) : appError.message;
  return Response.json(
    { error: { code: appError.code, message, type, request_id: requestId, ...(details && Object.keys(details).length ? { details } : {}) } },
    { status: appError.status, headers: { "x-request-id": requestId } },
  );
}

export function errorType(appError: AppError): string {
  if (appError.code === "adobe_auth_failed") return "authentication_error";
  if (appError.code === "adobe_quota_exhausted" || appError.code === "adobe_rate_limited" || appError.status === 429) return "rate_limit_error";
  if (appError.status < 400) return "success";
  if (appError.status < 500) return "invalid_request_error";
  return appError.status === 503 ? "service_unavailable" : "server_error";
}

export function asAppError(error: unknown): AppError {
  return error instanceof AppError ? error : new AppError("internal_error", "Internal server error");
}
