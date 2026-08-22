import { and, count, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { adobeAccount, entity, generationJob, type JobStatus } from "@/lib/db/schema";
import { requireServiceApiKey } from "@/lib/service-auth";
import { AppError, getRequestId, safeErrorMessage, statusForErrorCode, toErrorResponse } from "@/lib/errors";
import { allocateProxySnapshot } from "@/lib/proxy-pool";
import { createJob, waitForJob } from "@/lib/jobs";
import { validateReferenceUrls } from "@/lib/gateway";

const createSchema = z.object({ name: z.string().trim().min(1).max(128), type: z.string().trim().min(1).max(64), description: z.string().max(4000).optional(), images: z.array(z.unknown()).min(1).max(4), account_id: z.string().optional() }).passthrough();

async function availableAccount(accountId?: string) {
  return accountId
    ? db.select().from(adobeAccount).where(and(eq(adobeAccount.id, accountId), eq(adobeAccount.status, "AVAILABLE"))).limit(1).then((rows) => rows[0])
    : db.select().from(adobeAccount).where(eq(adobeAccount.status, "AVAILABLE")).orderBy(adobeAccount.createdAt).limit(1).then((rows) => rows[0]);
}

async function awaitEntityJob(jobId: string) {
  const job = await waitForJob(jobId);
  if (job.status !== "SUCCEEDED") {
    const code = job.errorCode ?? "entity_sync_failed";
    throw new AppError(code, safeErrorMessage(code, statusForErrorCode(code)), statusForErrorCode(code), { job_id: job.id });
  }
  return job.resultPayload && typeof job.resultPayload === "object" && !Array.isArray(job.resultPayload) ? job.resultPayload as Record<string, unknown> : {};
}

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const url = new URL(request.url);
    if (url.searchParams.get("sync") !== "true") throw new AppError("entity_sync_required", "Entity listing requires sync=true; local entity caching is disabled", 400);
    const account = await availableAccount();
    if (!account) throw new AppError("no_adobe_account", "No available Adobe account", 503);
    const job = await createJob({ apiPath: "/v1/entities?sync=true", kind: "ENTITY_SYNC", adobeAccountId: account.id, requestPayload: { account_id: account.id }, proxySnapshot: await allocateProxySnapshot() });
    const result = await awaitEntityJob(job.id);
    const upstream = Array.isArray(result.entities) ? result.entities : [];
    const data = upstream.filter((raw): raw is Record<string, unknown> => Boolean(raw && typeof raw === "object")).map((raw) => {
      const entityValue = raw.entityValue && typeof raw.entityValue === "object" ? raw.entityValue as Record<string, unknown> : {};
      const id = String(raw.id ?? raw.urn ?? raw.entityId ?? raw.entityUrn ?? "");
      return { id, name: String(raw.name ?? raw.displayName ?? entityValue.displayName ?? "").trim(), type: String(raw.entityType ?? raw.type ?? "character"), description: typeof raw.description === "string" ? raw.description : null, upstream_id: id, account: { id: account.id, displayName: account.displayName, externalId: account.externalId } };
    }).filter((entity) => entity.id && entity.name);
    return Response.json({ data, entities: data, synced: true, request_id: requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) { return toErrorResponse(error, requestId); }
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const input = createSchema.parse(await request.json());
    await validateReferenceUrls(input, { total: 4, image: 4, video: 0, audio: 0 });
    const account = await availableAccount(input.account_id);
    if (!account) throw new AppError("no_adobe_account", "No available Adobe account", 503);
    // 复合唯一键 accountId_name 用 and 条件 + limit(1) 等价查询
    const [existing] = await db.select().from(entity).where(and(eq(entity.accountId, account.id), eq(entity.name, input.name))).limit(1);
    if (existing && existing.status === "ACTIVE") throw new AppError("entity_exists", "Entity already exists", 409);
    const job = await createJob({ apiPath: "/v1/entities", kind: "ENTITY_CREATE", adobeAccountId: account.id, requestPayload: { name: input.name, type: input.type, description: input.description ?? "", images: input.images }, proxySnapshot: await allocateProxySnapshot() });
    const result = await awaitEntityJob(job.id);
    let entityRow;
    if (existing) {
      await db.update(entity).set({
        entityType: input.type,
        description: input.description,
        upstreamId: String(result.id ?? result.upstream_id ?? "") || null,
        metadata: { reference_count: input.images.length },
        status: "ACTIVE",
        updatedAt: new Date(),
      }).where(eq(entity.id, existing.id));
      [entityRow] = await db.select().from(entity).where(eq(entity.id, existing.id)).limit(1);
    } else {
      await db.insert(entity).values({
        accountId: account.id,
        name: input.name,
        entityType: input.type,
        description: input.description,
        upstreamId: String(result.id ?? result.upstream_id ?? "") || null,
        metadata: { reference_count: input.images.length },
      });
      // 按 accountId + name 复合唯一键回查
      [entityRow] = await db.select().from(entity).where(and(eq(entity.accountId, account.id), eq(entity.name, input.name))).limit(1);
    }
    if (!entityRow) throw new AppError("entity_create_failed", "Entity creation failed", 500);
    return Response.json({ id: entityRow.id, name: entityRow.name, type: entityRow.entityType, image_count: input.images.length, account_id: account.id, account_name: account.displayName, account_email: null, upstream_id: entityRow.upstreamId, request_id: requestId }, { status: 201, headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: { message: "Invalid entity request", type: "invalid_request_error", request_id: requestId } }, { status: 400, headers: { "x-request-id": requestId } });
    return toErrorResponse(error, requestId);
  }
}

