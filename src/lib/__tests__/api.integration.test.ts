import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { adobeAccount, adobeToken, entity, generationJob, jobAttempt, jobEvent, mediaAsset, refreshProfile, serviceApiKey, systemSetting } from "@/lib/db/schema";
import { createServiceApiKey } from "@/lib/service-auth";
import { encryptSecret } from "@/lib/crypto";
import { DEFAULT_MODEL_ID } from "@/lib/catalog";
import { processOne } from "@/lib/worker/processor";
import { POST as imageGenerations } from "@/app/v1/images/generations/route";
import { POST as chatCompletions } from "@/app/v1/chat/completions/route";
import { DELETE as entitiesDelete, GET as entitiesGet, POST as entitiesPost } from "@/app/v1/entities/route";
import { GET as models } from "@/app/v1/models/route";
import { POST as asyncGenerate } from "@/app/api/v1/generate/route";
import { GET as taskGet } from "@/app/api/v1/generate/[taskId]/route";
import { GET as generatedGet } from "@/app/generated/[...path]/route";

const enabled = process.env.RUN_API_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;

function completeSherlockCookie(label: string): string {
  const value = Buffer.from(JSON.stringify({ sid: `sid-${label}`, ark: `ark-${label}`, bfp: `bfp-${label}`, ftr: `ftr-${label}` })).toString("base64");
  return `sherlockToken=${value}`;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("fake Adobe server did not expose a port"));
      else resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForQueued(apiPath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [{ value }] = await db.select({ value: count() }).from(generationJob).where(and(eq(generationJob.apiPath, apiPath), eq(generationJob.status, "QUEUED")));
    if (Number(value)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${apiPath}`);
}

suite("public API compatibility integration", () => {
  let server: Server;
  let baseUrl = "";
  let mediaRoot = "";
  let apiKey = "";
  const originalKey = process.env.ENCRYPTION_KEY;
  const originalMediaRoot = process.env.MEDIA_ROOT;
  const originalBaseUrl = process.env.ADOBE_BASE_URL;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 6).toString("base64");
    mediaRoot = await mkdtemp("/tmp/adobe2api-plus-api-it-");
    process.env.MEDIA_ROOT = mediaRoot;
    await db.delete(mediaAsset);
    await db.delete(jobEvent);
    await db.delete(jobAttempt);
    await db.delete(generationJob);
    await db.delete(entity);
    await db.delete(refreshProfile);
    await db.delete(adobeToken);
    await db.delete(adobeAccount);
    await db.delete(serviceApiKey);
    await db.insert(systemSetting).values({ id: "singleton", proxyEnabled: false, mediaRoot }).onDuplicateKeyUpdate({ set: { proxyEnabled: false, mediaRoot, updatedAt: new Date() } });
    const accountId = randomUUID();
    const profileId = randomUUID();
    await db.insert(adobeAccount).values({ id: accountId, displayName: "api-integration-account" });
    await db.insert(refreshProfile).values({ id: profileId, accountId, encryptedCookie: encryptSecret(completeSherlockCookie("api-integration")), status: "ACTIVE", enabled: true });
    await db.insert(adobeToken).values({ accountId, refreshProfileId: profileId, encryptedAccessToken: encryptSecret("api-integration-token"), status: "ACTIVE" });
    apiKey = (await createServiceApiKey("api-integration")).key;
    server = createServer(async (request, response) => {
      for await (const chunk of request) { void chunk; }
      const pathname = new URL(request.url ?? "/", "http://fake-adobe.local").pathname;
      if (pathname.endsWith("/generate-async")) {
        response.writeHead(202, { "content-type": "application/json", "x-override-status-link": `${baseUrl}/poll/api-task` });
        response.end(JSON.stringify({ accepted: true }));
        return;
      }
      if (pathname.endsWith("/api/entities/") && request.method === "POST") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "entity-api" }));
        return;
      }
      if (pathname.endsWith("/api/entities/") && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ entities: [] }));
        return;
      }
      if (pathname.includes("/api/entities/") && request.method === "DELETE") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (pathname.endsWith("/index") && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ children: [{ "repo:repositoryId": "repository-api", "repo:state": "ACTIVE" }] }));
        return;
      }
      if (pathname.includes("/composite/component/path") && request.method === "PUT") {
        response.writeHead(200, { "etag": "entity-etag", "resource-length": "3", "content-type": "application/json" });
        response.end(JSON.stringify({ uploaded: true }));
        return;
      }
      if (pathname.includes("/base-resources/") && request.method === "POST") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ registered: true }));
        return;
      }
      if (pathname === "/poll/api-task") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "SUCCEEDED", outputs: [{ image: { presignedUrl: `${baseUrl}/media/api-result` } }] }));
        return;
      }
      if (pathname === "/media/api-result") {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(Buffer.from("api-image"));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const port = await listen(server);
    baseUrl = `http://127.0.0.1:${port}`;
    process.env.ADOBE_BASE_URL = baseUrl;
  });

  afterAll(async () => {
    if (server) await close(server);
    await db.delete(mediaAsset);
    await db.delete(jobEvent);
    await db.delete(jobAttempt);
    await db.delete(generationJob);
    await db.delete(entity);
    await db.delete(refreshProfile);
    await db.delete(adobeToken);
    await db.delete(adobeAccount);
    await db.delete(serviceApiKey);
    await rm(mediaRoot, { recursive: true, force: true });
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
    if (originalMediaRoot === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = originalMediaRoot;
    if (originalBaseUrl === undefined) delete process.env.ADOBE_BASE_URL;
    else process.env.ADOBE_BASE_URL = originalBaseUrl;
  });

  function authorizedRequest(url: string, init: RequestInit = {}) {
    return new Request(url, { ...init, headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) } });
  }

  it("keeps models, synchronous images, media reads and async task queries compatible", async () => {
    const modelResponse = await models(authorizedRequest("http://api.test/v1/models"));
    expect(modelResponse.status).toBe(200);
    expect((await modelResponse.json()).data.some((item: { id: string }) => item.id === DEFAULT_MODEL_ID)).toBe(true);

    const imageRequest = authorizedRequest("http://api.test/v1/images/generations", { method: "POST", body: JSON.stringify({ prompt: "integration image", model: DEFAULT_MODEL_ID }) });
    const imagePromise = imageGenerations(imageRequest);
    await waitForQueued("/v1/images/generations");
    expect(await processOne("api-image-worker")).toBe(true);
    const imageResponse = await imagePromise;
    expect(imageResponse.status).toBe(200);
    const imageBody = await imageResponse.json() as { data: Array<{ url: string }> };
    expect(imageBody.data[0]?.url).toContain("/generated/jobs/");
    const [imageJob] = await db.select({ adobeAccountId: generationJob.adobeAccountId }).from(generationJob).where(eq(generationJob.apiPath, "/v1/images/generations")).orderBy(desc(generationJob.createdAt)).limit(1);
    expect(imageJob?.adobeAccountId).toBeTruthy();
    const mediaUrl = new URL(imageBody.data[0].url);
    const mediaPath = mediaUrl.pathname.slice("/generated/".length).split("/");
    const mediaResponse = await generatedGet(new Request(mediaUrl), { params: Promise.resolve({ path: mediaPath }) });
    expect(mediaResponse.status).toBe(200);
    expect(mediaResponse.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await mediaResponse.arrayBuffer()).toString()).toBe("api-image");

    const asyncResponse = await asyncGenerate(authorizedRequest("http://api.test/api/v1/generate", { method: "POST", body: JSON.stringify({ prompt: "async image", model: DEFAULT_MODEL_ID }) }));
    expect(asyncResponse.status).toBe(202);
    const asyncBody = await asyncResponse.json() as { task_id: string };
    await waitForQueued("/api/v1/generate");
    expect(await processOne("api-async-worker")).toBe(true);
    const taskResponse = await taskGet(authorizedRequest(`http://api.test/api/v1/generate/${asyncBody.task_id}`), { params: Promise.resolve({ taskId: asyncBody.task_id }) });
    expect(taskResponse.status).toBe(200);
    expect((await taskResponse.json()).status).toBe("succeeded");
  });

  it("keeps chat SSE durable and terminates with [DONE]", async () => {
    const streamResponse = await chatCompletions(authorizedRequest("http://api.test/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: DEFAULT_MODEL_ID, prompt: "stream image", stream: true }) }));
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
    await waitForQueued("/v1/chat/completions");
    expect(await processOne("api-sse-worker")).toBe(true);
    const streamBody = await streamResponse.text();
    expect(streamBody).toContain("chat.completion.chunk");
    expect(streamBody).toContain("data: [DONE]");
  });

  it("keeps public entity create/list/delete behavior durable", async () => {
    const image = "data:image/png;base64,cG5n";
    const createPromise = entitiesPost(authorizedRequest("http://api.test/v1/entities", { method: "POST", body: JSON.stringify({ name: "api-entity", type: "character", images: [image] }) }));
    await waitForQueued("/v1/entities");
    expect(await processOne("api-entity-worker")).toBe(true);
    const created = await createPromise;
    const createdBody = await created.json() as { id: string; upstream_id?: string | null };
    expect(created.status, JSON.stringify(createdBody)).toBe(201);
    expect(createdBody.upstream_id).toBe("entity-api");

    const listed = await entitiesGet(authorizedRequest("http://api.test/v1/entities"));
    expect(listed.status).toBe(400);
    expect((await listed.json()).error.code).toBe("entity_sync_required");

    const deletePromise = entitiesDelete(authorizedRequest("http://api.test/v1/entities", { method: "DELETE", body: JSON.stringify({ id: createdBody.id }) }));
    await waitForQueued("/v1/entities");
    expect(await processOne("api-entity-delete-worker")).toBe(true);
    expect((await deletePromise).status).toBe(200);
  });

  it("returns a stable unauthorized response without an API key", async () => {
    const response = await models(new Request("http://api.test/v1/models"));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
  });
});
