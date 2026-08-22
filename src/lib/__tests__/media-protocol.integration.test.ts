import { describe, expect, beforeEach, it, vi } from "vitest";
import { AdobeClient } from "@/lib/adobe/client";
import { ADOBE_ENDPOINTS } from "@/lib/adobe/client";
import { buildImagePayloads, buildVideoPayload } from "@/lib/adobe/payloads";
import { resolveImageModel, resolveVideoModel } from "@/lib/catalog";
import { RecordingAdobeTransport } from "@/lib/adobe/transport";
import { AppError } from "@/lib/errors";
import { normalizeChatRequest, normalizeGeminiRequest, normalizeImageRequest, normalizeVideoRequest } from "@/lib/media-request";

const mocks = vi.hoisted(() => ({
  enqueueGeneration: vi.fn(),
  waitForGeneration: vi.fn(),
  validateReferenceUrls: vi.fn(),
  mediaUrl: vi.fn(),
  openAiImageData: vi.fn(),
  openAiChatContentParts: vi.fn(),
  openAiChatText: vi.fn(),
  canonicalProtocolModelId: vi.fn(),
  withCanonicalProtocolModel: vi.fn(),
  geminiImageParts: vi.fn(),
  geminiMediaParts: vi.fn(),
  parseVideoMultipartBody: vi.fn(),
  requireServiceApiKey: vi.fn(),
  getSystemSettings: vi.fn(),
  readJobEvents: vi.fn(),
  findVideoJob: vi.fn(),
  videoObject: vi.fn(),
}));

vi.mock("@/lib/service-auth", () => ({ requireServiceApiKey: mocks.requireServiceApiKey }));
vi.mock("@/lib/system-settings", () => ({ getSystemSettings: mocks.getSystemSettings }));
vi.mock("@/lib/jobs", () => ({ readJobEvents: mocks.readJobEvents }));
vi.mock("@/lib/gateway", () => ({
  enqueueGeneration: mocks.enqueueGeneration,
  waitForGeneration: mocks.waitForGeneration,
  validateReferenceUrls: mocks.validateReferenceUrls,
  mediaUrl: mocks.mediaUrl,
  openAiError: (message: string, type = "invalid_request_error", code?: string) => ({ error: { message, type, ...(code ? { code } : {}) } }),
}));
vi.mock("@/lib/media-response", () => ({
  openAiImageData: mocks.openAiImageData,
  openAiChatContentParts: mocks.openAiChatContentParts,
  openAiChatText: mocks.openAiChatText,
  canonicalProtocolModelId: mocks.canonicalProtocolModelId,
  withCanonicalProtocolModel: mocks.withCanonicalProtocolModel,
  geminiImageParts: mocks.geminiImageParts,
  geminiMediaParts: mocks.geminiMediaParts,
  parseVideoMultipartBody: mocks.parseVideoMultipartBody,
}));
vi.mock("@/lib/video-response", () => ({
  findVideoJob: mocks.findVideoJob,
  videoObject: mocks.videoObject,
}));

import { POST as openAiImageGenerations } from "@/app/v1/images/generations/route";
import { POST as openAiImageEdits } from "@/app/v1/images/edits/route";
import { POST as openAiChat } from "@/app/v1/chat/completions/route";
import { POST as geminiGenerateContent } from "@/app/v1beta/models/[...path]/route";
import { POST as soraVideos } from "@/app/v1/videos/route";
import { POST as klingVideos } from "@/app/kling/v1/videos/[...path]/route";

const imageMedia = [{ objectKey: "jobs/protocol-image/result-1.png", mimeType: "image/png" }];
const videoMedia = [{ objectKey: "jobs/protocol-video/result-1.mp4", mimeType: "video/mp4" }];
const videoTask = {
  job: {
    id: "protocol-video-job",
    status: "QUEUED",
    model: "sora2-8s-16x9",
    createdAt: new Date("2026-08-16T00:00:00.000Z"),
    updatedAt: new Date("2026-08-16T00:00:00.000Z"),
    errorMessage: null,
  },
  media: [],
};
const videoObjectValue = {
  id: "protocol-video-job",
  object: "video",
  status: "queued",
  model: "sora2-8s-16x9",
  created_at: 1,
  completed_at: null,
  progress: 0,
  seconds: 8,
  size: "720p",
  error: null,
  output: null,
  outputs: [],
};

function authRequest(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: { Authorization: "Bearer protocol-test-key", ...(init.headers ?? {}) },
  });
}

function queuedJob(id = "protocol-job") {
  return { id };
}

