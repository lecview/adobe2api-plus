import { db } from "@/lib/db";
import { systemSetting } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { config } from "@/lib/config";
import { normalizePublicModels } from "@/lib/media-model-routing";

export const DEFAULT_RETRY_STATUS_CODES = [429, 451, 500, 502, 503, 504] as const;
export const DEFAULT_RETRY_ERROR_TYPES = ["timeout", "connection", "proxy"] as const;

export type SystemSettings = {
  proxyEnabled: boolean;
  mediaRoot: string;
  publicModels: string[] | null;
  publicBaseUrl: string;
  adobeBaseUrl: string;
  generateTimeoutSeconds: number;
  videoGenerateTimeoutSeconds: number;
  refreshIntervalHours: number;
  /** sherlockToken 定时刷新周期（分钟），默认 5 */
  sherlockRefreshMinutes: number;
  /** 是否启用 sherlockToken 定时自动刷新 */
  sherlockAutoRefreshEnabled: boolean;
  /** 积分刷新后自动删除：剩余积分低于此阈值的账号（0 = 不启用） */
  minCreditsThreshold: number;
  /** 是否直接返回 Adobe 原地址（不下载到本地存储） */
  returnOriginalUrl: boolean;
  /** worker 进程内并发任务数 */
  workerConcurrency: number;
  retryEnabled: boolean;
  retryMaxAttempts: number;
  retryBackoffMs: number;
  retryOnStatusCodes: number[];
  retryOnErrorTypes: string[];
  tokenRotationStrategy: "round_robin" | "random";
  batchConcurrency: number;
  creditsRefreshConcurrency: number;
  accountMaxConcurrency: number;
  generatedMaxSizeMb: number;
  generatedPruneSizeMb: number;
  mediaRetentionDays: number;
  adobeTimeoutMs: number;
  adobeGenerateTimeoutMs: number;
  adobePollMs: number;
  workerPollMs: number;
  jobLeaseMs: number;
  syncTimeoutMs: number;
};

export const systemSettingSelect = {
  proxyEnabled: true,
  mediaRoot: true,
  publicModels: true,
  publicBaseUrl: true,
  adobeBaseUrl: true,
  generateTimeoutSeconds: true,
  videoGenerateTimeoutSeconds: true,
  refreshIntervalHours: true,
  sherlockRefreshMinutes: true,
  sherlockAutoRefreshEnabled: true,
  minCreditsThreshold: true,
  returnOriginalUrl: true,
  workerConcurrency: true,
  retryEnabled: true,
  retryMaxAttempts: true,
  retryBackoffMs: true,
  retryOnStatusCodes: true,
  retryOnErrorTypes: true,
  tokenRotationStrategy: true,
  batchConcurrency: true,
  creditsRefreshConcurrency: true,
  accountMaxConcurrency: true,
  generatedMaxSizeMb: true,
  generatedPruneSizeMb: true,
  mediaRetentionDays: true,
  adobeTimeoutMs: true,
  adobeGenerateTimeoutMs: true,
  adobePollMs: true,
  workerPollMs: true,
  jobLeaseMs: true,
  syncTimeoutMs: true,
} as const;

type SystemSettingRow = {
  [K in keyof typeof systemSettingSelect]: unknown;
};

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = positiveInt(value, fallback);
  return Math.min(max, Math.max(min, parsed));
}

function listOfStrings(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [...fallback];
}

function listOfStatusCodes(value: unknown): number[] {
  const parsed = Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item >= 100 && item <= 599)
    : [...DEFAULT_RETRY_STATUS_CODES];
  return [...new Set(parsed)].sort((left, right) => left - right);
}

