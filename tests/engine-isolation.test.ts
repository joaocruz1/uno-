import { describe, expect, it } from "vitest";

import { EngineError } from "@/engine/errors";
import { convertPdfIsolated, EngineIsolationError } from "@/engine/isolated";
import type { ProgressEvent } from "@/engine/types";
import { syntheticPdf } from "./fixtures/synthetic-pdf";

const SAFE_OUTPUT = { preset: "custom", widthMm: 100, heightMm: 210 } as const;

function hasSafeCode(code: string) {
  return (error: unknown) => error instanceof EngineError && error.code === code;
}

describe("isolated engine process", () => {
  it("converts a synthetic fixture and forwards progress in order", async () => {
    const events: ProgressEvent[] = [];
    const result = await convertPdfIsolated(
      await syntheticPdf({ additionalInformation: true }),
      SAFE_OUTPUT,
      "mercado-livre@1.0.0",
      (event) => { events.push(event); },
      { timeoutMs: 30_000, maxHeapMb: 256 },
    );

    expect(result.pageCount).toBe(1);
    expect(result.validation).toEqual({ contentPreserved: true, geometryValid: true, codesEquivalent: true });
    expect(events.map(({ stage }) => stage)).toEqual(["analyze", "detect", "extract", "layout", "compose", "validate"]);
  }, 35_000);

  it("reconstructs only a safe typed error from a child failure", async () => {
    const privateLookingBytes = new TextEncoder().encode("private-looking-input-that-must-not-escape");
    await expect(convertPdfIsolated(privateLookingBytes, SAFE_OUTPUT, undefined, undefined, { timeoutMs: 10_000 }))
      .rejects.toSatisfy(hasSafeCode("invalid_pdf"));
  }, 15_000);

  it("kills work that exceeds a short non-production deadline", async () => {
    const input = await syntheticPdf();
    await expect(convertPdfIsolated(input, SAFE_OUTPUT, undefined, undefined, { timeoutMs: 1 }))
      .rejects.toBeInstanceOf(EngineIsolationError);
  }, 10_000);

  it("kills the child and returns a safe error when progress handling fails", async () => {
    const input = await syntheticPdf();
    await expect(convertPdfIsolated(input, SAFE_OUTPUT, undefined, () => {
      throw new Error("caller detail must not cross the isolation boundary");
    }, { timeoutMs: 30_000 }))
      .rejects.toBeInstanceOf(EngineIsolationError);
  }, 35_000);

  it("drains asynchronous progress after the child sends its terminal result", async () => {
    const stages: ProgressEvent["stage"][] = [];
    const result = await convertPdfIsolated(
      await syntheticPdf({ additionalInformation: true }),
      SAFE_OUTPUT,
      "mercado-livre@1.0.0",
      async (event) => {
        stages.push(event.stage);
        if (event.stage === "validate") {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      },
      { timeoutMs: 30_000 },
    );

    expect(result.pageCount).toBe(1);
    expect(stages.at(-1)).toBe("validate");
  }, 35_000);
});