describe("media protocol normalization", () => {
  it("keeps OpenAI image generation and edit references distinct", () => {
    const generated = normalizeImageRequest({
      model: "gpt-image-1k-16x9",
      prompt: "a glass house",
      n: 2,
      response_format: "b64_json",
      images: ["https://cdn.example/source.png", "data:image/png;base64,cG5n"],
    });
    expect(generated).toMatchObject({ protocol: "openai-images", kind: "image", model: "gpt-image-1k-16x9", n: 2, response_format: "b64_json" });
    expect(generated.images).toEqual(["https://cdn.example/source.png", "data:image/png;base64,cG5n"]);

    const edited = normalizeImageRequest({
      model: "gpt-image-1k-16x9",
      prompt: "replace the sky",
      images: ["data:image/png;base64,c291cmNl"],
      mask: "data:image/png;base64,bWFzaw==",
    }, "openai-edits");
    expect(edited).toMatchObject({ protocol: "openai-edits", kind: "image", prompt: "replace the sky" });
    expect(edited.images).toEqual(["data:image/png;base64,c291cmNl"]);
    expect(edited.mask).toBe("data:image/png;base64,bWFzaw==");
  });

  it("collects OpenAI chat image URLs, data URLs, and nested Gemini media parts", () => {
    const result = normalizeChatRequest({
      model: "gpt-image-1k-16x9",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "make the reference brighter" },
          { type: "image_url", image_url: { url: "https://cdn.example/reference.png" } },
          { inlineData: { mimeType: "image/png", data: "cG5n" } },
          { fileData: { mimeType: "image/png", fileUri: "https://cdn.example/file.png" } },
        ],
      }],
    });
    expect(result).toMatchObject({ protocol: "openai-chat", kind: "image", prompt: "make the reference brighter" });
    expect(result.images).toEqual([
      "https://cdn.example/reference.png",
      "data:image/png;base64,cG5n",
      "https://cdn.example/file.png",
    ]);
  });

  it("selects the chat video model and preserves image/video URL references", () => {
    const result = normalizeChatRequest({
      model: "sora2-8s-16x9",
      media_type: "video",
      messages: [{ role: "user", content: [
        { type: "text", text: "animate this" },
        { image_url: { url: "https://cdn.example/frame.png" } },
        { video_url: { url: "https://cdn.example/source.mp4" } },
      ] }],
    });
    expect(result).toMatchObject({ protocol: "openai-chat", kind: "video", model: "sora2-8s-16x9", duration: 8, aspect_ratio: "16:9" });
    expect(result.images).toEqual(["https://cdn.example/frame.png"]);
    expect(result.videos).toEqual(["https://cdn.example/source.mp4"]);
  });

  it("normalizes native Gemini image and video contents", () => {
    const image = normalizeGeminiRequest("gemini-2.5-flash-image", {
      contents: [{ role: "user", parts: [
        { text: "turn it into watercolor" },
        { inlineData: { mimeType: "image/png", data: "cG5n" } },
        { fileData: { mimeType: "image/png", fileUri: "https://cdn.example/ref.png" } },
      ] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "1K" } },
    });
    expect(image).toMatchObject({ protocol: "gemini", kind: "image", model: "gpt-image-1k-16x9", output_resolution: "1K" });
    expect(image.images).toEqual(["data:image/png;base64,cG5n", "https://cdn.example/ref.png"]);

    const video = normalizeGeminiRequest("gemini-omni-8s-16x9-720p", {
      contents: [{ parts: [
        { text: "make it move" },
        { inlineData: { mimeType: "image/png", data: "cG5n" } },
        { fileData: { mimeType: "video/mp4", fileUri: "https://cdn.example/source.mp4" } },
      ] }],
      generationConfig: { responseModalities: ["VIDEO"] },
    });
    expect(video).toMatchObject({ protocol: "gemini", kind: "video", model: "gemini-omni-8s-16x9-720p", duration: 8, resolution: "720p" });
    expect(video.images).toEqual(["data:image/png;base64,cG5n"]);
    expect(video.videos).toEqual(["https://cdn.example/source.mp4"]);
  });

  it("normalizes Sora and Kling JSON request fields", () => {
    const sora = normalizeVideoRequest({
      model: "sora2-8s-16x9",
      prompt: "a slow pan",
      seconds: 8,
      size: "1920x1080",
      input_reference: "https://cdn.example/ref.png",
    }, "sora");
    expect(sora).toMatchObject({ protocol: "sora", kind: "video", model: "sora2-8s-16x9", duration: 8, aspect_ratio: "16:9" });
    expect(sora.images).toEqual(["https://cdn.example/ref.png"]);

    const kling = normalizeVideoRequest({
      model_name: "kling3-5s-16x9",
      prompt: "a paper plane",
      image: "data:image/png;base64,cG5n",
    }, "kling", "image2video");
    expect(kling).toMatchObject({ protocol: "kling", kind: "video", model: "kling3-5s-16x9", duration: 5 });
    expect(kling.images).toEqual(["data:image/png;base64,cG5n"]);
  });
});

