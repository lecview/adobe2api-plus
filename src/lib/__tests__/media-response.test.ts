import { describe, expect, it } from "vitest";
import { canonicalProtocolModelId, parseVideoMultipartBody } from "@/lib/media-response";

describe("media response protocol compatibility", () => {
  it("maps legacy and provider Seedance IDs to the canonical catalog", () => {
    expect(canonicalProtocolModelId("firefly-seedance20-fast-5s-9x16-1080p", {}, "video")).toBe("seedance20-fast-5s-9x16-1080p");
    expect(canonicalProtocolModelId("seedance", { duration: 5, aspect_ratio: "16:9", resolution: "1080p" }, "video")).toBe("seedance20-5s-16x9-1080p");
    expect(canonicalProtocolModelId("seedance-fast", { durationSeconds: 15, aspectRatio: "3:4", videoResolution: "1080p" }, "video")).toBe("seedance20-fast-15s-3x4-1080p");
    expect(canonicalProtocolModelId("sora", { seconds: 8, size: "1920x1080" }, "video")).toBe("sora2-8s-16x9");
    expect(canonicalProtocolModelId("kling-o3", { duration: 15, aspect_ratio: "9:16" }, "video")).toBe("kling-o3-15s-9x16");
    expect(canonicalProtocolModelId("gemini-2.5-flash", { generationConfig: { responseModalities: ["VIDEO"] }, duration: 8 }, "gemini")).toBe("gemini-omni-8s-16x9-720p");
  });

  it("uses nested Gemini video config in camel and snake case", () => {
    expect(canonicalProtocolModelId("gemini-2.5-flash", {
      generationConfig: {
        responseModalities: ["VIDEO"],
        videoConfig: { aspectRatio: "9:16", durationSeconds: 4, resolution: "1080p" },
      },
    }, "gemini")).toBe("gemini-omni-4s-9x16-1080p");

    expect(canonicalProtocolModelId("gemini-2.5-flash", {
      generation_config: {
        response_modalities: ["VIDEO"],
        video_config: { aspect_ratio: "9:16", duration_seconds: 6, video_resolution: "720p" },
      },
    }, "gemini")).toBe("gemini-omni-6s-9x16-720p");

    expect(canonicalProtocolModelId("gemini-2.5-flash", {
      extraBody: { google: { videoConfig: { aspectRatio: "9:16", durationSeconds: 10, resolution: "1080p" } } },
    }, "gemini")).toBe("gemini-omni-10s-9x16-1080p");
  });

  it("parses multipart JSON fields and multiple typed media files", async () => {
    const form = new FormData();
    form.set("prompt", "make a paper plane");
    form.set("seconds", "8");
    form.set("generate_audio", "false");
    form.append("input_reference", new File([Buffer.from("png")], "frame.png", { type: "image/png" }));
    form.append("input_reference", new File([Buffer.from("mp4")], "source.mp4", { type: "video/mp4" }));
    form.append("input_reference", new File([Buffer.from("mkv")], "source.mkv", { type: "application/octet-stream" }));
    form.append("input_audio", new File([Buffer.from("mp3")], "sound.mp3", { type: "audio/mpeg" }));

    const body = await parseVideoMultipartBody(new Request("https://api.test/v1/videos", { method: "POST", body: form }));
    expect(body.prompt).toBe("make a paper plane");
    expect(body.seconds).toBe(8);
    expect(body.generate_audio).toBe(false);
    expect(body.input_reference).toEqual([
      "data:image/png;base64,cG5n",
      "data:video/mp4;base64,bXA0",
      "data:video/x-matroska;base64,bWt2",
    ]);
    expect(body.input_audio).toBe("data:audio/mpeg;base64,bXAz");
  });
});
