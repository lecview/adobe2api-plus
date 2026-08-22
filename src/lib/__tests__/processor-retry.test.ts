import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdobeUpstreamError } from "@/lib/adobe/client";
import { AppError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  getSystemSettings: vi.fn(),
  assertJobLease: vi.fn(),
  recordJobAttempt: vi.fn(),
  finishJobAttempt: vi.fn(),
  appendJobEvent: vi.fn(),
}));

vi.mock("@/lib/system-settings", () => ({ getSystemSettings: mocks.getSystemSettings }));
vi.mock("@/lib/jobs", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/jobs")>(),
  assertJobLease: mocks.assertJobLease,
  recordJobAttempt: mocks.recordJobAttempt,
  finishJobAttempt: mocks.finishJobAttempt,
  appendJobEvent: mocks.appendJobEvent,
}));

import { runStage, stageRetryDisposition } from "@/lib/worker/processor";

const base = {
  stage: "SUBMIT" as const,
  attempts: 1,
  maxAttempts: 3,
  index: -1,
  entryCount: 0,
} as const;

function submitTimeout() {
  return new AdobeUpstreamError("adobe_submit_timeout", "Adobe generation service timed out", {
    status: 503,
    retryable: true,
    proxyEligible: false,
    details: { upstream_status: 408, response_received: true },
  });
}

describe("worker stage retry policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSystemSettings.mockResolvedValue({ retryEnabled: true, retryMaxAttempts: 3, retryBackoffMs: 0 });
    mocks.assertJobLease.mockResolvedValue(undefined);
    mocks.recordJobAttempt.mockResolvedValue({ id: "attempt-id" });
    mocks.finishJobAttempt.mockResolvedValue(undefined);
    mocks.appendJobEvent.mockResolvedValue(undefined);
  });

  it("retries explicit submit 408 responses on the same direct route until exhausted", () => {
    expect(stageRetryDisposition(submitTimeout(), { ...base, mode: "direct" })).toBe("same_route");
    expect(stageRetryDisposition(submitTimeout(), {
      ...base,
      mode: "direct",
      attempts: 2,
    })).toBe("same_route");
    expect(stageRetryDisposition(submitTimeout(), { ...base, mode: "direct", attempts: 3 })).toBe("stop");
  });

  it("does not misclassify explicit submit 408 responses as proxy failures", () => {
    expect(stageRetryDisposition(submitTimeout(), {
      ...base,
      mode: "proxy",
      attempts: 2,
      index: 0,
      entryCount: 3,
    })).toBe("same_route");
  });

  it("does not retry when retries are disabled or exhausted", () => {
    expect(stageRetryDisposition(submitTimeout(), {
      ...base,
      mode: "direct",
      maxAttempts: 1,
    })).toBe("stop");
    expect(stageRetryDisposition(submitTimeout(), {
      ...base,
      mode: "proxy",
      attempts: 3,
      index: 0,
      entryCount: 3,
    })).toBe("stop");
  });

  it("keeps proxy transport failures on the existing proxy-switch path", () => {
    const transportError = new AppError("adobe_transport_error", "proxy failed", 503, { proxyEligible: true });
    expect(stageRetryDisposition(transportError, {
      ...base,
      stage: "UPLOAD",
      mode: "proxy",
      index: 0,
      entryCount: 2,
    })).toBe("next_proxy");
    expect(stageRetryDisposition(transportError, {
      ...base,
      stage: "POLL",
      mode: "proxy",
      attempts: 2,
      index: 1,
      entryCount: 2,
    })).toBe("proxy_exhausted");
  });

  it("does not replay a submit when a transport failure leaves its outcome unknown", () => {
    const transportError = new AppError("adobe_transport_error", "connection lost", 503, { proxyEligible: true });
    expect(stageRetryDisposition(transportError, {
      ...base,
      stage: "SUBMIT",
      mode: "proxy",
      index: 0,
      entryCount: 2,
    })).toBe("stop");
  });

  it("does not replay direct transport failures or business errors", () => {
    const transportError = new AppError("adobe_transport_error", "connection lost", 503, { proxyEligible: true });
    const quotaError = new AdobeUpstreamError("adobe_quota_exhausted", "quota exhausted", {
      status: 502,
      retryable: false,
      proxyEligible: false,
    });
    expect(stageRetryDisposition(transportError, { ...base, mode: "direct" })).toBe("stop");
    expect(stageRetryDisposition(quotaError, { ...base, mode: "direct" })).toBe("stop");
  });

  it("stops before replaying when retry preparation cannot switch accounts", async () => {
    const error = submitTimeout();
    const callback = vi.fn().mockRejectedValue(error);
    const onRetry = vi.fn().mockRejectedValue(error);

    await expect(runStage({
      jobId: "job-id",
      workerId: "worker-id",
      stage: "SUBMIT",
      snapshot: { mode: "direct", entries: [], selectedIndex: -1 },
      startIndex: -1,
      callback,
      onRetry,
    })).rejects.toBe(error);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
