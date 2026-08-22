import { z } from "zod";
import { db } from "@/lib/db";
import { adminUser, proxyNode, serviceApiKey, systemSetting } from "@/lib/db/schema";
import { count, desc, eq } from "drizzle-orm";
import { requireAdminRequest, handleAdminError } from "@/lib/admin-api";
import { AppError, getRequestId } from "@/lib/errors";
import { config } from "@/lib/config";
import { hashSecret } from "@/lib/crypto";
import { getSystemSettings, systemSettingCreateData, systemSettingsResponse, type SystemSettings } from "@/lib/system-settings";

const schema = z.object({
  proxyEnabled: z.boolean().optional(),
  use_proxy: z.boolean().optional(),
  mediaRoot: z.string().trim().min(1).max(500).optional(),
  mediaRetentionDays: z.number().int().min(1).max(3650).optional(),
  publicModels: z.array(z.string().trim().min(1).max(128)).max(100).nullable().optional(),
  publicBaseUrl: z.string().trim().max(500).optional(),
  public_base_url: z.string().trim().max(500).optional(),
  adobeBaseUrl: z.string().trim().max(500).optional(),
  generateTimeoutSeconds: z.number().int().min(1).max(3600).optional(),
  generate_timeout: z.number().int().min(1).max(3600).optional(),
  videoGenerateTimeoutSeconds: z.number().int().min(1).max(3600).optional(),
  video_generate_timeout: z.number().int().min(1).max(3600).optional(),
  refreshIntervalHours: z.number().int().min(1).max(24).optional(),
  refresh_interval_hours: z.number().int().min(1).max(24).optional(),
  sherlockRefreshMinutes: z.number().int().min(1).max(60).optional(),
  sherlockAutoRefreshEnabled: z.boolean().optional(),
  sherlock_auto_refresh_enabled: z.boolean().optional(),
  minCreditsThreshold: z.number().int().min(0).max(10000).optional(),
  min_credits_threshold: z.number().int().min(0).max(10000).optional(),
  returnOriginalUrl: z.boolean().optional(),
  return_original_url: z.boolean().optional(),
  workerConcurrency: z.number().int().min(1).max(100).optional(),
  worker_concurrency: z.number().int().min(1).max(100).optional(),
  retryEnabled: z.boolean().optional(),
  retry_enabled: z.boolean().optional(),
  retryMaxAttempts: z.number().int().min(1).max(10).optional(),
  retry_max_attempts: z.number().int().min(1).max(10).optional(),
  retryBackoffSeconds: z.number().min(0).max(30).optional(),
  retry_backoff_seconds: z.number().min(0).max(30).optional(),
  retryOnStatusCodes: z.array(z.number().int().min(100).max(599)).max(30).optional(),
  retry_on_status_codes: z.array(z.number().int().min(100).max(599)).max(30).optional(),
  retryOnErrorTypes: z.array(z.string().trim().min(1).max(64)).max(30).optional(),
  retry_on_error_types: z.array(z.string().trim().min(1).max(64)).max(30).optional(),
  tokenRotationStrategy: z.enum(["round_robin", "random"]).optional(),
  token_rotation_strategy: z.enum(["round_robin", "random"]).optional(),
  batchConcurrency: z.number().int().min(1).max(100).optional(),
  batch_concurrency: z.number().int().min(1).max(100).optional(),
  creditsRefreshConcurrency: z.number().int().min(1).max(100).optional(),
  credits_refresh_concurrency: z.number().int().min(1).max(100).optional(),
  accountMaxConcurrency: z.number().int().min(1).max(50).optional(),
  account_max_concurrency: z.number().int().min(1).max(50).optional(),
  generatedMaxSizeMb: z.number().int().min(100).max(102400).optional(),
  generated_max_size_mb: z.number().int().min(100).max(102400).optional(),
  generatedPruneSizeMb: z.number().int().min(10).max(10240).optional(),
  generated_prune_size_mb: z.number().int().min(10).max(10240).optional(),
  adobeTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  adobeGenerateTimeoutMs: z.number().int().min(1000).max(3600000).optional(),
  adobePollMs: z.number().int().min(100).max(60000).optional(),
  workerPollMs: z.number().int().min(100).max(60000).optional(),
  jobLeaseMs: z.number().int().min(5000).max(600000).optional(),
  syncTimeoutMs: z.number().int().min(1000).max(3600000).optional(),
  adminUsername: z.string().trim().min(1).max(128).optional(),
  newAdminPassword: z.string().min(12).max(200).optional(),
});

