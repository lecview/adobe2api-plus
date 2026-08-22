import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mediaUrl: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/gateway", () => ({ mediaUrl: mocks.mediaUrl }));

import { safeMediaMimeType, videoObject } from "@/lib/video-response";

describe("video response metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mediaUrl.mockImplementation(async (_request: Request, objectKey: string) => `https://api.test/generated/${objectKey}`);
  });

  it("preserves safe output MIME types and normalized dimensions from the task snapshot", async () => {
    const result = await videoObject(new Request("https://api.test/v1/videos/job-1"), {
      job: {
        id: "job-1",
        status: "SUCCEEDED",
        model: "kling3-5s-16x9",
        createdAt: new Date("2026-08-16T00:00:00.000Z"),
        completedAt: new Date("2026-08-16T00:00:05.000Z"),
        requestPayload: { width: 1920, height: 1080, duration: 5, n: 2 },
        errorCode: null,
        errorMessage: null,
      },
      media: [
        { objectKey: "jobs/job-1/result-1.webm", mimeType: "video/webm; codecs=vp9" },
        { objectKey: "jobs/job-1/result-2.mp4", mimeType: "video/mp4" },
      ],
    } as never);

    expect(result).toMatchObject({
      seconds: 5,
      size: "1920x1080",
      output: { mime_type: "video/webm" },
      outputs: [
        { mime_type: "video/webm" },
        { mime_type: "video/mp4" },
      ],
    });
  });

  it("falls back to a safe video MIME for unknown or unsafe values", () => {
    expect(safeMediaMimeType("text/html", "video")).toBe("video/mp4");
    expect(safeMediaMimeType("video/webm; codecs=vp9", "video")).toBe("video/webm");
    expect(safeMediaMimeType(undefined, "image")).toBe("image/png");
  });
});
