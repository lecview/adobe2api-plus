import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import {
  adobeAccount,
  adobeToken,
  entity,
  generationJob,
  mediaAsset,
  proxyNode,
  refreshProfile,
  serviceApiKey,
} from "@/lib/db/schema";
import { eq, and, desc, count, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret, hashToken } from "@/lib/crypto";
import { parseProxyUrl } from "@/lib/proxy-pool";
import { buildReconciliation, type ReconciliationReport, type ResourceStats } from "@/lib/migration/reconciliation";
import { configuredMediaRoot } from "@/lib/media";

export type MigrationReport = { dryRun: boolean; sourceRoot: string; resources: Record<string, ResourceStats>; errors: Array<{ file: string; message: string }>; reconciliation: ReconciliationReport | null };

function emptyReport(dryRun: boolean, sourceRoot: string): MigrationReport { return { dryRun, sourceRoot, resources: {}, errors: [], reconciliation: null }; }
function bucket(report: MigrationReport, name: string) { return (report.resources[name] ??= { created: 0, updated: 0, skipped: 0, rejected: 0 }); }

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function listFiles(root: string, predicate: (file: string) => boolean): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string) {
    let entries: Dirent[] = [];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (predicate(file)) output.push(file);
    }
  }
  await visit(root);
  return output;
}

function cookieFromProfile(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const endpoint = (value as { endpoint?: unknown }).endpoint;
  if (!endpoint || typeof endpoint !== "object") return null;
  const headers = (endpoint as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return null;
  const header = (headers as Record<string, unknown>).Cookie ?? (headers as Record<string, unknown>).cookie;
  return typeof header === "string" && header.trim() ? header : null;
}

function profileExternalId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>).externalAccountId ?? (value as Record<string, unknown>).external_account_id ?? (value as Record<string, unknown>).accountId;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function tokenAccountId(value: string): string {
  const part = value.split(".")[1];
  if (!part) return "";
  try {
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="), "base64").toString("utf8")) as Record<string, unknown>;
    return String(payload.user_id ?? payload.aa_id ?? payload.sub ?? "").trim();
  } catch { return ""; }
}

function tokenValues(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  if (value && typeof value === "object" && Array.isArray((value as { tokens?: unknown }).tokens)) return tokenValues((value as { tokens: unknown }).tokens);
  return [];
}

async function importMedia(report: MigrationReport, sourceRoot: string, dryRun: boolean) {
  const mediaDirectories = [path.join(sourceRoot, "generated"), path.join(sourceRoot, "data", "generated"), path.join(sourceRoot, "static", "generated")];
  const files: string[] = [];
  for (const directory of mediaDirectories) files.push(...await listFiles(directory, (file) => /\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(file)));
  for (const source of files) {
    const stats = bucket(report, "media_assets");
    const fileName = path.basename(source);
    const objectKey = `legacy/${fileName}`;
    const [existing] = await db.select({ id: mediaAsset.id }).from(mediaAsset).where(eq(mediaAsset.objectKey, objectKey)).limit(1);
    if (existing) { stats.skipped += 1; continue; }
    let fileStats: Awaited<ReturnType<typeof stat>>;
    try { fileStats = await stat(source); } catch (error) { stats.rejected += 1; report.errors.push({ file: source, message: String(error) }); continue; }
    if (dryRun) { stats.created += 1; continue; }
    const bytes = await readFile(source);
    const mimeType = /\.mp4$/i.test(source) ? "video/mp4" : /\.webm$/i.test(source) ? "video/webm" : /\.jpe?g$/i.test(source) ? "image/jpeg" : /\.webp$/i.test(source) ? "image/webp" : "image/png";
    const target = path.resolve(await configuredMediaRoot(), objectKey);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      await db.transaction(async (tx) => {
        const jobId = crypto.randomUUID();
        await tx.insert(generationJob).values({
          id: jobId,
          apiPath: "/legacy/import",
          kind: "GENERATION",
          status: "SUCCEEDED",
          requestPayload: { legacy_file: fileName },
          resultPayload: { object_key: objectKey },
          completedAt: new Date(),
        });
        await tx.insert(mediaAsset).values({
          jobId,
          objectKey,
          mimeType,
          byteSize: BigInt(fileStats.size),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      });
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined);
      stats.rejected += 1;
      report.errors.push({ file: source, message: error instanceof Error ? error.message : "media import failed" });
      continue;
    }
    stats.created += 1;
  }
}

async function targetCounts(): Promise<Record<string, number>> {
  const [
    [{ value: serviceApiKeys }],
    [{ value: adobeAccounts }],
    [{ value: adobeTokens }],
    [{ value: refreshProfiles }],
    [{ value: proxyNodes }],
    [{ value: entities }],
    [{ value: mediaAssets }],
  ] = await Promise.all([
    db.select({ value: count() }).from(serviceApiKey),
    db.select({ value: count() }).from(adobeAccount),
    db.select({ value: count() }).from(adobeToken),
    db.select({ value: count() }).from(refreshProfile),
    db.select({ value: count() }).from(proxyNode),
    db.select({ value: count() }).from(entity),
    db.select({ value: count() }).from(mediaAsset),
  ]);
  return { adobe_accounts: adobeAccounts, service_api_keys: serviceApiKeys, adobe_tokens: adobeTokens, refresh_profiles: refreshProfiles, proxy_nodes: proxyNodes, entities, media_assets: mediaAssets };
}