type SettingsInput = z.infer<typeof schema>;

function firstDefined<T>(input: SettingsInput, ...keys: Array<keyof SettingsInput>): T | undefined {
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined) return value as T;
  }
  return undefined;
}

function normalizeUrl(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value) return "";
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new AppError("invalid_setting", `${label} must be a valid HTTP(S) URL`, 400); }
  if (!(parsed.protocol === "http:" || parsed.protocol === "https:") || parsed.username || parsed.password) {
    throw new AppError("invalid_setting", `${label} must be a credential-free HTTP(S) URL`, 400);
  }
  return value.replace(/\/+$/, "");
}

function mergeSettings(current: SystemSettings, input: SettingsInput): SystemSettings {
  const next: SystemSettings = {
    ...current,
    proxyEnabled: firstDefined<boolean>(input, "proxyEnabled", "use_proxy") ?? current.proxyEnabled,
    mediaRoot: input.mediaRoot ?? current.mediaRoot,
    mediaRetentionDays: input.mediaRetentionDays ?? current.mediaRetentionDays,
    publicModels: input.publicModels === undefined ? current.publicModels : input.publicModels,
    publicBaseUrl: normalizeUrl(firstDefined<string>(input, "publicBaseUrl", "public_base_url"), "publicBaseUrl") ?? current.publicBaseUrl,
    adobeBaseUrl: normalizeUrl(input.adobeBaseUrl, "adobeBaseUrl") ?? current.adobeBaseUrl,
    generateTimeoutSeconds: firstDefined<number>(input, "generateTimeoutSeconds", "generate_timeout") ?? current.generateTimeoutSeconds,
    videoGenerateTimeoutSeconds: firstDefined<number>(input, "videoGenerateTimeoutSeconds", "video_generate_timeout") ?? current.videoGenerateTimeoutSeconds,
    refreshIntervalHours: firstDefined<number>(input, "refreshIntervalHours", "refresh_interval_hours") ?? current.refreshIntervalHours,
    sherlockRefreshMinutes: firstDefined<number>(input, "sherlockRefreshMinutes") ?? current.sherlockRefreshMinutes,
    sherlockAutoRefreshEnabled: firstDefined<boolean>(input, "sherlockAutoRefreshEnabled", "sherlock_auto_refresh_enabled") ?? current.sherlockAutoRefreshEnabled,
    minCreditsThreshold: firstDefined<number>(input, "minCreditsThreshold", "min_credits_threshold") ?? current.minCreditsThreshold,
    returnOriginalUrl: firstDefined<boolean>(input, "returnOriginalUrl", "return_original_url") ?? current.returnOriginalUrl,
    workerConcurrency: firstDefined<number>(input, "workerConcurrency", "worker_concurrency") ?? current.workerConcurrency,
    retryEnabled: firstDefined<boolean>(input, "retryEnabled", "retry_enabled") ?? current.retryEnabled,
    retryMaxAttempts: firstDefined<number>(input, "retryMaxAttempts", "retry_max_attempts") ?? current.retryMaxAttempts,
    retryBackoffMs: Math.round((firstDefined<number>(input, "retryBackoffSeconds", "retry_backoff_seconds") ?? current.retryBackoffMs / 1000) * 1000),
    retryOnStatusCodes: firstDefined<number[]>(input, "retryOnStatusCodes", "retry_on_status_codes") ?? current.retryOnStatusCodes,
    retryOnErrorTypes: firstDefined<string[]>(input, "retryOnErrorTypes", "retry_on_error_types") ?? current.retryOnErrorTypes,
    tokenRotationStrategy: firstDefined<"round_robin" | "random">(input, "tokenRotationStrategy", "token_rotation_strategy") ?? current.tokenRotationStrategy,
    batchConcurrency: firstDefined<number>(input, "batchConcurrency", "batch_concurrency") ?? current.batchConcurrency,
    creditsRefreshConcurrency: firstDefined<number>(input, "creditsRefreshConcurrency", "credits_refresh_concurrency") ?? current.creditsRefreshConcurrency,
    accountMaxConcurrency: firstDefined<number>(input, "accountMaxConcurrency", "account_max_concurrency") ?? current.accountMaxConcurrency,
    generatedMaxSizeMb: firstDefined<number>(input, "generatedMaxSizeMb", "generated_max_size_mb") ?? current.generatedMaxSizeMb,
    generatedPruneSizeMb: firstDefined<number>(input, "generatedPruneSizeMb", "generated_prune_size_mb") ?? current.generatedPruneSizeMb,
    adobeTimeoutMs: input.adobeTimeoutMs ?? current.adobeTimeoutMs,
    adobeGenerateTimeoutMs: input.adobeGenerateTimeoutMs ?? current.adobeGenerateTimeoutMs,
    adobePollMs: input.adobePollMs ?? current.adobePollMs,
    workerPollMs: input.workerPollMs ?? current.workerPollMs,
    jobLeaseMs: input.jobLeaseMs ?? current.jobLeaseMs,
    syncTimeoutMs: input.syncTimeoutMs ?? current.syncTimeoutMs,
  };
  if (next.generatedPruneSizeMb >= next.generatedMaxSizeMb) {
    throw new AppError("invalid_setting", "generatedPruneSizeMb must be smaller than generatedMaxSizeMb", 400);
  }
  return next;
}

