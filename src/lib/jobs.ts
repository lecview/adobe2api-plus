import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { generationJob, jobAttempt, jobEvent, mediaAsset, type AttemptStatus, type JobStage, type JobStatus } from "@/lib/db/schema";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import type { ProxySnapshot } from "@/lib/proxy-pool";
import { getSystemSettings } from "@/lib/system-settings";

const allowedTransitions: Record<JobStatus, JobStatus[]> = {
  QUEUED: ["UPLOADING", "FAILED", "CANCELLED"],
  UPLOADING: ["SUBMITTING", "FAILED", "CANCELLED"],
  SUBMITTING: ["POLLING", "SUBMISSION_UNKNOWN", "FAILED"],
  POLLING: ["DOWNLOADING", "FAILED", "CANCELLED"],
  DOWNLOADING: ["SUCCEEDED", "FAILED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  SUBMISSION_UNKNOWN: ["POLLING", "FAILED"],
};

type LockedJob = { id: string; status: JobStatus };

// drizzle 事务回调里的 tx 类型。
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 仅当调用方仍持有有效租约时锁定任务。
 *
 * Worker 状态写入必须在同一事务中使用此辅助函数。带条件的
 * `SELECT ... FOR UPDATE` 同时完成 owner/expiry CAS 和行锁，保证事件序号
 * 连续。迁移及状态机测试可以省略 worker id，以保留旧的无租约调用语义。
 */
async function lockJob(tx: DbTx, jobId: string, workerId?: string): Promise<LockedJob | null> {
  const rows = workerId === undefined
    ? await tx.select({ id: generationJob.id, status: generationJob.status }).from(generationJob).where(eq(generationJob.id, jobId)).for("update")
    : await tx.select({ id: generationJob.id, status: generationJob.status }).from(generationJob).where(and(eq(generationJob.id, jobId), eq(generationJob.leaseOwner, workerId), gt(generationJob.leaseExpiresAt, new Date()))).for("update");
  return rows[0] ?? null;
}

async function requireJobForWrite(tx: DbTx, jobId: string, workerId?: string): Promise<LockedJob> {
  const current = await lockJob(tx, jobId, workerId);
  if (current) return current;

  // 区分任务不存在和租约已被回收/过期；错误详情不暴露租约或 token 数据。
  const [exists] = await tx.select({ id: generationJob.id }).from(generationJob).where(eq(generationJob.id, jobId)).for("update");
  if (!exists) throw new AppError("job_not_found", "Job not found", 404);
  if (workerId !== undefined) throw new AppError("job_lease_lost", "Generation lease was lost", 409, { job_id: jobId });
  throw new AppError("job_not_found", "Job not found", 404);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return allowedTransitions[from]?.includes(to) ?? false;
}

export async function createJob(input: {
  apiPath: string;
  model?: string;
  requestPayload: unknown;
  kind?: "GENERATION" | "ENTITY_CREATE" | "ENTITY_SYNC" | "ENTITY_DELETE" | "REFRESH";
  adobeAccountId?: string;
  accountSnapshot?: unknown;
  entityId?: string;
  proxySnapshot?: ProxySnapshot;
}) {
  return db.transaction(async (tx) => {
    const jobId = randomUUID();
    await tx.insert(generationJob).values({
      id: jobId,
      apiPath: input.apiPath,
      model: input.model,
      requestPayload: input.requestPayload,
      kind: input.kind ?? "GENERATION",
      adobeAccountId: input.adobeAccountId,
      accountSnapshot: input.accountSnapshot as unknown,
      entityId: input.entityId,
      proxySnapshot: input.proxySnapshot as unknown,
    });
    const [job] = await tx.select().from(generationJob).where(eq(generationJob.id, jobId)).limit(1);
    await tx.insert(jobEvent).values({ jobId, sequence: 1, type: "QUEUED", payload: { status: "QUEUED" } });
    return job;
  });
}

export async function appendJobEvent(jobId: string, type: string, payload?: unknown, workerId?: string) {
  return db.transaction(async (tx) => {
    await requireJobForWrite(tx, jobId, workerId);
    const [latest] = await tx.select({ sequence: jobEvent.sequence }).from(jobEvent).where(eq(jobEvent.jobId, jobId)).orderBy(desc(jobEvent.sequence)).limit(1);
    const eventId = randomUUID();
    await tx.insert(jobEvent).values({ id: eventId, jobId, sequence: (latest?.sequence ?? 0) + 1, type, payload: payload as unknown });
    const [event] = await tx.select().from(jobEvent).where(eq(jobEvent.id, eventId)).limit(1);
    return event;
  });
}

export async function recordJobAttempt(input: { jobId: string; stage: JobStage; proxyId?: string | null; workerId?: string }) {
  return db.transaction(async (tx) => {
    await requireJobForWrite(tx, input.jobId, input.workerId);
    const [latest] = await tx.select({ attemptNumber: jobAttempt.attemptNumber }).from(jobAttempt).where(and(eq(jobAttempt.jobId, input.jobId), eq(jobAttempt.stage, input.stage))).orderBy(desc(jobAttempt.attemptNumber)).limit(1);
    const attemptId = randomUUID();
    await tx.insert(jobAttempt).values({ id: attemptId, jobId: input.jobId, stage: input.stage, attemptNumber: (latest?.attemptNumber ?? 0) + 1, proxyId: input.proxyId ?? null });
    await tx.update(generationJob).set({ attemptCount: sql`${generationJob.attemptCount} + 1`, currentProxyId: input.proxyId ?? null, updatedAt: new Date() }).where(eq(generationJob.id, input.jobId));
    const [attempt] = await tx.select().from(jobAttempt).where(eq(jobAttempt.id, attemptId)).limit(1);
    return attempt;
  });
}

export async function finishJobAttempt(attemptId: string, input: { status: AttemptStatus; errorCategory?: string; errorMessage?: string; upstreamStatus?: number; metadata?: unknown }, workerId?: string) {
  const data = { status: input.status, errorCategory: input.errorCategory, errorMessage: input.errorMessage?.slice(0, 500), upstreamStatus: input.upstreamStatus, metadata: input.metadata, finishedAt: new Date() };
  if (workerId === undefined) {
    await db.update(jobAttempt).set(data).where(eq(jobAttempt.id, attemptId));
    const [attempt] = await db.select().from(jobAttempt).where(eq(jobAttempt.id, attemptId)).limit(1);
    return attempt;
  }
  return db.transaction(async (tx) => {
    const [attempt] = await tx.select({ jobId: jobAttempt.jobId }).from(jobAttempt).where(eq(jobAttempt.id, attemptId)).limit(1);
    if (!attempt) throw new AppError("job_attempt_not_found", "Job attempt not found", 404);
    await requireJobForWrite(tx, attempt.jobId, workerId);
    await tx.update(jobAttempt).set(data).where(eq(jobAttempt.id, attemptId));
    const [updated] = await tx.select().from(jobAttempt).where(eq(jobAttempt.id, attemptId)).limit(1);
    return updated;
  });
}

export async function assertJobLease(jobId: string, workerId: string): Promise<void> {
  const [lease] = await db.select({ id: generationJob.id }).from(generationJob).where(and(eq(generationJob.id, jobId), eq(generationJob.leaseOwner, workerId), gt(generationJob.leaseExpiresAt, new Date()))).limit(1);
  if (!lease) throw new AppError("job_lease_lost", "Generation lease was lost", 409, { job_id: jobId });
}

export async function completeJobWithMedia(input: { jobId: string; media: { objectKey: string; url?: string | null; mimeType: string; byteSize: number; sha256: string } | Array<{ objectKey: string; url?: string | null; mimeType: string; byteSize: number; sha256: string }>; workerId?: string }) {
  const settings = await getSystemSettings();
  return db.transaction(async (tx) => {
    const current = await requireJobForWrite(tx, input.jobId, input.workerId);
    if (!canTransition(current.status, "SUCCEEDED")) throw new AppError("invalid_job_transition", `Cannot transition ${current.status} to SUCCEEDED`, 409);
    const mediaItems = Array.isArray(input.media) ? input.media : [input.media];
    if (!mediaItems.length) throw new AppError("media_missing", "Generation completed without media", 502);
    const expiresAt = new Date(Date.now() + settings.mediaRetentionDays * 24 * 60 * 60 * 1000);
    await tx.insert(mediaAsset).values(mediaItems.map((media) => ({ id: randomUUID(), jobId: input.jobId, objectKey: media.objectKey, url: media.url || null, mimeType: media.mimeType, byteSize: BigInt(media.byteSize), sha256: media.sha256, expiresAt })));
    await tx.update(generationJob).set({ status: "SUCCEEDED", completedAt: new Date(), resultPayload: { objectKey: mediaItems[0].objectKey, url: mediaItems[0].url || null, mimeType: mediaItems[0].mimeType, assets: mediaItems.map((media) => ({ objectKey: media.objectKey, url: media.url || null, mimeType: media.mimeType })) }, updatedAt: new Date() }).where(eq(generationJob.id, input.jobId));
    const [latest] = await tx.select({ sequence: jobEvent.sequence }).from(jobEvent).where(eq(jobEvent.jobId, input.jobId)).orderBy(desc(jobEvent.sequence)).limit(1);
    await tx.insert(jobEvent).values({ jobId: input.jobId, sequence: (latest?.sequence ?? 0) + 1, type: "SUCCEEDED", payload: { status: "SUCCEEDED", object_key: mediaItems[0].objectKey, asset_count: mediaItems.length } });
    const media = await tx.select().from(mediaAsset).where(eq(mediaAsset.jobId, input.jobId));
    const [job] = await tx.select().from(generationJob).where(eq(generationJob.id, input.jobId)).limit(1);
    return { job, media };
  });
}

export async function completeJobWithResult(jobId: string, resultPayload: unknown, workerId?: string) {
  return db.transaction(async (tx) => {
    const current = await requireJobForWrite(tx, jobId, workerId);
    if (!canTransition(current.status, "SUCCEEDED")) throw new AppError("invalid_job_transition", `Cannot transition ${current.status} to SUCCEEDED`, 409);
    await tx.update(generationJob).set({ status: "SUCCEEDED", completedAt: new Date(), resultPayload, updatedAt: new Date() }).where(eq(generationJob.id, jobId));
    const [latest] = await tx.select({ sequence: jobEvent.sequence }).from(jobEvent).where(eq(jobEvent.jobId, jobId)).orderBy(desc(jobEvent.sequence)).limit(1);
    await tx.insert(jobEvent).values({ jobId, sequence: (latest?.sequence ?? 0) + 1, type: "SUCCEEDED", payload: { status: "SUCCEEDED" } });
    const [job] = await tx.select().from(generationJob).where(eq(generationJob.id, jobId)).limit(1);
    return job;
  });
}

export async function transitionJob(jobId: string, next: JobStatus, patch: Record<string, unknown> = {}, workerId?: string) {
  return db.transaction(async (tx) => {
    const current = await requireJobForWrite(tx, jobId, workerId);
    if (!canTransition(current.status, next)) throw new AppError("invalid_job_transition", `Cannot transition ${current.status} to ${next}`, 409);
    await tx.update(generationJob).set({
      ...patch,
      status: next,
      ...(next === "SUCCEEDED" || next === "FAILED" || next === "CANCELLED" ? { completedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(eq(generationJob.id, jobId));
    const [latest] = await tx.select({ sequence: jobEvent.sequence }).from(jobEvent).where(eq(jobEvent.jobId, jobId)).orderBy(desc(jobEvent.sequence)).limit(1);
    await tx.insert(jobEvent).values({ jobId, sequence: (latest?.sequence ?? 0) + 1, type: next, payload: { status: next } });
    const [job] = await tx.select().from(generationJob).where(eq(generationJob.id, jobId)).limit(1);
    return job;
  });
}

/** 持有同一 worker 租约 CAS 后更新任务的非状态字段。 */
export async function updateJobWithLease(jobId: string, data: Record<string, unknown>, workerId: string) {
  return db.transaction(async (tx) => {
    await requireJobForWrite(tx, jobId, workerId);
    await tx.update(generationJob).set({ ...data, updatedAt: new Date() }).where(eq(generationJob.id, jobId));
    const [job] = await tx.select().from(generationJob).where(eq(generationJob.id, jobId)).limit(1);
    return job;
  });
}

export async function claimNextJob(workerId = config.workerId()) {
  const leaseExpiresAt = new Date(Date.now() + (await getSystemSettings()).jobLeaseMs);
  return db.transaction(async (tx) => {
    // 在数据库事务内直接锁定候选行，避免多个 Worker 先读到同一任务再竞争更新。
    // MySQL 8 的 SKIP LOCKED 让被其他 Worker 占用的任务不会阻塞整个队列。
    const [candidateRow] = await tx.select({ id: generationJob.id, startedAt: generationJob.startedAt }).from(generationJob).where(sql`
      (status = 'QUEUED' AND (leaseExpiresAt IS NULL OR leaseExpiresAt < NOW()))
      OR (status IN ('UPLOADING', 'SUBMITTING', 'POLLING', 'DOWNLOADING') AND leaseExpiresAt < NOW())
      OR (status = 'SUBMISSION_UNKNOWN' AND upstreamTaskId IS NOT NULL AND upstreamPollUrl IS NOT NULL AND leaseExpiresAt < NOW())
    `).orderBy(asc(generationJob.createdAt)).limit(1).for("update", { skipLocked: true });
    const candidateId = candidateRow?.id;
    if (!candidateId) return null;
    const [updateResult] = await tx.update(generationJob).set({
      leaseOwner: workerId,
      leaseExpiresAt,
      lastHeartbeatAt: new Date(),
      startedAt: candidateRow.startedAt ?? new Date(),
      updatedAt: new Date(),
    }).where(and(eq(generationJob.id, candidateId), or(isNull(generationJob.leaseOwner), lt(generationJob.leaseExpiresAt, new Date()))));
    if (updateResult.affectedRows !== 1) return null;
    const [job] = await tx.select().from(generationJob).where(eq(generationJob.id, candidateId)).limit(1);
    return job;
  });
}

export async function renewJobLease(jobId: string, workerId = config.workerId()): Promise<boolean> {
  const [result] = await db.update(generationJob).set({ leaseExpiresAt: new Date(Date.now() + (await getSystemSettings()).jobLeaseMs), lastHeartbeatAt: new Date(), updatedAt: new Date() }).where(and(eq(generationJob.id, jobId), eq(generationJob.leaseOwner, workerId), gt(generationJob.leaseExpiresAt, new Date())));
  return result.affectedRows === 1;
}

export async function releaseJobLease(jobId: string, workerId = config.workerId()) {
  await db.update(generationJob).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() }).where(and(eq(generationJob.id, jobId), eq(generationJob.leaseOwner, workerId)));
}

export async function waitForJob(jobId: string, timeoutMs?: number) {
  const deadline = Date.now() + (timeoutMs ?? (await getSystemSettings()).syncTimeoutMs);
  while (Date.now() < deadline) {
    const [job] = await db.select().from(generationJob).where(eq(generationJob.id, jobId)).limit(1);
    if (!job) throw new AppError("job_not_found", "Job not found", 404);
    const media = await db.select().from(mediaAsset).where(eq(mediaAsset.jobId, jobId));
    const terminalStatuses: JobStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED", "SUBMISSION_UNKNOWN"];
    if (terminalStatuses.includes(job.status)) return { ...job, media };
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(100, deadline - Date.now()))));
  }
  throw new AppError("job_timeout", "Generation is still running", 504, { job_id: jobId });
}

