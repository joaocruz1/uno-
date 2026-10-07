import { lookup } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";

import { AppError } from "@/lib/errors";
import { WEBHOOK_URL_MAX_LENGTH } from "@/lib/webhook-model";

import { WEBHOOK_MAX_RESPONSE_BYTES, WEBHOOK_PORT } from "./config";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type DnsResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export type PinnedRequest = {
  /** Validated public IP the socket must connect to. */
  address: string;
  family: 4 | 6;
  port: typeof WEBHOOK_PORT;
  /** Original hostname, used only for the Host header, SNI and certificate check. */
  hostname: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  timeoutMs: number;
  maxResponseBytes: number;
};

export type WebhookConnector = (request: PinnedRequest) => Promise<{ status: number }>;
export type WebhookTransport = { resolve: DnsResolver; connect: WebhookConnector };

export type WebhookSendErrorCode =
  | "invalid_url"
  | "dns_failed"
  | "destination_not_allowed"
  | "timeout"
  | "tls_error"
  | "network_error";

/** Carries only a safe code; never the URL, the address or the raw cause. */
export class WebhookSendError extends Error {
  constructor(readonly code: WebhookSendErrorCode) {
    super(code);
    this.name = "WebhookSendError";
  }
}

const deniedIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) deniedIpv4.addSubnet(network, prefix, "ipv4");

// Only global unicast (2000::/3) is public; everything else (loopback, ULA,
// link-local, multicast, IPv4-mapped/compatible, NAT64...) is denied by default.
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
const deniedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) deniedIpv6.addSubnet(network, prefix, "ipv6");

export function isPublicAddress(address: string, family?: number): boolean {
  if (typeof address !== "string" || address.includes("%")) return false;
  const detected = isIP(address);
  if (detected === 0 || (family !== undefined && family !== detected)) return false;
  if (detected === 4) return !deniedIpv4.check(address, "ipv4");
  if (/^(0*:)*:?(0*:)*ffff:/i.test(address) || address.includes(".")) return false;
  return globalIpv6.check(address, "ipv6") && !deniedIpv6.check(address, "ipv6");
}

const BLOCKED_SUFFIXES = [
  "localhost", "local", "localdomain", "internal", "intranet", "lan", "home", "corp", "private",
  "test", "example", "invalid", "onion", "arpa",
];

export type WebhookUrl = { href: string; hostname: string; path: string };

function invalidUrl(): AppError {
  return new AppError(
    "invalid_webhook_url",
    "Informe uma URL HTTPS pública, na porta 443, sem credenciais nem fragmento.",
    400,
  );
}

/** Syntactic policy shared by registration and every send. */
export function parseWebhookUrl(raw: string): WebhookUrl {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > WEBHOOK_URL_MAX_LENGTH) throw invalidUrl();
  if (/[\s\x00-\x1f\x7f#\\]/u.test(raw)) throw invalidUrl();
  let url: URL;
  try { url = new URL(raw); } catch { throw invalidUrl(); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw invalidUrl();
  if (url.port !== "" && url.port !== String(WEBHOOK_PORT)) throw invalidUrl();
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname.length > 253 || hostname.startsWith("[") || isIP(hostname) !== 0) throw invalidUrl();
  const labels = hostname.split(".");
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw invalidUrl();
  const topLevel = labels.at(-1)!;
  if (/^[0-9]+$/.test(topLevel) || BLOCKED_SUFFIXES.includes(topLevel)) throw invalidUrl();
  return { href: url.href, hostname, path: `${url.pathname}${url.search}` };
}

export const systemDnsResolver: DnsResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family === 6 ? 6 : 4 }));
};

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WebhookSendError("timeout")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolves every A/AAAA record and refuses the destination when ANY of them is
 * not public, so a mixed answer cannot be used to reach internal services.
 */
export async function resolvePinnedAddress(hostname: string, resolve: DnsResolver, timeoutMs: number): Promise<ResolvedAddress> {
  let records: readonly ResolvedAddress[];
  try {
    records = await withDeadline(resolve(hostname), timeoutMs);
  } catch (error) {
    throw error instanceof WebhookSendError ? error : new WebhookSendError("dns_failed");
  }
  if (!Array.isArray(records) || records.length === 0) throw new WebhookSendError("dns_failed");
  for (const record of records) {
    if (!record || !isPublicAddress(record.address, record.family)) throw new WebhookSendError("destination_not_allowed");
  }
  return records.find((record) => record.family === 4) ?? records[0]!;
}

