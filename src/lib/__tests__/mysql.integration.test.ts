import { randomUUID } from "node:crypto";
import mariadb from "mariadb";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { adobeAccount, adobeToken, entity, generationJob, jobAttempt, jobEvent, loginThrottle, mediaAsset, proxyNode, proxyRotationState, refreshProfile, systemSetting } from "@/lib/db/schema";
import { allocateProxySnapshot } from "@/lib/proxy-pool";
import { claimRefreshProfile, deleteRefreshProfileWithCookie, persistRefreshSuccess } from "@/lib/adobe/refresh";
import { assertLoginRateLimit, clearLoginFailures, recordLoginFailure } from "@/lib/auth";
import { appendJobEvent, claimNextJob, completeJobWithResult, createJob, recordJobAttempt, transitionJob } from "@/lib/jobs";
import { migrateLegacy } from "@/lib/migration/legacy";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { processJob } from "@/lib/worker/processor";
import type { AdobeRequestOptions, AdobeResponse, AdobeTransport } from "@/lib/adobe/transport";
import type { ProxySnapshot, ProxySnapshotEntry } from "@/lib/proxy-pool";
import { DEFAULT_MODEL_ID } from "@/lib/catalog";
import { REQUIRED_MIGRATION } from "@/lib/schema";

const enabled = process.env.RUN_MYSQL_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;

class ProxyRoutingTransport implements AdobeTransport {
  readonly calls: Array<{ path: string; proxyId: string | null }> = [];

  constructor(private readonly failingProxyIds: Set<string>, private readonly businessFailure = false, private readonly bodyFailureProxyId?: string) {}

  async request<T = unknown>(options: AdobeRequestOptions): Promise<AdobeResponse<T>> {
    const proxyId = options.proxy?.id ?? null;
    this.calls.push({ path: options.path, proxyId });
    if (options.path.includes("generate-async")) {
      if (this.businessFailure) return { status: 400, headers: {}, data: { error: "invalid request" } as T };
      if (proxyId && this.failingProxyIds.has(proxyId)) return { status: 408, headers: {}, data: { error_code: "timeout_error", message: "system under load" } as T };
      return { status: 200, headers: { "x-override-status-link": "https://poll.example.test/task-proxy" }, data: {} as T };
    }
    if (options.path.includes("task-proxy")) return { status: 200, headers: {}, data: { status: "SUCCEEDED", outputs: [{ image: { presignedUrl: "https://cdn.example.test/result.png" } }] } as T };
    return { status: 200, headers: {}, data: {} as T };
  }

  upload<T = unknown>(path: string, body: Uint8Array | FormData, options: Omit<AdobeRequestOptions, "path" | "body"> = {}) {
    if (options.proxy?.id === this.bodyFailureProxyId) return Promise.reject(new AppError("adobe_transport_error", "non-replayable upload body failed", 503, { kind: "body", proxyEligible: false }));
    void body;
    return this.request<T>({ ...options, path, method: options.method ?? "POST" });
  }

  async download(url: string, options: Omit<AdobeRequestOptions, "path"> = {}) {
    const response = await this.request<ArrayBuffer>({ ...options, path: url, method: "GET", responseType: "arraybuffer" });
    return { ...response, data: new Uint8Array(Buffer.from("fake-image")) as unknown as ArrayBuffer };
  }
}