async function relationCounts(): Promise<Record<string, number>> {
  // drizzle mysql2 的 db.execute 返回 [rows, fields] 二维数组，需取第一层才是查询行。
  const [rows] = await db.execute(sql`
    SELECT 'tokens_without_account' AS relation_name, COUNT(*) AS relation_count
      FROM \`adobetoken\` token LEFT JOIN \`adobeaccount\` account ON account.id = token.accountId WHERE account.id IS NULL
    UNION ALL SELECT 'refresh_profiles_without_account', COUNT(*)
      FROM \`refreshprofile\` profile LEFT JOIN \`adobeaccount\` account ON account.id = profile.accountId WHERE account.id IS NULL
    UNION ALL SELECT 'entities_without_account', COUNT(*)
      FROM \`entity\` entity LEFT JOIN \`adobeaccount\` account ON account.id = entity.accountId WHERE account.id IS NULL
    UNION ALL SELECT 'attempts_without_job', COUNT(*)
      FROM \`jobattempt\` attempt LEFT JOIN \`generationjob\` job ON job.id = attempt.jobId WHERE job.id IS NULL
    UNION ALL SELECT 'events_without_job', COUNT(*)
      FROM \`jobevent\` event LEFT JOIN \`generationjob\` job ON job.id = event.jobId WHERE job.id IS NULL
    UNION ALL SELECT 'media_without_job', COUNT(*)
      FROM \`mediaasset\` media LEFT JOIN \`generationjob\` job ON job.id = media.jobId WHERE job.id IS NULL
  `) as unknown as [Array<{ relation_name: string; relation_count: bigint | number }>, unknown];
  return Object.fromEntries(rows.map((row) => [row.relation_name, Number(row.relation_count)]));
}