describe("Adobe media payload integration", () => {
  it("maps OpenAI image generation and edit inputs to GPT Image payload variants", () => {
    const generated = buildImagePayloads({
      modelId: "gpt-image-1k-16x9",
      prompt: "a glass house",
      aspectRatio: "16:9",
      outputResolution: "1K",
      quality: "high",
      n: 2,
    });
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ modelId: "gpt-image", modelVersion: "2", n: 2, prompt: "a glass house", outputResolution: "1K", generationSettings: { detailLevel: 5 }, modelSpecificPayload: { size: "1280x720" } });

    const edited = buildImagePayloads({
      modelId: "gpt-image-1k-16x9",
      prompt: "replace the sky",
      aspectRatio: "16:9",
      outputResolution: "1K",
      sourceImageIds: ["asset-1", "asset-2"],
    });
    expect(edited).toHaveLength(3);
    expect(edited[0]?.referenceBlobs).toEqual([{ id: "asset-1", usage: "subject" }, { id: "asset-2", usage: "subject" }]);
    expect(edited[1]?.referenceImages).toEqual([{ id: "asset-1" }, { id: "asset-2" }]);
    expect(edited[2]?.referenceImages).toEqual([{ localBlobRef: "asset-1" }, { localBlobRef: "asset-2" }]);
  });

  it("maps GPT Image 1K 16:9 provider options for text-to-image and image-to-image", () => {
    const generated = buildImagePayloads({
      modelId: "gpt-image-1k-16x9",
      prompt: "a clean studio product photo",
      aspectRatio: "16:9",
      outputResolution: "1K",
      width: 1280,
      height: 720,
      n: 2,
      background: "transparent",
      output_format: "webp",
      output_compression: 72,
      input_fidelity: "high",
      moderation: "low",
    });
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({
      modelId: "gpt-image",
      modelVersion: "2",
      n: 2,
      size: { width: 1280, height: 720 },
      modelSpecificPayload: {
        size: "1280x720",
        parameters: { background: "transparent", inputFidelity: "high", moderation: "low" },
      },
      output: { storeInputs: true, format: "webp", compression: 72 },
    });

    const edited = buildImagePayloads({
      modelId: "gpt-image-1k-16x9",
      prompt: "replace the background",
      aspectRatio: "16:9",
      outputResolution: "1K",
      sourceImageIds: ["source-image"],
      background: "opaque",
      output_format: "png",
      input_fidelity: "low",
    });
    expect(edited).toHaveLength(3);
    expect(edited.every((payload) => (payload.generationMetadata as { module?: unknown } | undefined)?.module === "image2image")).toBe(true);
    expect(edited[0]).toMatchObject({
      referenceBlobs: [{ id: "source-image", usage: "subject" }],
      modelSpecificPayload: { parameters: { background: "opaque", inputFidelity: "low" } },
      output: { format: "png" },
    });
  });

  it("maps native Gemini image generation to the Adobe Gemini engine", () => {
    const [payload] = buildImagePayloads({
      modelId: "nano-banana-pro-1k-16x9",
      prompt: "watercolor",
      aspectRatio: "16:9",
      outputResolution: "1K",
      sourceImageIds: ["asset-1"],
    });
    expect(payload).toMatchObject({ modelId: "gemini-flash", modelVersion: "nano-banana-2", prompt: "watercolor", generationMetadata: { module: "image2image" }, referenceBlobs: [{ id: "asset-1", usage: "general" }] });
  });

  it("maps Sora, Kling, and Gemini Omni video engines to distinct Adobe payloads", () => {
    const sora = buildVideoPayload({ model: resolveVideoModel("sora2-8s-16x9"), prompt: "a slow pan", aspectRatio: "16:9", duration: 8, resolution: "720p", sourceImageIds: ["frame-1"], seed: 7 });
    expect(sora).toMatchObject({ modelId: "sora", modelVersion: "sora-2", duration: 8, size: { width: 1280, height: 720 }, seed: "7", referenceBlobs: [{ id: "frame-1", usage: "general", promptReference: 1 }] });
    expect(JSON.parse(String(sora.prompt))).toMatchObject({ duration_sec: 8, prompt_text: "a slow pan" });

    const kling = buildVideoPayload({ model: resolveVideoModel("kling3-5s-16x9"), prompt: "a paper plane", aspectRatio: "16:9", duration: 5, resolution: "720p", sourceImageIds: ["frame-1"], seed: 8 });
    expect(kling).toMatchObject({ modelId: "kling", modelVersion: "kling_v3_standard_i2v", duration: 5, generationMetadata: { module: "image2video" }, referenceBlobs: [{ id: "frame-1", usage: "frame", order: 1 }] });

    const omni = buildVideoPayload({ model: resolveVideoModel("gemini-omni-8s-16x9-720p"), prompt: "make it move", aspectRatio: "16:9", duration: 8, resolution: "720p", sourceImageIds: ["frame-1"], sourceVideoIds: ["source-1"], seed: 9 });
    expect(omni).toMatchObject({ modelId: "gemini-omni", modelVersion: "omni-flash", duration: 8, generationMetadata: { module: "aura" }, referenceBlobs: [{ id: "frame-1", usage: "style" }, { id: "source-1", usage: "source" }] });
  });

  it("maps Kling3 5s 16:9 text-to-video and image-to-video payloads", () => {
    const options = {
      mode: "standard",
      cfg_scale: 6,
      camera_control: { type: "pan", horizontal: 0.4 },
      watermark: false,
      loop: true,
      transparent_background: true,
    } as const;
    const textToVideo = buildVideoPayload({
      model: resolveVideoModel("kling3-5s-16x9"),
      prompt: "a paper plane over the ocean",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      ...options,
    });
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
      referenceBlobs: [],
    });

    const imageToVideo = buildVideoPayload({
      model: resolveVideoModel("kling3-5s-16x9"),
      prompt: "animate the paper plane",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      sourceImageIds: ["frame-1"],
      ...options,
    });
    expect(imageToVideo).toMatchObject({
      modelId: "kling",
      modelVersion: "kling_v3_standard_i2v",
      generationMetadata: { module: "image2video" },
      referenceBlobs: [{ id: "frame-1", usage: "frame", order: 1 }],
    });
  });

  it("keeps normalized video dimensions and count while preserving mixed Seedance references", () => {
    const normalized = normalizeVideoRequest({
      model_name: "kling3-5s-16x9",
      prompt: "a paper plane over the ocean",
      n: 2,
      duration: 5,
      providerOptions: { width: 1920, height: 1080 },
    }, "kling", "text2video");

    expect(normalized).toMatchObject({ n: 2, duration: 5, width: 1920, height: 1080, aspect_ratio: "16:9" });

    const payload = buildVideoPayload({
      model: resolveVideoModel("seedance20-fast-5s-16x9-1080p"),
      prompt: normalized.prompt,
      aspectRatio: normalized.aspect_ratio,
      duration: normalized.duration,
      resolution: "1080p",
      width: normalized.width,
      height: normalized.height,
      n: normalized.n,
      sourceImageIds: ["image-asset"],
      sourceVideoIds: ["video-asset"],
      sourceAudioIds: ["audio-asset"],
    });

    expect(payload).toMatchObject({
      modelId: "seedance",
      modelVersion: "seedance_2.0_fast",
      n: 2,
      duration: 5,
      size: { width: 1920, height: 1080 },
      referenceBlobs: [
        { id: "image-asset", usage: "style" },
        { id: "video-asset", usage: "source" },
        { id: "audio-asset", usage: "source" },
      ],
    });
  });

  it("keeps Kling protocol while routing a Seedance or Jimeng model to its Adobe engine", () => {
    const normalized = normalizeVideoRequest({
      model_name: "seedance20-fast-5s-16x9-1080p",
      prompt: "a cinematic paper plane",
      image: "https://cdn.example/frame.png",
    }, "kling", "image2video");
    expect(normalized).toMatchObject({ protocol: "kling", model: "seedance20-fast-5s-16x9-1080p", duration: 5, aspect_ratio: "16:9" });

    const payload = buildVideoPayload({
      model: resolveVideoModel(normalized.model),
      prompt: normalized.prompt,
      aspectRatio: normalized.aspect_ratio,
      duration: normalized.duration,
      resolution: normalized.resolution,
      sourceImageIds: ["frame-1"],
    });
    expect(payload).toMatchObject({
      modelId: "seedance",
      modelVersion: "seedance_2.0_fast",
      size: { width: 1920, height: 1080 },
      generationMetadata: { module: "text2video", submodule: "ff-video-generate" },
      referenceBlobs: [{ id: "frame-1", usage: "style" }],
    });
  });

  it("uses the replaceable Adobe transport for image and video submissions", async () => {
    const transport = new RecordingAdobeTransport({
      status: 202,
      headers: { "x-override-status-link": "https://fake-adobe.test/poll/task-protocol" },
      data: { accepted: true },
    });
    const client = new AdobeClient(transport);
    const imageResult = await client.submitImage({ token: "test-token", proxy: null, arpSessionId: "TEST_SHERLOCK" }, { prompt: "a glass house", model: resolveImageModel("gpt-image-1k-16x9"), aspectRatio: "16:9", outputResolution: "1K" });
    expect(imageResult).toMatchObject({ upstreamTaskId: "task-protocol", pollUrl: "https://fake-adobe.test/poll/task-protocol" });
    expect(transport.calls[0]).toMatchObject({ method: "POST", path: ADOBE_ENDPOINTS.imageSubmit, token: "test-token" });
    expect(transport.calls[0]?.headers?.["Content-Type"]).toBe("application/json");
    expect(transport.calls[0]?.body).toMatchObject({ modelId: "gpt-image", prompt: "a glass house", size: { width: 1280, height: 720 } });

    transport.calls.length = 0;
    const videoResult = await client.submitVideo({ token: "test-token", proxy: null, arpSessionId: "TEST_SHERLOCK" }, { prompt: "a paper plane", model: resolveVideoModel("kling3-5s-16x9"), aspectRatio: "16:9", duration: 5, resolution: "720p", width: 1920, height: 1080, sourceImageIds: ["frame-1"], seed: 10 });
    expect(videoResult.upstreamTaskId).toBe("task-protocol");
    expect(transport.calls[0]).toMatchObject({ method: "POST", path: ADOBE_ENDPOINTS.videoSubmit, token: "test-token" });
    expect(transport.calls[0]?.body).toMatchObject({ modelId: "kling", modelVersion: "kling_v3_standard_i2v", duration: 5, size: { width: 1920, height: 1080 }, referenceBlobs: [{ id: "frame-1", usage: "frame", order: 1 }] });
  });
});

