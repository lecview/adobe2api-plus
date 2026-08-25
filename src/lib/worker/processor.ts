import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { adobeToken, entity, generationJob, type AttemptStatus, type JobStage, type JobStatus } from "@/lib/db/schema";
import { claimNextJob, appendJobEvent, assertJobLease, completeJobWithMedia, completeJobWithResult, finishJobAttempt, recordJobAttempt, releaseJobLease, renewJobLease, transitionJob, updateJobWithLease } from "@/lib/jobs";
import { AdobeClient, AdobeUpstreamError } from "@/lib/adobe/client";
import { selectAdobeAccount, selectAdobeGenerationAccount, deleteAdobeAccount, markAdobeTokenFailure, markAdobeTokenSuccess, markAdobeAccountRiskFlagged } from "@/lib/adobe/account";
import { refreshGlobalSherlockToken } from "@/lib/adobe/sherlock";
import { accountIdFromToken, queryCreditsUsed } from "@/lib/adobe/refresh";
import { cleanupReferenceSources, closeReferenceMedia, loadReferenceSources, openReferenceMedia, type ReferenceMedia } from "@/lib/adobe/input";
import { VIDEO_MODEL_CATALOG, resolveImageModel, resolveVideoModel } from "@/lib/catalog";
import { AppError } from "@/lib/errors";
import { removeMedia, writeMediaStream } from "@/lib/media";
import { isProxyEligibleFailure, type ProxySnapshot, type ProxySnapshotEntry } from "@/lib/proxy-pool";
import type { AdobeTransport } from "@/lib/adobe/transport";
import { FetchAdobeTransport } from "@/lib/adobe/transport";
import { getSystemSettings } from "@/lib/system-settings";
import type { ImageProviderOptions, VideoProviderOptions } from "@/lib/media-request";

type JobPayload = Record<string, unknown> & { __adobe_source_ids?: { images?: string[]; videos?: string[]; audios?: string[]; maskId?: string; mask?: string } };

function snapshotFromJson(value: unknown): ProxySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { mode: "direct", entries: [], selectedIndex: -1 };
  const candidate = value as Partial<ProxySnapshot>;
  if (candidate.mode !== "proxy" || !Array.isArray(candidate.entries)) return { mode: "direct", entries: [], selectedIndex: -1 };
  return { mode: "proxy", selectedIndex: Number.isInteger(candidate.selectedIndex) ? Number(candidate.selectedIndex) : 0, entries: candidate.entries.filter((entry): entry is ProxySnapshotEntry => Boolean(entry && typeof entry === "object" && "id" in entry && "host" in entry && "port" in entry)) };
}

function proxyEligible(error: unknown): boolean {
  if (error instanceof AdobeUpstreamError) return error.proxyEligible;
  if (error instanceof AppError) {
    const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
    if (typeof details.proxyEligible === "boolean") return details.proxyEligible;
    return error.code === "adobe_transport_error";
  }
  return isProxyEligibleFailure(error);
}

function isExplicitSubmitTimeout(error: unknown): error is AdobeUpstreamError {
  return error instanceof AdobeUpstreamError
    && error.code === "adobe_submit_timeout"
    && error.retryable
    && !error.proxyEligible;
}

export type StageRetryDisposition = "same_route" | "next_proxy" | "stop" | "proxy_exhausted";

export function stageRetryDisposition(error: unknown, input: {
  stage: JobStage;
  mode: ProxySnapshot["mode"];
  attempts: number;
  maxAttempts: number;
  index: number;
  entryCount: number;
}): StageRetryDisposition {
  const submissionOutcomeUnknown = input.stage === "SUBMIT"
    && error instanceof AppError
    && error.code === "adobe_transport_error";

  if (submissionOutcomeUnknown) {
    // 提交阶段 transport 错误按 kind 细分：
    // - connection/proxy：连接都没建立，请求未发出，可安全换代理重试
    // - timeout/body：结果不确定（可能已提交成功），保持 stop 避免重复提交扣积分
    const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? error.details as Record<string, unknown>
      : {};
    const kind = typeof details.kind === "string" ? details.kind : "";
    if ((kind === "connection" || kind === "proxy") && input.mode === "proxy" && input.index >= 0 && input.index + 1 < input.entryCount) {
      return "next_proxy";
    }
    return "stop";
  }
  if (input.attempts >= input.maxAttempts) {
    return input.mode === "proxy" && proxyEligible(error) && input.entryCount > 0
      ? "proxy_exhausted"
      : "stop";
  }
  // Adobe 已明确响应 timeout_error，提交结果是确定的；保持网络路由，
  // 由调用方在剩余账号池中重新随机，避免把账号问题误判为代理问题。
  if (isExplicitSubmitTimeout(error)) return "same_route";
  if (input.mode === "proxy" && proxyEligible(error) && input.index >= 0) {
    return input.index + 1 < input.entryCount ? "next_proxy" : "proxy_exhausted";
  }
  return "stop";
}

function errorCategory(error: unknown): string {
  if (error instanceof AdobeUpstreamError) return error.code;
  if (error instanceof AppError) return error.code;
  return "worker_error";
}

