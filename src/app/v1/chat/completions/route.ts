import { requireServiceApiKey } from "@/lib/service-auth";
import { AppError, errorType, getRequestId, toErrorResponse } from "@/lib/errors";
import { referenceLimitsForVideo, VIDEO_MODEL_CATALOG, resolveImageOptions } from "@/lib/catalog";
import { enqueueGeneration, openAiError, validateReferenceUrls, waitForGeneration } from "@/lib/gateway";
import { isVideoRequested, normalizeChatRequest } from "@/lib/media-request";
import { readJobEvents } from "@/lib/jobs";
import { canonicalProtocolModelId, openAiChatContentParts, openAiChatText, withCanonicalProtocolModel } from "@/lib/media-response";

type ChatResult = Awaited<ReturnType<typeof waitForGeneration>>;

function objectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contentPartsRequested(body: Record<string, unknown>): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some((message) => {
    const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
    return Array.isArray(content);
  });
}

function isVideoRequest(body: Record<string, unknown>): boolean {
  const modalityVideo = isVideoRequested(body);
  const candidate = typeof body.model === "string" ? body.model : "";
  const canonical = canonicalProtocolModelId(candidate, body, "video");
  return modalityVideo || Boolean(VIDEO_MODEL_CATALOG[candidate] || VIDEO_MODEL_CATALOG[candidate.replace(/^firefly-/i, "")] || (canonical && VIDEO_MODEL_CATALOG[canonical]));
}

async function chatChoices(request: Request, result: ChatResult, useContentParts: boolean) {
  const parts = await openAiChatContentParts(request, result.medias);
  return parts.map((part, index) => ({
    index,
    message: {
      role: "assistant",
      content: useContentParts ? [part] : openAiChatText(part),
      // This additive field gives multimodal clients the typed representation
      // while keeping the legacy markdown/string content contract available.
      content_parts: [part],
    },
    finish_reason: "stop",
  }));
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const body = objectBody(await request.json());
    const normalizedBody = withCanonicalProtocolModel(body, isVideoRequest(body) ? "video" : "image");
    if (isVideoRequested(body)) normalizedBody.media_type = "video";
    const input = normalizeChatRequest(normalizedBody);
    const video = input.kind === "video" ? VIDEO_MODEL_CATALOG[input.model] : undefined;
    // GPT Image 质量默认 high（原 gptImageQuality 系统配置已移除）。
    const imageOptions = video ? undefined : resolveImageOptions({ model: input.model, aspect_ratio: input.aspect_ratio, size: input.size as string | undefined, quality: typeof input.quality === "string" ? input.quality : "high", output_resolution: input.output_resolution });
    await validateReferenceUrls(input, referenceLimitsForVideo(video));
    const model = video ?? imageOptions!.model;
    const job = await enqueueGeneration({ apiPath: "/v1/chat/completions", model: model.id, payload: { ...input, quality: input.quality ?? "high", resolved_video: video ?? null, resolved_aspect_ratio: input.aspect_ratio, resolved_output_resolution: imageOptions?.outputResolution } });
    const useContentParts = contentPartsRequested(body);
    if (input.stream === true) return streamCompletion(request, job.id, model.id, requestId, useContentParts);
    const result = await waitForGeneration(job.id);
    return Response.json({ id: `chatcmpl-${job.id}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: model.id, choices: await chatChoices(request, result, useContentParts), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof AppError && error.status < 500) return Response.json(openAiError(error.message, errorType(error), error.code), { status: error.status, headers: { "x-request-id": requestId } });
    return toErrorResponse(error, requestId);
  }
}

function streamCompletion(request: Request, jobId: string, model: string, requestId: string, useContentParts: boolean): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: `chatcmpl-${jobId}`, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`));
        let cursor = Number(request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after_sequence") ?? 0) || 0;
        let terminal = false;
        while (!terminal) {
          const batch = await readJobEvents(jobId, cursor, 120_000);
          cursor = batch.cursor;
          terminal = batch.terminal;
          for (const event of batch.events) controller.enqueue(encoder.encode(`id: ${event.sequence}\ndata: ${JSON.stringify({ id: `chatcmpl-${jobId}`, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: event.type === "SUCCEEDED" ? "" : undefined }, finish_reason: null }], adobe_event: event.type, progress: event.payload ?? null })}\n\n`));
        }
        const result = await waitForGeneration(jobId);
        const parts = await openAiChatContentParts(request, result.medias);
        for (let index = 0; index < parts.length; index += 1) {
          const part = parts[index]!;
          const content = useContentParts ? [part] : openAiChatText(part);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: `chatcmpl-${jobId}`, object: "chat.completion.chunk", model, choices: [{ index, delta: { content, content_parts: [part] }, finish_reason: "stop" }] })}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        const appError = error instanceof AppError ? error : new AppError("internal_error", "Generation failed", 500);
        const message = appError.status < 500 ? appError.message : "Generation failed";
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAiError(message, errorType(appError), appError.code))}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "x-request-id": requestId } });
}
