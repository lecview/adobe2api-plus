import axios from "axios";
import dns from "node:dns/promises";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { AppError } from "@/lib/errors";
import { assertSafeRemoteUrl, isPrivateAddress } from "@/lib/ssrf";
import { cleanupRemoteMedia, downloadRemoteMedia } from "@/lib/ssrf";
import { cleanupReferenceSources, closeReferenceMedia, extractReferenceSources, loadReferenceSources, openReferenceMedia } from "@/lib/adobe/input";
import { validateReferenceUrls } from "@/lib/gateway";

describe("remote media safety", () => {
  const proxyEntry = (protocol: "HTTP" | "SOCKS5") => ({ id: `proxy-${protocol.toLowerCase()}`, version: 1, protocol, host: "proxy.example.test", port: protocol === "HTTP" ? 8080 : 1080, encryptedUsername: null, encryptedPassword: null });

  it("blocks private and metadata address ranges", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("168.63.129.16")).toBe(true);
    expect(isPrivateAddress("[::1]")).toBe(true);
    expect(isPrivateAddress("[::ffff:7f00:1]")).toBe(true);
    expect(isPrivateAddress("[::ffff:192.168.1.10]")).toBe(true);
    expect(isPrivateAddress("192.0.2.10")).toBe(true);
    expect(isPrivateAddress("198.51.100.10")).toBe(true);
    expect(isPrivateAddress("203.0.113.10")).toBe(true);
    expect(isPrivateAddress("2001:db8::10")).toBe(true);
    expect(isPrivateAddress("fc00::10")).toBe(true);
    expect(isPrivateAddress("fc00:0000:0000:0000:0000:0000:0000:0010")).toBe(true);
    expect(isPrivateAddress("2001:4860:4860:0000:0000:0000:0000:8888")).toBe(false);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("rejects credentials and unsupported protocols", async () => {
    await expect(assertSafeRemoteUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertSafeRemoteUrl("https://user:pass@example.com/a.png")).rejects.toThrow();
    await expect(assertSafeRemoteUrl("http://[::ffff:127.0.0.1]/image.png")).rejects.toMatchObject({ code: "blocked_media_url" });
    const lookup = vi.spyOn(dns, "lookup").mockRejectedValue(new Error("ENOTFOUND"));
    try {
      await expect(assertSafeRemoteUrl("https://unresolvable.fixture/image.png")).rejects.toMatchObject({ code: "blocked_media_url" });
    } finally {
      lookup.mockRestore();
    }
  });

  it("rejects oversized inline media before enqueue", async () => {
    await expect(validateReferenceUrls({ image_url: `data:image/png;base64,${"A".repeat(41 * 1024 * 1024)}` }, 1)).rejects.toMatchObject({ code: "media_too_large" });
  });

  it("validates inline media MIME types and base64 before enqueue", async () => {
    await expect(validateReferenceUrls({ image_url: "data:text/html;base64,PGh0bWw+" }, 1)).rejects.toMatchObject({ code: "invalid_media_type" });
    await expect(validateReferenceUrls({ image_url: "data:image/png;base64,not-valid%%%" }, 1)).rejects.toMatchObject({ code: "invalid_media_url" });
    await expect(validateReferenceUrls({ image_url: "data:image/png;base64,cG5n" }, 1)).resolves.toBeUndefined();
  });

  it.each([
    { kind: "image" as const, mime: "image/png", expected: "image/png" },
    { kind: "image" as const, mime: "image/jpeg", expected: "image/jpeg" },
    { kind: "image" as const, mime: "image/webp", expected: "image/webp" },
    { kind: "image" as const, mime: "image/gif", expected: "image/gif" },
    { kind: "video" as const, mime: "video/mp4", expected: "video/mp4" },
    { kind: "video" as const, mime: "video/webm", expected: "video/webm" },
    { kind: "video" as const, mime: "video/mov", expected: "video/quicktime" },
    { kind: "audio" as const, mime: "audio/mpeg", expected: "audio/mpeg" },
    { kind: "audio" as const, mime: "audio/wav", expected: "audio/wav" },
    { kind: "audio" as const, mime: "audio/ogg", expected: "audio/ogg" },
  ])("accepts common $kind data URL MIME $mime", async ({ kind, mime, expected }) => {
    const sources = await loadReferenceSources({ [`${kind}s`]: [`data:${mime};base64,ZmFrZQ==`] }, 1);
    expect(sources[0]).toMatchObject({ sourceType: "inline", kind, mimeType: expected, byteSize: 4 });
  });

  it.each([
    { kind: "image" as const, mime: "image/avif" },
    { kind: "image" as const, mime: "image/tiff" },
    { kind: "video" as const, mime: "video/x-matroska" },
    { kind: "video" as const, mime: "video/x-msvideo" },
    { kind: "video" as const, mime: "video/3gpp" },
    { kind: "audio" as const, mime: "audio/amr" },
    { kind: "audio" as const, mime: "audio/caf" },
  ])("accepts extended $kind data URL MIME $mime", async ({ kind, mime }) => {
    const sources = await loadReferenceSources({ media: [`data:${mime};base64,ZmFrZQ==`] }, 1);
    expect(sources[0]).toMatchObject({ sourceType: "inline", kind, mimeType: mime, byteSize: 4 });
  });

  it("accepts standard data URL parameters without weakening the media allow-list", async () => {
    const sources = await loadReferenceSources({ images: ["data:image/png;charset=utf-8;base64,ZmFrZQ=="] }, 1);
    expect(sources[0]).toMatchObject({ sourceType: "inline", kind: "image", mimeType: "image/png" });
    await expect(loadReferenceSources({ images: ["data:image/svg+xml;charset=utf-8;base64,PHN2Zz4="] }, 1)).rejects.toMatchObject({ code: "invalid_media_type" });
  });

  it("uses the source extension to classify mixed media input", () => {
    expect(extractReferenceSources({ media: ["https://fixture.example/clip.mov", "https://fixture.example/track.mp3", "https://fixture.example/photo.gif"] }, 3)).toMatchObject([
      { kind: "video" },
      { kind: "audio" },
      { kind: "image" },
    ]);
  });

  it("streams remote media and stops when the byte budget is exceeded", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    const get = vi.spyOn(axios, "get").mockResolvedValue({ status: 200, headers: { "content-type": "image/png" }, data: Readable.from([Buffer.from("png-fixture")]) } as never);
    try {
      const downloaded = await downloadRemoteMedia("https://fixture.example/image.png", { maxBytes: 32, allowedMime: ["image/png"] });
      expect(await readFile(downloaded.filePath)).toEqual(Buffer.from("png-fixture"));
      expect(downloaded.byteSize).toBe(11);
      expect(typeof (get.mock.calls[0]?.[1] as { lookup?: unknown } | undefined)?.lookup).toBe("function");
      await cleanupRemoteMedia(downloaded.filePath);

      get.mockResolvedValueOnce({ status: 200, headers: { "content-type": "image/png" }, data: Readable.from([Buffer.alloc(20), Buffer.alloc(20)]) } as never);
      await expect(downloadRemoteMedia("https://fixture.example/large.png", { maxBytes: 32, allowedMime: ["image/png"] })).rejects.toMatchObject({ code: "media_too_large" });
    } finally {
      get.mockRestore();
      lookup.mockRestore();
    }
  });

  it("normalizes remote MIME aliases and falls back to a safe URL extension", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    const get = vi.spyOn(axios, "get");
    const cases = [
      { url: "https://fixture.example/photo.gif?download=1", contentType: "application/octet-stream", allowedMime: "image/gif" },
      { url: "https://fixture.example/clip.mov", contentType: "", allowedMime: "video/quicktime" },
      { url: "https://fixture.example/track.mp3", contentType: "audio/mp3", allowedMime: "audio/mpeg" },
      { url: "https://fixture.example/recording.m4a", contentType: "", allowedMime: "audio/mp4" },
    ];
    const filePaths: string[] = [];
    try {
      for (const item of cases) {
        get.mockResolvedValueOnce({ status: 200, headers: { "content-type": item.contentType }, data: Readable.from([Buffer.from("media")]) } as never);
        const downloaded = await downloadRemoteMedia(item.url, { maxBytes: 32, allowedMime: [item.allowedMime] });
        filePaths.push(downloaded.filePath);
        expect(downloaded.mimeType).toBe(item.allowedMime);
      }
    } finally {
      await Promise.all(filePaths.map((filePath) => cleanupRemoteMedia(filePath)));
      get.mockRestore();
      lookup.mockRestore();
    }
  });

  it("supports category MIME patterns without accepting an explicit wrong type", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    const get = vi.spyOn(axios, "get").mockResolvedValue({ status: 200, headers: { "content-type": "image/gif" }, data: Readable.from([Buffer.from("gif")]) } as never);
    let filePath = "";
    try {
      const downloaded = await downloadRemoteMedia("https://fixture.example/picture.gif", { maxBytes: 32, allowedMime: ["image/*"] });
      filePath = downloaded.filePath;
      expect(downloaded.mimeType).toBe("image/gif");
    } finally {
      if (filePath) await cleanupRemoteMedia(filePath);
      get.mockRestore();
      lookup.mockRestore();
    }
  });

  it("does not let an allowed URL extension override an explicit unsafe content type", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    const get = vi.spyOn(axios, "get").mockResolvedValue({ status: 200, headers: { "content-type": "text/html" }, data: Readable.from([Buffer.from("html")]) } as never);
    try {
      await expect(downloadRemoteMedia("https://fixture.example/not-an-image.png", { maxBytes: 32, allowedMime: ["image/png"] })).rejects.toMatchObject({ code: "invalid_media_type" });
    } finally {
      get.mockRestore();
      lookup.mockRestore();
    }
  });

  it("revalidates a redirect target before opening its download stream", async () => {
    const lookup = vi.spyOn(dns, "lookup")
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    const get = vi.spyOn(axios, "get").mockResolvedValueOnce({ status: 302, headers: { location: "http://redirect.fixture/private.png" }, data: Readable.from([]) } as never);
    try {
      await expect(downloadRemoteMedia("https://fixture.example/redirect.png", { maxBytes: 32, allowedMime: ["image/png"] })).rejects.toMatchObject({ code: "blocked_media_url" });
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      get.mockRestore();
      lookup.mockRestore();
    }
  });

  it("routes HTTP proxy downloads through both HTTP agents without direct proxy mode", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    const get = vi.spyOn(axios, "get").mockImplementation(async () => ({ status: 200, headers: { "content-type": "image/png" }, data: Readable.from([Buffer.from("proxy-http")]) }) as never);
    const filePaths: string[] = [];
    try {
      const httpDownloaded = await downloadRemoteMedia("http://fixture.example/http-proxy.png", { maxBytes: 32, allowedMime: ["image/png"], proxy: proxyEntry("HTTP") });
      filePaths.push(httpDownloaded.filePath);
      const httpRequest = get.mock.calls[0]?.[1] as { httpAgent?: unknown; httpsAgent?: unknown; lookup?: unknown; proxy?: unknown };
      expect(httpRequest.httpAgent).toBeInstanceOf(HttpProxyAgent);
      expect(httpRequest.httpsAgent).toBe(httpRequest.httpAgent);
      expect(httpRequest.proxy).toBe(false);
      expect(httpRequest.lookup).toBeUndefined();

      const httpsDownloaded = await downloadRemoteMedia("https://fixture.example/https-proxy.png", { maxBytes: 32, allowedMime: ["image/png"], proxy: proxyEntry("HTTP") });
      filePaths.push(httpsDownloaded.filePath);
      const httpsRequest = get.mock.calls[1]?.[1] as { httpAgent?: unknown; httpsAgent?: unknown; lookup?: unknown; proxy?: unknown };
      expect(httpsRequest.httpAgent).toBeInstanceOf(HttpsProxyAgent);
      expect(httpsRequest.httpsAgent).toBe(httpsRequest.httpAgent);
      expect(httpsRequest.proxy).toBe(false);
      expect(httpsRequest.lookup).toBeUndefined();
    } finally {
      await Promise.all(filePaths.map((filePath) => cleanupRemoteMedia(filePath)));
      get.mockRestore();
      lookup.mockRestore();
    }
  });

  it("uses socks5h through SocksProxyAgent without passing a direct lookup", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    const get = vi.spyOn(axios, "get").mockResolvedValue({ status: 200, headers: { "content-type": "image/png" }, data: Readable.from([Buffer.from("proxy-socks")]) } as never);
    let filePath = "";
    try {
      const downloaded = await downloadRemoteMedia("https://fixture.example/socks-proxy.png", { maxBytes: 32, allowedMime: ["image/png"], proxy: proxyEntry("SOCKS5") });
      filePath = downloaded.filePath;
      const request = get.mock.calls[0]?.[1] as { httpAgent?: unknown; httpsAgent?: unknown; lookup?: unknown; proxy?: unknown };
      expect(request.httpAgent).toBeInstanceOf(SocksProxyAgent);
      expect(request.httpsAgent).toBe(request.httpAgent);
      expect(request.lookup).toBeUndefined();
      expect(request.proxy).toBe(false);
      expect((request.httpAgent as SocksProxyAgent).shouldLookup).toBe(false);
      expect((request.httpAgent as SocksProxyAgent).proxy.type).toBe(5);
    } finally {
      if (filePath) await cleanupRemoteMedia(filePath);
      get.mockRestore();
      lookup.mockRestore();
    }
  });

  it("marks proxy gateway statuses switchable while keeping 404 non-switchable", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    const get = vi.spyOn(axios, "get");
    const gatewayStatuses = [407, 408, 502, 503, 504];
    try {
      for (const status of gatewayStatuses) {
        get.mockResolvedValueOnce({ status, headers: {}, data: Readable.from([]) } as never);
        await expect(downloadRemoteMedia(`https://fixture.example/gateway-${status}.png`, { maxBytes: 32, allowedMime: ["image/png"], proxy: proxyEntry("HTTP") })).rejects.toMatchObject({ code: "media_download_failed", details: { proxyEligible: true } });
      }
      get.mockResolvedValueOnce({ status: 404, headers: {}, data: Readable.from([]) } as never);
      const error = await downloadRemoteMedia("https://fixture.example/not-found-proxy.png", { maxBytes: 32, allowedMime: ["image/png"], proxy: proxyEntry("HTTP") }).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "media_download_failed" });
      expect((error as AppError).details && typeof (error as AppError).details === "object" ? ((error as AppError).details as Record<string, unknown>).proxyEligible : undefined).not.toBe(true);
    } finally {
      get.mockRestore();
      lookup.mockRestore();
    }
  });

  it("does not remove a similarly prefixed sibling directory", async () => {
    const sibling = await mkdtemp(path.join(os.tmpdir(), "adobe2api-plus-remote-media-evil-"));
    const sentinel = path.join(sibling, "sentinel");
    await writeFile(sentinel, "keep");
    try {
      await cleanupRemoteMedia(path.join(sibling, "media"));
      await expect(access(sentinel)).resolves.toBeUndefined();
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it("keeps remote references replayable across proxy attempts and cleans them up", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    const get = vi.spyOn(axios, "get").mockResolvedValue({ status: 200, headers: { "content-type": "image/png" }, data: Readable.from([Buffer.from("replayable")]) } as never);
    let sources: Awaited<ReturnType<typeof loadReferenceSources>> = [];
    try {
      sources = await loadReferenceSources({ images: ["https://fixture.example/replay.png"] }, 1);
      expect(sources[0]?.sourceType).toBe("file");
      const first = openReferenceMedia(sources[0]!);
      const firstChunks: Buffer[] = [];
      for await (const chunk of first.body as AsyncIterable<Buffer>) firstChunks.push(Buffer.from(chunk));
      closeReferenceMedia(first.body);
      const second = openReferenceMedia(sources[0]!);
      const secondChunks: Buffer[] = [];
      for await (const chunk of second.body as AsyncIterable<Buffer>) secondChunks.push(Buffer.from(chunk));
      closeReferenceMedia(second.body);
      expect(Buffer.concat(firstChunks).toString()).toBe("replayable");
      expect(Buffer.concat(secondChunks).toString()).toBe("replayable");
      const filePath = sources[0]!.sourceType === "file" ? sources[0].filePath : "";
      await cleanupReferenceSources(sources);
      await expect(access(filePath)).rejects.toThrow();
    } finally {
      await cleanupReferenceSources(sources);
      get.mockRestore();
      lookup.mockRestore();
    }
  });

  it("passes the active proxy to remote reference loading", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "adobe2api-plus-reference-proxy-"));
    const filePath = path.join(directory, "media");
    await writeFile(filePath, Buffer.from("proxy-media"));
    const proxy = { id: "proxy-1", version: 1, protocol: "HTTP" as const, host: "proxy.example.test", port: 8080, encryptedUsername: null, encryptedPassword: null };
    let seenProxy: unknown;
    let sources: Awaited<ReturnType<typeof loadReferenceSources>> = [];
    try {
      sources = await loadReferenceSources({ images: ["https://fixture.example/proxy.png"] }, 1, {
        proxy,
        download: async (_source, options) => {
          seenProxy = options.proxy;
          return { filePath, byteSize: 11, mimeType: "image/png" };
        },
      });
      expect(seenProxy).toBe(proxy);
      expect(sources[0]).toMatchObject({ sourceType: "file", filePath, byteSize: 11, mimeType: "image/png" });
    } finally {
      await cleanupReferenceSources(sources);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks proxy network failures switchable but keeps remote HTTP errors sticky", async () => {
    const proxy = { id: "proxy-1", version: 1, protocol: "HTTP" as const, host: "proxy.example.test", port: 8080, encryptedUsername: null, encryptedPassword: null };
    await expect(loadReferenceSources({ images: ["https://fixture.example/network.png"] }, 1, {
      proxy,
      download: async () => { throw new Error("ECONNRESET"); },
    })).rejects.toMatchObject({ code: "media_download_failed", details: { proxyEligible: true } });
    await expect(loadReferenceSources({ images: ["https://fixture.example/not-found.png"] }, 1, {
      proxy,
      download: async () => { throw new AppError("media_download_failed", "Remote media returned HTTP 404", 400); },
    })).rejects.toMatchObject({ code: "media_download_failed" });
    await expect(loadReferenceSources({ images: ["https://fixture.example/not-found-again.png"] }, 1, {
      proxy,
      download: async () => { throw new AppError("invalid_media_type", "Remote media type is not allowed", 400); },
    })).rejects.toMatchObject({ code: "invalid_media_type" });
  });
});