export function normalizeSystemSettings(row?: SystemSettingRow | null): SystemSettings {
  const fallback = {
    mediaRoot: config.mediaRoot(),
    publicBaseUrl: config.optional("PUBLIC_BASE_URL") ?? config.optional("ADOBE_PUBLIC_BASE_URL") ?? "",
    adobeBaseUrl: config.adobeBaseUrl() ?? "",
    generateTimeoutSeconds: Math.round(config.adobeGenerateTimeoutMs() / 1000),
    videoGenerateTimeoutSeconds: 600,
    refreshIntervalHours: Math.round(config.refreshIntervalMs() / (60 * 60 * 1000)),
    sherlockRefreshMinutes: 5,
    sherlockAutoRefreshEnabled: true,
    minCreditsThreshold: 100,
    returnOriginalUrl: false,
    workerConcurrency: 5,
    retryEnabled: true,
    retryMaxAttempts: 3,
    retryBackoffMs: 1000,
    batchConcurrency: 5,
    creditsRefreshConcurrency: 2,
    accountMaxConcurrency: 3,
    generatedMaxSizeMb: Math.round(config.mediaMaxBytes() / (1024 * 1024)),
    generatedPruneSizeMb: 200,
    mediaRetentionDays: Math.round(config.mediaRetentionMs() / (24 * 60 * 60 * 1000)),
    adobeTimeoutMs: config.adobeTimeoutMs(),
    adobeGenerateTimeoutMs: config.adobeGenerateTimeoutMs(),
    adobePollMs: config.adobePollMs(),
    workerPollMs: config.workerPollMs(),
    jobLeaseMs: config.jobLeaseMs(),
    syncTimeoutMs: config.syncTimeoutMs(),
  };
  const strategy = row?.tokenRotationStrategy === "random" ? "random" : "round_robin";
  return {
    proxyEnabled: row?.proxyEnabled === true,
    mediaRoot: typeof row?.mediaRoot === "string" && row.mediaRoot.trim() ? row.mediaRoot.trim() : fallback.mediaRoot,
    publicModels: Array.isArray(row?.publicModels) ? normalizePublicModels(row.publicModels) : null,
    publicBaseUrl: typeof row?.publicBaseUrl === "string" ? row.publicBaseUrl.trim() : fallback.publicBaseUrl,
    adobeBaseUrl: typeof row?.adobeBaseUrl === "string" ? row.adobeBaseUrl.trim() : fallback.adobeBaseUrl,
    generateTimeoutSeconds: boundedInt(row?.generateTimeoutSeconds, fallback.generateTimeoutSeconds, 1, 3600),
    videoGenerateTimeoutSeconds: boundedInt(row?.videoGenerateTimeoutSeconds, fallback.videoGenerateTimeoutSeconds, 1, 3600),
    refreshIntervalHours: boundedInt(row?.refreshIntervalHours, fallback.refreshIntervalHours, 1, 24),
    sherlockRefreshMinutes: boundedInt(row?.sherlockRefreshMinutes, fallback.sherlockRefreshMinutes, 1, 60),
    sherlockAutoRefreshEnabled: typeof row?.sherlockAutoRefreshEnabled === "boolean" ? row.sherlockAutoRefreshEnabled : fallback.sherlockAutoRefreshEnabled,
    minCreditsThreshold: typeof row?.minCreditsThreshold === "number" && row.minCreditsThreshold >= 0 ? row.minCreditsThreshold : fallback.minCreditsThreshold,
    returnOriginalUrl: typeof row?.returnOriginalUrl === "boolean" ? row.returnOriginalUrl : fallback.returnOriginalUrl,
    workerConcurrency: boundedInt(row?.workerConcurrency, fallback.workerConcurrency, 1, 100),
    retryEnabled: typeof row?.retryEnabled === "boolean" ? row.retryEnabled : fallback.retryEnabled,
    retryMaxAttempts: boundedInt(row?.retryMaxAttempts, fallback.retryMaxAttempts, 1, 10),
    retryBackoffMs: typeof row?.retryBackoffMs === "number" && Number.isInteger(row.retryBackoffMs) && row.retryBackoffMs >= 0 ? Math.min(30_000, row.retryBackoffMs) : fallback.retryBackoffMs,
    retryOnStatusCodes: listOfStatusCodes(row?.retryOnStatusCodes),
    retryOnErrorTypes: listOfStrings(row?.retryOnErrorTypes, DEFAULT_RETRY_ERROR_TYPES),
    tokenRotationStrategy: strategy,
    batchConcurrency: boundedInt(row?.batchConcurrency, fallback.batchConcurrency, 1, 100),
    creditsRefreshConcurrency: boundedInt(row?.creditsRefreshConcurrency, fallback.creditsRefreshConcurrency, 1, 100),
    accountMaxConcurrency: boundedInt(row?.accountMaxConcurrency, fallback.accountMaxConcurrency, 1, 50),
    generatedMaxSizeMb: boundedInt(row?.generatedMaxSizeMb, fallback.generatedMaxSizeMb, 100, 102_400),
    generatedPruneSizeMb: boundedInt(row?.generatedPruneSizeMb, fallback.generatedPruneSizeMb, 10, 10240),
    mediaRetentionDays: boundedInt(row?.mediaRetentionDays, fallback.mediaRetentionDays, 1, 3650),
    adobeTimeoutMs: boundedInt(row?.adobeTimeoutMs, fallback.adobeTimeoutMs, 1000, 600_000),
    adobeGenerateTimeoutMs: boundedInt(row?.adobeGenerateTimeoutMs, fallback.adobeGenerateTimeoutMs, 1000, 3_600_000),
    adobePollMs: boundedInt(row?.adobePollMs, fallback.adobePollMs, 100, 60_000),
    workerPollMs: boundedInt(row?.workerPollMs, fallback.workerPollMs, 100, 60_000),
    jobLeaseMs: boundedInt(row?.jobLeaseMs, fallback.jobLeaseMs, 5000, 600_000),
    syncTimeoutMs: boundedInt(row?.syncTimeoutMs, fallback.syncTimeoutMs, 1000, 3_600_000),
  };
}