function errorMessage(error: unknown): string {
  if (error instanceof AdobeUpstreamError) {
    // 附加 Adobe 真实返回的状态码、关键响应头与响应体片段，便于后台定位拒绝原因（如 403 风控 / 408 超时）。
    const details = error.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details as Record<string, unknown> : {};
    const status = typeof details.upstream_status === "number" ? details.upstream_status : null;
    const body = typeof details.body === "string" && details.body.trim() ? details.body.trim().slice(0, 200) : null;
    const headers = details.headers && typeof details.headers === "object" && !Array.isArray(details.headers) ? details.headers as Record<string, unknown> : null;
    const headerText = headers && Object.keys(headers).length
      ? Object.entries(headers).map(([key, value]) => `${key}:${String(value)}`).join(" ")
      : null;
    const suffix = status !== null || headerText || body
      ? ` (${[status !== null ? `HTTP ${status}` : null, headerText, body].filter(Boolean).join(" | ")})`
      : "";
    return `${error.message}${suffix}`;
  }
  return error instanceof Error ? error.message : "Adobe worker failed";
}

function submitOutcomeMayBeUnknown(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (["adobe_transport_error", "adobe_upstream_temporary"].includes(error.code)) return true;
  const details = error.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details as Record<string, unknown> : {};
  return error.code === "proxy_exhausted" && details.submission_unknown === true;
}

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/apng": "apng",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

const VIDEO_MIME_EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-m4v": "m4v",
  "video/x-matroska": "mkv",
  "video/mkv": "mkv",
  "video/ogg": "ogv",
  "video/mpeg": "mpeg",
  "video/x-msvideo": "avi",
  "video/avi": "avi",
  "video/3gpp": "3gp",
  "video/3gpp2": "3g2",
  "video/mp2t": "ts",
  "video/x-flv": "flv",
  "video/x-ms-wmv": "wmv",
  "video/x-ms-asf": "asf",
};

const IMAGE_EXTENSIONS_MIME: Record<string, string> = {
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  bmp: "image/bmp",
  dib: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  ico: "image/x-icon",
  icns: "image/icns",
};

const VIDEO_EXTENSIONS_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  ogv: "video/ogg",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  avi: "video/x-msvideo",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  ts: "video/mp2t",
  m2ts: "video/mp2t",
  mts: "video/mp2t",
  flv: "video/x-flv",
  wmv: "video/x-ms-wmv",
  asf: "video/x-ms-asf",
};

function normalizedMimeType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.split(";", 1)[0]?.trim().toLowerCase();
  if (!candidate || /[\r\n]/.test(candidate)) return undefined;
  return candidate;
}

