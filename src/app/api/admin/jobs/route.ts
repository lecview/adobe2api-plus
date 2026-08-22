import { asc, desc, inArray } from "drizzle-orm";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { adobeAccount, generationJob, jobAttempt, jobEvent, mediaAsset, proxyNode } from "@/lib/db/schema";
import { getRequestId, safeErrorMessage, statusForErrorCode } from "@/lib/errors";
import { handleAdminError, requireAdminRequest } from "@/lib/admin-api";
import { removeMedia } from "@/lib/media";

/** 代理节点 id → host:port（仅用于后台展示，不暴露凭据）。 */
function proxyHostLabel(proxy: { protocol: string; host: string; port: number }): string {
  return `${proxy.protocol} ${proxy.host}:${proxy.port}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function promptText(payload: unknown): string | null {
  const record = asRecord(payload);
  let prompt = textValue(record.prompt);
  if (!prompt && Array.isArray(record.messages)) {
    const chunks: string[] = [];
    for (const message of record.messages) {
      const item = asRecord(message);
      if (typeof item.content === "string") chunks.push(item.content);
      else if (Array.isArray(item.content)) {
        for (const part of item.content) {
          const text = textValue(asRecord(part).text);
          if (text) chunks.push(text);
        }
      }
    }
    prompt = chunks.join("\n\n").trim();
  }
  if (!prompt) {
    const name = textValue(record.name || record.displayName);
    if (name) prompt = `entity: ${name}`;
  }
  if (!prompt) return null;
  return prompt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function promptPreview(payload: unknown): string | null {
  const prompt = promptText(payload);
  if (!prompt) return null;
  return prompt.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").slice(0, 180);
}

function progressForStatus(status: string): number | null {
  switch (status) {
    case "QUEUED": return 0;
    case "UPLOADING": return 10;
    case "SUBMITTING": return 35;
    case "POLLING": return 50;
    case "DOWNLOADING": return 90;
    case "SUCCEEDED": return 100;
    default: return null;
  }
}

function eventSummary(event: { type: string; payload: unknown; createdAt: Date }) {
  const payload = asRecord(event.payload);
  const rawProgress = Number(payload.progress);
  const progress = Number.isFinite(rawProgress)
    ? Math.max(0, Math.min(100, rawProgress <= 1 ? rawProgress * 100 : rawProgress))
    : null;
  const rawAttemptIndex = Number(payload.attempt_index);
  return {
    type: event.type,
    createdAt: event.createdAt,
    progress,
    stage: textValue(payload.stage) || null,
    proxyId: textValue(payload.proxy_id) || null,
    attemptIndex: Number.isInteger(rawAttemptIndex) ? rawAttemptIndex : null,
    upstreamTaskId: textValue(payload.upstream_task_id) || null,
  };
}

function mediaPath(objectKey: string): string {
  return `${config.mediaPublicPrefix()}/${objectKey.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

export async function GET(request: Request) {
  try {
    await requireAdminRequest(request);

    const jobs = await db
      .select({
        id: generationJob.id,
        status: generationJob.status,
        kind: generationJob.kind,
        apiPath: generationJob.apiPath,
        model: generationJob.model,
        errorCode: generationJob.errorCode,
        errorMessage: generationJob.errorMessage,
        requestPayload: generationJob.requestPayload,
        resultPayload: generationJob.resultPayload,
        upstreamTaskId: generationJob.upstreamTaskId,
        currentProxyId: generationJob.currentProxyId,
        attemptCount: generationJob.attemptCount,
        startedAt: generationJob.startedAt,
        completedAt: generationJob.completedAt,
        createdAt: generationJob.createdAt,
        updatedAt: generationJob.updatedAt,
        adobeAccountId: generationJob.adobeAccountId,
      })
      .from(generationJob)
      .orderBy(desc(generationJob.createdAt))
      .limit(100);

    const jobIds = jobs.map((job) => job.id);
    const accountIds = [...new Set(jobs.map((job) => job.adobeAccountId).filter((id): id is string => Boolean(id)))];

    // 并行查询：accounts / media / attempts / events 互不依赖，一次往返并行取回，
    // 避免逐个串行等待远端 MySQL（每事务约 1.7s）导致列表加载 8-10s 超时。
    const [accounts, mediaList, attempts, recentEvents] = await Promise.all([
      accountIds.length > 0
        ? db
            .select({ id: adobeAccount.id, displayName: adobeAccount.displayName, email: adobeAccount.email })
            .from(adobeAccount)
            .where(inArray(adobeAccount.id, accountIds))
        : Promise.resolve([]),
      jobIds.length > 0
        ? db
            .select({ jobId: mediaAsset.jobId, objectKey: mediaAsset.objectKey, url: mediaAsset.url, mimeType: mediaAsset.mimeType, byteSize: mediaAsset.byteSize })
            .from(mediaAsset)
            .where(inArray(mediaAsset.jobId, jobIds))
        : Promise.resolve([]),
      jobIds.length > 0
        ? db
            .select({
              jobId: jobAttempt.jobId,
              stage: jobAttempt.stage,
              attemptNumber: jobAttempt.attemptNumber,
              proxyId: jobAttempt.proxyId,
              status: jobAttempt.status,
              errorCategory: jobAttempt.errorCategory,
              errorMessage: jobAttempt.errorMessage,
              upstreamStatus: jobAttempt.upstreamStatus,
              startedAt: jobAttempt.startedAt,
              finishedAt: jobAttempt.finishedAt,
            })
            .from(jobAttempt)
            .where(inArray(jobAttempt.jobId, jobIds))
            .orderBy(asc(jobAttempt.startedAt))
        : Promise.resolve([]),
      jobIds.length > 0
        ? db
            .select({ jobId: jobEvent.jobId, type: jobEvent.type, payload: jobEvent.payload, createdAt: jobEvent.createdAt })
            .from(jobEvent)
            .where(inArray(jobEvent.jobId, jobIds))
            .orderBy(desc(jobEvent.createdAt), desc(jobEvent.sequence))
            .limit(Math.min(1000, Math.max(100, jobIds.length * 20)))
        : Promise.resolve([]),
    ]);
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const mediaByJobId = new Map<string, typeof mediaList>();
    for (const media of mediaList) {
      const list = mediaByJobId.get(media.jobId) ?? [];
      list.push(media);
      mediaByJobId.set(media.jobId, list);
    }
    const attemptsByJobId = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      const list = attemptsByJobId.get(attempt.jobId) ?? [];
      list.push(attempt);
      attemptsByJobId.set(attempt.jobId, list);
    }

    // 收集任务当前与各阶段尝试用到的代理 id，映射为 host:port 供后台展示（不暴露凭据）。
    // 依赖 attempts，单独一轮查询。
    const proxyIds = [...new Set([
      ...jobs.map((job) => job.currentProxyId).filter((id): id is string => Boolean(id)),
      ...attempts.map((attempt) => attempt.proxyId).filter((id): id is string => Boolean(id)),
    ])];
    const proxyRows = proxyIds.length > 0
      ? await db
          .select({ id: proxyNode.id, protocol: proxyNode.protocol, host: proxyNode.host, port: proxyNode.port })
          .from(proxyNode)
          .where(inArray(proxyNode.id, proxyIds))
      : [];
    const proxyById = new Map(proxyRows.map((proxy) => [proxy.id, proxy]));

    const eventsByJobId = new Map<string, typeof recentEvents>();
    for (const event of recentEvents) {
      const list = eventsByJobId.get(event.jobId) ?? [];
      list.push(event);
      eventsByJobId.set(event.jobId, list);
    }

    const result = jobs.map((job) => {
      const account = job.adobeAccountId ? accountById.get(job.adobeAccountId) ?? null : null;
      const jobAttempts = (attemptsByJobId.get(job.id) ?? []).map((attempt) => {
        const proxy = attempt.proxyId ? proxyById.get(attempt.proxyId) : undefined;
        return {
          stage: attempt.stage,
          attemptNumber: attempt.attemptNumber,
          proxyId: attempt.proxyId,
          proxyHost: proxy ? proxyHostLabel(proxy) : null,
          status: attempt.status,
          errorCategory: attempt.errorCategory,
          errorMessage: attempt.errorMessage,
          upstreamStatus: attempt.upstreamStatus,
          startedAt: attempt.startedAt,
          finishedAt: attempt.finishedAt,
        };
      });
      const summaries = (eventsByJobId.get(job.id) ?? []).map(eventSummary);
      const pollEvent = summaries.find((event) => event.type === "POLL_PROGRESS" && event.progress !== null);
      const latestEvent = summaries[0] ?? null;
      const terminal = ["SUCCEEDED", "FAILED", "CANCELLED", "SUBMISSION_UNKNOWN"].includes(job.status);
      const endAt = job.completedAt ?? (terminal ? job.updatedAt : null);
      const durationSeconds = Math.max(0, Math.round(((endAt ?? new Date()).getTime() - job.createdAt.getTime()) / 1000));
      const runningAttempt = jobAttempts.find((attempt) => attempt.status === "RUNNING") ?? null;
      const lastAttempt = jobAttempts.at(-1) ?? null;
      const media = (mediaByJobId.get(job.id) ?? []).map((asset) => ({
        objectKey: asset.objectKey,
        url: asset.url,
        mimeType: asset.mimeType,
        byteSize: asset.byteSize.toString(),
        previewPath: asset.url && asset.url.length ? asset.url : mediaPath(asset.objectKey),
      }));
      const resultPayload = asRecord(job.resultPayload);
      const creditCost = typeof resultPayload.creditCost === "number" && Number.isFinite(resultPayload.creditCost) ? Math.max(0, resultPayload.creditCost) : null;
      return {
        id: job.id,
        status: job.status,
        kind: job.kind,
        apiPath: job.apiPath,
        model: job.model,
        account: account ? { id: account.id, displayName: account.displayName, email: account.email } : null,
        errorCode: job.errorCode,
        errorMessage: job.errorCode ? (textValue(job.errorMessage) || safeErrorMessage(job.errorCode, statusForErrorCode(job.errorCode))) : null,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        updatedAt: job.updatedAt,
        durationSeconds,
        // 终态任务以状态映射进度为准（已完成=100），忽略最后一条 POLL_PROGRESS 的 0，
        // 否则 `0 ?? x` 会因 0 是合法值而取到 0，导致已完成任务仍显示 0%。
        progress: terminal ? progressForStatus(job.status) : (pollEvent?.progress ?? progressForStatus(job.status)),
        creditCost,
        promptText: promptText(job.requestPayload),
        promptPreview: promptPreview(job.requestPayload),
        currentStage: runningAttempt?.stage ?? lastAttempt?.stage ?? (job.status === "POLLING" ? "POLL" : null),
        currentProxyId: job.currentProxyId,
        // 当前/最近使用的代理 host:port 与最近一次尝试的上游状态码，便于判断上游拒绝是否与代理相关。
        proxyHost: job.currentProxyId ? (() => { const proxy = proxyById.get(job.currentProxyId); return proxy ? proxyHostLabel(proxy) : null; })() : null,
        upstreamStatus: lastAttempt?.upstreamStatus ?? null,
        attemptCount: job.attemptCount,
        upstreamTaskId: job.upstreamTaskId,
        latestEvent,
        attempts: jobAttempts,
        events: summaries.slice(0, 20),
        media,
      };
    });

    return Response.json({ jobs: result, request_id: getRequestId(request) });
  } catch (error) {
    return handleAdminError(error, request);
  }
}

export async function DELETE(request: Request) {
  try {
    await requireAdminRequest(request);
    const body = await request.json().catch(() => ({}));
    const rawIds = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).ids : null;
    const ids = Array.isArray(rawIds)
      ? rawIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).slice(0, 500)
      : [];
    if (ids.length === 0) {
      return Response.json({ error: { message: "请选择要删除的请求日志" } }, { status: 400 });
    }

    // 先删磁盘媒体文件（objectKey 非空才对应本地文件；returnOriginalUrl 场景 objectKey 为空串占位，
    // 仅返回 Adobe 原地址，无本地文件），单个文件删除失败不阻断整体（孤儿文件由运维清理兜底）。
    const mediaRows = await db
      .select({ objectKey: mediaAsset.objectKey })
      .from(mediaAsset)
      .where(inArray(mediaAsset.jobId, ids));
    await Promise.all(mediaRows.map((media) => {
      if (media.objectKey && media.objectKey.trim()) return removeMedia(media.objectKey).catch(() => undefined);
      return undefined;
    }));

    // 事务内按「子表 → 父表」顺序删除：mediaAsset / jobAttempt / jobEvent → generationJob。
    const removed = await db.transaction(async (tx) => {
      await tx.delete(mediaAsset).where(inArray(mediaAsset.jobId, ids));
      await tx.delete(jobAttempt).where(inArray(jobAttempt.jobId, ids));
      await tx.delete(jobEvent).where(inArray(jobEvent.jobId, ids));
      const result = await tx.delete(generationJob).where(inArray(generationJob.id, ids));
      return result[0]?.affectedRows ?? ids.length;
    });

    return Response.json({ deleted: removed, request_id: getRequestId(request) });
  } catch (error) {
    return handleAdminError(error, request);
  }
}