export async function getSystemSettings(): Promise<SystemSettings> {
  const [row] = await db.select().from(systemSetting).where(eq(systemSetting.id, "singleton")).limit(1);
  return normalizeSystemSettings(row as SystemSettingRow | null);
}

export function systemSettingCreateData(settings: SystemSettings) {
  return {
    proxyEnabled: settings.proxyEnabled,
    mediaRoot: settings.mediaRoot,
    // 原 Prisma.JsonNull 表示 JSON null；drizzle 的 json 列直接接受 null。
    publicModels: settings.publicModels === null ? null : settings.publicModels,
    publicBaseUrl: settings.publicBaseUrl || null,
    adobeBaseUrl: settings.adobeBaseUrl || null,
    generateTimeoutSeconds: settings.generateTimeoutSeconds,
    videoGenerateTimeoutSeconds: settings.videoGenerateTimeoutSeconds,
    refreshIntervalHours: settings.refreshIntervalHours,
    sherlockRefreshMinutes: settings.sherlockRefreshMinutes,
    sherlockAutoRefreshEnabled: settings.sherlockAutoRefreshEnabled,
    minCreditsThreshold: settings.minCreditsThreshold,
    returnOriginalUrl: settings.returnOriginalUrl,
    workerConcurrency: settings.workerConcurrency,
    retryEnabled: settings.retryEnabled,
    retryMaxAttempts: settings.retryMaxAttempts,
    retryBackoffMs: settings.retryBackoffMs,
    retryOnStatusCodes: settings.retryOnStatusCodes,
    retryOnErrorTypes: settings.retryOnErrorTypes,
    tokenRotationStrategy: settings.tokenRotationStrategy,
    batchConcurrency: settings.batchConcurrency,
    creditsRefreshConcurrency: settings.creditsRefreshConcurrency,
    accountMaxConcurrency: settings.accountMaxConcurrency,
    generatedMaxSizeMb: settings.generatedMaxSizeMb,
    generatedPruneSizeMb: settings.generatedPruneSizeMb,
    mediaRetentionDays: settings.mediaRetentionDays,
    adobeTimeoutMs: settings.adobeTimeoutMs,
    adobeGenerateTimeoutMs: settings.adobeGenerateTimeoutMs,
    adobePollMs: settings.adobePollMs,
    workerPollMs: settings.workerPollMs,
    jobLeaseMs: settings.jobLeaseMs,
    syncTimeoutMs: settings.syncTimeoutMs,
  };
}