describe("public media protocol route envelopes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canonicalProtocolModelId.mockImplementation((value: unknown) => typeof value === "string" ? value : undefined);
    mocks.withCanonicalProtocolModel.mockImplementation((value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value : {});
    mocks.openAiChatContentParts.mockImplementation(async (_request: Request, media: Array<{ mimeType: string; objectKey: string }>) => media.map((item) => item.mimeType.startsWith("video/") ? { type: "video_url", video_url: { url: `http://api.test/generated/${item.objectKey}` } } : { type: "image_url", image_url: { url: `http://api.test/generated/${item.objectKey}` } }));
    mocks.openAiChatText.mockImplementation((part: { type: string; image_url?: { url: string }; video_url?: { url: string } }) => part.type === "image_url" ? `![Generated Image](${part.image_url?.url})` : `<video src="${part.video_url?.url}" controls></video>`);
    mocks.geminiMediaParts.mockImplementation(async (request: Request, media: Array<{ mimeType: string; objectKey: string }>) => Promise.all(media.map(async (item) => item.mimeType.startsWith("image/") ? { inlineData: { mimeType: "image/png", data: "ZmFrZS1wbmc=" } } : { fileData: { fileUri: await mocks.mediaUrl(request, item.objectKey), mimeType: item.mimeType } })));
    mocks.parseVideoMultipartBody.mockImplementation(async (request: Request) => {
      const form = await request.formData();
      const body: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) {
        const parsed = typeof value === "string" ? value : `data:${value.type || "application/octet-stream"};base64,${Buffer.from(await value.arrayBuffer()).toString("base64")}`;
        body[key] = body[key] === undefined ? parsed : Array.isArray(body[key]) ? [...body[key] as unknown[], parsed] : [body[key], parsed];
      }
      return body;
    });
    mocks.requireServiceApiKey.mockResolvedValue(undefined);
    mocks.validateReferenceUrls.mockResolvedValue(undefined);
    mocks.enqueueGeneration.mockResolvedValue(queuedJob());
    mocks.waitForGeneration.mockResolvedValue({ job: queuedJob(), media: imageMedia[0], medias: imageMedia });
    mocks.mediaUrl.mockResolvedValue("http://api.test/generated/jobs/protocol/result-1.png");
    mocks.openAiImageData.mockResolvedValue([{ url: "http://api.test/generated/jobs/protocol/result-1.png" }]);
    mocks.geminiImageParts.mockResolvedValue([{ inlineData: { mimeType: "image/png", data: "ZmFrZS1wbmc=" } }]);
    mocks.findVideoJob.mockResolvedValue(videoTask);
    mocks.videoObject.mockResolvedValue(videoObjectValue);
    mocks.readJobEvents.mockResolvedValue({ cursor: 1, terminal: true, events: [] });
  });

  it("accepts OpenAI image generation JSON and returns the requested response format", async () => {
    const response = await openAiImageGenerations(authRequest("http://api.test/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-image-1k-16x9", prompt: "a glass house", response_format: "b64_json" }),
      headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(200);
    expect(mocks.enqueueGeneration).toHaveBeenCalledWith(expect.objectContaining({ apiPath: "/v1/images/generations", model: "gpt-image-1k-16x9", payload: expect.objectContaining({ kind: "image", protocol: "openai-images", response_format: "b64_json" }) }));
    expect(mocks.openAiImageData).toHaveBeenCalledWith(expect.any(Request), imageMedia, "b64_json");
  });

  it("passes OpenAI GPT Image 1K 16:9 provider options into the queued payload", async () => {
    const response = await openAiImageGenerations(authRequest("http://api.test/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-image-1k-16x9",
        prompt: "a transparent product render",
        extra_body: {
          openai: {
            background: "transparent",
            output_format: "webp",
            output_compression: 72,
            input_fidelity: "high",
            moderation: "low",
          },
        },
      }),
      headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(200);
    expect(mocks.enqueueGeneration).toHaveBeenLastCalledWith(expect.objectContaining({
      model: "gpt-image-1k-16x9",
      payload: expect.objectContaining({
        kind: "image",
        protocol: "openai-images",
        aspect_ratio: "16:9",
        output_resolution: "1K",
        background: "transparent",
        output_format: "webp",
        output_compression: 72,
        input_fidelity: "high",
        moderation: "low",
      }),
    }));
  });

  it("accepts OpenAI image edits multipart with an image and mask data URL", async () => {
    const form = new FormData();
    form.set("model", "gpt-image-1k-16x9");
    form.set("prompt", "replace the sky");
    form.set("response_format", "url");
    form.set("image", new File([Buffer.from("png")], "source.png", { type: "image/png" }));
    form.set("mask", new File([Buffer.from("mask")], "mask.png", { type: "image/png" }));
    const response = await openAiImageEdits(authRequest("http://api.test/v1/images/edits", { method: "POST", body: form }));
    expect(response.status).toBe(200);
    const payload = mocks.enqueueGeneration.mock.calls[0]?.[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ protocol: "openai-edits", kind: "image", prompt: "replace the sky", response_format: "url", images: ["data:image/png;base64,cG5n"], mask: "data:image/png;base64,bWFzaw==" });
  });

  it("normalizes OpenAI edit aliases, repeated images, arrays and provider options", async () => {
    const form = new FormData();
    form.set("model", "gpt-image-1");
    form.set("prompt", "replace the sky");
    form.set("size", "1792x1024");
    form.set("quality", "high");
    form.set("output_format", "webp");
    form.set("output_compression", "72");
    form.set("background", "transparent");
    form.append("image", new File([Buffer.from("one")], "one.png", { type: "image/png" }));
    form.append("image", new File([Buffer.from("two")], "two.jpeg", { type: "image/jpeg" }));
    form.set("images", JSON.stringify(["data:image/png;base64,dGhyZWU=", "https://cdn.example/four.webp"]));
    form.set("mask", "data:image/png;base64,bWFzaw==");

    const response = await openAiImageEdits(authRequest("http://api.test/v1/images/edits", { method: "POST", body: form }));
    expect(response.status).toBe(200);
    const payload = mocks.enqueueGeneration.mock.calls[0]?.[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      protocol: "openai-edits",
      model: "gpt-image-1k-16x9",
      size: "1792x1024",
      quality: "high",
      output_format: "webp",
      output_compression: 72,
      background: "transparent",
      mask: "data:image/png;base64,bWFzaw==",
    });
    expect(payload.images).toEqual([
      "data:image/png;base64,b25l",
      "data:image/jpeg;base64,dHdv",
      "data:image/png;base64,dGhyZWU=",
      "https://cdn.example/four.webp",
    ]);
    expect(mocks.openAiImageData).toHaveBeenLastCalledWith(expect.any(Request), imageMedia, "b64_json");
    expect(mocks.validateReferenceUrls).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-image-1k-16x9", images: payload.images, mask: "data:image/png;base64,bWFzaw==" }), { total: 4, image: 4, video: 0, audio: 0 });
  });

  it("keeps missing, empty and non-image multipart inputs in the existing error style", async () => {
    const missing = new FormData();
    missing.set("model", "gpt-image-1");
    missing.set("prompt", "missing image");
    const missingResponse = await openAiImageEdits(authRequest("http://api.test/v1/images/edits", { method: "POST", body: missing }));
    expect(missingResponse.status).toBe(400);
    expect((await missingResponse.json()).error.code).toBe("invalid_request_error");

    const empty = new FormData();
    empty.set("prompt", "empty image");
    empty.set("image", new File([], "empty.png", { type: "image/png" }));
    const emptyResponse = await openAiImageEdits(authRequest("http://api.test/v1/images/edits", { method: "POST", body: empty }));
    expect(emptyResponse.status).toBe(400);
    expect((await emptyResponse.json()).error.code).toBe("media_too_large");

    const nonImage = new FormData();
    nonImage.set("prompt", "wrong type");
    nonImage.set("image", new File([Buffer.from("text")], "notes.txt", { type: "text/plain" }));
    const nonImageResponse = await openAiImageEdits(authRequest("http://api.test/v1/images/edits", { method: "POST", body: nonImage }));
    expect(nonImageResponse.status).toBe(400);
    expect((await nonImageResponse.json()).error.code).toBe("invalid_media_type");
    expect(mocks.enqueueGeneration).not.toHaveBeenCalled();
  });

  it("rejects multiple or non-image masks before enqueueing", async () => {
    const multiple = new FormData();
    multiple.set("prompt", "multiple masks");
    multiple.set("image", new File([Buffer.from("source")], "source.png", { type: "image/png" }));
    multiple.append("mask", new File([Buffer.from("one")], "one.png", { type: "image/png" }));
    multiple.append("mask", new File([Buffer.from("two")], "two.png", { type: "image/png" }));
    const multipleResponse = await openAiImageEdits(authRequest("http://api.test/v1/images/edits", { method: "POST", body: multiple }));
    expect(multipleResponse.status).toBe(400);
    expect((await multipleResponse.json()).error.code).toBe("invalid_request_error");

    const wrongType = new FormData();
    wrongType.set("prompt", "wrong mask type");
    wrongType.set("image", new File([Buffer.from("source")], "source.png", { type: "image/png" }));
    wrongType.set("mask", new File([Buffer.from("video")], "mask.mp4", { type: "video/mp4" }));
    const wrongTypeResponse = await openAiImageEdits(authRequest("http://api.test/v1/images/edits", { method: "POST", body: wrongType }));
    expect(wrongTypeResponse.status).toBe(400);
    expect((await wrongTypeResponse.json()).error.code).toBe("invalid_media_type");
    expect(mocks.enqueueGeneration).not.toHaveBeenCalled();
  });

  it("accepts OpenAI chat image and video requests with nested media references", async () => {
    const imageResponse = await openAiChat(authRequest("http://api.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-image-1k-16x9", messages: [{ role: "user", content: [{ type: "text", text: "brighten" }, { type: "image_url", image_url: { url: "https://cdn.example/ref.png" } }] }] }),
      headers: { "content-type": "application/json" },
    }));
    expect(imageResponse.status).toBe(200);
    expect(mocks.enqueueGeneration).toHaveBeenLastCalledWith(expect.objectContaining({ model: "gpt-image-1k-16x9", payload: expect.objectContaining({ kind: "image", images: ["https://cdn.example/ref.png"] }) }));

    const videoResponse = await openAiChat(authRequest("http://api.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "sora2-8s-16x9", media_type: "video", prompt: "animate", input_reference: "data:image/png;base64,cG5n" }),
      headers: { "content-type": "application/json" },
    }));
    expect(videoResponse.status).toBe(200);
    expect(mocks.enqueueGeneration).toHaveBeenLastCalledWith(expect.objectContaining({ model: "sora2-8s-16x9", payload: expect.objectContaining({ kind: "video", images: ["data:image/png;base64,cG5n"] }) }));
  });

  it("returns native Gemini image inlineData and video fileData envelopes", async () => {
    const imageResponse = await geminiGenerateContent(authRequest("http://api.test/v1beta/models/gemini-2.5-flash-image:generateContent", {
      method: "POST",
      body: JSON.stringify({ contents: [{ parts: [{ text: "watercolor" }, { inlineData: { mimeType: "image/png", data: "cG5n" } }, { fileData: { mimeType: "image/png", fileUri: "https://cdn.example/ref.png" } }] }], generationConfig: { responseModalities: ["IMAGE"] } }),
      headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ path: ["gemini-2.5-flash-image:generateContent"] }) });
    expect(imageResponse.status).toBe(200);
    expect((await imageResponse.json()).candidates[0].content.parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: "ZmFrZS1wbmc=" } });
    expect(mocks.enqueueGeneration).toHaveBeenLastCalledWith(expect.objectContaining({ model: "gpt-image-1k-16x9", payload: expect.objectContaining({ kind: "image", images: ["data:image/png;base64,cG5n", "https://cdn.example/ref.png"] }) }));

    mocks.waitForGeneration.mockResolvedValue({ job: queuedJob("gemini-video-job"), media: videoMedia[0], medias: videoMedia });
    mocks.mediaUrl.mockResolvedValue("http://api.test/generated/jobs/gemini-video-job/result-1.mp4");
    const videoResponse = await geminiGenerateContent(authRequest("http://api.test/v1beta/models/gemini-omni-8s-16x9-720p:generateContent", {
      method: "POST",
      body: JSON.stringify({ contents: [{ parts: [{ text: "make it move" }] }], generationConfig: { responseModalities: ["VIDEO"] } }),
      headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ path: ["gemini-omni-8s-16x9-720p:generateContent"] }) });
    expect(videoResponse.status).toBe(200);
    expect((await videoResponse.json()).candidates[0].content.parts[0]).toEqual({ fileData: { fileUri: "http://api.test/generated/jobs/gemini-video-job/result-1.mp4", mimeType: "video/mp4" } });
  });

  it("passes Gemini nested video options into the queued payload", async () => {
    const response = await geminiGenerateContent(authRequest("http://api.test/v1beta/models/gemini-omni-8s-16x9-720p:generateContent", {
      method: "POST",
      body: JSON.stringify({
        contents: [{ parts: [{ text: "make the camera move" }] }],
        generationConfig: {
          responseModalities: ["VIDEO"],
          videoConfig: {
            aspectRatio: "16:9",
            durationSeconds: 8,
            resolution: "720p",
            mode: "standard",
            cfgScale: 6,
            cameraControl: { type: "pan", horizontal: 0.4 },
            addWaterMark: false,
            generateLoop: true,
            transparentBackground: true,
          },
        },
      }),
      headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ path: ["gemini-omni-8s-16x9-720p:generateContent"] }) });
    expect(response.status).toBe(200);
    expect(mocks.enqueueGeneration).toHaveBeenLastCalledWith(expect.objectContaining({
      model: "gemini-omni-8s-16x9-720p",
      payload: expect.objectContaining({
        kind: "video",
        duration: 8,
        aspect_ratio: "16:9",
        resolution: "720p",
        mode: "standard",
        cfg_scale: 6,
        camera_control: { type: "pan", horizontal: 0.4 },
        watermark: false,
        loop: true,
        transparent_background: true,
      }),
    }));
  });

  it("honors Gemini candidateCount and groups multiple media parts per candidate", async () => {
    const media = [
      { objectKey: "jobs/gemini-candidates/result-1.png", mimeType: "image/png" },
      { objectKey: "jobs/gemini-candidates/result-2.png", mimeType: "image/png" },
      { objectKey: "jobs/gemini-candidates/result-3.png", mimeType: "image/png" },
      { objectKey: "jobs/gemini-candidates/result-4.png", mimeType: "image/png" },
    ];
    mocks.waitForGeneration.mockResolvedValue({ job: queuedJob("gemini-candidates-job"), media: media[0], medias: media });
    const response = await geminiGenerateContent(authRequest("http://api.test/v1beta/models/gemini-2.5-flash-image:generateContent", {
      method: "POST",
      body: JSON.stringify({
        contents: [{ parts: [{ text: "make two candidate sets" }] }],
        extra_body: { google: { image_config: { aspect_ratio: "21:9", image_size: "2K" }, generation_config: { candidate_count: 2 } } },
      }),
      headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ path: ["gemini-2.5-flash-image:generateContent"] }) });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.candidates).toHaveLength(2);
    expect(payload.candidates[0].content.parts).toHaveLength(2);
    expect(payload.candidates[1].content.parts).toHaveLength(2);
    expect(mocks.enqueueGeneration).toHaveBeenLastCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ n: 2, aspect_ratio: "21:9", output_resolution: "2K" }),
    }));
  });

  it("reads Gemini candidateCount from extra body config and camel/snake spellings", async () => {
    const variants = [
      { extra_body: { generationConfig: { candidateCount: 2 } }, expected: 2 },
      { extra_body: { generation_config: { candidate_count: 3 } }, expected: 3 },
      { extraBody: { generationConfig: { candidate_count: 4 } }, expected: 4 },
      { extraBody: { generation_config: { candidateCount: 5 } }, expected: 5 },
    ];
    for (const { expected, ...bodyVariant } of variants) {
      const response = await geminiGenerateContent(authRequest("http://api.test/v1beta/models/gemini-2.5-flash-image:generateContent", {
        method: "POST",
        body: JSON.stringify({ contents: [{ parts: [{ text: "candidate spelling" }] }], ...bodyVariant }),
        headers: { "content-type": "application/json" },
      }), { params: Promise.resolve({ path: ["gemini-2.5-flash-image:generateContent"] }) });
      expect(response.status).toBe(200);
      expect(mocks.enqueueGeneration).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ n: expected }) }));
    }
  });

  it("uses the catalog reference limit for Gemini Omni video requests", async () => {
    const response = await geminiGenerateContent(authRequest("http://api.test/v1beta/models/gemini-omni-8s-16x9-720p:generateContent", {
      method: "POST",
      body: JSON.stringify({ contents: [{ parts: [{ text: "make it move" }] }], generationConfig: { responseModalities: ["VIDEO"] } }),
      headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ path: ["gemini-omni-8s-16x9-720p:generateContent"] }) });
    expect(response.status).toBe(200);
    expect(mocks.validateReferenceUrls).toHaveBeenLastCalledWith(expect.objectContaining({ model: "gemini-omni-8s-16x9-720p", kind: "video" }), { total: 5, image: 4, video: 1, audio: 0 });
  });

  it("returns native Gemini errors with a request id and no upstream detail", async () => {
    mocks.enqueueGeneration.mockRejectedValueOnce(new AppError("adobe_upstream_temporary", "secret upstream token", 503));
    const response = await geminiGenerateContent(authRequest("http://api.test/v1beta/models/gemini-2.5-flash-image:generateContent", {
      method: "POST",
      body: JSON.stringify({ contents: [{ parts: [{ text: "error fixture" }] }], generationConfig: { responseModalities: ["IMAGE"] } }),
      headers: { "content-type": "application/json", "x-request-id": "gemini-request-123" },
    }), { params: Promise.resolve({ path: ["gemini-2.5-flash-image:generateContent"] }) });
    expect(response.status).toBe(503);
    expect(response.headers.get("x-request-id")).toBe("gemini-request-123");
    expect(await response.json()).toEqual({ error: { code: 503, message: "Upstream service temporarily unavailable", status: "UNAVAILABLE" } });
  });

  it("serves Gemini streamGenerateContent as an SSE candidate event", async () => {
    mocks.waitForGeneration.mockResolvedValue({ job: queuedJob("gemini-stream-job"), media: imageMedia[0], medias: imageMedia });
    mocks.readJobEvents
      .mockResolvedValueOnce({ cursor: 1, terminal: false, events: [{ sequence: 1, type: "QUEUED", payload: { status: "QUEUED" } }] })
      .mockResolvedValueOnce({ cursor: 2, terminal: false, events: [{ sequence: 2, type: "POLL_PROGRESS", payload: { progress: 42 } }] })
      .mockResolvedValueOnce({ cursor: 3, terminal: true, events: [{ sequence: 3, type: "SUCCEEDED", payload: { status: "SUCCEEDED" } }] });
    const response = await geminiGenerateContent(authRequest("http://api.test/v1beta/models/gemini-2.5-flash-image:streamGenerateContent", {
      method: "POST",
      body: JSON.stringify({ contents: [{ parts: [{ text: "watercolor" }] }], generationConfig: { responseModalities: ["IMAGE"] } }),
      headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ path: ["gemini-2.5-flash-image:streamGenerateContent"] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const streamBody = await response.text();
    expect(streamBody).toContain("inlineData");
    expect(streamBody).not.toContain("data: [DONE]");
    const frames = streamBody.trim().split("\n\n").filter(Boolean);
    expect(frames).toHaveLength(3);
    const payloads = frames.map((frame) => JSON.parse(frame.replace(/^data:\s*/, "")));
    expect(payloads.map((payload) => payload.adobe_event)).toEqual(["QUEUED", "POLL_PROGRESS", "SUCCEEDED"]);
    expect(payloads[1].progress).toEqual({ progress: 42 });
    const finalPayload = payloads[2];
    expect(finalPayload.candidates[0].finishReason).toBe("STOP");
  });

  it("accepts Sora JSON and multipart requests", async () => {
    const jsonResponse = await soraVideos(authRequest("http://api.test/v1/videos", {
      method: "POST",
      body: JSON.stringify({ model: "sora2-8s-16x9", prompt: "a slow pan", seconds: 8, input_reference: "https://cdn.example/ref.png" }),
      headers: { "content-type": "application/json" },
    }));
    expect(jsonResponse.status).toBe(202);
    expect(mocks.enqueueGeneration).toHaveBeenLastCalledWith(expect.objectContaining({ apiPath: "/v1/videos", payload: expect.objectContaining({ protocol: "sora", images: ["https://cdn.example/ref.png"] }) }));

    const form = new FormData();
    form.set("model", "sora2-8s-16x9");
    form.set("prompt", "a slow pan");
    form.set("seconds", "8");
    form.set("input_reference", new File([Buffer.from("png")], "reference.png", { type: "image/png" }));
    const multipartResponse = await soraVideos(authRequest("http://api.test/v1/videos", { method: "POST", body: form }));
    expect(multipartResponse.status).toBe(202);
    expect(mocks.enqueueGeneration).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ protocol: "sora", images: ["data:image/png;base64,cG5n"] }) }));
  });

  it("accepts Kling JSON and multipart image-to-video requests", async () => {
    const jsonResponse = await klingVideos(authRequest("http://api.test/kling/v1/videos/image2video", {
      method: "POST",
      body: JSON.stringify({ model_name: "kling3-5s-16x9", prompt: "a paper plane", image: "https://cdn.example/frame.png" }),
      headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ path: ["image2video"] }) });
    expect(jsonResponse.status).toBe(200);
    expect(mocks.enqueueGeneration).toHaveBeenLastCalledWith(expect.objectContaining({ apiPath: "/kling/v1/videos/image2video", payload: expect.objectContaining({ protocol: "kling", images: ["https://cdn.example/frame.png"] }) }));

    const form = new FormData();
    form.set("model_name", "kling3-5s-16x9");
    form.set("prompt", "a paper plane");
    form.set("image", new File([Buffer.from("png")], "frame.png", { type: "image/png" }));
    const multipartResponse = await klingVideos(authRequest("http://api.test/kling/v1/videos/image2video", { method: "POST", body: form }), { params: Promise.resolve({ path: ["image2video"] }) });
    expect(multipartResponse.status).toBe(200);
    expect(mocks.enqueueGeneration).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ protocol: "kling", images: ["data:image/png;base64,cG5n"] }) }));
  });

  it("accepts Kling protocol requests that select a Seedance or Jimeng model", async () => {
    const response = await klingVideos(authRequest("http://api.test/kling/v1/videos/image2video", {
      method: "POST",
      body: JSON.stringify({
        model_name: "seedance20-fast-5s-16x9-1080p",
        prompt: "a cinematic paper plane",
        image: "https://cdn.example/frame.png",
      }),
      headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ path: ["image2video"] }) });
    expect(response.status).toBe(200);
    expect(mocks.enqueueGeneration).toHaveBeenLastCalledWith(expect.objectContaining({
      apiPath: "/kling/v1/videos/image2video",
      model: "seedance20-fast-5s-16x9-1080p",
      payload: expect.objectContaining({
        protocol: "kling",
        kind: "video",
        model: "seedance20-fast-5s-16x9-1080p",
        duration: 5,
        aspect_ratio: "16:9",
        resolution: "1080p",
        images: ["https://cdn.example/frame.png"],
      }),
    }));
  });
});
