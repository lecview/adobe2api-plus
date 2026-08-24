import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { config } from "@/lib/config";
import { AppError } from "@/lib/errors";
import type { AdobeTransport } from "@/lib/adobe/transport";
import type { ProxySnapshotEntry } from "@/lib/proxy-pool";
import { buildImagePayloads, buildVideoPayload } from "@/lib/adobe/payloads";
import type { ImageModel, VideoModel } from "@/lib/catalog";
import type { ImageProviderOptions, VideoProviderOptions } from "@/lib/media-request";

export const ADOBE_ENDPOINTS = {
  imageSubmit: "https://firefly-3p.ff.adobe.io/v2/3p-images/generate-async",
  videoSubmit: "https://firefly-3p.ff.adobe.io/v2/3p-videos/generate-async",
  imageUpload: "https://firefly-3p.ff.adobe.io/v2/storage/image",
  videoUpload: "https://firefly-3p.ff.adobe.io/v2/storage/video",
  audioUpload: "https://firefly-3p.ff.adobe.io/v2/storage/audio",
  entityBase: "https://firefly-entity.adobe.io/api/entities/",
  platformIndex: "https://platform-cs-edge.adobe.io/index",
  platformComponent: "https://platform-cs-va6.adobe.io/composite/component/path",
};

export type AdobeRequestContext = {
  token: string;
  proxy?: ProxySnapshotEntry | null;
  signal?: AbortSignal;
  /**
   * 官网 Sherlock SDK 签发的 x-arp-session-id。
   * 账号选择阶段从该账号绑定的 refreshprofile Cookie 提取；提交阶段必须提供。
   */
  arpSessionId?: string;
};

export type AdobeBinaryBody = Uint8Array | Readable;

function binaryLength(body: AdobeBinaryBody, byteSize?: number): number | undefined {
  return byteSize ?? (body instanceof Uint8Array ? body.byteLength : undefined);
}

/**
 * 使用稳定且内部一致的浏览器提示头。随机切换 UA/OS 会与签发 Sherlock 的
 * 浏览器会话产生不必要的指纹差异，也会污染 408 的判别实验。
 */