function safeMimeForKind(value: unknown, kind: "image" | "video"): string | undefined {
  const mimeType = normalizedMimeType(value);
  if (!mimeType) return undefined;
  const allowed = kind === "image" ? IMAGE_MIME_EXTENSIONS : VIDEO_MIME_EXTENSIONS;
  if (!Object.prototype.hasOwnProperty.call(allowed, mimeType)) return undefined;
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

function outputMimeFromUrl(value: string, kind: "image" | "video"): string | undefined {
  let pathname = value;
  try {
    pathname = new URL(value).pathname;
  } catch {
    pathname = value.split(/[?#]/, 1)[0] ?? value;
  }
  const extension = pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (!extension) return undefined;
  return (kind === "image" ? IMAGE_EXTENSIONS_MIME : VIDEO_EXTENSIONS_MIME)[extension];
}

function outputMimeFromFormat(value: unknown, kind: "image" | "video"): string | undefined {
  const candidate = normalizedMimeType(value);
  if (!candidate) return undefined;
  const direct = safeMimeForKind(candidate, kind);
  if (direct) return direct;
  const format = candidate.replace(/^\./, "");
  if (kind === "image" && ["png", "apng", "jpg", "jpeg", "webp", "avif", "gif", "bmp", "dib", "tif", "tiff", "heic", "heif", "ico", "icns"].includes(format)) return IMAGE_EXTENSIONS_MIME[format];
  if (kind === "video" && ["mp4", "webm", "mov", "m4v", "mkv", "ogv", "mpeg", "mpg", "avi", "3gp", "3g2", "ts", "m2ts", "mts", "flv", "wmv", "asf"].includes(format)) return VIDEO_EXTENSIONS_MIME[format];
  return undefined;
}

function requestedOutputMime(payload: Record<string, unknown>, kind: "image" | "video"): string | undefined {
  for (const key of ["output_mime_type", "outputMimeType", "output_format", "outputFormat"]) {
    const mimeType = outputMimeFromFormat(payload[key], kind);
    if (mimeType) return mimeType;
  }
  return undefined;
}

function defaultOutputMime(kind: "image" | "video"): string {
  return kind === "image" ? "image/png" : "video/mp4";
}

function resolveOutputMime(input: { kind: "image" | "video"; outputUrl: string; upstreamMime?: unknown; requestedMime?: string }): string {
  const upstreamMime = safeMimeForKind(input.upstreamMime, input.kind);
  const defaultMime = defaultOutputMime(input.kind);
  // AdobeClient 的旧轮询响应可能只给出 image/png 或 video/mp4。只有在
  // MIME 不是这个通用值时才优先相信它，避免把 webp/webm 结果误存成默认格式。
  if (upstreamMime && upstreamMime !== defaultMime) return upstreamMime;
  return input.requestedMime
    ?? outputMimeFromUrl(input.outputUrl, input.kind)
    ?? upstreamMime
    ?? defaultMime;
}

function resolveOutputMimes(input: { kind: "image" | "video"; outputUrls: string[]; upstreamMime?: unknown; upstreamMimes?: unknown[]; requestedMime?: string }): string[] {
  return input.outputUrls.map((outputUrl, index) => resolveOutputMime({
    kind: input.kind,
    outputUrl,
    upstreamMime: input.upstreamMimes?.[index] ?? input.upstreamMime,
    requestedMime: input.requestedMime,
  }));
}

export function extensionForMime(mimeType: string, kind: "image" | "video") {
  const extensions = kind === "image" ? IMAGE_MIME_EXTENSIONS : VIDEO_MIME_EXTENSIONS;
  const normalized = normalizedMimeType(mimeType);
  return (normalized && extensions[normalized]) || (kind === "image" ? "png" : "mp4");
}

export async function runStage<T>(input: {
  jobId: string;
  workerId: string;
  stage: JobStage;
  snapshot: ProxySnapshot;
  startIndex: number;
  callback: (proxy: ProxySnapshotEntry | null) => Promise<T>;
  onRetry?: (error: unknown, disposition: "same_route" | "next_proxy", attempts: number) => Promise<void>;
}) {
  const settings = await getSystemSettings();
  const entries = input.snapshot.mode === "proxy" ? input.snapshot.entries : [];
  let index = input.snapshot.mode === "proxy" ? Math.max(0, Math.min(input.startIndex, Math.max(0, entries.length - 1))) : -1;
  let attempts = 0;
  while (true) {
    attempts += 1;
    await assertJobLease(input.jobId, input.workerId);
    const proxy = index >= 0 ? entries[index] ?? null : null;
    const attempt = await recordJobAttempt({ jobId: input.jobId, stage: input.stage, proxyId: proxy?.id ?? null, workerId: input.workerId });
    // recordJobAttempt 已持久化 currentProxyId；代理模式的断点信息在 attempt 行里也有。
    // 直连模式这里完全是冗余事务，跳过可省一次公网 MySQL 往返（约 1.7s）。
    if (input.snapshot.mode === "proxy") {
      await updateJobWithLease(input.jobId, { currentProxyId: proxy?.id ?? null, ...(index >= 0 ? { proxyAttemptIndex: index } : {}) }, input.workerId);
    }
    try {
      const value = await input.callback(proxy);
      await finishJobAttempt(attempt.id, { status: "SUCCEEDED" as AttemptStatus }, input.workerId);
      return { value, index };
    } catch (error) {
      await finishJobAttempt(attempt.id, { status: "FAILED" as AttemptStatus, errorCategory: errorCategory(error), errorMessage: errorMessage(error), upstreamStatus: error instanceof AdobeUpstreamError ? error.realUpstreamStatus : undefined }, input.workerId).catch(() => undefined);
      const maxAttempts = settings.retryEnabled ? settings.retryMaxAttempts : 1;
      const disposition = stageRetryDisposition(error, {
        stage: input.stage,
        mode: input.snapshot.mode,
        attempts,
        maxAttempts,
        index,
        entryCount: entries.length,
      });
      if (disposition === "stop") throw error;
      if (disposition === "proxy_exhausted") {
        throw new AppError("proxy_exhausted", "All proxy nodes failed for this task", 503, { job_id: input.jobId, stage: input.stage, submission_unknown: input.stage === "SUBMIT" });
      }
      await input.onRetry?.(error, disposition, attempts);

      const delayMs = settings.retryBackoffMs > 0
        ? Math.min(30_000, settings.retryBackoffMs * 2 ** Math.max(0, attempts - 1))
        : 0;
      if (disposition === "same_route") {
        await appendJobEvent(input.jobId, "RETRY", {
          stage: input.stage,
          retry_reason: errorCategory(error),
          next_attempt_number: attempts + 1,
          delay_ms: delayMs,
          proxy_id: proxy?.id ?? null,
        }, input.workerId);
      } else {
        index += 1;
        await appendJobEvent(input.jobId, "PROXY_SWITCH", {
          stage: input.stage,
          retry_reason: errorCategory(error),
          proxy_id: entries[index]?.id ?? null,
          attempt_index: index,
          next_attempt_number: attempts + 1,
          delay_ms: delayMs,
        }, input.workerId);
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      await assertJobLease(input.jobId, input.workerId);
    }
  }
}

function requestPayload(job: { requestPayload: unknown }): JobPayload {
  return job.requestPayload && typeof job.requestPayload === "object" && !Array.isArray(job.requestPayload) ? { ...(job.requestPayload as JobPayload) } : {};
}

type WorkerDependencies = { transport?: AdobeTransport };

async function processEntityJob(initial: typeof generationJob.$inferSelect, workerId: string, dependencies: WorkerDependencies = {}) {
  const settings = await getSystemSettings();
  const snapshot = snapshotFromJson(initial.proxySnapshot);
  let status: JobStatus = initial.status;
  let proxyIndex = initial.proxyAttemptIndex ?? snapshot.selectedIndex;
  let upstreamId = initial.upstreamTaskId ?? "";
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let leaseLost = false;
  let sourceMedia: ReferenceMedia[] = [];
  let account: Awaited<ReturnType<typeof selectAdobeAccount>> | undefined;
  try {
    if (initial.status === "SUBMISSION_UNKNOWN" && !initial.upstreamTaskId) {
      await appendJobEvent(initial.id, "MANUAL_REVIEW_REQUIRED", { reason: "entity_operation_unknown" }, workerId).catch(() => undefined);
      return;
    }
    heartbeat = setInterval(() => {
      void renewJobLease(initial.id, workerId)
        .then((ok) => { if (!ok) leaseLost = true; })
        .catch(() => { leaseLost = true; });
    }, Math.max(1000, Math.floor(settings.jobLeaseMs / 3)));
    account = await selectAdobeAccount(initial.adobeAccountId, initial.id);
    const payload = requestPayload(initial);
    const client = new AdobeClient(dependencies.transport ?? new FetchAdobeTransport(settings.adobeBaseUrl), { baseUrl: settings.adobeBaseUrl, timeoutMs: settings.adobeTimeoutMs });
    if (status === "SUBMISSION_UNKNOWN" && upstreamId) { await transitionJob(initial.id, "POLLING", { leaseOwner: workerId }, workerId); status = "POLLING"; }
    if (status === "QUEUED") { await transitionJob(initial.id, "UPLOADING", { leaseOwner: workerId }, workerId); status = "UPLOADING"; }
    if (status === "UPLOADING") { await transitionJob(initial.id, "SUBMITTING", { leaseOwner: workerId }, workerId); status = "SUBMITTING"; }
    if (status === "SUBMITTING") {
      const operation = await runStage({ jobId: initial.id, workerId, stage: "SUBMIT", snapshot, startIndex: proxyIndex, callback: async (proxy) => {
        const context = { token: account!.token, proxy };
        const attemptMedia = initial.kind === "ENTITY_CREATE" ? await loadReferenceSources({ images: payload.images ?? [] }, 4, { proxy }) : [];
        sourceMedia = attemptMedia;
        try {
        if (initial.kind === "ENTITY_DELETE") {
          const entityId = String(payload.upstream_id ?? upstreamId);
          if (!entityId) throw new AppError("entity_not_found", "Upstream entity ID is required", 404);
          await client.deleteEntity(context, entityId);
          return { id: entityId, deleted: true };
        }
        if (initial.kind === "ENTITY_SYNC") return { entities: await client.listEntities(context, 100) };
        const name = String(payload.name ?? "").trim();
        if (!name) throw new AppError("invalid_entity", "Entity name is required", 400);
        let created: { id: string; raw: Record<string, unknown> } | null = upstreamId ? { id: upstreamId, raw: {} } : null;
        if (!created) {
          created = await client.createEntity(context, { displayName: name, entityType: String(payload.type ?? "character"), description: String(payload.description ?? "") });
          upstreamId = created.id;
          await updateJobWithLease(initial.id, { upstreamTaskId: upstreamId, resultPayload: { upstream_id: upstreamId } }, workerId);
        }
        const repository = await client.resolveRepository(context);
        const components = [];
        for (const media of sourceMedia) {
          const opened = openReferenceMedia(media);
          try {
            components.push(await client.uploadEntityImage(context, { repository, entityName: name, body: opened.body, byteSize: opened.byteSize, mimeType: media.mimeType }));
          } finally {
            closeReferenceMedia(opened.body);
          }
        }
        if (components.length) await client.registerEntityResources(context, created.id, components);
        return { id: created.id, name, type: String(payload.type ?? "character"), description: String(payload.description ?? ""), components: components.length };
        } finally {
          await cleanupReferenceSources(attemptMedia);
          sourceMedia = [];
        }
      } });
      if (leaseLost) throw new AppError("job_lease_lost", "Generation lease was lost", 409, { job_id: initial.id });
      proxyIndex = operation.index;
      const result = operation.value as Record<string, unknown>;
      upstreamId = String(result.id ?? upstreamId);
      await updateJobWithLease(initial.id, { upstreamTaskId: upstreamId || undefined, resultPayload: result, proxyAttemptIndex: proxyIndex }, workerId);
      await transitionJob(initial.id, "POLLING", { leaseOwner: workerId }, workerId);
      status = "POLLING";
    }
    if (status === "POLLING") { await transitionJob(initial.id, "DOWNLOADING", { leaseOwner: workerId }, workerId); status = "DOWNLOADING"; }
    if (status === "DOWNLOADING") {
      if (leaseLost) throw new AppError("job_lease_lost", "Generation lease was lost", 409, { job_id: initial.id });
      const [stored] = await db.select({ resultPayload: generationJob.resultPayload }).from(generationJob).where(eq(generationJob.id, initial.id)).limit(1);
      await completeJobWithResult(initial.id, stored?.resultPayload ?? { upstream_id: upstreamId }, workerId);
    }
  } catch (error) {
    const [current] = await db.select({ status: generationJob.status }).from(generationJob).where(eq(generationJob.id, initial.id)).limit(1).catch(() => []);
    if (error instanceof AppError && error.code === "job_lease_lost") return;
    if (current?.status === "SUBMITTING" && !upstreamId && submitOutcomeMayBeUnknown(error)) {
      await transitionJob(initial.id, "SUBMISSION_UNKNOWN", { errorCode: errorCategory(error), errorMessage: errorMessage(error) }, workerId).catch(() => undefined);
      return;
    }
    const terminal: JobStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED", "SUBMISSION_UNKNOWN"];
    if (current && !terminal.includes(current.status)) await transitionJob(initial.id, "FAILED", { errorCode: errorCategory(error), errorMessage: errorMessage(error) }, workerId).catch(() => undefined);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await cleanupReferenceSources(sourceMedia);
    await releaseJobLease(initial.id, workerId);
  }
}

export async function processJob(jobId: string, workerId: string, dependencies: WorkerDependencies = {}): Promise<void> {
  const [initial] = await db.select().from(generationJob).where(eq(generationJob.id, jobId)).limit(1);
  if (!initial) return;
  if (initial.status === "SUCCEEDED" || initial.status === "FAILED" || initial.status === "CANCELLED") return;
  if (initial.kind === "ENTITY_CREATE" || initial.kind === "ENTITY_SYNC" || initial.kind === "ENTITY_DELETE") {
    await processEntityJob(initial, workerId, dependencies);
    return;
  }
  const settings = await getSystemSettings();
  const snapshot = snapshotFromJson(initial.proxySnapshot);
  let status: JobStatus = initial.status;
  let currentProxyIndex = initial.proxyAttemptIndex ?? snapshot.selectedIndex;
  let upstreamTaskId = initial.upstreamTaskId ?? "";
  let pollUrl = initial.upstreamPollUrl ?? "";
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let leaseLost = false;
  let loaded: ReferenceMedia[] = [];
  let accountContext: Awaited<ReturnType<typeof selectAdobeGenerationAccount>> | undefined;
  const storedMedia: Array<{ objectKey: string; mimeType: string; byteSize: number; sha256: string }> = [];

  try {
    if (initial.status === "SUBMISSION_UNKNOWN" && !initial.upstreamPollUrl) {
      await appendJobEvent(jobId, "MANUAL_REVIEW_REQUIRED", { reason: "submission_result_unknown" }, workerId).catch(() => undefined);
      return;
    }
    heartbeat = setInterval(() => { void renewJobLease(jobId, workerId).then((ok) => { if (!ok) leaseLost = true; }).catch(() => { leaseLost = true; }); }, Math.max(1000, Math.floor(settings.jobLeaseMs / 3)));
    accountContext = await selectAdobeGenerationAccount(initial.adobeAccountId, initial.id);
    if (accountContext.accountId !== initial.adobeAccountId) await updateJobWithLease(jobId, { adobeAccountId: accountContext.accountId }, workerId);
    await db.update(adobeToken).set({ lastUsedAt: new Date(), updatedAt: new Date() }).where(eq(adobeToken.id, accountContext.tokenId)).catch(() => undefined);
    const payload = requestPayload(initial);
    const [entityRow] = initial.entityId ? await db.select({ name: entity.name, upstreamId: entity.upstreamId }).from(entity).where(eq(entity.id, initial.entityId)).limit(1) : [];
    const entityRefs = entityRow?.upstreamId ? [{ urn: entityRow.upstreamId, mention_id: entityRow.name }] : [];
    const modelId = initial.model ?? String(payload.model ?? "");
    const requestedKind = payload.kind === "video" || payload.kind === "image" ? payload.kind : undefined;
    const videoModel = requestedKind === "video" ? resolveVideoModel(modelId) : VIDEO_MODEL_CATALOG[modelId];
    const kind: "image" | "video" = requestedKind ?? (videoModel ? "video" : "image");
    if (kind === "video" && !videoModel) throw new AppError("invalid_model", "Unsupported video model", 400);
    const prompt = String(payload.prompt ?? "").trim();
    if (!prompt) throw new AppError("invalid_request_error", "Generation prompt is required", 400);
    if (status === "SUBMISSION_UNKNOWN" && upstreamTaskId && pollUrl) {
      await transitionJob(jobId, "POLLING", { leaseOwner: workerId }, workerId);
      status = "POLLING";
    }
    const sourceIds = payload.__adobe_source_ids ?? {};
    let imageIds = sourceIds.images ?? [];
    let videoIds = sourceIds.videos ?? [];
    let audioIds = sourceIds.audios ?? [];
    let maskId = sourceIds.maskId ?? sourceIds.mask;
    const client = new AdobeClient(dependencies.transport ?? new FetchAdobeTransport(settings.adobeBaseUrl), { baseUrl: settings.adobeBaseUrl, timeoutMs: settings.adobeTimeoutMs });

    if (status === "QUEUED") {
      await transitionJob(jobId, "UPLOADING", { leaseOwner: workerId }, workerId);
      status = "UPLOADING";
    }

    if (status === "UPLOADING") {
      const upload = await runStage({ jobId, workerId, stage: "UPLOAD", snapshot, startIndex: currentProxyIndex, callback: async (proxy) => {
        const context = { token: accountContext!.token, proxy };
        const attemptMedia = await loadReferenceSources(payload, kind === "video" ? 12 : 6, { proxy });
        loaded = attemptMedia;
        const nextImages: string[] = [];
        const nextVideos: string[] = [];
        const nextAudios: string[] = [];
        let nextMaskId: string | undefined;
        try {
          for (const media of attemptMedia) {
            await assertJobLease(jobId, workerId);
            const opened = openReferenceMedia(media);
            try {
              if (media.kind === "image") {
                if (media.purpose === "mask" && nextMaskId) throw new AppError("invalid_request_error", "Only one mask image is supported", 400);
                const uploadedId = await client.uploadImage(context, opened.body, media.mimeType, opened.byteSize);
                if (media.purpose === "mask") {
                  nextMaskId = uploadedId;
                } else {
                  nextImages.push(uploadedId);
                }
              }
              else if (media.kind === "video") nextVideos.push(await client.uploadVideo(context, opened.body, media.mimeType, opened.byteSize));
              else nextAudios.push(await client.uploadAudio(context, opened.body, media.mimeType, opened.byteSize));
            } finally {
              closeReferenceMedia(opened.body);
            }
          }
          return { images: nextImages, videos: nextVideos, audios: nextAudios, ...(nextMaskId ? { maskId: nextMaskId } : {}) };
        } finally {
          await cleanupReferenceSources(attemptMedia);
          loaded = [];
        }
      } });
      currentProxyIndex = upload.index;
      imageIds = upload.value.images;
      videoIds = upload.value.videos;
      audioIds = upload.value.audios;
      maskId = upload.value.maskId;
      await updateJobWithLease(jobId, { requestPayload: { ...payload, __adobe_source_ids: { images: imageIds, videos: videoIds, audios: audioIds, ...(maskId ? { maskId } : {}) } } }, workerId);
      await transitionJob(jobId, "SUBMITTING", { leaseOwner: workerId }, workerId);
      status = "SUBMITTING";
    }

    if (status === "SUBMITTING") {
      if (upstreamTaskId && !pollUrl) {
        await transitionJob(jobId, "SUBMISSION_UNKNOWN", { errorCode: "submission_unknown", errorMessage: "Adobe task ID exists without a polling URL" }, workerId);
        return;
      }
      if (!upstreamTaskId) {
        const submit = await runStage({ jobId, workerId, stage: "SUBMIT", snapshot, startIndex: currentProxyIndex, onRetry: async (error, _disposition, attempts) => {
          if (!isExplicitSubmitTimeout(error)) return;
          // 408（timeout_error）≠ 账号风控：不再标记账号。
          // 立即强制重铸全局 sherlockToken（全新浏览器环境），同账号用新 token 重试；
          // 尝试次数由 runStage 按 retryMaxAttempts（默认 3）封顶，每次重试都记入任务操作记录。
          try {
            const remint = await refreshGlobalSherlockToken({ fresh: true });
            accountContext = accountContext ? { ...accountContext, arpSessionId: remint.token } : undefined;
            await appendJobEvent(jobId, "SHERLOCK_REMINT", {
              stage: "SUBMIT",
              retry_reason: "adobe_submit_timeout",
              token_expires_at: remint.expiresAt.toISOString(),
              next_attempt_number: attempts + 1,
            }, workerId);
          } catch (remintError) {
            await appendJobEvent(jobId, "SHERLOCK_REMINT_FAILED", {
              stage: "SUBMIT",
              retry_reason: "adobe_submit_timeout",
              error: errorMessage(remintError),
              next_attempt_number: attempts + 1,
            }, workerId).catch(() => undefined);
          }
        }, callback: async (proxy) => {
          const context = { token: accountContext!.token, proxy, arpSessionId: accountContext!.arpSessionId };
          if (kind === "video") return client.submitVideo(context, {
            prompt,
            model: videoModel!,
            aspectRatio: String(payload.aspect_ratio ?? videoModel!.aspectRatio),
            duration: Number(payload.duration ?? videoModel!.duration),
            resolution: String(payload.resolution ?? videoModel!.resolution ?? "720p"),
            width: Number.isFinite(Number(payload.width)) ? Number(payload.width) : undefined,
            height: Number.isFinite(Number(payload.height)) ? Number(payload.height) : undefined,
            sourceImageIds: imageIds,
            sourceVideoIds: videoIds,
            sourceAudioIds: audioIds,
            entityRefs,
            negativePrompt: String(payload.negative_prompt ?? ""),
            generateAudio: payload.generate_audio === undefined ? videoModel!.generateAudio : Boolean(payload.generate_audio),
            referenceMode: String(payload.reference_mode ?? videoModel!.referenceMode ?? "frame"),
            n: Number(payload.n ?? 1),
            seed: Number.isFinite(Number(payload.seed)) ? Number(payload.seed) : undefined,
            fps: Number.isFinite(Number(payload.fps)) ? Number(payload.fps) : undefined,
            mode: payload.mode as VideoProviderOptions["mode"],
            cfg_scale: payload.cfg_scale as VideoProviderOptions["cfg_scale"],
            camera_control: payload.camera_control as VideoProviderOptions["camera_control"],
            watermark: payload.watermark as VideoProviderOptions["watermark"],
            loop: payload.loop as VideoProviderOptions["loop"],
            transparent_background: payload.transparent_background as VideoProviderOptions["transparent_background"],
          });
          return client.submitImage(context, {
            prompt,
            model: resolveImageModel(modelId),
            aspectRatio: String(payload.resolved_aspect_ratio ?? payload.aspect_ratio ?? "16:9"),
            outputResolution: String(payload.resolved_output_resolution ?? payload.output_resolution ?? "2K"),
            quality: String(payload.quality ?? ""),
            sourceImageIds: imageIds,
            maskId,
            n: Number(payload.n ?? 1),
            background: payload.background as ImageProviderOptions["background"],
            output_format: payload.output_format as ImageProviderOptions["output_format"],
            output_compression: payload.output_compression as ImageProviderOptions["output_compression"],
            input_fidelity: payload.input_fidelity as ImageProviderOptions["input_fidelity"],
            moderation: payload.moderation as ImageProviderOptions["moderation"],
          });
        } });
        currentProxyIndex = submit.index;
        upstreamTaskId = submit.value.upstreamTaskId;
        pollUrl = submit.value.pollUrl;
        if (!upstreamTaskId || !pollUrl) {
          await transitionJob(jobId, "SUBMISSION_UNKNOWN", { errorCode: "submission_unknown", errorMessage: "Adobe submission returned incomplete task metadata" }, workerId);
          return;
        }
        await transitionJob(jobId, "POLLING", { upstreamTaskId, upstreamPollUrl: pollUrl, currentProxyId: snapshot.entries[currentProxyIndex]?.id ?? null, proxyAttemptIndex: currentProxyIndex, resultPayload: { upstream_task_id: upstreamTaskId, poll_url: pollUrl }, leaseOwner: workerId }, workerId);
        status = "POLLING";
      } else {
        await transitionJob(jobId, "POLLING", { leaseOwner: workerId }, workerId);
        status = "POLLING";
      }
    }

    let outputUrl = "";
    let outputUrls: string[] = [];
    const requestedMime = requestedOutputMime(payload, kind);
    let outputMime = requestedMime ?? defaultOutputMime(kind);
    let outputMimes: string[] = [];
    if (status === "POLLING") {
      if (!pollUrl) throw new AppError("submission_unknown", "Adobe polling URL is unavailable", 503, { job_id: jobId });
      const generationTimeoutSeconds = kind === "video" ? settings.videoGenerateTimeoutSeconds : settings.generateTimeoutSeconds;
      const pollingDeadline = Date.now() + generationTimeoutSeconds * 1000;
      let completed = false;
      let lastProgress: number | null = null;
      while (!completed) {
        if (leaseLost) throw new AppError("job_lease_lost", "Generation lease was lost", 409, { job_id: jobId });
        if (Date.now() >= pollingDeadline) throw new AppError("adobe_generation_timeout", "Adobe generation exceeded the configured timeout", 504, { job_id: jobId });
        const poll = await runStage({ jobId, workerId, stage: "POLL", snapshot, startIndex: currentProxyIndex, callback: (proxy) => client.poll({ token: accountContext!.token, proxy }, pollUrl, kind) });
        currentProxyIndex = poll.index;
        const result = poll.value;
        if (result.status === "FAILED") throw new AdobeUpstreamError("adobe_generation_failed", "Adobe generation failed", { status: 502, details: { job_id: jobId } });
        if (result.status === "SUCCEEDED" && result.outputUrl) {
          outputUrl = result.outputUrl;
          outputUrls = result.outputUrls?.length ? result.outputUrls : [result.outputUrl];
          outputMimes = resolveOutputMimes({ kind, outputUrls, upstreamMime: result.mimeType, upstreamMimes: result.mimeTypes, requestedMime });
          outputMime = outputMimes[0] ?? defaultOutputMime(kind);
          await updateJobWithLease(jobId, { resultPayload: { upstream_task_id: upstreamTaskId, poll_url: pollUrl, output_url: outputUrl, output_urls: outputUrls, mime_type: outputMime, mime_types: outputMimes }, currentProxyId: snapshot.entries[currentProxyIndex]?.id ?? null, proxyAttemptIndex: currentProxyIndex }, workerId);
          completed = true;
          break;
        }
        // 仅进度变化时记录事件，避免每轮 poll 都写库（公网 MySQL 每事务约 1.7s）
        if (result.progress !== lastProgress) {
          await appendJobEvent(jobId, "POLL_PROGRESS", { progress: result.progress, upstream_task_id: upstreamTaskId }, workerId);
          lastProgress = result.progress;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(settings.adobePollMs, Math.max(1, pollingDeadline - Date.now()))));
      }
      await transitionJob(jobId, "DOWNLOADING", { leaseOwner: workerId }, workerId);
      status = "DOWNLOADING";
    }

    if (status === "DOWNLOADING") {
      const [persisted] = await db.select({ resultPayload: generationJob.resultPayload }).from(generationJob).where(eq(generationJob.id, jobId)).limit(1);
      const result = persisted?.resultPayload && typeof persisted.resultPayload === "object" && !Array.isArray(persisted.resultPayload) ? persisted.resultPayload as Record<string, unknown> : {};
      outputUrl ||= String(result.output_url ?? "");
      outputUrls = Array.isArray(result.output_urls) ? result.output_urls.filter((value): value is string => typeof value === "string" && value.length > 0) : outputUrl ? [outputUrl] : [];
      if (!outputUrls.length) throw new AppError("media_missing", "Adobe task completed without a media URL", 502);
      outputMimes = resolveOutputMimes({ kind, outputUrls, upstreamMime: result.mime_type, upstreamMimes: Array.isArray(result.mime_types) ? result.mime_types : undefined, requestedMime });
      outputMime = outputMimes[0] ?? defaultOutputMime(kind);
      // returnOriginalUrl 开启：不下载到本地，直接把 Adobe 原地址存为媒体，响应层返回原地址（省下载时间）
      if (settings.returnOriginalUrl) {
        const remoteMedia = outputUrls.map((currentUrl, index) => {
          const currentMime = resolveOutputMime({ kind, outputUrl: currentUrl, upstreamMime: outputMimes[index] ?? outputMime, requestedMime });
          // objectKey 仅作非空唯一占位（远程媒体无本地文件），url 存原地址
          return { objectKey: `remote/${jobId}-${index + 1}`, url: currentUrl, mimeType: currentMime, byteSize: 0, sha256: "" };
        });
        storedMedia.push(...remoteMedia);
      } else {
        // 下载阶段不走代理（直连 Adobe CDN），独立重试（retryMaxAttempts 次，指数退避）
        const downloadMaxAttempts = settings.retryEnabled ? settings.retryMaxAttempts : 1;
        for (let index = 0; index < outputUrls.length; index += 1) {
          const currentUrl = outputUrls[index];
          const currentMime = resolveOutputMime({ kind, outputUrl: currentUrl, upstreamMime: outputMimes[index] ?? outputMime, requestedMime });
          let downloadAttempt = 0;
          let downloaded;
          for (;;) {
            downloadAttempt += 1;
            try {
              downloaded = await client.downloadStream({ token: accountContext!.token, proxy: null }, currentUrl, currentMime);
              break;
            } catch (error) {
              await finishJobAttempt((await recordJobAttempt({ jobId, stage: "DOWNLOAD", proxyId: null, workerId })).id, { status: "FAILED" as AttemptStatus, errorCategory: "worker_error", errorMessage: errorMessage(error) }, workerId).catch(() => undefined);
              if (downloadAttempt >= downloadMaxAttempts) throw error;
              await appendJobEvent(jobId, "RETRY", { stage: "DOWNLOAD", retry_reason: errorCategory(error), next_attempt_number: downloadAttempt + 1 }, workerId);
              await new Promise((resolve) => setTimeout(resolve, settings.retryBackoffMs * 2 ** Math.max(0, downloadAttempt - 1)));
            }
          }
          const storedMime = resolveOutputMime({ kind, outputUrl: currentUrl, upstreamMime: downloaded.mimeType, requestedMime: currentMime });
          const objectKey = `jobs/${jobId}/result-${index + 1}.${extensionForMime(storedMime, kind)}`;
          const stored = await writeMediaStream(objectKey, downloaded.stream, storedMime);
          storedMedia.push({ objectKey: stored.objectKey, mimeType: stored.mimeType, byteSize: stored.byteSize, sha256: stored.sha256 });
        }
      }
      try {
        await completeJobWithMedia({ jobId, media: storedMedia, workerId });
        status = "SUCCEEDED";
        if (accountContext) {
          await markAdobeTokenSuccess(accountContext.tokenId);
          // 记录本次任务消耗的积分（查询当前已用 - 任务前已知已用），失败不影响任务完成
          await recordCreditCost(jobId, workerId, accountContext, settings.adobeTimeoutMs).catch(() => undefined);
        }
      } catch (error) {
        await Promise.all(storedMedia.map((media) => removeMedia(media.objectKey).catch(() => undefined)));
        throw error;
      }
    }
  } catch (error) {
    const [current] = await db.select({ status: generationJob.status, upstreamTaskId: generationJob.upstreamTaskId, upstreamPollUrl: generationJob.upstreamPollUrl }).from(generationJob).where(eq(generationJob.id, jobId)).limit(1).catch(() => []);
    if (accountContext && error instanceof AdobeUpstreamError && error.code === "adobe_auth_failed") {
      if (error.realUpstreamStatus === 401) {
        // 401：token 彻底失效，删除该账号（含 token、Cookie 刷新资料），避免反复被选中
        const failedAccountId = accountContext.accountId;
        await deleteAdobeAccount(failedAccountId).catch((deleteError) => console.error(`[processor] 删除 401 账号失败 account=${failedAccountId}`, deleteError instanceof Error ? deleteError.message : deleteError));
      } else if (error.realUpstreamStatus === 403) {
        // 403：通常是「账号无某模型权限」（如 gateway_model_not_authorized，视频模型），
        // 不代表 token 失效 —— 绝不标 INVALID/不删号（token 完全可用）。
        // 只标记账号风控，避免后续选号命中；管理员可手动解除。
        await markAdobeAccountRiskFlagged(accountContext.accountId, `提交 403 ${errorMessage(error)}`).catch(() => undefined);
      } else {
        // 其他认证失败：仅标记 token 失败（保留账号），待后续刷新/重试
        await markAdobeTokenFailure(accountContext.tokenId, errorMessage(error));
      }
    }
    // 408 不再标记账号风控：重铸 sherlockToken 的重试已由提交阶段 onRetry 完成并留痕，
    // 重试耗尽后的剩余 408 保留为普通任务失败（不污染账号选号池）。
    if (error instanceof AppError && error.code === "job_lease_lost") return;
    // 单账号并发已满：不标记失败，释放任务回队列，等账号空闲后由 Worker 再次领取执行。
    if (error instanceof AppError && error.code === "adobe_account_concurrency_limit") return;
    if (current?.status === "SUBMITTING" && !current.upstreamTaskId && submitOutcomeMayBeUnknown(error)) {
      const errorCode = error instanceof AppError && error.code === "proxy_exhausted" ? "proxy_exhausted" : "submission_unknown";
      await transitionJob(jobId, "SUBMISSION_UNKNOWN", { errorCode, errorMessage: "Adobe submit outcome could not be determined" }, workerId).catch(() => undefined);
      return;
    }
    const terminal: JobStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED", "SUBMISSION_UNKNOWN"];
    if (current && !terminal.includes(current.status)) await transitionJob(jobId, "FAILED", { errorCode: errorCategory(error), errorMessage: errorMessage(error) }, workerId).catch(() => undefined);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (storedMedia.length && status !== "SUCCEEDED") await Promise.all(storedMedia.map((media) => removeMedia(media.objectKey).catch(() => undefined)));
    await cleanupReferenceSources(loaded);
    await releaseJobLease(jobId, workerId);
  }
}

/**
 * 任务完成后记录本次消耗的积分：查询账号当前已用，减去任务执行前已知已用（token 表快照）。
 * 单账号并发限制默认 1，同一账号串行执行，因此差值即本次任务消耗。
 * 结果写入 generationJob.resultPayload.creditCost，并同步更新 token 的已用积分快照。
 */
async function recordCreditCost(jobId: string, workerId: string, account: Awaited<ReturnType<typeof selectAdobeAccount>>, timeoutMs: number): Promise<void> {
  const externalId = accountIdFromToken(account.token);
  if (!externalId) return;
  const used = await queryCreditsUsed({ token: account.token, accountId: externalId, timeoutMs });
  if (used === null) return;
  const [tokenRow] = await db.select({ creditsUsed: adobeToken.creditsUsed }).from(adobeToken).where(eq(adobeToken.id, account.tokenId)).limit(1);
  const previous = tokenRow?.creditsUsed ?? 0;
  const cost = Math.max(0, used - previous);
  const [persisted] = await db.select({ resultPayload: generationJob.resultPayload }).from(generationJob).where(eq(generationJob.id, jobId)).limit(1);
  const base = persisted?.resultPayload && typeof persisted.resultPayload === "object" && !Array.isArray(persisted.resultPayload) ? persisted.resultPayload as Record<string, unknown> : {};
  await updateJobWithLease(jobId, { resultPayload: { ...base, creditCost: cost, creditsUsedAt: new Date().toISOString() } }, workerId);
  await db.update(adobeToken).set({ creditsUsed: used, creditsUpdatedAt: new Date(), updatedAt: new Date() }).where(eq(adobeToken.id, account.tokenId)).catch(() => undefined);
}

export async function processOne(workerId: string): Promise<boolean> {
  const job = await claimNextJob(workerId);
  if (!job) return false;
  await processJob(job.id, workerId);
  return true;
}
