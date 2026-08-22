import { and, eq, inArray, lt, lte, asc, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { generationJob, loginThrottle, mediaAsset, systemSetting, type JobStatus } from "@/lib/db/schema";
import { removeMedia } from "@/lib/media";
import { getSystemSettings } from "@/lib/system-settings";

export async function cleanupMedia(workerId: string, limit = 100): Promise<number> {
  const settings = await getSystemSettings();
  const now = new Date();
  const claimed = await db.update(systemSetting)
    .set({ cleanupLeaseOwner: workerId, cleanupLeaseExpiresAt: new Date(Date.now() + settings.jobLeaseMs), updatedAt: new Date() })
    .where(and(eq(systemSetting.id, "singleton"), sql`(${systemSetting.cleanupLeaseOwner} is null or ${systemSetting.cleanupLeaseExpiresAt} < ${now})`));
  if (claimed[0].affectedRows !== 1) return 0;
  let removed = 0;
  try {
    await db.delete(loginThrottle).where(lt(loginThrottle.updatedAt, new Date(Date.now() - 24 * 60 * 60 * 1000))).catch(() => undefined);
    const terminalStatuses: JobStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED", "SUBMISSION_UNKNOWN"];
    const expired = await db
      .select({ id: mediaAsset.id, objectKey: mediaAsset.objectKey, byteSize: mediaAsset.byteSize })
      .from(mediaAsset)
      .innerJoin(generationJob, eq(mediaAsset.jobId, generationJob.id))
      .where(and(eq(mediaAsset.status, "READY"), lte(mediaAsset.expiresAt, now), inArray(generationJob.status, terminalStatuses)))
      .orderBy(asc(mediaAsset.createdAt))
      .limit(limit);
    let candidates = expired;
    const [{ totalBytes }] = await db
      .select({ totalBytes: sql<number>`cast(coalesce(sum(${mediaAsset.byteSize}), 0) as signed)` })
      .from(mediaAsset)
      .where(eq(mediaAsset.status, "READY"));
    let total = Number(totalBytes);
    const maxBytes = settings.generatedMaxSizeMb * 1024 * 1024;
    if (total > maxBytes) {
      const additional = await db
        .select({ id: mediaAsset.id, objectKey: mediaAsset.objectKey, byteSize: mediaAsset.byteSize })
        .from(mediaAsset)
        .innerJoin(generationJob, eq(mediaAsset.jobId, generationJob.id))
        .where(and(eq(mediaAsset.status, "READY"), inArray(generationJob.status, terminalStatuses)))
        .orderBy(asc(mediaAsset.createdAt))
        .limit(limit);
      const ids = new Set(candidates.map((item) => item.id));
      candidates = [...candidates, ...additional.filter((item) => !ids.has(item.id))];
    }
    for (const asset of candidates) {
      if (total > maxBytes || expired.some((item) => item.id === asset.id)) {
        try {
          await removeMedia(asset.objectKey);
          const marked = await db.update(mediaAsset)
            .set({ status: "DELETED" })
            .where(and(eq(mediaAsset.id, asset.id), eq(mediaAsset.status, "READY")));
          if (marked[0].affectedRows !== 1) continue;
        } catch {
          // 物理删除失败时保留 READY，下一轮继续重试，避免数据库先标记成功而留下孤儿文件。
          continue;
        }
        total = Math.max(0, total - Number(asset.byteSize));
        removed += 1;
      }
    }
    return removed;
  } finally {
    await db.update(systemSetting)
      .set({ cleanupLeaseOwner: null, cleanupLeaseExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(systemSetting.id, "singleton"), eq(systemSetting.cleanupLeaseOwner, workerId)))
      .catch(() => undefined);
  }
}
