import { requireServiceApiKey } from "@/lib/service-auth";
import { AppError, getRequestId, safeErrorMessage } from "@/lib/errors";
import { referenceLimitsForVideo, VIDEO_MODEL_CATALOG } from "@/lib/catalog";
import { enqueueGeneration, validateReferenceUrls, waitForGeneration } from "@/lib/gateway";
import { readJobEvents } from "@/lib/jobs";
import { normalizeGeminiRequest } from "@/lib/media-request";
import { canonicalProtocolModelId, geminiMediaParts } from "@/lib/media-response";

type GeminiResult = Awaited<ReturnType<typeof waitForGeneration>>;

function objectBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function candidateCount(body: Record<string, unknown>): number {
  const extraBodies = [objectBody(body.extra_body), objectBody(body.extraBody)];
  const googleBodies = extraBodies.flatMap((extraBody) => [objectBody(extraBody.google), objectBody(extraBody.Google)]);
  const sources = [body, ...googleBodies, ...extraBodies];
  const value = sources
    .map((source) => {
      const generationConfig = objectBody(source.generationConfig ?? source.generation_config);
      return generationConfig.candidateCount ?? generationConfig.candidate_count ?? source.candidateCount ?? source.candidate_count;
    })
    .find((candidate) => candidate !== undefined);
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 1;
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 10) : 1;
}

type GeminiPart = Awaited<ReturnType<typeof geminiMediaParts>>[number];

function groupCandidateParts(parts: GeminiPart[], requestedCount: number): GeminiPart[][] {
  if (!parts.length) return [[]];
  const count = Math.max(1, Math.min(requestedCount, parts.length));
  const perCandidate = Math.ceil(parts.length / count);
  const groups: GeminiPart[][] = [];
  for (let offset = 0; offset < parts.length; offset += perCandidate) groups.push(parts.slice(offset, offset + perCandidate));
  return groups;
}

async function geminiPayload(request: Request, result: GeminiResult, requestedCount = 1) {
  const parts = await geminiMediaParts(request, result.medias);
  const candidates = groupCandidateParts(parts, requestedCount);
  return {
    candidates: candidates.map((candidateParts, index) => ({ index, content: { role: "model", parts: candidateParts }, finishReason: "STOP", safetyRatings: [] })),
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
  };
}

type GeminiJobEvent = { sequence: number; type: string; payload?: unknown };
const terminalEventTypes = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "SUBMISSION_UNKNOWN"]);

function geminiErrorStatus(error: AppError): string {
  if (error.status === 400) return "INVALID_ARGUMENT";
  if (error.status === 401) return "UNAUTHENTICATED";
  if (error.status === 403) return "PERMISSION_DENIED";
  if (error.status === 404) return "NOT_FOUND";
  if (error.status === 409) return "ABORTED";
  if (error.status === 429) return "RESOURCE_EXHAUSTED";
  if (error.status === 504) return "DEADLINE_EXCEEDED";
  if (error.status === 502 || error.status === 503) return "UNAVAILABLE";
  if (error.status >= 500) return "INTERNAL";
  return "UNKNOWN";
}

function geminiErrorPayload(error: unknown): { error: { code: number; message: string; status: string } } {
  const appError = error instanceof AppError ? error : new AppError("internal_error", "Internal server error", 500);
  return {
    error: {
      code: appError.status,
      message: appError.status >= 500 ? safeErrorMessage(appError.code, appError.status) : appError.message,
      status: geminiErrorStatus(appError),
    },
  };
}

function geminiErrorResponse(error: unknown, requestId: string): Response {
  const appError = error instanceof AppError ? error : new AppError("internal_error", "Internal server error", 500);
  return Response.json(geminiErrorPayload(appError), { status: appError.status, headers: { "x-request-id": requestId } });
}

function geminiEventPayload(event: GeminiJobEvent) {
  return {
    candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: null }],
    adobe_event: event.type,
    progress: event.payload ?? null,
  };
}

function geminiEventFrame(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function geminiStream(request: Request, jobId: string, requestId: string, requestedCount: number): Response {
  const stream = new ReadableStream({
    async start(controller) {
      try {
        let cursor = Number(request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after_sequence") ?? 0) || 0;
        let terminal = false;
        while (!terminal) {
          const batch = await readJobEvents(jobId, cursor, 120_000);
          cursor = batch.cursor;
          for (const event of batch.events as GeminiJobEvent[]) {
            if (!terminalEventTypes.has(event.type)) {
              controller.enqueue(geminiEventFrame(geminiEventPayload(event)));
              continue;
            }
            if (event.type === "SUCCEEDED") {
              const result = await waitForGeneration(jobId);
              const payload = await geminiPayload(request, result, requestedCount);
              controller.enqueue(geminiEventFrame({ ...payload, adobe_event: event.type, progress: event.payload ?? null }));
            } else {
              const status = event.type === "CANCELLED" ? 499 : event.type === "SUBMISSION_UNKNOWN" ? 503 : 502;
              const failure = new AppError(event.type.toLowerCase(), event.type === "CANCELLED" ? "Generation was cancelled" : "Generation failed", status);
              controller.enqueue(geminiEventFrame({ ...geminiErrorPayload(failure), adobe_event: event.type, progress: event.payload ?? null }));
            }
            terminal = true;
            break;
          }
          if (!terminal && batch.terminal) {
            const result = await waitForGeneration(jobId);
            const payload = await geminiPayload(request, result, requestedCount);
            controller.enqueue(geminiEventFrame({ ...payload, adobe_event: result.job.status, progress: { status: result.job.status } }));
            terminal = true;
          }
        }
        controller.close();
      } catch (error) {
        controller.enqueue(geminiEventFrame(geminiErrorPayload(error)));
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "x-request-id": requestId } });
}

export async function POST(request: Request, { params }: { params: Promise<unknown> }) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const segments = ((await params) as { path?: string[] }).path ?? [];
    const operation = segments.join("/");
    const match = operation.match(/^(.+):(generateContent|streamGenerateContent)$/);
    if (!match) throw new AppError("invalid_request_error", "Only :generateContent and :streamGenerateContent are supported", 400);
    const body = objectBody(await request.json());
    const modelName = canonicalProtocolModelId(decodeURIComponent(match[1]!), body, "gemini") ?? decodeURIComponent(match[1]!);
    const requestedCount = candidateCount(body);
    const input = { ...normalizeGeminiRequest(modelName, body), n: requestedCount };
    await validateReferenceUrls(input, input.kind === "video" ? referenceLimitsForVideo(VIDEO_MODEL_CATALOG[input.model]) : { total: 4, image: 4, video: 0, audio: 0 });
    const job = await enqueueGeneration({ apiPath: `/v1beta/models/${modelName}:${match[2]}`, model: input.model, payload: input });
    if (match[2] === "streamGenerateContent") return geminiStream(request, job.id, requestId, requestedCount);
    const result = await waitForGeneration(job.id);
    return Response.json(await geminiPayload(request, result, requestedCount), { headers: { "x-request-id": requestId } });
  } catch (error) {
    return geminiErrorResponse(error, requestId);
  }
}
