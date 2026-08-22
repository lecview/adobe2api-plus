import { describe, expect, it } from "vitest";
import { extensionForMime } from "@/lib/worker/processor";

describe("worker media extension mapping", () => {
  it.each([
    ["image/png", "image", "png"],
    ["IMAGE/JPEG", "image", "jpg"],
    ["image/webp; quality=lossless", "image", "webp"],
    ["image/avif", "image", "avif"],
    ["image/gif", "image", "gif"],
    ["video/mp4", "video", "mp4"],
    ["video/webm; codecs=vp9", "video", "webm"],
    ["video/quicktime", "video", "mov"],
    ["video/x-matroska", "video", "mkv"],
  ])("maps %s to a safe %s extension", (mimeType, kind, extension) => {
    expect(extensionForMime(mimeType, kind as "image" | "video")).toBe(extension);
  });

  it("falls back by media kind for unknown or unsafe MIME values", () => {
    expect(extensionForMime("text/html", "image")).toBe("png");
    expect(extensionForMime("image/svg+xml", "image")).toBe("png");
    expect(extensionForMime("video/unknown", "video")).toBe("mp4");
    expect(extensionForMime("video/mp4\r\nContent-Type: text/html", "video")).toBe("mp4");
  });
});