export async function DELETE(request: Request) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const input = z.object({ id: z.string().optional(), upstream_id: z.string().optional(), name: z.string().optional(), account_id: z.string().optional() }).parse(await request.json().catch(() => ({})));
    const entityRow = input.id
      ? await db.select().from(entity).where(or(eq(entity.id, input.id), eq(entity.upstreamId, input.id))).limit(1).then((rows) => rows[0])
      : input.upstream_id
        ? await db.select().from(entity).where(eq(entity.upstreamId, input.upstream_id)).limit(1).then((rows) => rows[0])
        : await db.select().from(entity).where(and(eq(entity.name, input.name!), eq(entity.accountId, input.account_id!), eq(entity.status, "ACTIVE"))).limit(1).then((rows) => rows[0]);
    if (!entityRow) throw new AppError("entity_not_found", "Entity not found", 404);
    const activeStatuses: JobStatus[] = ["QUEUED", "UPLOADING", "SUBMITTING", "POLLING", "DOWNLOADING", "SUBMISSION_UNKNOWN"];
    const [{ value: activeJobs }] = await db.select({ value: count() }).from(generationJob).where(and(eq(generationJob.entityId, entityRow.id), inArray(generationJob.status, activeStatuses)));
    if (activeJobs > 0) throw new AppError("entity_in_use", "Entity has active jobs", 409, { active_jobs: activeJobs });
    if (entityRow.upstreamId) {
      const account = await availableAccount(entityRow.accountId);
      if (!account) throw new AppError("no_adobe_account", "No available Adobe account", 503);
      const job = await createJob({ apiPath: "/v1/entities", kind: "ENTITY_DELETE", adobeAccountId: account.id, entityId: entityRow.id, requestPayload: { upstream_id: entityRow.upstreamId }, proxySnapshot: await allocateProxySnapshot() });
      await awaitEntityJob(job.id);
    }
    await db.update(entity).set({ status: "DELETED", updatedAt: new Date() }).where(eq(entity.id, entityRow.id));
    return Response.json({ deleted: true, id: entityRow.id, request_id: requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) { return toErrorResponse(error, requestId); }
}
