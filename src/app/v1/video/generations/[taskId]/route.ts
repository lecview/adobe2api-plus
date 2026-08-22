import { GET as getVideo } from "@/app/v1/videos/[videoId]/route";

function genericStatus(status: string): "queued" | "in_progress" | "completed" | "failed" {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "queued") return "queued";
  return "in_progress";
}

export async function GET(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const response = await getVideo(request, { params: Promise.resolve({ videoId: taskId }) });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) return Response.json(body, { status: response.status, headers: { "x-request-id": response.headers.get("x-request-id") ?? "" } });
  const output = body.output && typeof body.output === "object" && !Array.isArray(body.output) ? body.output as Record<string, unknown> : {};
  const size = typeof body.size === "string" ? body.size.match(/^(\d+)x(\d+)$/) : null;
  const metadata: Record<string, unknown> = {};
  if (typeof body.seconds === "number") metadata.duration = body.seconds;
  if (typeof body.fps === "number") metadata.fps = body.fps;
  if (size) { metadata.width = Number(size[1]); metadata.height = Number(size[2]); }
  const mimeType = typeof output.mime_type === "string" ? output.mime_type : "video/mp4";
  return Response.json({
    task_id: body.id,
    status: genericStatus(String(body.status ?? "in_progress")),
    url: typeof output.url === "string" ? output.url : null,
    format: mimeType.split("/")[1] ?? "mp4",
    metadata,
    error: body.error && typeof body.error === "object" ? body.error : { code: 0, message: "" },
  }, { headers: { "x-request-id": response.headers.get("x-request-id") ?? "" } });
}
