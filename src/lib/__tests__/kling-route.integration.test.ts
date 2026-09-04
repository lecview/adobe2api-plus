import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireServiceApiKey: vi.fn(),
  validateReferenceUrls: vi.fn(),
  enqueueGeneration: vi.fn(),
  findVideoJob: vi.fn(),
  videoObject: vi.fn(),
  mediaUrl: vi.fn(),
}));

vi.mock("@/lib/service-auth", () => ({ requireServiceApiKey: mocks.requireServiceApiKey }));
vi.mock("@/lib/gateway", () => ({
  validateReferenceUrls: mocks.validateReferenceUrls,
  enqueueGeneration: mocks.enqueueGeneration,
  mediaUrl: mocks.mediaUrl,
  openAiError: (message: string, type = "invalid_request_error", code?: string) => ({ error: { message, type, ...(code ? { code } : {}) } }),
}));
vi.mock("@/lib/video-response", () => ({
  findVideoJob: mocks.findVideoJob,
  videoObject: mocks.videoObject,
}));

import { POST as klingVideos } from "@/app/kling/v1/videos/[...path]/route";

const task = {
  job: {
    id: "kling-protocol-job",
    status: "QUEUED",
    model: "seedance20-fast-5s-16x9-1080p",
    createdAt: new Date("2026-08-16T00:00:00.000Z"),
    updatedAt: new Date("2026-08-16T00:00:00.000Z"),
    errorMessage: null,
  },
  media: [],
};

function request(body: BodyInit, contentType?: string) {
  return new Request("https://api.test/kling/v1/videos/text2video", {
    method: "POST",
    body,
    headers: {
      Authorization: "Bearer kling-test-key",
      ...(contentType ? { "content-type": contentType } : {}),
    },
  });
}

function params(operation = "text2video") {
  return { params: Promise.resolve({ path: [operation] }) };
}

describe("Kling protocol route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireServiceApiKey.mockResolvedValue(undefined);
    mocks.validateReferenceUrls.mockResolvedValue(undefined);
    mocks.enqueueGeneration.mockResolvedValue({ id: task.job.id });
    mocks.findVideoJob.mockResolvedValue(task);
    mocks.videoObject.mockResolvedValue({ outputs: [], seconds: 5 });
  });

  it("accepts Seedance through Kling JSON with multiple images, video, and audio references", async () => {
    const response = await klingVideos(request(JSON.stringify({
      model_name: "seedance-fast",
      prompt: "animate the paper plane",
      duration: 5,
      aspect_ratio: "16:9",
      resolution: "1080p",
      images: ["https://cdn.example/frame.png", "data:image/png;base64,cG5n"],
      videos: ["https://cdn.example/source.mp4", "data:video/mp4;base64,bXA0"],
      audios: ["https://cdn.example/sound.mp3", "data:audio/mpeg;base64,bXAz"],
      generate_audio: false,
    }), "application/json"), params());

    expect(response.status).toBe(200);
    const payload = mocks.enqueueGeneration.mock.calls[0]?.[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      protocol: "kling",
      kind: "video",
      model: "seedance20-fast-5s-16x9-1080p",
      prompt: "animate the paper plane",
      duration: 5,
      resolution: "1080p",
      generate_audio: false,
    });
    expect(payload.images).toEqual(["https://cdn.example/frame.png", "data:image/png;base64,cG5n"]);
    expect(payload.videos).toEqual(["https://cdn.example/source.mp4", "data:video/mp4;base64,bXA0"]);
    expect(payload.audios).toEqual(["https://cdn.example/sound.mp3", "data:audio/mpeg;base64,bXAz"]);
    expect(mocks.validateReferenceUrls).toHaveBeenCalledWith(payload, { total: 12, image: 9, video: 3, audio: 3, audioRequiresVisual: true });
  });

  it("accepts Seedance through Kling multipart with repeated typed files", async () => {
    const form = new FormData();
    form.set("model", "seedance-fast");
    form.set("prompt", "animate the paper plane");
    form.set("duration", "5");
    form.set("aspect_ratio", "16:9");
    form.set("resolution", "1080p");
    form.set("generate_audio", "false");
    form.append("input_reference", new File([Buffer.from("png-a")], "frame-a.png", { type: "image/png" }));
    form.append("input_reference", new File([Buffer.from("png-b")], "frame-b.png", { type: "image/png" }));
    form.append("input_video", new File([Buffer.from("mp4")], "source.mp4", { type: "video/mp4" }));
    form.append("input_audio", new File([Buffer.from("mp3-a")], "sound-a.mp3", { type: "audio/mpeg" }));
    form.append("input_audio", new File([Buffer.from("mp3-b")], "sound-b.mp3", { type: "audio/mpeg" }));

    const response = await klingVideos(request(form), params());

    expect(response.status).toBe(200);
    const payload = mocks.enqueueGeneration.mock.calls[0]?.[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ protocol: "kling", kind: "video", model: "seedance20-fast-5s-16x9-1080p", duration: 5, resolution: "1080p", generate_audio: false });
    expect(payload.images).toEqual([
      "data:image/png;base64,cG5nLWE=",
      "data:image/png;base64,cG5nLWI=",
    ]);
    expect(payload.videos).toEqual(["data:video/mp4;base64,bXA0"]);
    expect(payload.audios).toEqual([
      "data:audio/mpeg;base64,bXAzLWE=",
      "data:audio/mpeg;base64,bXAzLWI=",
    ]);
    expect(mocks.validateReferenceUrls).toHaveBeenCalledWith(payload, { total: 12, image: 9, video: 3, audio: 3, audioRequiresVisual: true });
  });

  it("keeps Kling image2video JSON compatible with canonical Seedance IDs", async () => {
    const response = await klingVideos(request(JSON.stringify({
      model: "seedance20",
      prompt: "use this frame",
      image: "https://cdn.example/frame.png",
    }), "application/json"), params("image2video"));

    expect(response.status).toBe(200);
    expect(mocks.enqueueGeneration).toHaveBeenCalledWith(expect.objectContaining({
      apiPath: "/kling/v1/videos/image2video",
      model: "seedance20",
      payload: expect.objectContaining({ protocol: "kling", requested_model: "seedance20", resolved_model: "seedance20-8s-16x9-720p", images: ["https://cdn.example/frame.png"] }),
    }));
  });
});
