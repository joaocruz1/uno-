"use client";

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export function safeInternalPath(candidate: string | null | undefined, fallback = "/dashboard"): string {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) return fallback;
  try {
    const parsed = new URL(candidate, "http://uno.local");
    return parsed.origin === "http://uno.local" ? `${parsed.pathname}${parsed.search}${parsed.hash}` : fallback;
  } catch {
    return fallback;
  }
}
