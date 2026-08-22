import { randomUUID } from "node:crypto";

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// 数据库连接：单一 DATABASE_URL，由 .env.development / .env.production 分别提供。
// next dev 自动加载 .env.development，next build/start 自动加载 .env.production，
// tsx 入口用 --env-file-if-exists 兜底（容器由部署平台注入环境变量）。
// 不锁定 host——环境文件本身已隔离开发库与生产库。
function databaseUrl(): string {
  const raw = required("DATABASE_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL must be a valid MySQL URL");
  }
  if (url.protocol !== "mysql:") throw new Error("DATABASE_URL must use the mysql protocol");
  if (!url.pathname || url.pathname === "/") throw new Error("DATABASE_URL must include a database name");
  return raw;
}

function databasePoolConnectionLimit(): number {
  const raw = required("DATABASE_URL");
  const value = Number(new URL(raw).searchParams.get("connectionLimit") ?? 10);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 50) : 10;
}

function secret(name: string, minimumBytes: number): string {
  const value = required(name);
  if (Buffer.byteLength(value, "utf8") < minimumBytes) {
    throw new Error(`${name} must contain at least ${minimumBytes} bytes`);
  }
  return value;
}

export const config = {
  optional,
  databaseUrl,
  databasePoolConnectionLimit,
  validateRuntime: () => {
    // 在 Web/Worker 真正开始监听或领取任务前主动完成配置校验。
    // 这里不建立数据库连接，避免构建阶段依赖部署环境，但能保证
    // 数据库 URL 和密钥不会延迟到首个请求才失败。
    databaseUrl();
    secret("SESSION_SECRET", 32);
    secret("ENCRYPTION_KEY", 16);
  },
  sessionSecret: () => secret("SESSION_SECRET", 32),
  encryptionKey: () => secret("ENCRYPTION_KEY", 16),
  mediaRoot: () => optional("MEDIA_ROOT") ?? "./data/generated",
  mediaPublicPrefix: () => optional("MEDIA_PUBLIC_PREFIX") ?? "/generated",
  adobeBaseUrl: () => optional("ADOBE_BASE_URL"),
  adobeApiKey: () => optional("ADOBE_API_KEY") ?? "clio-playground-web",
  adobeUserAgent: () => optional("ADOBE_USER_AGENT") ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  adobeTimeoutMs: () => parsePositiveInt(optional("ADOBE_TIMEOUT_MS"), 60_000),
  adobeGenerateTimeoutMs: () => parsePositiveInt(optional("ADOBE_GENERATE_TIMEOUT_MS"), 300_000),
  adobePollMs: () => parsePositiveInt(optional("ADOBE_POLL_MS"), 3_000),
  refreshIntervalMs: () => parsePositiveInt(optional("REFRESH_INTERVAL_HOURS"), 15) * 60 * 60 * 1000,
  mediaMaxBytes: () => parsePositiveInt(optional("MEDIA_MAX_BYTES"), 1024 * 1024 * 1024),
  mediaRetentionMs: () => parsePositiveInt(optional("MEDIA_RETENTION_DAYS"), 30) * 24 * 60 * 60 * 1000,
  // workerId 未显式配置时为每个进程生成唯一 ID（缓存），保证多副本 Worker 各自独占租约，
  // 不会互相续租/释放对方任务的租约。
  workerId: (() => { const explicit = optional("WORKER_ID"); const generated = explicit ?? `worker-${randomUUID().slice(0, 8)}`; return () => generated; })(),
  workerPollMs: () => parsePositiveInt(optional("WORKER_POLL_MS"), 1000),
  jobLeaseMs: () => parsePositiveInt(optional("JOB_LEASE_MS"), 30_000),
  syncTimeoutMs: () => parsePositiveInt(optional("JOB_SYNC_TIMEOUT_MS"), 120_000),
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received ${value}`);
  return parsed;
}