export async function migrateLegacy(sourceRoot: string, dryRun: boolean): Promise<MigrationReport> {
  const report = emptyReport(dryRun, sourceRoot);
  const targetBefore = await targetCounts();
  const configFile = path.join(sourceRoot, "config", "config.json");
  const tokenFile = path.join(sourceRoot, "config", "tokens.json");
  const refreshFile = path.join(sourceRoot, "config", "refresh_profile.json");
  const legacyConfig = await readJson<Record<string, unknown>>(configFile).catch((error) => { report.errors.push({ file: configFile, message: String(error) }); return null; });
  const tokens = await readJson<unknown>(tokenFile).catch((error) => { report.errors.push({ file: tokenFile, message: String(error) }); return null; });
  const refreshProfileData = await readJson<unknown>(refreshFile).catch((error) => { report.errors.push({ file: refreshFile, message: String(error) }); return null; });

  const apiKey = typeof legacyConfig?.api_key === "string" && legacyConfig.api_key !== "your-api-key" ? legacyConfig.api_key : null;
  if (apiKey) {
    const stats = bucket(report, "service_api_keys");
    const keyHash = hashToken(apiKey);
    const [existing] = await db.select().from(serviceApiKey).where(eq(serviceApiKey.keyHash, keyHash)).limit(1);
    if (existing) stats.skipped += 1;
    else if (dryRun) stats.created += 1;
    else { await db.insert(serviceApiKey).values({ name: "legacy-config", keyHash, prefix: apiKey.slice(0, 12) }); stats.created += 1; }
  }

  for (const token of tokenValues(tokens)) {
    const stats = bucket(report, "adobe_tokens");
    const value = typeof token.value === "string" ? token.value.replace(/^Bearer\s+/i, "").trim() : "";
    if (!value || value.startsWith("YOUR_")) { stats.rejected += 1; continue; }
    const externalId = tokenAccountId(value) || null;
    const displayName = `legacy-${String(token.id ?? externalId ?? stats.created + stats.skipped + 1)}`;
    const [account] = externalId
      ? await db.select().from(adobeAccount).where(eq(adobeAccount.externalId, externalId)).limit(1)
      : await db.select().from(adobeAccount).where(eq(adobeAccount.displayName, displayName)).limit(1);
    const desiredStatus: "ACTIVE" | "REVOKED" = token.status === "active" ? "ACTIVE" : "REVOKED";
    if (!account) {
      const accountStats = bucket(report, "adobe_accounts");
      if (dryRun) stats.created += 1;
      else {
        await db.transaction(async (tx) => {
          const accountId = crypto.randomUUID();
          await tx.insert(adobeAccount).values({ id: accountId, externalId, displayName });
          const tokenId = crypto.randomUUID();
          await tx.insert(adobeToken).values({ id: tokenId, accountId, encryptedAccessToken: encryptSecret(value), status: desiredStatus });
        });
        stats.created += 1;
      }
      accountStats.created += 1;
      continue;
    }
    const [currentToken] = await db.select().from(adobeToken).where(eq(adobeToken.accountId, account.id)).orderBy(desc(adobeToken.updatedAt)).limit(1);
    let sameValue = false;
    try { sameValue = Boolean(currentToken && decryptSecret(currentToken.encryptedAccessToken) === value); } catch { sameValue = false; }
    if (currentToken && sameValue && currentToken.status === desiredStatus) {
      stats.skipped += 1;
    } else if (dryRun) {
      stats.updated += 1;
    } else if (currentToken) {
      await db.update(adobeToken).set({ encryptedAccessToken: encryptSecret(value), status: desiredStatus, expiresAt: null, updatedAt: new Date() }).where(eq(adobeToken.id, currentToken.id));
      stats.updated += 1;
    } else {
      await db.insert(adobeToken).values({ accountId: account.id, encryptedAccessToken: encryptSecret(value), status: desiredStatus });
      stats.created += 1;
    }
  }

  const profiles = refreshProfileData && typeof refreshProfileData === "object" && Array.isArray((refreshProfileData as { profiles?: unknown }).profiles) ? (refreshProfileData as { profiles: unknown[] }).profiles : [refreshProfileData];
  for (const [profileIndex, profile] of profiles.entries()) {
    const cookie = cookieFromProfile(profile);
    if (!cookie) continue;
    const stats = bucket(report, "refresh_profiles");
    const externalId = profileExternalId(profile);
    const displayName = `legacy-refresh-${createHash("sha256").update(cookie, "utf8").digest("hex").slice(0, 16) || profileIndex}`;
    const [account] = externalId
      ? await db.select().from(adobeAccount).where(eq(adobeAccount.externalId, externalId)).limit(1)
      : await db.select().from(adobeAccount).where(eq(adobeAccount.displayName, displayName)).limit(1);
    const existingProfiles = account
      ? await db.select({ id: refreshProfile.id, encryptedCookie: refreshProfile.encryptedCookie, externalAccountId: refreshProfile.externalAccountId }).from(refreshProfile).where(eq(refreshProfile.accountId, account.id))
      : [];
    let sameCookie = false;
    const sameExternal = existingProfiles.find((item) => Boolean(externalId && item.externalAccountId === externalId));
    for (const item of existingProfiles) {
      try {
        if (decryptSecret(item.encryptedCookie) === cookie) { sameCookie = true; break; }
      } catch { /* 损坏的旧密文按需覆盖，不阻塞整批迁移 */ }
    }
    if (sameCookie) stats.skipped += 1;
    else if (dryRun) {
      if (account && sameExternal) stats.updated += 1;
      else stats.created += 1;
    }
    else if (account && sameExternal) {
      await db.update(refreshProfile).set({ encryptedCookie: encryptSecret(cookie), externalAccountId: externalId, updatedAt: new Date() }).where(eq(refreshProfile.id, sameExternal.id));
      stats.updated += 1;
    } else if (account) {
      await db.insert(refreshProfile).values({ accountId: account.id, encryptedCookie: encryptSecret(cookie), externalAccountId: externalId });
      stats.created += 1;
    } else {
      const accountStats = bucket(report, "adobe_accounts");
      await db.transaction(async (tx) => {
        const accountId = crypto.randomUUID();
        await tx.insert(adobeAccount).values({ id: accountId, externalId, displayName });
        await tx.insert(refreshProfile).values({ accountId, encryptedCookie: encryptSecret(cookie), externalAccountId: externalId });
      });
      stats.created += 1;
      accountStats.created += 1;
    }
  }

  const proxyValue = typeof legacyConfig?.proxy === "string" && legacyConfig.use_proxy ? legacyConfig.proxy : "";
  if (proxyValue) {
    const stats = bucket(report, "proxy_nodes");
    try {
      const parsed = parseProxyUrl(proxyValue);
      const [existing] = await db.select().from(proxyNode).where(and(eq(proxyNode.host, parsed.host), eq(proxyNode.port, parsed.port), eq(proxyNode.protocol, parsed.protocol))).limit(1);
      if (existing) stats.skipped += 1;
      else if (dryRun) stats.created += 1;
      else { await db.insert(proxyNode).values({ protocol: parsed.protocol, host: parsed.host, port: parsed.port, displayOrder: 0, encryptedUsername: parsed.username ? encryptSecret(parsed.username) : null, encryptedPassword: parsed.password ? encryptSecret(parsed.password) : null }); stats.created += 1; }
    } catch (error) { stats.rejected += 1; report.errors.push({ file: configFile, message: error instanceof Error ? error.message : "invalid legacy proxy" }); }
  }

  await importMedia(report, sourceRoot, dryRun);
  const targetAfter = await targetCounts();
  report.reconciliation = buildReconciliation({ dryRun, resources: report.resources, targetBefore, targetAfter, relations: await relationCounts() });
  return report;
}
