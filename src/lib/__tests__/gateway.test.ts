import { validateReferenceUrls } from "@/lib/gateway";

describe("gateway reference limits", () => {
  const image = "data:image/png;base64,cG5n";
  const video = "data:video/mp4;base64,TVA=";
  const audio = "data:audio/mpeg;base64,TVA=";

  it("enforces per-kind and total model limits before upload", async () => {
    await expect(validateReferenceUrls({ images: [image, image, image] }, { total: 3, image: 2, video: 0, audio: 0 })).rejects.toMatchObject({ code: "invalid_reference_count" });
    await expect(validateReferenceUrls({ images: [image, image], videos: [video, video] }, { total: 3, image: 2, video: 2, audio: 0 })).rejects.toMatchObject({ code: "invalid_reference_count" });
  });

  it("requires a visual reference when audio references are used", async () => {
    await expect(validateReferenceUrls({ audios: [audio] }, { total: 12, image: 9, video: 3, audio: 3, audioRequiresVisual: true })).rejects.toMatchObject({ code: "invalid_reference_count" });
    await expect(validateReferenceUrls({ images: [image], audios: [audio] }, { total: 12, image: 9, video: 3, audio: 3, audioRequiresVisual: true })).resolves.toBeUndefined();
  });

  it("counts a direct mask as an image reference and validates its remote URL", async () => {
    await expect(validateReferenceUrls({ images: [image, image, image, image], mask: image }, { total: 4, image: 4, video: 0, audio: 0 })).rejects.toMatchObject({ code: "invalid_reference_count" });
    await expect(validateReferenceUrls({ mask: { image_url: { url: image } } }, 1)).resolves.toBeUndefined();
    await expect(validateReferenceUrls({ mask: "http://127.0.0.1/mask.png" }, 1)).rejects.toMatchObject({ code: "blocked_media_url" });
  });
});