export function systemSettingsResponse(settings: SystemSettings) {
  return {
    proxyEnabled: settings.proxyEnabled,
    use_proxy: settings.proxyEnabled,
    mediaRoot: settings.mediaRoot,
    mediaRetentionDays: settings.mediaRetentionDays,
    publicModels: settings.publicModels,
    publicBaseUrl: settings.publicBaseUrl,
    public_base_url: settings.publicBaseUrl,
    adobeBaseUrl: settings.adobeBaseUrl,
    generateTimeoutSeconds: settings.generateTimeoutSeconds,
    generate_timeout: settings.generateTimeoutSeconds,
    videoGenerateTimeoutSeconds: settings.videoGenerateTimeoutSeconds,
    video_generate_timeout: settings.videoGenerateTimeoutSeconds,
    refreshIntervalHours: settings.refreshIntervalHours,
    refresh_interval_hours: settings.refreshIntervalHours,
    sherlockRefreshMinutes: settings.sherlockRefreshMinutes,
    sherlock_auto_refresh_enabled: settings.sherlockAutoRefreshEnabled,
    minCreditsThreshold: settings.minCreditsThreshold,
    min_credits_threshold: settings.minCreditsThreshold,
    returnOriginalUrl: settings.returnOriginalUrl,
    return_original_url: settings.returnOriginalUrl,
    workerConcurrency: settings.workerConcurrency,
    worker_concurrency: settings.workerConcurrency,
    retryEnabled: settings.retryEnabled,
    retry_enabled: settings.retryEnabled,
    retryMaxAttempts: settings.retryMaxAttempts,
    retry_max_attempts: settings.retryMaxAttempts,
    retryBackoffSeconds: settings.retryBackoffMs / 1000,
    retry_backoff_seconds: settings.retryBackoffMs / 1000,
    retryOnStatusCodes: settings.retryOnStatusCodes,
    retry_on_status_codes: settings.retryOnStatusCodes,
    retryOnErrorTypes: settings.retryOnErrorTypes,
    retry_on_error_types: settings.retryOnErrorTypes,
    tokenRotationStrategy: settings.tokenRotationStrategy,
    token_rotation_strategy: settings.tokenRotationStrategy,
    batchConcurrency: settings.batchConcurrency,
    batch_concurrency: settings.batchConcurrency,
    creditsRefreshConcurrency: settings.creditsRefreshConcurrency,
    credits_refresh_concurrency: settings.creditsRefreshConcurrency,
    accountMaxConcurrency: settings.accountMaxConcurrency,
    account_max_concurrency: settings.accountMaxConcurrency,
    generatedMaxSizeMb: settings.generatedMaxSizeMb,
    generated_max_size_mb: settings.generatedMaxSizeMb,
    generatedPruneSizeMb: settings.generatedPruneSizeMb,
    generated_prune_size_mb: settings.generatedPruneSizeMb,
    adobeTimeoutMs: settings.adobeTimeoutMs,
    adobeGenerateTimeoutMs: settings.adobeGenerateTimeoutMs,
    adobePollMs: settings.adobePollMs,
    workerPollMs: settings.workerPollMs,
    jobLeaseMs: settings.jobLeaseMs,
    syncTimeoutMs: settings.syncTimeoutMs,
  };
}
