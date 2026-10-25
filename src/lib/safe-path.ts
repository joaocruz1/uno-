/** Accepts only same-origin relative paths; anything else becomes `fallback`. */
export function safeInternalPath(candidate: string | null | undefined, fallback = "/dashboard"): string {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) return fallback;
  try {
    const parsed = new URL(candidate, "http://uno.local");
    // Validate the normalized result too: "/.//evil.com" normalizes to "//evil.com".
    if (parsed.origin !== "http://uno.local" || parsed.pathname.startsWith("//") || parsed.pathname.includes("\\")) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