/** Registration-time guard: same URL policy and DNS validation used for sends. */
export async function assertWebhookDestinationAllowed(
  rawUrl: string,
  resolve: DnsResolver,
  timeoutMs: number,
): Promise<WebhookUrl> {
  const url = parseWebhookUrl(rawUrl);
  try {
    await resolvePinnedAddress(url.hostname, resolve, timeoutMs);
  } catch {
    throw new AppError(
      "webhook_destination_not_allowed",
      "O endereço informado não pôde ser validado como um destino público.",
      400,
    );
  }
  return url;
}

type RequestFactory = (options: RequestOptions) => ClientRequest;

function classifyRequestError(error: unknown): WebhookSendErrorCode {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
  if (/TLS|SSL|CERT|ALTNAME|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return "tls_error";
  return "network_error";
}

/**
 * Production connector. It dials the pinned IP directly (no second DNS lookup),
 * keeps the hostname for Host/SNI/certificate validation, never follows
 * redirects, ignores environment proxies (dedicated agent), enforces one
 * overall deadline and discards at most `maxResponseBytes` of response body.
 * The address check is repeated here so no caller can bypass it.
 */
export function createPinnedHttpsConnector(requestFactory: RequestFactory = httpsRequest): WebhookConnector {
  return (target) => new Promise<{ status: number }>((resolve, reject) => {
    if (target.port !== WEBHOOK_PORT || !isPublicAddress(target.address, target.family)) {
      reject(new WebhookSendError("destination_not_allowed"));
      return;
    }
    const agent = new Agent({ keepAlive: false, maxSockets: 1 });
    let settled = false;
    let request: ClientRequest | undefined;
    const finish = (outcome: { status: number } | WebhookSendError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      agent.destroy();
      if (outcome instanceof WebhookSendError) reject(outcome);
      else resolve(outcome);
    };
    const timer = setTimeout(() => finish(new WebhookSendError("timeout")), target.timeoutMs);
    try {
      request = requestFactory({
        agent,
        host: target.address,
        family: target.family,
        port: target.port,
        servername: target.hostname,
        method: "POST",
        path: target.path,
        headers: { ...target.headers, host: target.hostname, connection: "close" },
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      });
    } catch {
      finish(new WebhookSendError("network_error"));
      return;
    }
    request.on("error", (error) => finish(new WebhookSendError(classifyRequestError(error))));
    request.on("response", (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        finish(new WebhookSendError("network_error"));
        return;
      }
      // The status line is the whole answer: the body is never kept or parsed.
      let received = 0;
      response.on("data", (chunk: Buffer | string) => {
        received += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        if (received > target.maxResponseBytes) finish({ status });
      });
      response.on("end", () => finish({ status }));
      response.on("close", () => finish({ status }));
      response.on("error", () => finish({ status }));
    });
    request.end(target.body, "utf8");
  });
}

export function defaultWebhookTransport(): WebhookTransport {
  return { resolve: systemDnsResolver, connect: createPinnedHttpsConnector() };
}

/**
 * The only way a webhook leaves the process. URL policy, DNS resolution and the
 * public-address check always run here; tests inject `transport` to replace the
 * resolver and the socket layer, never the validation itself.
 */
export async function sendWebhookRequest(
  input: { url: string; headers: Readonly<Record<string, string>>; body: string; timeoutMs: number },
  transport: WebhookTransport,
): Promise<{ status: number }> {
  let url: WebhookUrl;
  try { url = parseWebhookUrl(input.url); } catch { throw new WebhookSendError("invalid_url"); }
  const startedAt = Date.now();
  const pinned = await resolvePinnedAddress(url.hostname, transport.resolve, input.timeoutMs);
  const remaining = input.timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) throw new WebhookSendError("timeout");
  let result: { status: number };
  try {
    result = await withDeadline(transport.connect({
      address: pinned.address,
      family: pinned.family,
      port: WEBHOOK_PORT,
      hostname: url.hostname,
      path: url.path,
      headers: input.headers,
      body: input.body,
      timeoutMs: remaining,
      maxResponseBytes: WEBHOOK_MAX_RESPONSE_BYTES,
    }), remaining + 250);
  } catch (error) {
    throw error instanceof WebhookSendError ? error : new WebhookSendError("network_error");
  }
  if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) throw new WebhookSendError("network_error");
  return { status: result.status };
}
