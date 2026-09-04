import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mediaUrl: vi.fn(),
  readMediaBytes: vi.fn(),
}));

vi.mock("@/lib/gateway", () => ({ mediaUrl: mocks.mediaUrl }));
vi.mock("@/lib/media", () => ({ readMediaBytes: mocks.readMediaBytes }));

import { geminiMediaParts, openAiChatContentParts, openAiImageData } from "@/lib/media-response";

const image = { objectKey: "jobs/job/image.webp", mimeType: "image/webp" };
const video = { objectKey: "jobs/job/video.mov", mimeType: "video/quicktime" };
const audio = { objectKey: "jobs/job/audio.flac", mimeType: "audio/flac" };

describe("media response conversion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mediaUrl.mockImplementation((_request: Request, objectKey: string) => Promise.resolve(`https://api.test/generated/${objectKey}`));
    mocks.readMediaBytes.mockImplementation(async (objectKey: string) => {
      const values: Record<string, { bytes: Uint8Array; mimeType: string }> = {
        [image.objectKey]: { bytes: new Uint8Array([1, 2, 3]), mimeType: image.mimeType },
        [video.objectKey]: { bytes: new Uint8Array([4, 5]), mimeType: video.mimeType },
        [audio.objectKey]: { bytes: new Uint8Array([6]), mimeType: audio.mimeType },
      };
      return values[objectKey];
    });
  });

  it("returns URLs or base64 bytes for OpenAI image responses", async () => {
    const request = new Request("https://api.test/v1/images/generations");
    await expect(openAiImageData(request, [image], "url")).resolves.toEqual([{ url: "https://api.test/generated/jobs/job/image.webp" }]);
    await expect(openAiImageData(request, [image], "b64_json")).resolves.toEqual([{ b64_json: "AQID" }]);
  });

  it("passes through remote URLs even when a compatible caller requests b64_json", async () => {
    const request = new Request("https://api.test/v1/images/generations");
    const remote = { ...image, url: "https://cdn.example/result.webp" };
    await expect(openAiImageData(request, [remote], "b64_json")).resolves.toEqual([{ url: remote.url }]);
    expect(mocks.readMediaBytes).not.toHaveBeenCalled();
  });

  it("preserves image, video, and audio MIME families in typed chat parts", async () => {
    const parts = await openAiChatContentParts(new Request("https://api.test/v1/chat/completions"), [image, video, audio]);
    expect(parts).toEqual([
      { type: "image_url", image_url: { url: "https://api.test/generated/jobs/job/image.webp" } },
      { type: "video_url", video_url: { url: "https://api.test/generated/jobs/job/video.mov" } },
      { type: "audio_url", audio_url: { url: "https://api.test/generated/jobs/job/audio.flac" } },
    ]);
  });

  it("uses inlineData for images and fileData URLs for non-image Gemini media", async () => {
    const parts = await geminiMediaParts(new Request("https://api.test/v1beta/models/generateContent"), [image, video, audio]);
    expect(parts).toEqual([
      { inlineData: { mimeType: "image/webp", data: "AQID" } },
      { fileData: { fileUri: "https://api.test/generated/jobs/job/video.mov", mimeType: "video/quicktime" } },
      { fileData: { fileUri: "https://api.test/generated/jobs/job/audio.flac", mimeType: "audio/flac" } },
    ]);
  });
});

