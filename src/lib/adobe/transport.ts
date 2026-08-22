import { fetch as undiciFetch, FormData as UndiciFormData, ProxyAgent, type BodyInit as UndiciBodyInit } from "undici";
import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";
import { Readable } from "node:stream";
import { config } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import type { ProxySnapshotEntry } from "@/lib/proxy-pool";

export type AdobeRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  responseType?: "json" | "arraybuffer" | "text" | "stream";
  timeoutMs?: number;
  token?: string;
  proxy?: ProxySnapshotEntry | null;
  signal?: AbortSignal;
};

export type AdobeUploadBody = Uint8Array | Readable | FormData;

export type AdobeResponse<T = unknown> = { status: number; headers: Record<string, string>; data: T };

export interface AdobeTransport {
  request<T = unknown>(options: AdobeRequestOptions): Promise<AdobeResponse<T>>;
  upload<T = unknown>(path: string, body: AdobeUploadBody, options?: Omit<AdobeRequestOptions, "path" | "body">): Promise<AdobeResponse<T>>;
  download(url: string, options?: Omit<AdobeRequestOptions, "path">): Promise<AdobeResponse<ArrayBuffer>>;
  downloadStream?(url: string, options?: Omit<AdobeRequestOptions, "path">): Promise<AdobeResponse<Readable>>;
}

function proxyUrl(proxy: ProxySnapshotEntry): string {
  const username = proxy.encryptedUsername ? encodeURIComponent(decryptSecret(proxy.encryptedUsername)) : "";
  const password = proxy.encryptedPassword ? encodeURIComponent(decryptSecret(proxy.encryptedPassword)) : "";
  const credentials = username ? `${username}${password ? `:${password}` : ""}@` : "";
  // socks5h 让代理服务器做远端 DNS 解析：本地解析后直接按 IP 连接，部分
  // SOCKS5 服务商（按 IP 白名单/机房路由）会拒绝 HostUnreachable。
  return `${proxy.protocol === "SOCKS5" ? "socks5h" : "http"}://${credentials}${proxy.host}:${proxy.port}`;
}

// undici ProxyAgent 实例按代理串缓存复用，避免每个请求重建连接池。
// 与 gpt-team-management 的 glm-account.ts 保持一致的做法。
const undiciProxyAgents = new Map<string, ProxyAgent>();

