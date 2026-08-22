import { AppError, errorType, toErrorResponse } from "@/lib/errors";

describe("public error mapping", () => {
  it("keeps authentication and quota failures distinguishable", async () => {
    expect(errorType(new AppError("adobe_auth_failed", "token expired", 401))).toBe("authentication_error");
    expect(errorType(new AppError("adobe_quota_exhausted", "quota exhausted", 429))).toBe("rate_limit_error");
    const response = await toErrorResponse(new AppError("adobe_quota_exhausted", "quota exhausted", 429), "req-error-test").json() as { error: { type: string; request_id: string } };
    expect(response.error).toMatchObject({ type: "rate_limit_error", request_id: "req-error-test" });
  });

  it("does not expose internal or upstream exception text", async () => {
    const response = await toErrorResponse(new AppError("adobe_transport_error", "https://user:password@example.test/?token=secret", 503), "req-redaction-test").json() as { error: { message: string } };
    expect(response.error.message).toBe("Upstream service temporarily unavailable");
    expect(response.error.message).not.toContain("password");
    expect(response.error.message).not.toContain("secret");
  });
});