export function browserSecurityHeaders(): Record<string, string> {
  const ua = config.adobeUserAgent();
  const version = /Chrome\/(\d+)/.exec(ua)?.[1] ?? "151";
  const platform = /Macintosh/.test(ua) ? '"macOS"' : /Linux/.test(ua) ? '"Linux"' : '"Windows"';
  return {
    "User-Agent": ua,
    // 对齐 fingerprint-chromium 148 实测 Client Hints（品牌顺序与 grease 令牌均按实机数据）
    "sec-ch-ua": `"Chromium";v="${version}", "Google Chrome";v="${version}", "Not/A)Brand";v="99"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": platform,
    "sec-fetch-site": "cross-site", // firefly.adobe.com → firefly-3p.ff.adobe.io 属跨站（对齐官网实测）
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };
}

function binaryHeaders(context: AdobeRequestContext, mimeType: string, byteSize?: number): Record<string, string> {
  const length: Record<string, string> = byteSize === undefined ? {} : { "Content-Length": String(byteSize) };
  return { Authorization: `Bearer ${context.token}`, "x-api-key": config.adobeApiKey(), "Content-Type": mimeType, Accept: "application/json", ...browserSecurityHeaders(), ...length };
}

export type AdobeSubmission = {
  pollUrl: string;
  upstreamTaskId: string;
  raw: Record<string, unknown>;
};

export type AdobePollResult = {
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  progress: number | null;
  outputUrl?: string;
  outputUrls?: string[];
  mimeType?: string;
  mimeTypes?: string[];
  raw: Record<string, unknown>;
};

export class AdobeUpstreamError extends AppError {
  readonly retryable: boolean;
  readonly proxyEligible: boolean;
  readonly upstreamStatus?: number;

  constructor(code: string, message: string, options: { status?: number; retryable?: boolean; proxyEligible?: boolean; details?: unknown } = {}) {
    super(code, message, options.status && options.status >= 400 && options.status < 600 ? options.status : 502, options.details);
    this.retryable = options.retryable ?? false;
    this.proxyEligible = options.proxyEligible ?? false;
    this.upstreamStatus = options.status;
  }

  /** Adobe 真实返回的 HTTP 状态码（upstreamStatus 是错误对象自身的映射状态，可能为 502/503）。 */
  get realUpstreamStatus(): number | undefined {
    const details = this.details && typeof this.details === "object" && !Array.isArray(this.details) ? this.details as Record<string, unknown> : {};
    return typeof details.upstream_status === "number" ? details.upstream_status : this.upstreamStatus;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function submitNonce(token: string, prompt: string): string | undefined {
  const claims = decodeJwtPayload(token);
  const userId = String(claims.user_id ?? claims.aa_id ?? claims.sub ?? "").trim();
  if (!userId || !prompt) return undefined;
  return createHash("sha256").update(`${userId}-${prompt.slice(0, 256)}`, "utf8").digest("hex");
}

function resultLink(headers: Record<string, string>, data: unknown): string {
  const override = headers["x-override-status-link"] || headers["x-override-status-link".toLowerCase()];
  if (override) return override;
  if (data && typeof data === "object") {
    const links = (data as Record<string, unknown>).links;
    const result = links && typeof links === "object" ? (links as Record<string, unknown>).result : undefined;
    if (typeof result === "string") return result;
    if (result && typeof result === "object") return String((result as Record<string, unknown>).href ?? "");
  }
  return "";
}

function jobIdFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.at(-1) ?? "";
  } catch {
    return "";
  }
}

function progressValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(100, value <= 1 ? value * 100 : value));
  if (typeof value === "string") {
    const parsed = Number(value.replace(/%$/, ""));
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed <= 1 ? parsed * 100 : parsed)) : null;
  }
  if (value && typeof value === "object") {
    for (const key of ["progress", "percentage", "percent", "task_progress", "taskProgress", "value"]) {
      const nested = progressValue((value as Record<string, unknown>)[key]);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/** 提取上游响应的排错关键头（不含敏感值）。 */
function upstreamHeaderSummary(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const picked: Record<string, string> = {};
  for (const name of ["x-request-id", "x-task-status", "x-override-status-link", "retry-after", "content-type", "server", "via", "date"]) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (value) picked[name] = value;
  }
  return Object.keys(picked).length ? picked : undefined;
}

function upstreamError(status: number, stage: string, body: unknown, headers?: Record<string, string>): AdobeUpstreamError {
  if (status === 401 || status === 403) {
    const authBody = typeof body === "string" ? body : body && typeof body === "object" ? JSON.stringify(body) : undefined;
    return new AdobeUpstreamError("adobe_auth_failed", "Adobe account authorization failed", { status: 502, details: { stage, upstream_status: status, body: authBody ? authBody.slice(0, 300) : undefined, headers: upstreamHeaderSummary(headers) } });
  }
  const bodyText = typeof body === "string" ? body : JSON.stringify(body ?? "");
  const quotaError = status === 402 || /quota|credit|balance|insufficient|limit\s*exceeded/i.test(bodyText);
  if (status === 429 && !quotaError) return new AdobeUpstreamError("adobe_rate_limited", "Adobe request rate limit reached", { status: 429, retryable: true, proxyEligible: false, details: { stage, upstream_status: status } });
  if (status === 408 && stage.startsWith("submit")) {
    const subtype = body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).error_code === "string"
      ? String((body as Record<string, unknown>).error_code)
      : undefined;
    if (subtype !== "timeout_error") {
      return new AdobeUpstreamError("adobe_upstream_rejected", "Adobe upstream rejected the submission", {
        status: 502,
        retryable: false,
        proxyEligible: false,
        details: {
          stage,
          upstream_status: status,
          subtype,
          response_received: true,
          body: bodyText ? bodyText.slice(0, 300) : undefined,
          headers: upstreamHeaderSummary(headers),
        },
      });
    }
    return new AdobeUpstreamError("adobe_submit_timeout", "Adobe generation service timed out", {
      status: 503,
      retryable: true,
      proxyEligible: false,
      details: {
        stage,
        upstream_status: status,
        subtype,
        response_received: true,
        body: bodyText ? bodyText.slice(0, 300) : undefined,
        headers: upstreamHeaderSummary(headers),
      },
    });
  }
  // 非提交阶段的 408 仍可沿用代理节点重试策略。
  const retryable = !quotaError && (status === 408 || status === 429 || status === 451 || status >= 500);
  if (quotaError) return new AdobeUpstreamError("adobe_quota_exhausted", "Adobe account quota is exhausted", { status: 502, retryable: false, proxyEligible: false, details: { stage, upstream_status: status } });
  return new AdobeUpstreamError(retryable ? "adobe_upstream_temporary" : "adobe_upstream_rejected", retryable ? "Adobe upstream is temporarily unavailable" : "Adobe upstream rejected the request", { status: retryable ? 503 : 502, retryable, proxyEligible: retryable, details: { stage, upstream_status: status, body: bodyText ? bodyText.slice(0, 300) : undefined, headers: upstreamHeaderSummary(headers) } });
}

function endpoint(path: string, overrideBase?: string): string {
  const base = overrideBase ?? config.adobeBaseUrl();
  if (!base) return path;
  const source = new URL(path);
  const target = new URL(base);
  const prefix = target.pathname.replace(/\/$/, "");
  source.protocol = target.protocol;
  source.host = target.host;
  source.pathname = `${prefix}${source.pathname}`.replace(/\/+/g, "/");
  return source.toString();
}

function bodyRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? data as Record<string, unknown> : {};
}

export class AdobeClient {
  constructor(private readonly transport: AdobeTransport, private readonly options: { baseUrl?: string; timeoutMs?: number } = {}) {}

  private endpoint(path: string): string {
    return endpoint(path, this.options.baseUrl);
  }

  private timeoutMs(): number {
    return this.options.timeoutMs ?? config.adobeTimeoutMs();
  }

  private submitHeaders(context: AdobeRequestContext, prompt?: string, video = false): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${context.token}`,
      ...browserSecurityHeaders(),
      "x-api-key": config.adobeApiKey(),
      "Content-Type": "application/json",
      Accept: "*/*",
      Origin: "https://firefly.adobe.com",
      Referer: "https://firefly.adobe.com/",
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (prompt && !video) {
      const nonce = submitNonce(context.token, prompt);
      if (nonce) headers["x-nonce"] = nonce;
    }
    if (!context.arpSessionId) {
      throw new AdobeUpstreamError("adobe_sherlock_unavailable", "Adobe Sherlock session is unavailable", {
        status: 503,
        retryable: true,
        proxyEligible: false,
        details: { stage: "submit", reason: "missing_x_arp_session_id" },
      });
    }
    headers["x-arp-session-id"] = context.arpSessionId;
    return headers;
  }

  private pollHeaders(context: AdobeRequestContext) {
    return { Authorization: `Bearer ${context.token}`, ...browserSecurityHeaders(), Accept: "*/*", Origin: "https://firefly.adobe.com", Referer: "https://firefly.adobe.com/" };
  }

  private entityHeaders(context: AdobeRequestContext) {
    return { Authorization: `Bearer ${context.token}`, "x-api-key": config.adobeApiKey(), "Content-Type": "application/json", Accept: "application/json", ...browserSecurityHeaders() };
  }

  private async json<T>(options: Parameters<AdobeTransport["request"]>[0], stage: string): Promise<T> {
    const response = await this.transport.request<T>(options);
    if (response.status < 200 || response.status >= 300) throw upstreamError(response.status, stage, response.data, response.headers);
    return response.data;
  }

  async uploadImage(context: AdobeRequestContext, body: AdobeBinaryBody, mimeType: string, byteSize?: number) {
    const response = await this.transport.upload<{ images?: Array<{ id?: string }>; id?: string }>(this.endpoint(ADOBE_ENDPOINTS.imageUpload), body, { token: context.token, proxy: context.proxy, signal: context.signal, headers: binaryHeaders(context, mimeType, binaryLength(body, byteSize)) });
    if (response.status < 200 || response.status >= 300) throw upstreamError(response.status, "upload", response.data, response.headers);
    const id = String(response.data?.images?.[0]?.id ?? response.data?.id ?? "");
    if (!id) throw new AdobeUpstreamError("adobe_upload_invalid", "Adobe upload returned no asset ID", { status: 502 });
    return id;
  }

  async uploadVideo(context: AdobeRequestContext, body: AdobeBinaryBody, mimeType: string, byteSize?: number) {
    return this.uploadStorage(context, ADOBE_ENDPOINTS.videoUpload, body, mimeType, "video", byteSize);
  }

  async uploadAudio(context: AdobeRequestContext, body: AdobeBinaryBody, mimeType: string, byteSize?: number) {
    return this.uploadStorage(context, ADOBE_ENDPOINTS.audioUpload, body, mimeType, "audio", byteSize);
  }

  private async uploadStorage(context: AdobeRequestContext, path: string, body: AdobeBinaryBody, mimeType: string, kind: string, byteSize?: number) {
    const response = await this.transport.upload<Record<string, unknown>>(this.endpoint(path), body, { token: context.token, proxy: context.proxy, signal: context.signal, headers: binaryHeaders(context, mimeType, binaryLength(body, byteSize)) });
    if (response.status < 200 || response.status >= 300) throw upstreamError(response.status, `upload_${kind}`, response.data, response.headers);
    const data = bodyRecord(response.data);
    const candidates = [data.id, ...(Array.isArray(data[`${kind}s`]) ? (data[`${kind}s`] as Array<Record<string, unknown>>).map((item) => item.id) : []), ...(Array.isArray(data.assets) ? (data.assets as Array<Record<string, unknown>>).map((item) => item.id) : [])];
    const id = String(candidates.find((value) => value) ?? "");
    if (!id) throw new AdobeUpstreamError("adobe_upload_invalid", `Adobe ${kind} upload returned no asset ID`, { status: 502 });
    return id;
  }

  async submitImage(context: AdobeRequestContext, input: { prompt: string; model: ImageModel; aspectRatio?: string; outputResolution?: string; quality?: string; sourceImageIds?: string[]; maskId?: string; n?: number } & ImageProviderOptions): Promise<AdobeSubmission> {
    let last: unknown;
    for (const payload of buildImagePayloads({ prompt: input.prompt, modelId: input.model.id, aspectRatio: input.aspectRatio, outputResolution: input.outputResolution, quality: input.quality, sourceImageIds: input.sourceImageIds, maskId: input.maskId, n: input.n, background: input.background, output_format: input.output_format, output_compression: input.output_compression, input_fidelity: input.input_fidelity, moderation: input.moderation })) {
      try {
        const response = await this.transport.request<Record<string, unknown>>({ method: "POST", path: this.endpoint(ADOBE_ENDPOINTS.imageSubmit), body: payload, headers: this.submitHeaders(context, input.prompt), token: context.token, proxy: context.proxy, signal: context.signal, timeoutMs: this.timeoutMs() });
        if (response.status >= 200 && response.status < 300) {
          const pollUrl = resultLink(response.headers, response.data);
          if (!pollUrl) throw new AdobeUpstreamError("adobe_submit_invalid", "Adobe submit returned no polling URL", { status: 502 });
          return { pollUrl, upstreamTaskId: jobIdFromUrl(pollUrl), raw: bodyRecord(response.data) };
        }
        last = upstreamError(response.status, "submit", response.data, response.headers);
        if (response.status === 401 || response.status === 403 || response.status < 500 && response.status !== 429 && response.status !== 451) break;
      } catch (error) {
        last = error;
        if (error instanceof AdobeUpstreamError && error.retryable) throw error;
        if (!(error instanceof AdobeUpstreamError) || !error.retryable) break;
      }
    }
    throw last instanceof Error ? last : new AdobeUpstreamError("adobe_submit_failed", "Adobe image submission failed", { status: 502 });
  }

  async submitVideo(context: AdobeRequestContext, input: { prompt: string; model: VideoModel; aspectRatio?: string; duration?: number; resolution?: string; width?: number; height?: number; sourceImageIds?: string[]; sourceVideoIds?: string[]; sourceAudioIds?: string[]; entityRefs?: Array<{ urn?: string; id?: string; mention_id?: string }>; negativePrompt?: string; generateAudio?: boolean; referenceMode?: string; n?: number; seed?: number; fps?: number } & VideoProviderOptions): Promise<AdobeSubmission> {
    const payload = buildVideoPayload({ prompt: input.prompt, model: input.model, aspectRatio: input.aspectRatio, duration: input.duration, resolution: input.resolution, width: input.width, height: input.height, sourceImageIds: input.sourceImageIds, sourceVideoIds: input.sourceVideoIds, sourceAudioIds: input.sourceAudioIds, entityRefs: input.entityRefs, negativePrompt: input.negativePrompt, generateAudio: input.generateAudio, referenceMode: input.referenceMode, n: input.n, seed: input.seed, fps: input.fps, mode: input.mode, cfg_scale: input.cfg_scale, camera_control: input.camera_control, watermark: input.watermark, loop: input.loop, transparent_background: input.transparent_background });
        const response = await this.transport.request<Record<string, unknown>>({ method: "POST", path: this.endpoint(ADOBE_ENDPOINTS.videoSubmit), body: payload, headers: this.submitHeaders(context, undefined, true), token: context.token, proxy: context.proxy, signal: context.signal, timeoutMs: this.timeoutMs() });
    if (response.status < 200 || response.status >= 300) throw upstreamError(response.status, "submit_video", response.data, response.headers);
    const pollUrl = resultLink(response.headers, response.data);
    if (!pollUrl) throw new AdobeUpstreamError("adobe_submit_invalid", "Adobe video submit returned no polling URL", { status: 502 });
    return { pollUrl, upstreamTaskId: jobIdFromUrl(pollUrl), raw: bodyRecord(response.data) };
  }

  async poll(context: AdobeRequestContext, pollUrl: string, kind: "image" | "video"): Promise<AdobePollResult> {
    const response = await this.transport.request<Record<string, unknown>>({ method: "GET", path: pollUrl, headers: this.pollHeaders(context), token: context.token, proxy: context.proxy, signal: context.signal, timeoutMs: this.timeoutMs() });
    if (response.status < 200 || response.status >= 300) throw upstreamError(response.status, "poll", response.data, response.headers);
    const data = bodyRecord(response.data);
    const status = String(data.status ?? response.headers["x-task-status"] ?? "").toUpperCase();
    const progress = progressValue(data.progress ?? data.percentage ?? data.task_progress ?? data.taskProgress ?? data.task ?? data.result ?? data.meta ?? response.headers["x-task-progress"]);
    const outputs = Array.isArray(data.outputs) ? data.outputs : [];
    const mediaResults = outputs.map((output) => {
      const item = output && typeof output === "object" ? output as Record<string, unknown> : {};
      const media = item[kind] && typeof item[kind] === "object" ? item[kind] as Record<string, unknown> : {};
      const url = String(media.presignedUrl ?? media.url ?? item.presignedUrl ?? "");
      return url ? { url, mimeType: kind === "video" ? "video/mp4" : "image/png" } : null;
    }).filter((item): item is { url: string; mimeType: string } => Boolean(item));
    const outputUrl = mediaResults[0]?.url ?? "";
    if (outputUrl) return { status: "SUCCEEDED", progress: 100, outputUrl, outputUrls: mediaResults.map((item) => item.url), mimeType: mediaResults[0]?.mimeType, mimeTypes: mediaResults.map((item) => item.mimeType), raw: data };
    if (["FAILED", "CANCELLED", "ERROR"].includes(status)) return { status: "FAILED", progress, raw: data };
    return { status: "IN_PROGRESS", progress, raw: data };
  }

  async download(context: AdobeRequestContext, outputUrl: string, mimeType: string) {
      const response = await this.transport.download(outputUrl, { proxy: context.proxy, signal: context.signal, timeoutMs: this.timeoutMs(), headers: { Accept: "*/*" } });
    if (response.status < 200 || response.status >= 300) throw upstreamError(response.status, "download", response.data, response.headers);
    return { bytes: new Uint8Array(response.data), mimeType };
  }

  async downloadStream(context: AdobeRequestContext, outputUrl: string, mimeType: string) {
    if (this.transport.downloadStream) {
      const response = await this.transport.downloadStream(outputUrl, { proxy: context.proxy, signal: context.signal, timeoutMs: this.timeoutMs(), headers: { Accept: "*/*" } });
      if (response.status < 200 || response.status >= 300) {
        response.data.destroy();
        throw upstreamError(response.status, "download", "stream_error");
      }
      return { stream: response.data, mimeType };
    }
    const response = await this.download(context, outputUrl, mimeType);
    return { stream: Readable.from([Buffer.from(response.bytes)]), mimeType };
  }

  async createEntity(context: AdobeRequestContext, input: { displayName: string; entityType: string; description?: string }) {
        const response = await this.transport.request<Record<string, unknown>>({ method: "POST", path: this.endpoint(ADOBE_ENDPOINTS.entityBase), body: { entityType: input.entityType, entityValue: { displayName: input.displayName, description: input.description ?? "", metaAttrs: null } }, headers: this.entityHeaders(context), token: context.token, proxy: context.proxy, signal: context.signal, timeoutMs: this.timeoutMs() });
    if (response.status < 200 || response.status >= 300) throw upstreamError(response.status, "entity_create", response.data, response.headers);
    const data = bodyRecord(response.data);
    const id = String(data.id ?? data.urn ?? data.entityId ?? data.entityUrn ?? bodyRecord(data.entity).id ?? "");
    if (!id) throw new AdobeUpstreamError("adobe_entity_invalid", "Adobe entity response has no ID", { status: 502 });
    return { id, raw: data };
  }

  async resolveRepository(context: AdobeRequestContext): Promise<string> {
    const data = bodyRecord(await this.json<Record<string, unknown>>({ method: "GET", path: this.endpoint(ADOBE_ENDPOINTS.platformIndex), headers: { ...this.entityHeaders(context), Accept: "*/*" }, token: context.token, proxy: context.proxy, signal: context.signal, timeoutMs: this.timeoutMs() }, "entity_repository"));
    const candidates: Array<Record<string, unknown>> = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) for (const child of value) visit(child);
      else if (value && typeof value === "object") {
        const item = value as Record<string, unknown>;
        if (item["repo:repositoryId"]) candidates.push(item);
        for (const child of Object.values(item)) visit(child);
      }
    };
    visit(data.children);
    candidates.sort((left, right) => Number(String(right["repo:state"] ?? "").toUpperCase() === "ACTIVE") - Number(String(left["repo:state"] ?? "").toUpperCase() === "ACTIVE"));
    const id = String(candidates[0]?.["repo:repositoryId"] ?? "");
    if (!id) throw new AdobeUpstreamError("adobe_repository_missing", "Adobe repository is unavailable", { status: 502 });
    return id;
  }

  async uploadEntityImage(context: AdobeRequestContext, input: { repository: string; entityName: string; body: AdobeBinaryBody; byteSize?: number; mimeType: string; href?: string }) {
    const componentId = randomUUID();
    let url = input.href ? input.href.split("{", 1)[0] : `${this.endpoint(ADOBE_ENDPOINTS.platformComponent)}/${encodeURIComponent(input.repository)}/appassets/firefly/entities/${encodeURIComponent(input.entityName)}?component_id=${componentId}`;
    if (input.href && !url.includes("component_id=")) url += `${url.includes("?") ? "&" : "?"}component_id=${componentId}`;
    const length = binaryLength(input.body, input.byteSize);
    const response = await this.transport.request<unknown>({ method: "PUT", path: url, body: input.body, headers: { Authorization: `Bearer ${context.token}`, "x-api-key": config.adobeApiKey(), "Content-Type": input.mimeType, Accept: "application/json", ...(length === undefined ? {} : { "Content-Length": String(length) }) }, token: context.token, proxy: context.proxy, signal: context.signal, timeoutMs: this.timeoutMs() });
    if (response.status < 200 || response.status >= 300) throw upstreamError(response.status, "entity_upload", response.data, response.headers);
    const header = (name: string) => response.headers[name.toLowerCase()] ?? "";
    return { component_id: componentId, type: input.mimeType, length: Number(header("resource-length") || header("content-length") || length || 0), etag: header("etag"), version: header("revision") || header("x-revision"), md5: header("content-md5") || header("x-content-md5") };
  }

  async registerEntityResources(context: AdobeRequestContext, entityId: string, components: Array<Record<string, unknown>>) {
    const body = components.map((component, index) => ({ component: { id: component.component_id, type: component.type, length: component.length, etag: component.etag, version: component.version, md5: component.md5 }, ...(index === 0 ? { is_primary: true } : {}) }));
    return this.json<Record<string, unknown>>({ method: "POST", path: this.endpoint(`${ADOBE_ENDPOINTS.entityBase}${encodeURIComponent(entityId)}/base-resources/`), body, headers: this.entityHeaders(context), token: context.token, proxy: context.proxy, signal: context.signal, timeoutMs: this.timeoutMs() }, "entity_register");
  }

  async listEntities(context: AdobeRequestContext, limit = 50) {
    const data = await this.json<unknown>({ method: "GET", path: this.endpoint(`${ADOBE_ENDPOINTS.entityBase}?limit=${Math.max(1, Math.min(100, limit))}`), headers: this.entityHeaders(context), token: context.token, proxy: context.proxy, signal: context.signal, timeoutMs: this.timeoutMs() }, "entity_list");
    if (Array.isArray(data)) return data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
    const record = bodyRecord(data);
    for (const key of ["entities", "items", "data", "results"]) if (Array.isArray(record[key])) return (record[key] as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
    return [];
  }

  async deleteEntity(context: AdobeRequestContext, entityId: string) {
    const response = await this.transport.request<unknown>({ method: "DELETE", path: this.endpoint(`${ADOBE_ENDPOINTS.entityBase}${encodeURIComponent(entityId)}/`), headers: this.entityHeaders(context), token: context.token, proxy: context.proxy, signal: context.signal, timeoutMs: this.timeoutMs() });
    if (![200, 202, 204].includes(response.status)) throw upstreamError(response.status, "entity_delete", response.data, response.headers);
  }
}
