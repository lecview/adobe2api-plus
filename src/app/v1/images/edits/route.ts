import { requireServiceApiKey } from "@/lib/service-auth";
import { AppError, errorType, getRequestId, toErrorResponse } from "@/lib/errors";
import { enqueueGeneration, openAiError, validateReferenceUrls, waitForGeneration } from "@/lib/gateway";
import { fileToDataUrl, normalizeImageRequest } from "@/lib/media-request";
import { openAiImageData } from "@/lib/media-response";

// 编辑上传的参考源图：放宽容忍大尺寸 PNG（2K/4K 源图常超几 MB），与生成分辨率无关
const MAX_EDIT_IMAGE_BYTES = 20 * 1024 * 1024;

// OpenAI 客户端会重复提交 `image`，中继服务也常使用 `images` 或现有内部引用字段。
// 统一收集到内部 `images` 数组后再执行媒体校验。
const IMAGE_FORM_FIELDS = new Set([
  "image",
  "images",
  "image_url",
  "image_urls",
  "imageurl",
  "imageurls",
  "input",
  "input_image",
  "input_images",
  "inputimage",
  "inputimages",
  "input_reference",
  "inputreference",
  "media",
  "assets",
  "reference",
  "references",
  "reference_image",
  "reference_images",
  "referenceimage",
  "referenceimages",
  "image_references",
  "imagereferences",
  "source_image",
  "source_images",
  "sourceimage",
  "sourceimages",
]);

const STRUCTURED_FORM_FIELDS = new Set([
  "extra_body",
  "extrabody",
  "provider_options",
  "provideroptions",
  "openai",
  "google",
  "generation_config",
  "generationconfig",
  "image_config",
  "imageconfig",
  "metadata",
]);

function formFieldBaseName(key: string): string {
  return key.trim().toLowerCase().replace(/\[\d*\]$/, "");
}

function isImageFormField(key: string): boolean {
  return IMAGE_FORM_FIELDS.has(formFieldBaseName(key));
}

function isMaskFormField(key: string): boolean {
  return formFieldBaseName(key) === "mask";
}

function isFile(value: unknown): value is File {
  return typeof File !== "undefined" && value instanceof File;
}

function parseStructuredFormValue(key: string, value: string): unknown {
  const normalizedKey = formFieldBaseName(key);
  const trimmed = value.trim();
  if (!STRUCTURED_FORM_FIELDS.has(normalizedKey) || !/^[\[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function parseMediaFormValue(value: string): unknown {
  const trimmed = value.trim();
  if (!/^[\[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

async function normalizeMultipartMediaValue(value: unknown): Promise<unknown> {
  if (isFile(value)) return fileToDataUrl(value, { kind: "image", maxBytes: MAX_EDIT_IMAGE_BYTES });
  if (Array.isArray(value)) return Promise.all(value.map((item) => normalizeMultipartMediaValue(item)));
  if (value && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) normalized[key] = await normalizeMultipartMediaValue(child);
    return normalized;
  }
  return value;
}

function appendFormValue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (target[key] === undefined) {
    target[key] = value;
    return;
  }
  target[key] = Array.isArray(target[key]) ? [...target[key] as unknown[], value] : [target[key], value];
}

async function parseEditMultipartForm(form: FormData): Promise<{ body: Record<string, unknown>; hasMask: boolean }> {
  const body: Record<string, unknown> = {};
  const imageValues: unknown[] = [];
  const maskValues: unknown[] = [];

  for (const [key, value] of form.entries()) {
    if (isImageFormField(key)) {
      imageValues.push(await normalizeMultipartMediaValue(typeof value === "string" ? parseMediaFormValue(value) : value));
      continue;
    }
    if (isMaskFormField(key)) {
      maskValues.push(await normalizeMultipartMediaValue(typeof value === "string" ? parseMediaFormValue(value) : value));
      continue;
    }
    if (typeof value === "string") appendFormValue(body, key, parseStructuredFormValue(key, value));
  }

  if (maskValues.length > 1) throw new AppError("invalid_request_error", "mask must contain one image", 400);
  body.images = imageValues;
  if (maskValues.length === 1) body.mask = maskValues[0];
  return { body, hasMask: maskValues.length === 1 };
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    if (!request.headers.get("content-type")?.toLowerCase().includes("multipart/form-data")) throw new AppError("invalid_request_error", "images/edits requires multipart/form-data", 400);
    const form = await request.formData();
    const { body, hasMask } = await parseEditMultipartForm(form);
    if (body.model === undefined) body.model = "gpt-image-1k-16x9";
    const input = normalizeImageRequest(body, "openai-edits");
    if (!input.images.length) throw new AppError("invalid_request_error", "image is required", 400);
    if (input.videos.length || input.audios.length) throw new AppError("invalid_media_type", "Image references must be images", 400);
    if (hasMask && !input.mask) throw new AppError("invalid_request_error", "mask must contain one image", 400);
    await validateReferenceUrls(input, { total: 4, image: 4, video: 0, audio: 0 });
    const job = await enqueueGeneration({ apiPath: "/v1/images/edits", model: input.model, payload: input });
    const result = await waitForGeneration(job.id);
    const data = await openAiImageData(request, result.medias, input.response_format);
    return Response.json({ created: Math.floor(Date.now() / 1000), model: input.model, data }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AppError && error.status < 500) return Response.json(openAiError(error.message, errorType(error), error.code), { status: error.status, headers: { "x-request-id": requestId } });
    return toErrorResponse(error, requestId);
  }
}
