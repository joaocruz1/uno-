import type { BrowserContext } from "@playwright/test";

const DOCUMENTATION_RANGES = ["192.0.2", "198.51.100", "203.0.113"];

/**
 * Gives a browser context its own synthetic client address (RFC 5737), so the
 * per-IP auth limits (3 sign-ups per 10 s, 3 verification e-mails per minute)
 * apply per test instead of to the whole suite running from one machine.
 */
export async function isolateClientIp(context: BrowserContext): Promise<void> {
  const range = DOCUMENTATION_RANGES[Math.floor(Math.random() * DOCUMENTATION_RANGES.length)];
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `${range}.${Math.floor(Math.random() * 254) + 1}` });
}
