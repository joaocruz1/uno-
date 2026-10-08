import { afterEach, describe, expect, it, vi } from "vitest";

import { allowDraftTemplates } from "@/lib/env";

describe("unreleased template gate", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("stays closed in production unless the operator opts in explicitly", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("UNO_ALLOW_DRAFT_TEMPLATES", "true");
    vi.stubEnv("UNO_ALLOW_UNRELEASED_TEMPLATES", "");
    expect(allowDraftTemplates()).toBe(false);
    vi.stubEnv("UNO_ALLOW_UNRELEASED_TEMPLATES", "true");
    expect(allowDraftTemplates()).toBe(true);
  });
});
