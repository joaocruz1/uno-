import { z } from "zod";

export const safeTelemetrySchema = z.object({
  code: z.enum(["request_failed", "worker_failed", "provider_unavailable", "conversion_completed", "conversion_failed", "batch_completed", "analytics_enabled", "download_requested"]),
  stage: z.enum(["request", "analyzer", "detector", "extractor", "layout", "composer", "validator", "queue", "archive", "billing", "webhook", "dashboard"]).optional(),
  durationMs: z.number().finite().min(0).max(86_400_000).optional(),
  count: z.number().int().min(0).max(1_000_000).optional(),
  engineVersion: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/).optional(),
  templateVersion: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/).optional(),
});
export type SafeTelemetry = z.infer<typeof safeTelemetrySchema>;

/** Pick fields explicitly; caller objects may contain private documents or errors. */
export function safeTelemetry(input: unknown): SafeTelemetry | undefined {
  if (!input || typeof input !== "object") return undefined;
  const source = input as Record<string, unknown>;
  const result = safeTelemetrySchema.safeParse({ code: source.code, stage: source.stage, durationMs: source.durationMs, count: source.count, engineVersion: source.engineVersion, templateVersion: source.templateVersion });
  return result.success ? result.data : undefined;
}

/** Unknown/automatic SDK events are dropped. Rebuild approved events from scratch. */
export function safeSentryEvent(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const event = input as { extra?: Record<string, unknown> };
  const approved = safeTelemetry(event.extra?.uno);
  if (!approved) return null;
  return {
    message: approved.code,
    level: "error" as const,
    tags: { application: "uno", code: approved.code, ...(approved.stage ? { stage: approved.stage } : {}) },
    extra: { uno: approved },
  };
}

export class ConsentAnalytics {
  private enabled = false;
  private distinctId?: string;
  private inFlight = new Set<AbortController>();
  constructor(private config: { key?: string; host?: string; fetch: typeof fetch; randomId: () => string }) {}
  setConsent(allowed: boolean) {
    this.enabled = allowed;
    if (!allowed) {
      this.distinctId = undefined;
      for (const request of this.inFlight) request.abort();
      this.inFlight.clear();
    }
  }
  async capture(input: unknown): Promise<void> {
    const event = safeTelemetry(input);
    if (!this.enabled || !event || !this.config.key) return;
    let url: URL;
    try { url = new URL(this.config.host ?? "https://us.i.posthog.com"); } catch { return; }
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !["us.i.posthog.com", "eu.i.posthog.com"].includes(url.hostname)) return;
    this.distinctId ??= this.config.randomId();
    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      // Direct capture avoids SDK autocapture, enrichment, retry queues and replay.
      await this.config.fetch(new URL("/i/v0/e/", url), {
        method: "POST", mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: this.config.key, event: `uno_${event.code}`, distinct_id: this.distinctId, properties: { ...event, $process_person_profile: false, $geoip_disable: true } }),
      });
    } catch { /* diagnostics must not interrupt a user operation or expose provider errors */ }
    finally { this.inFlight.delete(controller); }
  }
}
