import { randomUUID } from "node:crypto";
import {
  bigint,
  boolean,
  char,
  datetime,
  double,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * 数据库层（Drizzle ORM）。
 *
 * 表结构精确映射现有 MySQL 库（由原 Prisma 创建，表名全小写、列名驼峰），
 * 不重建表、不迁移数据。id 由应用层生成（原 Prisma cuid，现用 crypto.randomUUID）。
 * 注意：updatedAt 在原 Prisma 中由客户端在每次写操作时自动设置，这里没有 DB 默认值，
 * 因此 insert/update 都必须显式提供 updatedAt（本文件用 $defaultFn 兜底 insert）。
 */

// 时间列统一精度 3（与原 Prisma DATETIME(3) 一致）
const id = (column: string) => varchar(column, { length: 191 }).$defaultFn(() => randomUUID()).primaryKey();
const createdAt = () => datetime("createdAt", { mode: "date", fsp: 3 }).$defaultFn(() => new Date()).notNull();
const updatedAt = () => datetime("updatedAt", { mode: "date", fsp: 3 }).$defaultFn(() => new Date()).notNull();

export const adminUser = mysqlTable(
  "adminuser",
  {
    id: id("id"),
    username: varchar("username", { length: 128 }).notNull(),
    passwordHash: varchar("passwordHash", { length: 255 }).notNull(),
    status: mysqlEnum("status", ["ACTIVE", "DISABLED"]).default("ACTIVE").notNull(),
    lastLoginAt: datetime("lastLoginAt", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("AdminUser_username_key").on(table.username)],
);

export const adminSession = mysqlTable(
  "adminsession",
  {
    id: id("id"),
    tokenHash: char("tokenHash", { length: 64 }).notNull(),
    userId: varchar("userId", { length: 191 }).notNull(),
    expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }).notNull(),
    revokedAt: datetime("revokedAt", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    lastSeenAt: datetime("lastSeenAt", { mode: "date", fsp: 3 }),
  },
  (table) => [
    uniqueIndex("AdminSession_tokenHash_key").on(table.tokenHash),
    index("AdminSession_userId_revokedAt_expiresAt_idx").on(table.userId, table.revokedAt, table.expiresAt),
  ],
);

export const loginThrottle = mysqlTable(
  "loginthrottle",
  {
    keyHash: char("keyHash", { length: 64 }).primaryKey(),
    windowStartedAt: datetime("windowStartedAt", { mode: "date", fsp: 3 }).notNull(),
    attempts: int("attempts").default(0).notNull(),
    blockedUntil: datetime("blockedUntil", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("LoginThrottle_blockedUntil_idx").on(table.blockedUntil),
    index("LoginThrottle_updatedAt_idx").on(table.updatedAt),
  ],
);

export const serviceApiKey = mysqlTable(
  "serviceapikey",
  {
    id: id("id"),
    name: varchar("name", { length: 128 }).notNull(),
    keyHash: char("keyHash", { length: 64 }).notNull(),
    prefix: varchar("prefix", { length: 16 }).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: createdAt(),
    revokedAt: datetime("revokedAt", { mode: "date", fsp: 3 }),
    lastUsedAt: datetime("lastUsedAt", { mode: "date", fsp: 3 }),
  },
  (table) => [uniqueIndex("ServiceApiKey_keyHash_key").on(table.keyHash)],
);

export const systemSetting = mysqlTable("systemsetting", {
  id: varchar("id", { length: 191 }).primaryKey().default("singleton"),
  proxyEnabled: boolean("proxyEnabled").default(false).notNull(),
  mediaRoot: varchar("mediaRoot", { length: 500 }).default("./data/generated").notNull(),
  mediaRetention: json("mediaRetention"),
  publicModels: json("publicModels"),
  publicBaseUrl: varchar("publicBaseUrl", { length: 500 }),
  adobeBaseUrl: varchar("adobeBaseUrl", { length: 500 }),
  generateTimeoutSeconds: int("generateTimeoutSeconds").default(300).notNull(),
  videoGenerateTimeoutSeconds: int("videoGenerateTimeoutSeconds").default(600).notNull(),
  refreshIntervalHours: int("refreshIntervalHours").default(25).notNull(),
  /** sherlockToken 定时刷新周期（分钟）：默认 5min */
  sherlockRefreshMinutes: int("sherlockRefreshMinutes").default(5).notNull(),
  /** 是否启用 sherlockToken 定时自动刷新（worker 主循环执行） */
  sherlockAutoRefreshEnabled: boolean("sherlockAutoRefreshEnabled").default(true).notNull(),
  /** 积分刷新后自动删除：剩余积分低于此阈值的账号（0 = 不启用） */
  minCreditsThreshold: int("minCreditsThreshold").default(0).notNull(),
  /** 是否直接返回 Adobe 原地址（不下载到本地，节省时间）；默认 false = 下载后存本地 */
  returnOriginalUrl: boolean("returnOriginalUrl").default(false).notNull(),
  /** worker 进程内并发生图任务数（默认 1；调大后单 worker 即可并行跑多个任务） */
  workerConcurrency: int("workerConcurrency").default(1).notNull(),
  /** 全局 sherlockToken（x-arp-session-id）：浏览器会话级，所有账号共用，与账号无关 */
  sherlockToken: text("sherlockToken"),
  sherlockExpiresAt: datetime("sherlockExpiresAt", { mode: "date", fsp: 3 }),
  sherlockSource: varchar("sherlockSource", { length: 16 }),
  sherlockUpdatedAt: datetime("sherlockUpdatedAt", { mode: "date", fsp: 3 }),
  retryEnabled: boolean("retryEnabled").default(true).notNull(),
  retryMaxAttempts: int("retryMaxAttempts").default(3).notNull(),
  retryBackoffMs: int("retryBackoffMs").default(1000).notNull(),
  retryOnStatusCodes: json("retryOnStatusCodes"),
  retryOnErrorTypes: json("retryOnErrorTypes"),
  tokenRotationStrategy: varchar("tokenRotationStrategy", { length: 32 }).default("round_robin").notNull(),
  batchConcurrency: int("batchConcurrency").default(5).notNull(),
  creditsRefreshConcurrency: int("creditsRefreshConcurrency").default(1).notNull(),
  accountMaxConcurrency: int("accountMaxConcurrency").default(1).notNull(),
  generatedMaxSizeMb: int("generatedMaxSizeMb").default(1024).notNull(),
  generatedPruneSizeMb: int("generatedPruneSizeMb").default(200).notNull(),
  mediaRetentionDays: int("mediaRetentionDays").default(30).notNull(),
  adobeTimeoutMs: int("adobeTimeoutMs").default(60000).notNull(),
  adobeGenerateTimeoutMs: int("adobeGenerateTimeoutMs").default(300000).notNull(),
  adobePollMs: int("adobePollMs").default(3000).notNull(),
  workerPollMs: int("workerPollMs").default(1000).notNull(),
  jobLeaseMs: int("jobLeaseMs").default(30000).notNull(),
  syncTimeoutMs: int("syncTimeoutMs").default(120000).notNull(),
  cleanupLeaseOwner: varchar("cleanupLeaseOwner", { length: 128 }),
  cleanupLeaseExpiresAt: datetime("cleanupLeaseExpiresAt", { mode: "date", fsp: 3 }),
  updatedAt: updatedAt(),
});

export const adobeAccount = mysqlTable(
  "adobeaccount",
  {
    id: id("id"),
    externalId: varchar("externalId", { length: 255 }),
    displayName: varchar("displayName", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }),
    status: mysqlEnum("status", ["AVAILABLE", "UNAVAILABLE", "REFRESHING"]).default("AVAILABLE").notNull(),
    /** 3p 端点 408 风控标记：不删除账号，但不再被选号逻辑选中 */
    riskFlagged: boolean("riskFlagged").default(false).notNull(),
    riskFlaggedAt: datetime("riskFlaggedAt", { mode: "date", fsp: 3 }),
    riskFlaggedReason: text("riskFlaggedReason"),
    lastRefreshAt: datetime("lastRefreshAt", { mode: "date", fsp: 3 }),
    lastRefreshError: text("lastRefreshError"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("AdobeAccount_externalId_key").on(table.externalId)],
);

export const adobeToken = mysqlTable(
  "adobetoken",
  {
    id: id("id"),
    accountId: varchar("accountId", { length: 191 }).notNull(),
    encryptedAccessToken: text("encryptedAccessToken").notNull(),
    expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }),
    status: mysqlEnum("status", ["ACTIVE", "DISABLED", "EXHAUSTED", "INVALID", "EXPIRED", "REVOKED"]).default("ACTIVE").notNull(),
    source: varchar("source", { length: 32 }).default("manual").notNull(),
    autoRefreshEnabled: boolean("autoRefreshEnabled").default(false).notNull(),
    refreshProfileId: varchar("refreshProfileId", { length: 191 }),
    failureCount: int("failureCount").default(0).notNull(),
    errorUntil: datetime("errorUntil", { mode: "date", fsp: 3 }),
    lastError: text("lastError"),
    creditsTotal: double("creditsTotal"),
    creditsUsed: double("creditsUsed"),
    creditsAvailable: double("creditsAvailable"),
    creditsAvailableUntil: varchar("creditsAvailableUntil", { length: 64 }),
    creditsUpdatedAt: datetime("creditsUpdatedAt", { mode: "date", fsp: 3 }),
    creditsError: text("creditsError"),
    lastUsedAt: datetime("lastUsedAt", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("AdobeToken_accountId_status_expiresAt_idx").on(table.accountId, table.status, table.expiresAt),
    index("AdobeToken_refreshProfileId_autoRefreshEnabled_idx").on(table.refreshProfileId, table.autoRefreshEnabled),
  ],
);

export const refreshProfile = mysqlTable(
  "refreshprofile",
  {
    id: id("id"),
    accountId: varchar("accountId", { length: 191 }).notNull(),
    name: varchar("name", { length: 255 }),
    encryptedCookie: text("encryptedCookie").notNull(),
    externalAccountId: varchar("externalAccountId", { length: 255 }),
    status: mysqlEnum("status", ["ACTIVE", "INVALID", "DISABLED"]).default("ACTIVE").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    /** x-arp-session-id 完整值（sherlockToken），浏览器铸造或手动输入 */
    sherlockToken: text("sherlockToken"),
    /** token 预计过期时间（sid 组件 30min 寿命，存过期时刻用于后台显示与定时刷新） */
    sherlockExpiresAt: datetime("sherlockExpiresAt", { mode: "date", fsp: 3 }),
    /** token 来源：browser=浏览器铸造 auto=定时拉取 manual=手动输入 */
    sherlockSource: varchar("sherlockSource", { length: 16 }),
    sherlockUpdatedAt: datetime("sherlockUpdatedAt", { mode: "date", fsp: 3 }),
    nextRefreshAt: datetime("nextRefreshAt", { mode: "date", fsp: 3 }),
    lastAttemptAt: datetime("lastAttemptAt", { mode: "date", fsp: 3 }),
    lastSuccessAt: datetime("lastSuccessAt", { mode: "date", fsp: 3 }),
    consecutiveFailures: int("consecutiveFailures").default(0).notNull(),
    lastHttpStatus: int("lastHttpStatus"),
    leaseOwner: varchar("leaseOwner", { length: 128 }),
    leaseExpiresAt: datetime("leaseExpiresAt", { mode: "date", fsp: 3 }),
    lastError: text("lastError"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("RefreshProfile_accountId_status_idx").on(table.accountId, table.status),
    index("RefreshProfile_status_nextRefreshAt_leaseExpiresAt_idx").on(table.status, table.nextRefreshAt, table.leaseExpiresAt),
  ],
);

export const entity = mysqlTable(
  "entity",
  {
    id: id("id"),
    accountId: varchar("accountId", { length: 191 }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    entityType: varchar("entityType", { length: 64 }).notNull(),
    description: text("description"),
    upstreamId: varchar("upstreamId", { length: 255 }),
    metadata: json("metadata"),
    status: mysqlEnum("status", ["ACTIVE", "DISABLED", "DELETED"]).default("ACTIVE").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("Entity_accountId_name_key").on(table.accountId, table.name),
    index("Entity_name_status_idx").on(table.name, table.status),
  ],
);

export const proxyNode = mysqlTable(
  "proxynode",
  {
    id: id("id"),
    protocol: mysqlEnum("protocol", ["HTTP", "SOCKS5"]).notNull(),
    host: varchar("host", { length: 255 }).notNull(),
    port: int("port").notNull(),
    encryptedUsername: text("encryptedUsername"),
    encryptedPassword: text("encryptedPassword"),
    enabled: boolean("enabled").default(true).notNull(),
    displayOrder: int("displayOrder").notNull(),
    version: int("version").default(1).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("ProxyNode_displayOrder_key").on(table.displayOrder),
    index("ProxyNode_enabled_displayOrder_idx").on(table.enabled, table.displayOrder),
  ],
);

export const proxyRotationState = mysqlTable("proxyrotationstate", {
  id: varchar("id", { length: 191 }).primaryKey().default("singleton"),
  nextOrder: int("nextOrder").default(0).notNull(),
  version: int("version").default(1).notNull(),
  updatedAt: updatedAt(),
});

export const generationJob = mysqlTable(
  "generationjob",
  {
    id: id("id"),
    kind: mysqlEnum("kind", ["GENERATION", "ENTITY_CREATE", "ENTITY_SYNC", "ENTITY_DELETE", "REFRESH"]).default("GENERATION").notNull(),
    status: mysqlEnum("status", ["QUEUED", "UPLOADING", "SUBMITTING", "POLLING", "DOWNLOADING", "SUCCEEDED", "FAILED", "CANCELLED", "SUBMISSION_UNKNOWN"]).default("QUEUED").notNull(),
    apiPath: varchar("apiPath", { length: 255 }).notNull(),
    model: varchar("model", { length: 128 }),
    requestPayload: json("requestPayload").notNull(),
    resultPayload: json("resultPayload"),
    errorCode: varchar("errorCode", { length: 128 }),
    errorMessage: text("errorMessage"),
    upstreamTaskId: varchar("upstreamTaskId", { length: 255 }),
    upstreamPollUrl: text("upstreamPollUrl"),
    adobeAccountId: varchar("adobeAccountId", { length: 191 }),
    accountSnapshot: json("accountSnapshot"),
    currentProxyId: varchar("currentProxyId", { length: 191 }),
    proxySnapshot: json("proxySnapshot"),
    proxyAttemptIndex: int("proxyAttemptIndex"),
    leaseOwner: varchar("leaseOwner", { length: 128 }),
    leaseExpiresAt: datetime("leaseExpiresAt", { mode: "date", fsp: 3 }),
    attemptCount: int("attemptCount").default(0).notNull(),
    startedAt: datetime("startedAt", { mode: "date", fsp: 3 }),
    completedAt: datetime("completedAt", { mode: "date", fsp: 3 }),
    lastHeartbeatAt: datetime("lastHeartbeatAt", { mode: "date", fsp: 3 }),
    entityId: varchar("entityId", { length: 191 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("GenerationJob_status_leaseExpiresAt_createdAt_idx").on(table.status, table.leaseExpiresAt, table.createdAt),
    index("GenerationJob_createdAt_idx").on(table.createdAt),
    index("GenerationJob_adobeAccountId_status_idx").on(table.adobeAccountId, table.status),
    index("GenerationJob_entityId_fkey").on(table.entityId),
  ],
);

export const jobAttempt = mysqlTable(
  "jobattempt",
  {
    id: id("id"),
    jobId: varchar("jobId", { length: 191 }).notNull(),
    stage: mysqlEnum("stage", ["UPLOAD", "SUBMIT", "POLL", "DOWNLOAD", "REFRESH"]).notNull(),
    attemptNumber: int("attemptNumber").notNull(),
    proxyId: varchar("proxyId", { length: 191 }),
    status: mysqlEnum("status", ["RUNNING", "SUCCEEDED", "FAILED", "SKIPPED"]).default("RUNNING").notNull(),
    errorCategory: varchar("errorCategory", { length: 128 }),
    errorMessage: text("errorMessage"),
    upstreamStatus: int("upstreamStatus"),
    metadata: json("metadata"),
    startedAt: datetime("startedAt", { mode: "date", fsp: 3 }).$defaultFn(() => new Date()).notNull(),
    finishedAt: datetime("finishedAt", { mode: "date", fsp: 3 }),
  },
  (table) => [
    uniqueIndex("JobAttempt_jobId_stage_attemptNumber_key").on(table.jobId, table.stage, table.attemptNumber),
    index("JobAttempt_jobId_startedAt_idx").on(table.jobId, table.startedAt),
    index("JobAttempt_proxyId_status_idx").on(table.proxyId, table.status),
  ],
);

export const jobEvent = mysqlTable(
  "jobevent",
  {
    id: id("id"),
    jobId: varchar("jobId", { length: 191 }).notNull(),
    sequence: int("sequence").notNull(),
    type: varchar("type", { length: 64 }).notNull(),
    payload: json("payload"),
    createdAt: createdAt(),
  },
  (table) => [
    index("JobEvent_jobId_createdAt_idx").on(table.jobId, table.createdAt),
    uniqueIndex("JobEvent_jobId_sequence_key").on(table.jobId, table.sequence),
  ],
);

export const mediaAsset = mysqlTable(
  "mediaasset",
  {
    id: id("id"),
    jobId: varchar("jobId", { length: 191 }).notNull(),
    objectKey: varchar("objectKey", { length: 500 }).notNull(),
    /** returnOriginalUrl 开启时，存 Adobe 原地址（objectKey 为空串占位），响应层直接返回该地址 */
    url: varchar("url", { length: 1000 }),
    mimeType: varchar("mimeType", { length: 128 }).notNull(),
    byteSize: bigint("byteSize", { mode: "bigint" }).notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    status: mysqlEnum("status", ["READY", "EXPIRED", "DELETED"]).default("READY").notNull(),
    expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("MediaAsset_objectKey_key").on(table.objectKey),
    index("MediaAsset_jobId_status_idx").on(table.jobId, table.status),
    index("MediaAsset_expiresAt_status_idx").on(table.expiresAt, table.status),
  ],
);

// 类型导出：供各模块引用枚举列类型，避免重复定义字符串字面量联合。
export type AdminUserStatus = (typeof adminUser.$inferSelect)["status"];
export type AdobeAccountStatus = (typeof adobeAccount.$inferSelect)["status"];
export type AdobeTokenStatus = (typeof adobeToken.$inferSelect)["status"];
export type RefreshProfileStatus = (typeof refreshProfile.$inferSelect)["status"];
export type EntityStatus = (typeof entity.$inferSelect)["status"];
export type ProxyProtocol = (typeof proxyNode.$inferSelect)["protocol"];
export type JobKind = (typeof generationJob.$inferSelect)["kind"];
export type JobStatus = (typeof generationJob.$inferSelect)["status"];
export type JobStage = (typeof jobAttempt.$inferSelect)["stage"];
export type AttemptStatus = (typeof jobAttempt.$inferSelect)["status"];
export type MediaStatus = (typeof mediaAsset.$inferSelect)["status"];
