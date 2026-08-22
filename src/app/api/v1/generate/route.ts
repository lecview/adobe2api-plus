import { z } from "zod";
import { requireServiceApiKey } from "@/lib/service-auth";
import { getRequestId, toErrorResponse } from "@/lib/errors";
import { enqueueGeneration, validateReferenceUrls } from "@/lib/gateway";
import { referenceLimitsForVideo, SUPPORTED_RATIOS, resolveImageModel, VIDEO_MODEL_CATALOG } from "@/lib/catalog";
import { AppError } from "@/lib/errors";

const schema = z.object({ prompt: z.string().trim().min(1).max(1200), aspect_ratio: z.string().default("16:9"), output_resolution: z.enum(["1K", "2K", "4K"]).default("2K"), model: z.string().optional() }).passthrough();

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const input = schema.parse(await request.json());
    if (!SUPPORTED_RATIOS.has(input.aspect_ratio)) throw new AppError("invalid_aspect_ratio", "Unsupported aspect_ratio", 400);
    const video = input.model ? VIDEO_MODEL_CATALOG[input.model] : undefined;
    if (input.model && !video) resolveImageModel(input.model);
    await validateReferenceUrls(input, referenceLimitsForVideo(video));
    const job = await enqueueGeneration({ apiPath: "/api/v1/generate", model: input.model, payload: input });
    return Response.json({ task_id: job.id, status: job.status.toLowerCase(), request_id: requestId }, { status: 202, headers: { "x-request-id": requestId } });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
