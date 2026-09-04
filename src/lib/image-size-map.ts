export type ImageResolutionTier = "1K" | "2K" | "4K";

export type ImageSizeSpec = {
  aspectRatio: string;
  outputResolution: ImageResolutionTier;
};

const rows: Array<[string, string, string, string]> = [
  ["1:1", "1024x1024", "2048x2048", "2880x2880"],
  ["5:4", "1120x896", "2240x1792", "3200x2560"],
  ["4:3", "1152x864", "2304x1728", "3264x2448"],
  ["3:2", "1248x832", "2496x1664", "3504x2336"],
  ["16:9", "1280x720", "2560x1440", "3840x2160"],
  ["21:9", "1456x624", "3024x1296", "3696x1584"],
  ["4:5", "896x1120", "1792x2240", "2560x3200"],
  ["3:4", "864x1152", "1728x2304", "2448x3264"],
  ["2:3", "832x1248", "1664x2496", "2336x3504"],
  ["9:16", "720x1280", "1440x2560", "2160x3840"],
];

export const IMAGE_SIZE_MAP: Readonly<Record<string, ImageSizeSpec>> = Object.freeze(Object.fromEntries(
  rows.flatMap(([aspectRatio, oneK, twoK, fourK]) => [
    [oneK, { aspectRatio, outputResolution: "1K" as const }],
    [twoK, { aspectRatio, outputResolution: "2K" as const }],
    [fourK, { aspectRatio, outputResolution: "4K" as const }],
  ]),
));

export function imageSpecFromSize(value: unknown): ImageSizeSpec | undefined {
  if (typeof value !== "string") return undefined;
  return IMAGE_SIZE_MAP[value.trim().toLowerCase().replace("×", "x")];
}
