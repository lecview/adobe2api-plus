import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { processOne } from "@/lib/worker/processor";
import { refreshDueProfiles } from "@/lib/adobe/refresh";
import { refreshSherlockIfDue } from "@/lib/adobe/sherlock";
import { cleanupMedia } from "@/lib/media-cleanup";
import { cleanupStaleRemoteMedia } from "@/lib/ssrf";
import { ensureSchema, REQUIRED_MIGRATION, schemaIsReady, type MigrationStatusRow } from "@/lib/schema";
import { getSystemSettings } from "@/lib/system-settings";
import { sql } from "drizzle-orm";

let stopping = false;

function requestShutdown() {
  if (stopping) {
    // 第二次 Ctrl+C：用户明确要立即退出，强制终止（可能中断当前任务）
    console.log("正在强制退出 Worker...");
    process.exit(130);
  }
  stopping = true;
  console.log("正在停止 Worker，等待当前任务完成（再次 Ctrl+C 立即强制退出）...");
}

process.on("SIGTERM", requestShutdown);
process.on("SIGINT", requestShutdown);

async function assertWorkerDatabaseReady() {
  await db.execute(sql`SELECT 1`);
  // drizzle mysql2 的 db.execute 返回 [rows, fields] 二维数组，需取第一层才是查询行。
  const [migrations] = await db.execute(sql`SELECT migration_name, finished_at, rolled_back_at FROM \`_prisma_migrations\` WHERE migration_name = ${REQUIRED_MIGRATION} LIMIT 1`) as unknown as [MigrationStatusRow[], unknown];
  if (!schemaIsReady(migrations)) throw new Error(`Required migration ${REQUIRED_MIGRATION} is not applied`);
}

async function main() {
  config.validateRuntime();
  await ensureSchema();
  await assertWorkerDatabaseReady();
  const workerId = config.workerId();
  const once = process.env.WORKER_ONCE === "1";
  if (stopping) return;
  await cleanupStaleRemoteMedia().catch((error) => console.error("remote media temp cleanup failed", error instanceof Error ? error.message : error));

  const initialSettings = await getSystemSettings();
  // 每个消费者 slot 独立循环：领一个任务 → 全程跑完 → 领下一个。
  // claimNextJob 用 SELECT ... SKIP LOCKED 锁任务，多个 slot 并发安全，互不抢占。
  const workerConcurrency = Math.max(1, initialSettings.workerConcurrency);
  const pollMs = initialSettings.workerPollMs;

  const runJobLoop = async () => {
    while (!stopping) {
      try {
        const worked = await processOne(workerId);
        if (once) break;
        if (!worked) await new Promise((resolve) => setTimeout(resolve, pollMs));
      } catch (error) {
        // 单个任务/事务失败不应杀死整个 Worker：记录错误后按轮询周期退避重试。
        console.error("job cycle failed", error instanceof Error ? error.message : error);
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
  };

  // 周期性维护（token 刷新 / sherlock / 媒体清理）独立于任务消费循环，互不阻塞
  const runPeriodicLoop = async () => {
    let lastRefreshAt = 0;
    let lastCleanupAt = 0;
    let lastSherlockAt = 0;
    while (!stopping) {
      const settings = await getSystemSettings();
      if (stopping) break;
      if (Date.now() - lastRefreshAt >= Math.min(settings.refreshIntervalHours * 60 * 60 * 1000, 60_000)) {
        await refreshDueProfiles(workerId, settings.batchConcurrency).catch((error) => console.error("refresh cycle failed", error instanceof Error ? error.message : error));
        lastRefreshAt = Date.now();
      }
      if (stopping) break;
      if (settings.sherlockAutoRefreshEnabled && Date.now() - lastSherlockAt >= settings.sherlockRefreshMinutes * 60 * 1000) {
        await refreshSherlockIfDue().catch((error) => console.error("sherlock refresh cycle failed", error instanceof Error ? error.message : error));
        lastSherlockAt = Date.now();
      }
      if (stopping) break;
      if (Date.now() - lastCleanupAt >= 60_000) {
        await cleanupMedia(workerId).catch((error) => console.error("media cleanup failed", error instanceof Error ? error.message : error));
        lastCleanupAt = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };

  await Promise.all([
    runPeriodicLoop(),
    ...Array.from({ length: workerConcurrency }, () => runJobLoop()),
  ]);
}

main().catch((error) => {
  console.error("worker stopped", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
