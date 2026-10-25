import type { BrowserContext } from "@playwright/test";

/**
 * A synthetic client address in the IPv6 documentation prefix (RFC 3849),
 * random enough never to repeat across runs. Per-IP limits then apply per test
 * instead of to the whole suite running from one machine: the auth limits
 * (3 sign-ups per 10 s, 3 verification e-mails per minute) and the landing
 * trial's once-per-visitor rule, which remembers an address for 30 days.
 */
export function syntheticClientIp(): string {
  const group = () => Math.floor(Math.random() * 0x10000).toString(16);
  return `2001:db8:${group()}:${group()}:${group()}:${group()}:${group()}:${group()}`;
}

export async function isolateClientIp(context: BrowserContext): Promise<void> {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": syntheticClientIp() });
}