export async function readJobEvents(jobId: string, afterSequence = 0, timeoutMs?: number) {
  const deadline = Date.now() + (timeoutMs ?? (await getSystemSettings()).syncTimeoutMs);
  const terminalStatuses: JobStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED", "SUBMISSION_UNKNOWN"];
  let cursor = Math.max(0, afterSequence);
  while (Date.now() < deadline) {
    const events = await db.select().from(jobEvent).where(and(eq(jobEvent.jobId, jobId), gt(jobEvent.sequence, cursor))).orderBy(asc(jobEvent.sequence)).limit(100);
    if (events.length > 0) {
      cursor = events.at(-1)?.sequence ?? cursor;
      const [job] = await db.select({ status: generationJob.status }).from(generationJob).where(eq(generationJob.id, jobId)).limit(1);
      return { events, cursor, terminal: Boolean(job && terminalStatuses.includes(job.status)) };
    }
    const [job] = await db.select({ status: generationJob.status }).from(generationJob).where(eq(generationJob.id, jobId)).limit(1);
    if (job && terminalStatuses.includes(job.status)) return { events: [], cursor, terminal: true };
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(100, deadline - Date.now()))));
  }
  throw new AppError("job_timeout", "Generation is still running", 504, { job_id: jobId, after_sequence: cursor });
}
