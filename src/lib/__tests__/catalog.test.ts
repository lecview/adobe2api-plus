import { DEFAULT_MODEL_ID, publicModelList, referenceLimitsForVideo, resolveImageOptions, VIDEO_MODEL_CATALOG } from "@/lib/catalog";

describe("model catalog", () => {
  it("publishes the default model and deterministic ratio options", () => {
    expect(publicModelList().some((model) => model.id === DEFAULT_MODEL_ID)).toBe(true);
    expect(resolveImageOptions({}).aspectRatio).toBe("16:9");
    expect(resolveImageOptions({ aspect_ratio: "unsupported" }).aspectRatio).toBe("16:9");
  });

  it("publishes legacy Veo reference models and exact media limits", () => {
    const refModel = VIDEO_MODEL_CATALOG["veo31-ref-4s-16x9-720p"];
    expect(refModel?.referenceMode).toBe("image");
    expect(referenceLimitsForVideo(refModel)).toMatchObject({ total: 3, image: 3, video: 0, audio: 0 });
    expect(referenceLimitsForVideo(VIDEO_MODEL_CATALOG["seedance20-4s-16x9-480p"])).toMatchObject({ total: 12, image: 9, video: 3, audio: 3 });
  });

  it("honors normalized explicit image dimensions over catalog defaults", () => {
    expect(resolveImageOptions({ model: "gpt-image-2k-16x9", aspect_ratio: "1:1", output_resolution: "1K" })).toMatchObject({ aspectRatio: "1:1", outputResolution: "1K" });
  });

  it("publishes separate Kling3 and Kling O3 resolution variants", () => {
    expect(VIDEO_MODEL_CATALOG["kling3-5s-16x9-720p"]?.resolution).toBe("720p");
    expect(VIDEO_MODEL_CATALOG["kling3-5s-16x9-1080p"]?.resolution).toBe("1080p");
    expect(VIDEO_MODEL_CATALOG["kling3-5s-16x9"]?.resolution).toBe("720p");
    expect(VIDEO_MODEL_CATALOG["kling-o3-5s-16x9-720p"]?.resolution).toBe("720p");
    expect(VIDEO_MODEL_CATALOG["kling-o3-5s-16x9-1080p"]?.resolution).toBe("1080p");
    expect(VIDEO_MODEL_CATALOG["kling-o3-5s-16x9"]?.resolution).toBe("1080p");
  });
});
