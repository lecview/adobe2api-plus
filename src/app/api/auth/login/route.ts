import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAdmin, assertLoginRateLimit, clearLoginFailures, createSessionToken, recordLoginFailure, safeReturnPath } from "@/lib/auth";
import { AUTH_COOKIE_NAME } from "@/lib/auth-constants";
import { getRequestId, toErrorResponse } from "@/lib/errors";

const schema = z.object({ username: z.string().trim().min(1).max(128), password: z.string().min(1).max(512), next: z.string().optional() });

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  const source = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  let attemptedUsername = "";
  try {
    const input = schema.parse(await request.json());
    attemptedUsername = input.username.toLowerCase();
    const throttleKey = `${source}:${attemptedUsername}`;
    await assertLoginRateLimit(throttleKey);
    const user = await authenticateAdmin(input.username, input.password);
    await clearLoginFailures(throttleKey);
    const token = await createSessionToken(user.id, user.username);
    const response = NextResponse.json({ ok: true, next: safeReturnPath(input.next), request_id: requestId }, { headers: { "x-request-id": requestId } });
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    const secureCookie = process.env.NODE_ENV === "production" && (forwardedProto === "https" || new URL(request.url).protocol === "https:");
    response.cookies.set(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookie,
      path: "/",
      maxAge: 60 * 60 * 8,
    });
    return response;
  } catch (error) {
    if (attemptedUsername) {
      const throttleKey = `${source}:${attemptedUsername}`;
      await recordLoginFailure(throttleKey).catch(() => undefined);
    }
    if (error instanceof z.ZodError) return NextResponse.json({ error: { code: "invalid_request_error", type: "invalid_request_error", message: "Invalid login request", request_id: requestId } }, { status: 400, headers: { "x-request-id": requestId } });
    return toErrorResponse(error, requestId);
  }
}