suite("MySQL coordination integration", () => {
  const prefix = `it-${Date.now()}`;
  const orders = [31_000, 31_001, 31_002];
  let legacyRoot = "";
  const originalMediaRoot = process.env.MEDIA_ROOT;
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;

  async function directMysql(query: string): Promise<void> {
    const url = new URL(process.env.DATABASE_URL ?? "");
    const rootPassword = process.env.MYSQL_ROOT_PASSWORD;
    const connection = await mariadb.createConnection({ host: url.hostname, port: Number(url.port || 3306), user: rootPassword ? "root" : decodeURIComponent(url.username), password: rootPassword ?? decodeURIComponent(url.password), database: url.pathname.slice(1), allowPublicKeyRetrieval: true });
    try { await connection.query(query); } finally { await connection.end(); }
  }

  async function clearTables() {
    await db.delete(mediaAsset);
    await db.delete(jobEvent);
    await db.delete(jobAttempt);
    await db.delete(loginThrottle);
    await db.delete(generationJob);
    await db.delete(entity);
    await db.delete(refreshProfile);
    await db.delete(adobeToken);
    await db.delete(adobeAccount);
    await db.delete(proxyNode);
    await db.delete(proxyRotationState);
    await db.delete(systemSetting);
  }

  async function insertGenerationAccount(accountId: string, displayName: string, token: string): Promise<void> {
    const profileId = randomUUID();
    const sherlock = Buffer.from(JSON.stringify({ sid: `sid-${accountId}`, ark: `ark-${accountId}`, bfp: `bfp-${accountId}`, ftr: `ftr-${accountId}` })).toString("base64");
    await db.insert(adobeAccount).values({ id: accountId, displayName });
    await db.insert(refreshProfile).values({ id: profileId, accountId, encryptedCookie: encryptSecret(`sherlockToken=${sherlock}`), status: "ACTIVE", enabled: true });
    await db.insert(adobeToken).values({ accountId, refreshProfileId: profileId, encryptedAccessToken: encryptSecret(token), status: "ACTIVE" });
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
    legacyRoot = await mkdtemp(`/tmp/adobe2api-plus-legacy-${prefix}-`);
    await mkdir(path.join(legacyRoot, "config"), { recursive: true });
    await mkdir(path.join(legacyRoot, "data", "generated"), { recursive: true });
    const token = `header.${Buffer.from(JSON.stringify({ sub: `${prefix}-account` })).toString("base64url")}.signature`;
    await writeFile(path.join(legacyRoot, "config", "config.json"), JSON.stringify({ api_key: `${prefix}-api-key`, use_proxy: false }));
    await writeFile(path.join(legacyRoot, "config", "tokens.json"), JSON.stringify({ tokens: [{ id: `${prefix}-token`, value: token, status: "active" }] }));
    await writeFile(path.join(legacyRoot, "config", "refresh_profile.json"), JSON.stringify({ profiles: [{ externalAccountId: `${prefix}-account`, endpoint: { headers: { Cookie: `${prefix}=cookie` } } }] }));
    await writeFile(path.join(legacyRoot, "config", "entities.json"), JSON.stringify([{ name: `${prefix}-entity`, type: "character", externalId: `${prefix}-account` }]));
    await writeFile(path.join(legacyRoot, "requests.jsonl"), `${JSON.stringify({ request_id: `${prefix}-request`, path: "/v1/models", method: "GET", status_code: 200 })}\n`);
    await writeFile(path.join(legacyRoot, "requests.ndjson"), "{broken-json\n");
    await writeFile(path.join(legacyRoot, "data", "generated", `${prefix}.png`), Buffer.from("png-fixture"));
    process.env.MEDIA_ROOT = path.join(legacyRoot, "target-media");

    await clearTables();
  });

  afterAll(async () => {
    await clearTables();
    if (legacyRoot) await rm(legacyRoot, { recursive: true, force: true });
    if (originalMediaRoot === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = originalMediaRoot;
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalEncryptionKey;
  });

  it("applies the expected migration and keeps the migration row stable", async () => {
    const rows = (await db.execute(sql`SELECT migration_name, finished_at, rolled_back_at FROM \`_prisma_migrations\` WHERE migration_name = ${REQUIRED_MIGRATION}`))[0] as unknown as Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.finished_at).toBeTruthy();
    expect(rows[0]?.rolled_back_at).toBeNull();
  });

  it("allocates the persisted proxy cursor exactly once per concurrent transaction", async () => {
    await db.insert(systemSetting).values({ id: "singleton", proxyEnabled: true, mediaRoot: process.env.MEDIA_ROOT ?? "./data/generated" });
    await db.insert(proxyNode).values(orders.map((displayOrder, index) => ({ protocol: "HTTP" as const, host: `proxy-${index}.example.test`, port: 8_000 + index, displayOrder })));
    await db.insert(proxyRotationState).values({ id: "singleton", nextOrder: orders[0] });

    const snapshots = await Promise.all(Array.from({ length: 6 }, () => allocateProxySnapshot()));
    const firstIds = snapshots.map((snapshot) => snapshot.entries[0]?.id);
    expect(firstIds.every(Boolean)).toBe(true);
    expect(new Set(firstIds).size).toBe(3);
    expect(firstIds).toEqual(expect.arrayContaining([expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(String), expect.any(String)]));
    for (const id of new Set(firstIds)) expect(firstIds.filter((value) => value === id).length).toBe(2);
  });

  it("keeps a task sticky, switches in order, and never falls back to direct", async () => {
    const nodes = await db.select().from(proxyNode).where(inArray(proxyNode.displayOrder, orders)).orderBy(proxyNode.displayOrder);
    const snapshot: ProxySnapshot = { mode: "proxy", selectedIndex: 0, entries: nodes.map((node): ProxySnapshotEntry => ({ id: node.id, version: node.version, protocol: node.protocol, host: node.host, port: node.port, encryptedUsername: node.encryptedUsername, encryptedPassword: node.encryptedPassword })) };
    const accountId = randomUUID();
    await insertGenerationAccount(accountId, `${prefix}-routing`, `${prefix}-token`);
    const fake = new ProxyRoutingTransport(new Set([nodes[0].id]));
    const job = await createJob({ apiPath: "/integration/routing", model: DEFAULT_MODEL_ID, adobeAccountId: accountId, requestPayload: { prompt: "routing test", model: DEFAULT_MODEL_ID, resolved_aspect_ratio: "16:9", resolved_output_resolution: "2K" }, proxySnapshot: snapshot });
    expect(await claimNextJob(`${prefix}-routing-worker`)).toMatchObject({ id: job.id });
    await processJob(job.id, `${prefix}-routing-worker`, { transport: fake });
    const [stored] = await db.select().from(generationJob).where(eq(generationJob.id, job.id)).limit(1);
    const attempts = await db.select().from(jobAttempt).where(eq(jobAttempt.jobId, job.id));
    expect(stored?.status, stored?.errorMessage ?? "no error").toBe("SUCCEEDED");
    const submitCalls = fake.calls.filter((call) => call.path.includes("generate-async"));
    expect(submitCalls.map((call) => call.proxyId)).toEqual([nodes[0].id, nodes[0].id, nodes[1].id]);
    expect(fake.calls.every((call) => call.proxyId !== null)).toBe(true);
    expect(attempts.some((attempt) => attempt.proxyId === nodes[1].id)).toBe(true);
  });

  it("does not switch proxies after a non-replayable upload body failure", async () => {
    const nodes = await db.select().from(proxyNode).where(inArray(proxyNode.displayOrder, orders)).orderBy(proxyNode.displayOrder);
    const snapshot: ProxySnapshot = { mode: "proxy", selectedIndex: 0, entries: nodes.map((node): ProxySnapshotEntry => ({ id: node.id, version: node.version, protocol: node.protocol, host: node.host, port: node.port, encryptedUsername: node.encryptedUsername, encryptedPassword: node.encryptedPassword })) };
    const accountId = randomUUID();
    await insertGenerationAccount(accountId, `${prefix}-body-failure`, `${prefix}-body-token`);
    const fake = new ProxyRoutingTransport(new Set(), false, nodes[0].id);
    const job = await createJob({ apiPath: "/integration/body-failure", model: DEFAULT_MODEL_ID, adobeAccountId: accountId, requestPayload: { prompt: "body failure", model: DEFAULT_MODEL_ID, images: ["data:image/png;base64,cG5n"] }, proxySnapshot: snapshot });
    expect(await claimNextJob(`${prefix}-body-failure-worker`)).toMatchObject({ id: job.id });
    await processJob(job.id, `${prefix}-body-failure-worker`, { transport: fake });
    const [stored] = await db.select().from(generationJob).where(eq(generationJob.id, job.id)).limit(1);
    expect(stored?.status).toBe("FAILED");
    const attempts = await db.select().from(jobAttempt).where(eq(jobAttempt.jobId, job.id)).orderBy(jobAttempt.attemptNumber);
    expect(attempts.map((attempt) => attempt.proxyId)).toEqual([nodes[0].id]);
  });

  it("does not replay an explicit-account submit timeout or a business error", async () => {
    const nodes = await db.select().from(proxyNode).where(inArray(proxyNode.displayOrder, orders)).orderBy(proxyNode.displayOrder);
    const snapshot: ProxySnapshot = { mode: "proxy", selectedIndex: 0, entries: nodes.map((node): ProxySnapshotEntry => ({ id: node.id, version: node.version, protocol: node.protocol, host: node.host, port: node.port, encryptedUsername: node.encryptedUsername, encryptedPassword: node.encryptedPassword })) };
    const accountId = randomUUID();
    await insertGenerationAccount(accountId, `${prefix}-exhausted`, `${prefix}-token-exhausted`);
    const exhausted = new ProxyRoutingTransport(new Set(nodes.map((node) => node.id)));
    const exhaustedJob = await createJob({ apiPath: "/integration/exhausted", model: DEFAULT_MODEL_ID, adobeAccountId: accountId, requestPayload: { prompt: "exhausted", model: DEFAULT_MODEL_ID }, proxySnapshot: snapshot });
    expect(await claimNextJob(`${prefix}-exhausted-worker`)).toMatchObject({ id: exhaustedJob.id });
    await processJob(exhaustedJob.id, `${prefix}-exhausted-worker`, { transport: exhausted });
    const [exhaustedStored] = await db.select().from(generationJob).where(eq(generationJob.id, exhaustedJob.id)).limit(1);
    expect(exhaustedStored?.status, exhaustedStored?.errorMessage ?? "no error").toBe("FAILED");
    expect(exhaustedStored?.errorCode).toBe("adobe_submit_timeout");
    expect(exhausted.calls.map((call) => call.proxyId)).toEqual([nodes[0].id]);
    expect(exhausted.calls.every((call) => call.proxyId !== null)).toBe(true);

    const business = new ProxyRoutingTransport(new Set(), true);
    const businessJob = await createJob({ apiPath: "/integration/business-error", model: DEFAULT_MODEL_ID, adobeAccountId: accountId, requestPayload: { prompt: "business", model: DEFAULT_MODEL_ID }, proxySnapshot: snapshot });
    expect(await claimNextJob(`${prefix}-business-worker`)).toMatchObject({ id: businessJob.id });
    await processJob(businessJob.id, `${prefix}-business-worker`, { transport: business });
    const [businessStored] = await db.select().from(generationJob).where(eq(generationJob.id, businessJob.id)).limit(1);
    expect(businessStored?.status).toBe("FAILED");
    expect(business.calls.map((call) => call.proxyId)).toEqual([nodes[0].id]);
  });

  it("keeps legacy dry-run read-only and reports repeat-import reconciliation", async () => {
    const countResource = async () => {
      const [a] = await db.select({ value: count() }).from(adobeAccount);
      const [m] = await db.select({ value: count() }).from(mediaAsset);
      return { accounts: Number(a.value), media: Number(m.value) };
    };
    const before = await countResource();
    const dryRun = await migrateLegacy(legacyRoot, true);
    const afterDryRun = await countResource();
    expect(afterDryRun).toEqual(before);
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.reconciliation?.mismatches).toHaveLength(0);

    const first = await migrateLegacy(legacyRoot, false);
    expect(first.errors).toHaveLength(0);
    expect(first.reconciliation?.mismatches).toHaveLength(0);
    expect(first.reconciliation?.relations).toMatchObject({ tokens_without_account: 0, refresh_profiles_without_account: 0, entities_without_account: 0, attempts_without_job: 0, events_without_job: 0, media_without_job: 0 });

    const rotatedToken = `header.${Buffer.from(JSON.stringify({ sub: `${prefix}-account` })).toString("base64url")}.rotated`;
    await writeFile(path.join(legacyRoot, "config", "tokens.json"), JSON.stringify({ tokens: [{ id: `${prefix}-token`, value: rotatedToken, status: "active" }] }));
    await writeFile(path.join(legacyRoot, "config", "refresh_profile.json"), JSON.stringify({ profiles: [{ externalAccountId: `${prefix}-account`, endpoint: { headers: { Cookie: `${prefix}=cookie-v2` } } }] }));
    const updated = await migrateLegacy(legacyRoot, false);
    expect(updated.resources.adobe_tokens?.updated).toBe(1);
    expect(updated.resources.refresh_profiles?.updated).toBe(1);

    const rollbackSource = path.join(legacyRoot, "data", "generated", "rollback.png");
    await writeFile(rollbackSource, Buffer.from("rollback-fixture"));
    await directMysql("DROP TRIGGER IF EXISTS `adobe2api_plus_it_media_fail`");
    await directMysql("CREATE TRIGGER `adobe2api_plus_it_media_fail` BEFORE INSERT ON `MediaAsset` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced rollback'");
    const [jobCountBefore] = await db.select({ value: count() }).from(generationJob);
    const jobsBeforeRollback = Number(jobCountBefore.value);
    try {
      const rollback = await migrateLegacy(legacyRoot, false);
      expect(rollback.errors.some((error) => error.file.endsWith("rollback.png"))).toBe(true);
      const [jobCountAfter] = await db.select({ value: count() }).from(generationJob);
      expect(Number(jobCountAfter.value)).toBe(jobsBeforeRollback);
      await expect(stat(path.join(legacyRoot, "target-media", "legacy", "rollback.png"))).rejects.toThrow();
    } finally {
      await directMysql("DROP TRIGGER IF EXISTS `adobe2api_plus_it_media_fail`");
      await rm(rollbackSource, { force: true });
    }

    const [accountCountRow] = await db.select({ value: count() }).from(adobeAccount);
    const [mediaCountRow] = await db.select({ value: count() }).from(mediaAsset);
    const accountCount = Number(accountCountRow.value);
    const mediaCount = Number(mediaCountRow.value);
    const second = await migrateLegacy(legacyRoot, false);
    expect(second.reconciliation?.mismatches).toHaveLength(0);
    const [accountAfter] = await db.select({ value: count() }).from(adobeAccount);
    const [mediaAfter] = await db.select({ value: count() }).from(mediaAsset);
    expect(Number(accountAfter.value)).toBe(accountCount);
    expect(Number(mediaAfter.value)).toBe(mediaCount);
    expect(await readFile(path.join(legacyRoot, "data", "generated", `${prefix}.png`))).toEqual(Buffer.from("png-fixture"));
  });

  it("allows only one worker to claim a queued job", async () => {
    const job = await createJob({ apiPath: "/integration/claim", requestPayload: { prefix } });
    const claims = await Promise.all([claimNextJob(`${prefix}-a`), claimNextJob(`${prefix}-b`)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.id).toBe(job.id);
  });

  it("reclaims a queued job when a worker dies before its first transition", async () => {
    const job = await createJob({ apiPath: "/integration/queued-reclaim", requestPayload: { prefix } });
    expect((await claimNextJob(`${prefix}-crashed`))?.id).toBe(job.id);
    await db.update(generationJob).set({ leaseExpiresAt: new Date(Date.now() - 1_000), updatedAt: new Date() }).where(eq(generationJob.id, job.id));
    expect((await claimNextJob(`${prefix}-reclaimer`))?.id).toBe(job.id);
  });

  it("blocks every stale worker write after reclaim and allows the new lease owner", async () => {
    const oldWorker = `${prefix}-stale-writer`;
    const newWorker = `${prefix}-current-writer`;
    const job = await createJob({ apiPath: "/integration/lease-cas", requestPayload: { prefix } });
    expect((await claimNextJob(oldWorker))?.id).toBe(job.id);
    await db.update(generationJob).set({ leaseExpiresAt: new Date(Date.now() - 1_000), updatedAt: new Date() }).where(eq(generationJob.id, job.id));
    expect((await claimNextJob(newWorker))?.id).toBe(job.id);

    await expect(transitionJob(job.id, "UPLOADING", {}, oldWorker)).rejects.toMatchObject({ code: "job_lease_lost" });
    await expect(appendJobEvent(job.id, "STALE_EVENT", undefined, oldWorker)).rejects.toMatchObject({ code: "job_lease_lost" });
    await expect(recordJobAttempt({ jobId: job.id, stage: "UPLOAD", workerId: oldWorker })).rejects.toMatchObject({ code: "job_lease_lost" });

    await transitionJob(job.id, "UPLOADING", {}, newWorker);
    await appendJobEvent(job.id, "CURRENT_EVENT", undefined, newWorker);
    await expect(recordJobAttempt({ jobId: job.id, stage: "UPLOAD", workerId: newWorker })).resolves.toBeTruthy();
    await transitionJob(job.id, "SUBMITTING", {}, newWorker);
    await transitionJob(job.id, "POLLING", {}, newWorker);
    await transitionJob(job.id, "DOWNLOADING", {}, newWorker);
    await expect(completeJobWithResult(job.id, { result: "current-worker" }, newWorker)).resolves.toBeTruthy();
    const [stored] = await db.select().from(generationJob).where(eq(generationJob.id, job.id)).limit(1);
    expect(stored?.status).toBe("SUCCEEDED");
  });

  it("leaves submission-unknown jobs for manual review instead of reclaiming them forever", async () => {
    const job = await createJob({ apiPath: "/integration/manual-review", requestPayload: { prefix } });
    await transitionJob(job.id, "UPLOADING");
    await transitionJob(job.id, "SUBMITTING");
    await transitionJob(job.id, "SUBMISSION_UNKNOWN", { errorCode: "submission_unknown", errorMessage: "Adobe submission outcome is unknown" });
    await db.update(generationJob).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() }).where(eq(generationJob.id, job.id));
    expect(await claimNextJob(`${prefix}-manual-review`)).toBeNull();
  });

  it("locks refresh leases and prevents duplicate ownership", async () => {
    const accountId = randomUUID();
    await db.insert(adobeAccount).values({ id: accountId, displayName: `${prefix}-account` });
    const profileId = randomUUID();
    await db.insert(refreshProfile).values({ id: profileId, accountId, encryptedCookie: "v1:placeholder" });
    const claims = await Promise.all([claimRefreshProfile(profileId, `${prefix}-a`), claimRefreshProfile(profileId, `${prefix}-b`)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await db.update(refreshProfile).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() }).where(eq(refreshProfile.id, profileId));
  });

  it("rolls back stale refresh-owner token writes after a lease is reclaimed", async () => {
    const accountId = randomUUID();
    await db.insert(adobeAccount).values({ id: accountId, displayName: `${prefix}-refresh-cas-account` });
    const profileId = randomUUID();
    await db.insert(refreshProfile).values({ id: profileId, accountId, encryptedCookie: "v1:placeholder" });
    const oldWorker = `${prefix}-refresh-old`;
    const newWorker = `${prefix}-refresh-new`;
    try {
      expect((await claimRefreshProfile(profileId, oldWorker))?.id).toBe(profileId);
      await db.update(refreshProfile).set({ leaseExpiresAt: new Date(Date.now() - 1_000), updatedAt: new Date() }).where(eq(refreshProfile.id, profileId));
      expect((await claimRefreshProfile(profileId, newWorker))?.leaseOwner).toBe(newWorker);

      await expect(persistRefreshSuccess({ profileId, workerId: oldWorker, accessToken: `${prefix}-stale-token`, expiresAt: new Date(Date.now() + 3_600_000) })).rejects.toMatchObject({ code: "refresh_lease_lost" });
      const [tokenCount] = await db.select({ value: count() }).from(adobeToken).where(eq(adobeToken.accountId, accountId));
      expect(Number(tokenCount.value)).toBe(0);
      const [profile] = await db.select().from(refreshProfile).where(eq(refreshProfile.id, profileId)).limit(1);
      expect(profile?.leaseOwner).toBe(newWorker);

      await persistRefreshSuccess({ profileId, workerId: newWorker, accessToken: `${prefix}-current-token`, expiresAt: new Date(Date.now() + 3_600_000) });
      const [token] = await db.select().from(adobeToken).where(eq(adobeToken.accountId, accountId)).limit(1);
      expect(decryptSecret(token?.encryptedAccessToken ?? "")).toBe(`${prefix}-current-token`);
      const [profileAfter] = await db.select().from(refreshProfile).where(eq(refreshProfile.id, profileId)).limit(1);
      expect(profileAfter?.leaseOwner).toBeNull();
    } finally {
      await db.delete(refreshProfile).where(eq(refreshProfile.id, profileId));
      await db.delete(adobeToken).where(eq(adobeToken.accountId, accountId));
      await db.delete(adobeAccount).where(eq(adobeAccount.id, accountId));
    }
  });

  it("deletes an expired-cookie refresh profile, unbinds its token but keeps the token usable", async () => {
    const accountId = randomUUID();
    await db.insert(adobeAccount).values({ id: accountId, displayName: `${prefix}-cookie-expired-account` });
    const profileId = randomUUID();
    await db.insert(refreshProfile).values({ id: profileId, accountId, encryptedCookie: "v1:placeholder", status: "ACTIVE", enabled: true });
    const tokenId = randomUUID();
    await db.insert(adobeToken).values({ id: tokenId, accountId, refreshProfileId: profileId, encryptedAccessToken: encryptSecret("v1:placeholder-token"), status: "ACTIVE", autoRefreshEnabled: true });
    try {
      await deleteRefreshProfileWithCookie(profileId, accountId, "Adobe refresh returned HTTP 401：Cookie 已失效");

      const [profileCount] = await db.select({ value: count() }).from(refreshProfile).where(eq(refreshProfile.id, profileId));
      expect(Number(profileCount.value)).toBe(0);
      const [token] = await db.select().from(adobeToken).where(eq(adobeToken.id, tokenId)).limit(1);
      expect(token?.refreshProfileId).toBeNull();
      expect(token?.autoRefreshEnabled).toBe(false);
      // cookie 失效不代表 access token 失效：token 自身状态保持不变，仍可继续用于生成
      expect(token?.status).toBe("ACTIVE");
      expect(token?.lastError).toContain("401");
      const [account] = await db.select().from(adobeAccount).where(eq(adobeAccount.id, accountId)).limit(1);
      expect(account?.lastRefreshError).toContain("401");
    } finally {
      await db.delete(refreshProfile).where(eq(refreshProfile.id, profileId));
      await db.delete(adobeToken).where(eq(adobeToken.id, tokenId));
      await db.delete(adobeAccount).where(eq(adobeAccount.id, accountId));
    }
  });

  it("coordinates login failure throttling in MySQL and clears it after success", async () => {
    const key = `${prefix}-login:admin`;
    await clearLoginFailures(key);
    for (let index = 0; index < 10; index += 1) await recordLoginFailure(key);
    await expect(assertLoginRateLimit(key)).resolves.toBeUndefined();
    await recordLoginFailure(key);
    await expect(assertLoginRateLimit(key)).rejects.toMatchObject({ code: "rate_limited" });
    await clearLoginFailures(key);
    await expect(assertLoginRateLimit(key)).resolves.toBeUndefined();
  });

  it("writes terminal state and event atomically and rejects a submit rollback", async () => {
    const job = await createJob({ apiPath: "/integration/terminal", requestPayload: { prefix } });
    await transitionJob(job.id, "UPLOADING");
    await transitionJob(job.id, "SUBMITTING");
    await transitionJob(job.id, "POLLING", { upstreamTaskId: `${prefix}-upstream`, upstreamPollUrl: "https://upstream.example.test/poll" });
    await expect(transitionJob(job.id, "SUBMITTING")).rejects.toMatchObject({ code: "invalid_job_transition" });
    await transitionJob(job.id, "DOWNLOADING");
    await completeJobWithResult(job.id, { upstream_task_id: `${prefix}-upstream`, result: "ok" });
    const [stored] = await db.select().from(generationJob).where(eq(generationJob.id, job.id)).limit(1);
    const events = await db.select().from(jobEvent).where(eq(jobEvent.jobId, job.id)).orderBy(jobEvent.sequence);
    expect(stored?.status).toBe("SUCCEEDED");
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("serializes attempt numbers per stage", async () => {
    const job = await createJob({ apiPath: "/integration/attempts", requestPayload: { prefix } });
    const attempts = await Promise.all([1, 2, 3].map(() => recordJobAttempt({ jobId: job.id, stage: "UPLOAD" })));
    expect(attempts.map((attempt) => attempt.attemptNumber).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    await db.update(jobAttempt).set({ status: "SUCCEEDED" }).where(eq(jobAttempt.jobId, job.id));
  });
});
