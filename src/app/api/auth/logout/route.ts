import { NextResponse } from "next/server";
import { revokeCurrentSession } from "@/lib/auth";
import { assertTrustedMutation } from "@/lib/admin-api";
import { getRequestId, toErrorResponse } from "@/lib/errors";

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    assertTrustedMutation(request);
    await revokeCurrentSession();
    return NextResponse.json({ ok: true, request_id: requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