function getUndiciProxyAgent(url: string): ProxyAgent {
  const cached = undiciProxyAgents.get(url);
  if (cached) return cached;
  const agent = new ProxyAgent(url);
  undiciProxyAgents.set(url, agent);
  return agent;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function isFormData(body: unknown): boolean {
  return body instanceof UndiciFormData || (typeof FormData !== "undefined" && body instanceof FormData) || Object.prototype.toString.call(body) === "[object FormData]";
}

function isRawBody(body: unknown): boolean {
  if (body === null || body === undefined || typeof body === "string") return true;
  if (Array.isArray(body)) return false;
  if (body instanceof Readable || ArrayBuffer.isView(body) || body instanceof ArrayBuffer) return true;
  if (isFormData(body)) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return true;
  if (typeof body === "object" && body !== null && (Symbol.asyncIterator in body || Symbol.iterator in body)) return true;
  return false;
}

function normalizeRequestBody(body: unknown, headers: Record<string, string>): { body: unknown; headers: Record<string, string> } {
  if (isRawBody(body) || (typeof body !== "object" && !Array.isArray(body))) return { body, headers };
  const normalizedHeaders = hasHeader(headers, "Content-Type") ? headers : { ...headers, "Content-Type": "application/json" };
  return { body: JSON.stringify(body), headers: normalizedHeaders };
}

function toUndiciBody(body: unknown): unknown {
  if (!isFormData(body) || body instanceof UndiciFormData) return body;
  const entries = body && typeof body === "object" && "entries" in body && typeof body.entries === "function" ? body.entries() as Iterable<[string, unknown]> : null;
  if (!entries) return body;
  const form = new UndiciFormData();
  for (const [name, value] of entries) {
    if (typeof value === "string") form.append(name, value);
    else form.append(name, value as Blob);
  }
  return form;
}

// undici 的 ProxyAgent 只支持 HTTP/HTTPS 代理（不支持 SOCKS5）。
// SOCKS5 场景仍走 axios + socks-proxy-agent，其余统一走 undici fetch。
export class FetchAdobeTransport implements AdobeTransport {
  constructor(private readonly baseUrl = config.adobeBaseUrl()) {}

  async request<T = unknown>(options: AdobeRequestOptions): Promise<AdobeResponse<T>> {
    if (!this.baseUrl && !/^https?:\/\//i.test(options.path)) {
      throw new AppError("adobe_transport_not_configured", "ADOBE_BASE_URL is not configured", 503);
    }
    const url = /^https?:\/\//i.test(options.path) ? options.path : new URL(options.path, `${this.baseUrl!.replace(/\/$/, "")}/`).toString();
    if (options.proxy?.protocol === "SOCKS5") return this.socksRequest<T>(options, url);
    return this.undiciRequest<T>(options, url);
  }

  private async undiciRequest<T>(options: AdobeRequestOptions, url: string): Promise<AdobeResponse<T>> {
    const responseType = options.responseType ?? "json";
    const streamingBody = options.body instanceof Readable;
    const timeoutMs = options.timeoutMs ?? config.adobeTimeoutMs();
    const normalized = normalizeRequestBody(options.body, { Accept: "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...options.headers });
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const dispatcher = options.proxy ? getUndiciProxyAgent(proxyUrl(options.proxy)) : undefined;
    try {
      const response = await undiciFetch(url, {
        method: options.method ?? "GET",
        headers: normalized.headers,
        body: normalized.body === undefined || normalized.body === null ? undefined : (toUndiciBody(normalized.body) as unknown as UndiciBodyInit),
        signal,
        ...(dispatcher ? { dispatcher } : {}),
        // 流式上传体不跟随重定向，与 axios 版 maxRedirects: 0 语义一致；
        // 普通请求跟随重定向（axios 默认行为）。
        redirect: streamingBody ? "manual" : "follow",
        // WHATWG fetch 发送流式 body 必须显式声明 duplex，否则抛 TypeError。
        ...(streamingBody ? { duplex: "half" as const } : {}),
      });
      const status = response.status;
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      let data: T;
      if (responseType === "stream") {
        if (!response.body) throw new AppError("adobe_transport_error", "Adobe upstream returned no response body", 503, { kind: "connection" });
        data = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream) as unknown as T;
      } else {
        // undici fetch 与 axios 一样会按 Content-Encoding 自动解压 gzip/deflate，
        // 直接使用响应体即可，不能再手动解压（否则会抛 incorrect header check）。
        const decoded = Buffer.from(await response.arrayBuffer());
        if (responseType === "arraybuffer") {
          data = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as unknown as T;
        } else if (responseType === "text") {
          data = decoded.toString("utf8") as unknown as T;
        } else {
          try {
            data = JSON.parse(decoded.toString("utf8")) as T;
          } catch {
            // 非 JSON 响应按原始文本返回，避免解析失败直接抛错（对齐 axios 的宽松行为）。
            data = decoded.toString("utf8") as unknown as T;
          }
        }
      }
      return { status, headers, data };
    } catch (error) {
      const code = errorCode(error);
      const name = errorName(error);
      const bodyStreamFailure = ["ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED", "ENOENT", "EPIPE"].includes(code);
      // 超时由本地计时器触发；外部取消/网络错误按是否走代理归类，与 axios 版一致。
      const kind = bodyStreamFailure ? "body" : timedOut ? "timeout" : name === "AbortError" || code === "ECONNABORTED" || code === "ETIMEDOUT" ? "timeout" : options.proxy ? "proxy" : "connection";
      throw new AppError("adobe_transport_error", "Adobe upstream transport failed", 503, { kind, retryable: !bodyStreamFailure, proxyEligible: !bodyStreamFailure && (Boolean(options.proxy) || kind !== "connection") });
    } finally {
      clearTimeout(timer);
    }
  }

  // SOCKS5 代理：undici ProxyAgent 不支持，保留 axios + socks-proxy-agent 路径。
  private async socksRequest<T>(options: AdobeRequestOptions, url: string): Promise<AdobeResponse<T>> {
    const agent = new SocksProxyAgent(proxyUrl(options.proxy!));
    const streamingBody = options.body instanceof Readable;
    const normalized = normalizeRequestBody(options.body, { Accept: "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...options.headers });
    const request: AxiosRequestConfig = {
      url,
      method: options.method ?? "GET",
      data: normalized.body,
      headers: normalized.headers,
      timeout: options.timeoutMs ?? config.adobeTimeoutMs(),
      responseType: options.responseType ?? "json",
      signal: options.signal,
      proxy: false,
      maxBodyLength: Infinity,
      ...(streamingBody ? { maxRedirects: 0 } : {}),
      httpAgent: agent,
      httpsAgent: agent,
      validateStatus: () => true,
    };
    let response: AxiosResponse<T>;
    try {
      response = await axios.request<T>(request);
    } catch (error) {
      const code = errorCode(error);
      const bodyStreamFailure = ["ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED", "ENOENT", "EPIPE"].includes(code);
      const kind = bodyStreamFailure ? "body" : code === "ECONNABORTED" || code === "ETIMEDOUT" ? "timeout" : "proxy";
      throw new AppError("adobe_transport_error", "Adobe upstream transport failed", 503, { kind, retryable: !bodyStreamFailure, proxyEligible: !bodyStreamFailure });
    }
    return { status: response.status, headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, String(value)])), data: response.data };
  }

  upload<T = unknown>(path: string, body: AdobeUploadBody, options: Omit<AdobeRequestOptions, "path" | "body"> = {}) {
    const defaultHeaders: Record<string, string> = isFormData(body) ? {} : { "Content-Type": "application/octet-stream" };
    return this.request<T>({ ...options, path, body, method: options.method ?? "POST", headers: { ...defaultHeaders, ...options.headers } });
  }

  download(url: string, options: Omit<AdobeRequestOptions, "path"> = {}) {
    return this.request<ArrayBuffer>({ ...options, path: url, method: "GET", responseType: "arraybuffer" });
  }

  downloadStream(url: string, options: Omit<AdobeRequestOptions, "path"> = {}) {
    return this.request<Readable>({ ...options, path: url, method: "GET", responseType: "stream" });
  }
}

export function createAdobeTransport(): AdobeTransport {
  return new FetchAdobeTransport();
}

export class RecordingAdobeTransport implements AdobeTransport {
  readonly calls: AdobeRequestOptions[] = [];
  constructor(private readonly response: AdobeResponse = { status: 200, headers: {}, data: {} }) {}
  async request<T = unknown>(options: AdobeRequestOptions): Promise<AdobeResponse<T>> {
    this.calls.push(options);
    return this.response as AdobeResponse<T>;
  }
  upload<T = unknown>(path: string, body: AdobeUploadBody, options: Omit<AdobeRequestOptions, "path" | "body"> = {}) {
    return this.request<T>({ ...options, path, body, method: options.method ?? "POST" });
  }
  download(url: string, options: Omit<AdobeRequestOptions, "path"> = {}) {
    return this.request<ArrayBuffer>({ ...options, path: url, method: "GET", responseType: "arraybuffer" });
  }

  downloadStream(url: string, options: Omit<AdobeRequestOptions, "path"> = {}) {
    return this.request<Readable>({ ...options, path: url, method: "GET", responseType: "stream" }).then((response) => {
      const value = response.data as unknown;
      const bytes = value instanceof ArrayBuffer ? Buffer.from(value) : value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
      return { ...response, data: Readable.from([bytes]) };
    });
  }
}
