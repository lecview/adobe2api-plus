import { NextResponse } from "next/server";
import { getCurrentAdmin } from "@/lib/auth";
import { getRequestId, toErrorResponse } from "@/lib/errors";

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    const user = await getCurrentAdmin();
    if (!user) return NextResponse.json({ error: { code: "unauthorized", message: "Unauthorized", request_id: requestId } }, { status: 401 });
    return NextResponse.json({ id: user.id, username: user.username, request_id: requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
