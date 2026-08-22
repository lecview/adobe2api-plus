import { Readable } from "node:stream";
import { AdobeClient } from "@/lib/adobe/client";
import { RecordingAdobeTransport } from "@/lib/adobe/transport";
import { resolveImageModel, resolveVideoModel } from "@/lib/catalog";

describe("AdobeClient", () => {
  const originalBaseUrl = process.env.ADOBE_BASE_URL;

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.ADOBE_BASE_URL;
    else process.env.ADOBE_BASE_URL = originalBaseUrl;
  });

  it("submits an image with the legacy-compatible endpoint and payload", async () => {
    const transport = new RecordingAdobeTransport({ status: 200, headers: { "x-override-status-link": "https://bks-epo1234.adobe.io/v2/jobs/result/task-1" }, data: { links: {} } });
    const client = new AdobeClient(transport);
    const result = await client.submitImage({ token: "header.eyJzdWIiOiJ1c2VyIn0.signature", proxy: null, arpSessionId: "TEST_SHERLOCK" }, { prompt: "a red square", model: resolveImageModel(), aspectRatio: "16:9", outputResolution: "2K" });
    expect(result.upstreamTaskId).toBe("task-1");
    expect(transport.calls[0]?.path).toContain("firefly-3p.ff.adobe.io/v2/3p-images/generate-async");
    expect((transport.calls[0]?.body as Record<string, unknown>).modelId).toBe("gemini-flash");
  });

  it("passes a separately uploaded mask through the image submission payload", async () => {
    const transport = new RecordingAdobeTransport({ status: 202, headers: { "x-override-status-link": "https://bks-epo1234.adobe.io/v2/jobs/result/task-mask" }, data: { links: {} } });
    const client = new AdobeClient(transport);
    await client.submitImage({ token: "token", proxy: null, arpSessionId: "TEST_SHERLOCK" }, { prompt: "edit", model: resolveImageModel("nano-banana-pro-1k-1x1"), sourceImageIds: ["image-id"], maskId: "mask-id" });
    expect((transport.calls[0]?.body as Record<string, unknown>).generationMetadata).toMatchObject({ module: "image2image" });
    expect((transport.calls[0]?.body as Record<string, unknown>).referenceBlobs).toEqual([{ id: "image-id", usage: "general" }, { id: "mask-id", usage: "mask" }]);
  });

  it("forwards GPT Image 1K 16:9 generation and edit options to Adobe", async () => {
    const transport = new RecordingAdobeTransport({ status: 202, headers: { "x-override-status-link": "https://bks-epo1234.adobe.io/v2/jobs/result/task-gpt-options" }, data: { links: {} } });
    const client = new AdobeClient(transport);
    await client.submitImage({ token: "test-token", proxy: null, arpSessionId: "TEST_SHERLOCK" }, {
      prompt: "a clean studio product photo",
      model: resolveImageModel("gpt-image-1k-16x9"),
      aspectRatio: "16:9",
      outputResolution: "1K",
      background: "transparent",
      output_format: "webp",
      output_compression: 72,
      input_fidelity: "high",
      moderation: "low",
    });

    const body = transport.calls[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      modelId: "gpt-image",
      modelVersion: "2",
      size: { width: 1280, height: 720 },
      modelSpecificPayload: {
        size: "1280x720",
        parameters: { background: "transparent", inputFidelity: "high", moderation: "low" },
      },
      output: { format: "webp", compression: 72 },
    });
  });

  it("forwards Kling3 5s 16:9 T2V and I2V options to Adobe", async () => {
    const transport = new RecordingAdobeTransport({ status: 202, headers: { "x-override-status-link": "https://bks-epo1234.adobe.io/v2/jobs/result/task-kling-options" }, data: { links: {} } });
    const client = new AdobeClient(transport);
    const options = {
      mode: "standard",
      cfg_scale: 6,
      camera_control: { type: "pan", horizontal: 0.4 },
      watermark: false,
      loop: true,
      transparent_background: true,
    } as const;

    await client.submitVideo({ token: "test-token", proxy: null, arpSessionId: "TEST_SHERLOCK" }, {
      prompt: "a paper plane over the ocean",
      model: resolveVideoModel("kling3-5s-16x9"),
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      ...options,
    });
    const textToVideo = transport.calls[0]?.body as Record<string, unknown>;
    expect(textToVideo).toMatchObject({
      modelId: "kling",
      modelVersion: "kling_v3_standard_t2v",
      duration: 5,
      size: { width: 1280, height: 720 },
      generationMetadata: { module: "text2video" },
      generationSettings: { aspectRatio: "16:9", mode: "standard", cfgScale: 6 },
      generateLoop: true,
      transparentBackground: true,
      modelSpecificPayload: { parameters: { cameraControl: { type: "pan", horizontal: 0.4 }, addWaterMark: false } },
    });

    transport.calls.length = 0;
    await client.submitVideo({ token: "test-token", proxy: null, arpSessionId: "TEST_SHERLOCK" }, {
      prompt: "animate the paper plane",
      model: resolveVideoModel("kling3-5s-16x9"),
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      sourceImageIds: ["frame-1"],
      ...options,
    });
    const imageToVideo = transport.calls[0]?.body as Record<string, unknown>;
    expect(imageToVideo).toMatchObject({
      modelId: "kling",
      modelVersion: "kling_v3_standard_i2v",
      generationMetadata: { module: "image2video" },
      referenceBlobs: [{ id: "frame-1", usage: "frame", order: 1 }],
    });
  });

  it("extracts a terminal media URL from a polling response", async () => {
    const transport = new RecordingAdobeTransport({ status: 200, headers: {}, data: { status: "SUCCEEDED", outputs: [{ image: { presignedUrl: "https://cdn.example/result.png" } }] } });
    const client = new AdobeClient(transport);
    const result = await client.poll({ token: "token", proxy: null, arpSessionId: "TEST_SHERLOCK" }, "https://example.com/poll", "image");
    expect(result).toMatchObject({ status: "SUCCEEDED", outputUrl: "https://cdn.example/result.png", mimeType: "image/png" });
  });

  it("routes absolute Adobe endpoints through the configured compatibility base", async () => {
    process.env.ADOBE_BASE_URL = "http://127.0.0.1:43123/mock";
    const transport = new RecordingAdobeTransport({ status: 200, headers: { "x-override-status-link": "http://127.0.0.1:43123/mock/poll/task-1" }, data: {} });
    await new AdobeClient(transport).submitImage({ token: "token", proxy: null, arpSessionId: "TEST_SHERLOCK" }, { prompt: "test", model: resolveImageModel() });
    expect(transport.calls[0]?.path).toBe("http://127.0.0.1:43123/mock/v2/3p-images/generate-async");
  });

  it("does not classify quota exhaustion as a proxy-routable failure", async () => {
    const transport = new RecordingAdobeTransport({ status: 429, headers: {}, data: { message: "quota exceeded" } });
    const client = new AdobeClient(transport);
    await expect(client.submitImage({ token: "token", proxy: null, arpSessionId: "TEST_SHERLOCK" }, { prompt: "quota", model: resolveImageModel() })).rejects.toMatchObject({ code: "adobe_quota_exhausted", proxyEligible: false });
  });

  it("keeps generic upstream rate limits on the same account and proxy", async () => {
    const transport = new RecordingAdobeTransport({ status: 429, headers: {}, data: { message: "too many requests" } });
    const client = new AdobeClient(transport);
    await expect(client.submitImage({ token: "token", proxy: null, arpSessionId: "TEST_SHERLOCK" }, { prompt: "rate limit", model: resolveImageModel() })).rejects.toMatchObject({ code: "adobe_rate_limited", proxyEligible: false });
  });

  it("classifies an explicit submit 408 as a retryable Adobe service timeout", async () => {
    const transport = new RecordingAdobeTransport({ status: 408, headers: { "x-request-id": "request-408" }, data: { error_code: "timeout_error", message: "system under load" } });
    const client = new AdobeClient(transport);
    await expect(client.submitImage({ token: "token", proxy: null, arpSessionId: "TEST_SHERLOCK" }, { prompt: "risk", model: resolveImageModel() }))
      .rejects.toMatchObject({
        code: "adobe_submit_timeout",
        retryable: true,
        proxyEligible: false,
        realUpstreamStatus: 408,
        details: {
          subtype: "timeout_error",
          response_received: true,
          headers: { "x-request-id": "request-408" },
        },
      });
  });

  it("does not retry an unrecognized submit 408 response", async () => {
    const transport = new RecordingAdobeTransport({ status: 408, headers: {}, data: { message: "request rejected" } });
    const client = new AdobeClient(transport);
    await expect(client.submitImage({ token: "token", proxy: null, arpSessionId: "TEST_SHERLOCK" }, { prompt: "risk", model: resolveImageModel() }))
      .rejects.toMatchObject({
        code: "adobe_upstream_rejected",
        retryable: false,
        proxyEligible: false,
        realUpstreamStatus: 408,
      });
  });

  it("supports replayable stream bodies with an explicit content length", async () => {
    const transport = new RecordingAdobeTransport({ status: 200, headers: {}, data: {} });
    const client = new AdobeClient(transport);
    const body = Readable.from([Buffer.from("entity")]);
    await client.uploadEntityImage({ token: "token", proxy: null, arpSessionId: "TEST_SHERLOCK" }, { repository: "repo", entityName: "entity", body, byteSize: 6, mimeType: "image/png" });
    expect(transport.calls.at(-1)?.body).toBe(body);
    expect(transport.calls.at(-1)?.headers?.["Content-Length"]).toBe("6");
  });
});
