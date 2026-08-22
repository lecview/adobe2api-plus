import { describe, expect, it } from "vitest";
import { extractReferenceSources, loadReferenceSources } from "@/lib/adobe/input";
import { buildImagePayloads } from "@/lib/adobe/payloads";
import { normalizeChatRequest, normalizeGeminiRequest, normalizeImageRequest, normalizeVideoRequest } from "@/lib/media-request";

describe("media protocol normalization", () => {
  it("normalizes OpenAI image generation with GPT Image dimensions and n", () => {
    const result = normalizeImageRequest({ model: "gpt-image-1k-16x9", prompt: "a glass house", n: 2, response_format: "b64_json" });
    expect(result).toMatchObject({ protocol: "openai-images", kind: "image", model: "gpt-image-1k-16x9", aspect_ratio: "16:9", output_resolution: "1K", n: 2, response_format: "b64_json" });
  });

  it("defaults OpenAI image responses to base64 while preserving explicit URLs", () => {
    expect(normalizeImageRequest({ model: "gpt-image-1", prompt: "a glass house" }).response_format).toBe("b64_json");
    expect(normalizeImageRequest({ model: "gpt-image-1", prompt: "a glass house", response_format: "url" }).response_format).toBe("url");
  });

  it("accepts the public GPT Image model alias without accepting arbitrary variants", () => {
    expect(normalizeImageRequest({ model: "gpt-image-1", prompt: "a wide studio photo" })).toMatchObject({
      model: "gpt-image-1k-16x9",
      aspect_ratio: "16:9",
      output_resolution: "1K",
    });
    expect(normalizeImageRequest({ model: "gpt_image", prompt: "an alternate alias" }).model).toBe("gpt-image-1k-16x9");
    let error: unknown;
    try {
      normalizeImageRequest({ model: "gpt-image-1-fake", prompt: "test" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "invalid_model" });
  });

  it("normalizes OpenAI chat image parts and media URLs", () => {
    const result = normalizeChatRequest({ model: "gpt-image-1k-16x9", messages: [{ role: "user", content: [{ type: "text", text: "edit this" }, { type: "image_url", image_url: { url: "https://example.com/source.png" } }] }] });
    expect(result).toMatchObject({ protocol: "openai-chat", kind: "image", prompt: "edit this", images: ["https://example.com/source.png"] });
  });

  it("normalizes Gemini contents inlineData/fileData and imageConfig", () => {
    const result = normalizeGeminiRequest("gemini-2.5-flash-image", {
      contents: [{ role: "user", parts: [{ text: "make it brighter" }, { inlineData: { mimeType: "image/png", data: "cG5n" } }, { fileData: { mimeType: "image/png", fileUri: "https://example.com/ref.png" } }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "1K" } },
    });
    expect(result).toMatchObject({ protocol: "gemini", kind: "image", model: "gpt-image-1k-16x9", prompt: "make it brighter", aspect_ratio: "16:9", output_resolution: "1K" });
    expect(result.images).toEqual(["data:image/png;base64,cG5n", "https://example.com/ref.png"]);
  });

  it("normalizes Gemini extra_body google image_config in snake and camel forms", () => {
    const snake = normalizeGeminiRequest("gemini-2.5-flash-image", {
      contents: [{ parts: [{ text: "wide watercolor" }] }],
      extra_body: { google: { image_config: { aspect_ratio: "21:9", image_size: "2K" } } },
    });
    expect(snake).toMatchObject({ aspect_ratio: "21:9", output_resolution: "2K" });

    const camel = normalizeGeminiRequest("gemini-2.5-flash-image", {
      contents: [{ parts: [{ text: "portrait watercolor" }] }],
      extraBody: { google: { imageConfig: { aspectRatio: "9:16", imageSize: "1K" } } },
    });
    expect(camel).toMatchObject({ aspect_ratio: "9:16", output_resolution: "1K" });
  });

  it("normalizes nested Gemini videoConfig in camel and snake forms", () => {
    const camel = normalizeGeminiRequest("gemini-omni-4s-9x16-1080p", {
      contents: [{ parts: [{ text: "portrait motion" }] }],
      generationConfig: {
        responseModalities: ["VIDEO"],
        videoConfig: { aspectRatio: "9:16", durationSeconds: 4, resolution: "1080p" },
      },
    });
    expect(camel).toMatchObject({ kind: "video", duration: 4, aspect_ratio: "9:16", resolution: "1080p" });

    const snake = normalizeGeminiRequest("gemini-omni-6s-9x16-720p", {
      contents: [{ parts: [{ text: "square motion" }] }],
      generation_config: {
        response_modalities: ["VIDEO"],
        video_config: { aspect_ratio: "9:16", duration_seconds: 6, video_resolution: "720p" },
      },
    });
    expect(snake).toMatchObject({ kind: "video", duration: 6, aspect_ratio: "9:16", resolution: "720p" });

    const extraBody = normalizeGeminiRequest("gemini-omni-10s-9x16-1080p", {
      contents: [{ parts: [{ text: "relay config" }] }],
      extraBody: { google: { videoConfig: { aspectRatio: "9:16", durationSeconds: 10, resolution: "1080p" } } },
    });
    expect(extraBody).toMatchObject({ kind: "video", duration: 10, aspect_ratio: "9:16", resolution: "1080p" });
  });

  it("normalizes image provider options from nested relay bodies and direct fields win", () => {
    const result = normalizeImageRequest({
      model: "gpt-image-1k-16x9",
      prompt: "a studio product photo",
      providerOptions: {
        background: "opaque",
        outputFormat: "jpeg",
        outputCompression: 35,
        inputFidelity: "low",
        moderation: "auto",
      },
      extra_body: {
        openai: {
          background: "transparent",
          output_format: "webp",
          output_compression: 81,
          input_fidelity: "high",
          moderation: "low",
        },
      },
      background: "transparent",
      output_format: "png",
    });

    expect(result).toMatchObject({
      background: "transparent",
      output_format: "png",
      output_compression: 81,
      input_fidelity: "high",
      moderation: "low",
    });
  });

  it("normalizes Kling video provider options in camel and snake forms", () => {
    const result = normalizeVideoRequest({
      model_name: "kling3-5s-16x9",
      prompt: "a paper plane over the ocean",
      providerOptions: {
        mode: "standard",
        cfgScale: 6,
        cameraControl: { type: "pan", horizontal: 0.4 },
        addWaterMark: false,
        generateLoop: true,
        transparentBackground: true,
      },
      cfg_scale: 7,
      camera_control: { type: "tilt", vertical: -0.2 },
    }, "kling", "text2video");

    expect(result).toMatchObject({
      mode: "standard",
      cfg_scale: 7,
      camera_control: { type: "tilt", vertical: -0.2 },
      watermark: false,
      loop: true,
      transparent_background: true,
    });
  });

  it("returns a stable 400 error for unsupported media extension values", () => {
    const cases: Array<{ body: unknown; field: string }> = [
      {
        body: { model: "gpt-image-1k-16x9", prompt: "invalid", output_format: "gif" },
        field: "output_format",
      },
      {
        body: { model: "gpt-image-1k-16x9", prompt: "invalid", output_compression: 101 },
        field: "output_compression",
      },
      {
        body: { model_name: "kling3-5s-16x9", prompt: "invalid", cfg_scale: 31 },
        field: "cfg_scale",
      },
      {
        body: { model_name: "kling3-5s-16x9", prompt: "invalid", camera_control: "pan" },
        field: "camera_control",
      },
    ];

    for (const { body, field } of cases) {
      let error: unknown;
      try {
        if ("model_name" in (body as Record<string, unknown>)) normalizeVideoRequest(body, "kling", "text2video");
        else normalizeImageRequest(body);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "unsupported_media_parameter", status: 400, details: { field } });
    }
  });

  it("rejects unknown image provider aliases instead of falling back to GPT Image", () => {
    for (const model of ["gpt-image-fake", "gpt-image-9k-99x99", "nano-banana-fake", "gemini-2.5-flash-image-unknown"]) {
      let error: unknown;
      try {
        normalizeImageRequest({ model, prompt: "test" });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "invalid_model", status: 400 });
    }

    expect(normalizeImageRequest({ model: "gpt-image", prompt: "test" }).model).toBe("gpt-image-1k-16x9");
    expect(normalizeImageRequest({ model: "nano-banana-pro", prompt: "test" }).model).toBe("nano-banana-pro-2k-16x9");
    expect(normalizeImageRequest({ model: "firefly-gpt-image-1k-16x9", prompt: "test" }).model).toBe("gpt-image-1k-16x9");
  });

  it("normalizes Sora JSON and accepts image references", () => {
    const result = normalizeVideoRequest({ prompt: "a slow pan", model: "sora2-8s-16x9", seconds: 8, size: "1920x1080", input_reference: "https://example.com/ref.png" }, "sora");
    expect(result).toMatchObject({ protocol: "sora", kind: "video", model: "sora2-8s-16x9", duration: 8, aspect_ratio: "16:9", images: ["https://example.com/ref.png"] });
  });

  it("keeps Kling protocol independent from a Seedance model", () => {
    const result = normalizeVideoRequest({ model_name: "seedance20-fast-5s-16x9-1080p", prompt: "a paper plane", image: "https://example.com/first.png" }, "kling", "image2video");
    expect(result).toMatchObject({ protocol: "kling", kind: "video", model: "seedance20-fast-5s-16x9-1080p", images: ["https://example.com/first.png"], duration: 5 });
  });

  it("maps image size to 1K, falls back auto to 1:1, and keeps mask separate", () => {
    const result = normalizeImageRequest({
      model: "gpt-image-2k-16x9",
      prompt: "edit this",
      size: "1024x1024",
      aspect_ratio: "auto",
      images: ["data:image/png;base64,cG5n"],
      mask: { image_url: { url: "data:image/png;base64,bWFzaw==" } },
    }, "openai-edits");
    expect(result).toMatchObject({ aspect_ratio: "1:1", output_resolution: "1K", images: ["data:image/png;base64,cG5n"], mask: "data:image/png;base64,bWFzaw==" });
  });

  it("prefers an explicit aspect ratio over a conflicting size ratio", () => {
    const result = normalizeImageRequest({ model: "gpt-image-1k-16x9", prompt: "wide", size: "1024x1024", aspect_ratio: "16:9" });
    expect(result).toMatchObject({ aspect_ratio: "16:9", output_resolution: "1K" });
  });

  it("collects multiple image and video references from chat parts", () => {
    const result = normalizeChatRequest({
      model: "gemini-omni-4s-16x9-720p",
      messages: [{ role: "user", content: [
        { type: "text", text: "animate these" },
        { type: "image_url", image_url: { url: "https://example.com/one.png" } },
        { type: "image_url", image_url: { url: "https://example.com/two.png" } },
        { type: "video_url", video_url: { url: "https://example.com/source.mp4" } },
      ] }],
    });
    expect(result.images).toEqual(["https://example.com/one.png", "https://example.com/two.png"]);
    expect(result.videos).toEqual(["https://example.com/source.mp4"]);
  });

  it("does not treat a plain Responses-style input string as a media reference", () => {
    const result = normalizeChatRequest({ model: "gpt-image-1k-16x9", input: "make a clean product photo" });
    expect(result).toMatchObject({ prompt: "make a clean product photo", images: [], videos: [], audios: [] });
  });

  it("infers mixed media from typed wrappers, raw base64 data, and URL extensions", () => {
    const result = normalizeChatRequest({
      model: "seedance20-5s-16x9-720p",
      input: [
        { type: "input_text", text: "animate these" },
        { type: "image", mime_type: "image/avif", data: "aW1hZ2U=" },
        { type: "video", mime_type: "video/x-matroska", source: { base64: "dmlkZW8=" } },
        { type: "audio", url: "https://cdn.example/sound.flac" },
      ],
    });
    expect(result).toMatchObject({ kind: "video", prompt: "animate these" });
    expect(result.images).toEqual(["data:image/avif;base64,aW1hZ2U="]);
    expect(result.videos).toEqual(["data:video/x-matroska;base64,dmlkZW8="]);
    expect(result.audios).toEqual(["https://cdn.example/sound.flac"]);
  });

  it("keeps explicit Kling dimensions and candidate count in the normalized request", () => {
    const result = normalizeVideoRequest({
      model: "kling3-5s-16x9",
      prompt: "a paper plane",
      width: 1920,
      height: 1080,
      n: 2,
    }, "kling", "text2video");
    expect(result).toMatchObject({ duration: 5, aspect_ratio: "16:9", resolution: "1080p", width: 1920, height: 1080, n: 2 });
  });

  it("uses data URL MIME types when multipart references share one field", () => {
    const result = normalizeVideoRequest({
      model: "seedance20-fast-5s-16x9-1080p",
      prompt: "animate the references",
      input_reference: [
        "data:image/png;base64,cG5n",
        "data:video/mp4;base64,bXA0",
      ],
    }, "sora");
    expect(result.images).toEqual(["data:image/png;base64,cG5n"]);
    expect(result.videos).toEqual(["data:video/mp4;base64,bXA0"]);
  });

  it("retains a mask when the ordinary reference limit is reached", async () => {
    const payload = {
      images: ["data:image/png;base64,cG5n", "data:image/png;base64,cG5nMg=="],
      videos: ["data:video/mp4;base64,dm"],
      mask: "data:image/png;base64,bQ==",
    };
    expect(extractReferenceSources(payload, 2)).toMatchObject([
      { kind: "image" },
      { kind: "image", purpose: "mask" },
    ]);
    const loaded = await loadReferenceSources(payload, 2);
    expect(loaded.map((media) => ({ kind: media.kind, purpose: media.purpose }))).toEqual([
      { kind: "image", purpose: undefined },
      { kind: "image", purpose: "mask" },
    ]);
  });

  it("maps an uploaded mask to an Adobe mask reference", () => {
    const [payload] = buildImagePayloads({ modelId: "nano-banana-pro-1k-1x1", prompt: "edit", sourceImageIds: ["image-id"], maskId: "mask-id" });
    expect(payload).toMatchObject({ generationMetadata: { module: "image2image" }, referenceBlobs: [{ id: "image-id", usage: "general" }, { id: "mask-id", usage: "mask" }] });
  });
});
