import { describe, expect, it } from "vitest";
import { executionModelId } from "@/lib/worker/processor";

describe("worker model routing", () => {
  it("prefers resolved_model for new jobs", () => {
    expect(executionModelId({ model: "seedance20-fast", resolved_model: "seedance20-fast-10s-9x16-1080p" }, "seedance20-fast")).toBe("seedance20-fast-10s-9x16-1080p");
  });

  it("falls back to historical job.model", () => {
    expect(executionModelId({ prompt: "redacted" }, "gpt-image-4k-4x3")).toBe("gpt-image-4k-4x3");
  });
});
