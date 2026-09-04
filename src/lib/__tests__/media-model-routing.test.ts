import { describe, expect, it } from "vitest";
import { publicModelList } from "@/lib/catalog";
import { IMAGE_SIZE_MAP } from "@/lib/image-size-map";
import { normalizePublicModels, PUBLIC_MEDIA_MODELS, resolveMediaRouting } from "@/lib/media-model-routing";
import { normalizeChatRequest, normalizeGeminiRequest, normalizeImageRequest, normalizeVideoRequest } from "@/lib/media-request";

describe("canonical media model routing", () => {
  it("publishes only the 13 stable families", () => {
    expect(publicModelList().map((model) => model.id)).toEqual(PUBLIC_MEDIA_MODELS);
    expect(publicModelList().every((model) => !/(?:^|-)(?:1k|2k|4k|\d+s|480p|720p|1080p|\d+x\d+)(?:-|$)/i.test(model.id))).toBe(true);
  });

  it("normalizes legacy public settings in prefix-safe order", () => {
    expect(normalizePublicModels([
      "gpt-image-4k-4x3", "nano-banana-pro-2k-16x9", "nano-banana-2k-16x9",
      "sora2-pro-12s-9x16", "sora2-8s-16x9", "veo31-ref-6s-16x9-1080p",
      "seedance20-fast-12s-9x16-1080p", "seedance20-8s-16x9-720p",
    ])).toEqual(["gpt-image-2", "nano-banana-pro", "nano-banana", "sora2-pro", "sora2", "veo31-ref", "seedance20-fast", "seedance20"]);
  });

  it("uses the shared exact image size map for ratio and tier", () => {
    expect(Object.keys(IMAGE_SIZE_MAP)).toHaveLength(30);
    expect(resolveMediaRouting({ model: "gpt-image-2", size: "3840x2160", quality: "low" }, "image")).toMatchObject({
      requestedModel: "gpt-image-2", resolvedModel: "gpt-image-4k-16x9", aspectRatio: "16:9", outputResolution: "4K", quality: "low",
    });
    expect(resolveMediaRouting({ model: "nano-banana-pro", size: "3264x2448" }, "image").resolvedModel).toBe("nano-banana-pro-4k-4x3");
    expect(resolveMediaRouting({ model: "nano-banana2", aspect_ratio: "1:8", output_resolution: "2K" }, "image").resolvedModel).toBe("nano-banana2-2k-1x8");
  });

  it("keeps quality independent from resolution", () => {
    for (const quality of ["low", "medium", "high"]) {
      expect(resolveMediaRouting({ model: "gpt-image-2", quality }, "image").resolvedModel).toBe("gpt-image-1k-16x9");
    }
  });

  it.each([
    [{ model: "gpt-image-2", size: "3840x2160", output_resolution: "2K" }, "invalid_size"],
    [{ model: "gpt-image-2", size: "1234x987" }, "invalid_size"],
    [{ model: "gpt-image-4k-4x3", aspect_ratio: "16:9" }, "invalid_aspect_ratio"],
    [{ model: "nano-banana", aspect_ratio: "1:8" }, "invalid_aspect_ratio"],
  ])("rejects invalid image parameters before enqueue", (input, code) => {
    expect(() => resolveMediaRouting(input, "image")).toThrowError(expect.objectContaining({ code, status: 400 }));
  });

  it("keeps legacy image variants fixed", () => {
    expect(resolveMediaRouting({ model: "firefly-gpt-image-4k-4x3" }, "image")).toMatchObject({ requestedModel: "gpt-image-2", resolvedModel: "gpt-image-4k-4x3", aspectRatio: "4:3", outputResolution: "4K" });
  });

  it.each([
    ["sora2-pro", { duration: 12, aspect_ratio: "9:16" }, "sora2-pro-12s-9x16"],
    ["veo31-ref", { duration: 6, resolution: "1080p" }, "veo31-ref-6s-16x9-1080p"],
    ["gemini-omni", { duration: 10, resolution: "720p" }, "gemini-omni-10s-16x9-720p"],
    ["kling3", { duration: 15, resolution: "1080p" }, "kling3-15s-16x9-1080p"],
    ["kling-o3", {}, "kling-o3-5s-16x9-1080p"],
    ["seedance20-fast", { duration: 4 }, "seedance20-fast-4s-16x9-720p"],
    ["seedance20-fast", { duration: 15, aspect_ratio: "9:16", resolution: "1080p" }, "seedance20-fast-15s-9x16-1080p"],
  ])("resolves %s capabilities", (model, options, expected) => {
    expect(resolveMediaRouting({ model, ...options }, "video").resolvedModel).toBe(expected);
  });

  it.each([
    { model: "sora2", resolution: "720p" },
    { model: "kling3", duration: 8 },
    { model: "veo31", aspect_ratio: "4:3" },
    { model: "seedance20", duration: 16 },
    { model: "gemini-omni", resolution: "480p" },
    { model: "veo31-6s-16x9-1080p", duration: 8 },
  ])("rejects unsupported video parameters before enqueue: $model", (input) => {
    expect(() => resolveMediaRouting(input, "video")).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("resolves identical parameters consistently across protocol entry points", () => {
    const image = { model: "gpt-image-2", prompt: "offline fixture", aspect_ratio: "4:3", output_resolution: "4K" };
    expect(new Set([
      normalizeImageRequest(image).resolved_model,
      normalizeChatRequest(image).resolved_model,
      normalizeGeminiRequest("gpt-image-2", image).resolved_model,
    ])).toEqual(new Set(["gpt-image-4k-4x3"]));

    const video = { model: "seedance20-fast", prompt: "offline fixture", duration: 10, aspect_ratio: "9:16", resolution: "1080p", media_type: "video" };
    expect(new Set([
      normalizeVideoRequest(video, "sora").resolved_model,
      normalizeChatRequest(video).resolved_model,
      normalizeGeminiRequest("seedance20-fast", video).resolved_model,
    ])).toEqual(new Set(["seedance20-fast-10s-9x16-1080p"]));
  });
});
