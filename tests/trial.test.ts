import { describe, expect, it, vi } from "vitest";

import { EngineError } from "@/engine/errors";
import type { ConversionResult } from "@/engine/types";
import { runPublicTrial, TRIAL_MAX_BYTES, trialAvailable, trialCookie, trialVisitorKey, type TrialDependencies } from "@/server/trial";

const PDF = Buffer.from("%PDF-1.7\nsynthetic trial\n%%EOF", "ascii");
const OUTPUT = new Uint8Array([37, 80, 68, 70]);

function dependencies(overrides: Partial<TrialDependencies> = {}) {
  const used = new Set<string>();
  const base: TrialDependencies = {
    store: { isUsed: async (key) => used.has(key), markUsed: async (key) => { used.add(key); } },
    convert: vi.fn(async () => ({ bytes: OUTPUT }) as ConversionResult),
    assertAvailable: async () => undefined,
    limit: vi.fn(async () => undefined),
    secret: () => "synthetic-secret",
  };
  return { ...base, ...overrides, used };
}

function request(bytes: Uint8Array = PDF, headers: Record<string, string> = {}, type = "application/pdf") {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(bytes)], { type }), "synthetic.pdf");
  return new Request("http://127.0.0.1:3100/api/public/trial", { method: "POST", body: form, headers: { "x-forwarded-for": "203.0.113.7", ...headers } });
}

describe("public one-time trial", () => {
  it("converts once per visitor and never stores the raw address", async () => {
    const deps = dependencies();
    expect(Buffer.from(await runPublicTrial(request(), deps))).toEqual(Buffer.from(OUTPUT));
    expect([...deps.used][0]).toBe(trialVisitorKey(new Headers({ "x-forwarded-for": "203.0.113.7" }), "synthetic-secret"));
    expect([...deps.used][0]).not.toContain("203.0.113.7");
    await expect(runPublicTrial(request(), deps)).rejects.toMatchObject({ code: "trial_used", status: 403 });
    expect(deps.convert).toHaveBeenCalledTimes(1);
    // Another network address is still unused, unless it carries the cookie.
    expect(await trialAvailable(new Headers({ "x-forwarded-for": "203.0.113.8" }), deps)).toBe(true);
    expect(await trialAvailable(new Headers({ "x-forwarded-for": "203.0.113.8", cookie: "a=b; uno_trial_used=1" }), deps)).toBe(false);
    expect(trialCookie()).toMatch(/HttpOnly; SameSite=Lax/);
  });

  it("does not consume the trial when the file is rejected or the engine fails", async () => {
    const deps = dependencies({ convert: vi.fn(async () => { throw new EngineError("unsupported_template"); }) });
    await expect(runPublicTrial(request(), deps)).rejects.toMatchObject({ code: "unsupported_template", status: 422 });
    await expect(runPublicTrial(request(Buffer.from("plain text")), deps)).rejects.toMatchObject({ code: "invalid_pdf" });
    await expect(runPublicTrial(request(Buffer.concat([PDF, Buffer.alloc(TRIAL_MAX_BYTES)])), deps)).rejects.toMatchObject({ code: "file_too_large", status: 413 });
    expect(deps.used.size).toBe(0);
  });

  it("applies rate limits before reading the body and respects template availability", async () => {
    const limited = dependencies({ limit: vi.fn(async () => { throw new Error("limited"); }) });
    await expect(runPublicTrial(request(), limited)).rejects.toThrow("limited");
    expect(limited.convert).not.toHaveBeenCalled();
    const unavailable = dependencies({ assertAvailable: async () => { throw new Error("template_not_released"); } });
    await expect(runPublicTrial(request(), unavailable)).rejects.toThrow("template_not_released");
    expect(unavailable.convert).not.toHaveBeenCalled();
  });
});