async function responsePayload(admin: { id: string; username: string }, settings: SystemSettings) {
  const apiKeys = await db.select({ id: serviceApiKey.id, name: serviceApiKey.name, prefix: serviceApiKey.prefix, active: serviceApiKey.active, createdAt: serviceApiKey.createdAt, revokedAt: serviceApiKey.revokedAt, lastUsedAt: serviceApiKey.lastUsedAt }).from(serviceApiKey).orderBy(desc(serviceApiKey.createdAt));
  let databaseHost = "unknown";
  try { databaseHost = new URL(config.databaseUrl()).hostname; } catch { /* 配置错误由启动校验返回 */ }
  return { ...systemSettingsResponse(settings), environment: process.env.NODE_ENV ?? "unknown", databaseHost, admin: { id: admin.id, username: admin.username }, apiKeys };
}

export async function GET(request: Request) {
  try {
    const admin = await requireAdminRequest(request);
    const payload = await responsePayload(admin, await getSystemSettings());
    return Response.json({ ...payload, request_id: getRequestId(request) });
  } catch (error) { return handleAdminError(error, request); }
}

export async function PATCH(request: Request) {
  try {
    const admin = await requireAdminRequest(request);
    const input = schema.parse(await request.json());
    const next = mergeSettings(await getSystemSettings(), input);
    if (next.proxyEnabled) {
      const [{ value: enabledNodes }] = await db.select({ value: count() }).from(proxyNode).where(eq(proxyNode.enabled, true));
      if (Number(enabledNodes) === 0) throw new AppError("proxy_pool_empty", "Cannot enable proxy pool without an enabled proxy node", 409);
    }
    const passwordHash = input.newAdminPassword ? await hashSecret(input.newAdminPassword) : undefined;
    const updatedAdmin = await db.transaction(async (tx) => {
      const data = systemSettingCreateData(next);
      await tx.insert(systemSetting).values({ id: "singleton", ...data }).onDuplicateKeyUpdate({ set: { ...data, updatedAt: new Date() } });
      if (input.adminUsername || passwordHash) {
        await tx.update(adminUser).set({ ...(input.adminUsername ? { username: input.adminUsername } : {}), ...(passwordHash ? { passwordHash } : {}), updatedAt: new Date() }).where(eq(adminUser.id, admin.id));
        const [updated] = await tx.select({ id: adminUser.id, username: adminUser.username }).from(adminUser).where(eq(adminUser.id, admin.id)).limit(1);
        return updated;
      }
      return { id: admin.id, username: admin.username };
    });
    const payload = await responsePayload(updatedAdmin, next);
    return Response.json({ ...payload, request_id: getRequestId(request) });
  } catch (error) { return handleAdminError(error, request); }
}
