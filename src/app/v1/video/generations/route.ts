import { POST as createVideo } from "@/app/v1/videos/route";

function genericStatus(status: string): "queued" | "in_progress" | "completed" | "failed" {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "queued") return "queued";
  return "in_progress";
}

export async function POST(request: Request) {
  const response = await createVideo(request);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) return Response.json(body, { status: response.status, headers: { "x-request-id": response.headers.get("x-request-id") ?? "" } });
  return Response.json({ task_id: body.id, status: genericStatus(String(body.status ?? "queued")) }, { headers: { "x-request-id": response.headers.get("x-request-id") ?? "" } });
}
