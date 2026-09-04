import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { generationJob, mediaAsset } from "@/lib/db/schema";
import { requireServiceApiKey } from "@/lib/service-auth";
import { getRequestId, safeErrorMessage, statusForErrorCode, toErrorResponse } from "@/lib/errors";
import { config } from "@/lib/config";

export async function GET(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const { taskId } = await params;
    const [job] = await db.select().from(generationJob).where(eq(generationJob.id, taskId)).limit(1);
    if (!job) {
      return Response.json({ error: { message: "task not found", type: "invalid_request_error", code: "job_not_found", request_id: requestId } }, { status: 404, headers: { "x-request-id": requestId } });
    }
    // 查询首个媒体资产；任务状态与错误已经保存在 generationJob。
    const [media] = await db.select().from(mediaAsset).where(eq(mediaAsset.jobId, taskId)).limit(1);
    const error = job.errorCode ? safeErrorMessage(job.errorCode, statusForErrorCode(job.errorCode)) : null;
    // returnOriginalUrl 开启时 media.url 存原地址，直接返回；否则返回本地存储地址
    const imageUrl = media ? (media.url && media.url.length ? media.url : `${config.mediaPublicPrefix()}/${media.objectKey}`) : null;
    return Response.json({ task_id: job.id, status: job.status.toLowerCase(), progress: job.status === "SUCCEEDED" ? 100 : job.status === "QUEUED" ? 0 : 50, image_url: imageUrl, error, updated_at: job.updatedAt, request_id: requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
