import { describe, expect, it, vi } from "vitest";
import { ConsentAnalytics, safeSentryEvent, safeTelemetry } from "../src/lib/telemetry";

const sensitive = "SENTINEL_PRIVATE_PDF_TOKEN@example.test";
describe("private telemetry", () => {
  it("rebuilds only allowed values and drops arbitrary strings and automatic events", () => {
    const result = safeSentryEvent({ message: sensitive, request: { headers: { authorization: sensitive } }, user: { email: sensitive }, exception: { values: [{ value: sensitive }] }, breadcrumbs: [sensitive], attachments: [sensitive], extra: { uno: { code: "request_failed", stage: "request", count: 2, email: sensitive, filename: sensitive, pdf: sensitive }, private: sensitive } });
    expect(JSON.stringify(result).includes(sensitive)).toBe(false);
    expect(result?.extra.uno.count).toBe(2);
    expect(safeSentryEvent({ message: sensitive })).toBeNull();
    expect(safeTelemetry({ code: sensitive })).toBeUndefined();
    expect(safeTelemetry({ code: "worker_failed", engineVersion: sensitive })).toBeUndefined();
  });
  it("does no work before opt-in and rejects unsafe provider hosts", async () => {
    const send = vi.fn<typeof fetch>();
    const analytics = new ConsentAnalytics({ key: "synthetic-project-token", fetch: send, randomId: () => "random-session" });
    await analytics.capture({ code: "download_requested" });
    expect(send).not.toHaveBeenCalled();
    const unsafe = new ConsentAnalytics({ key: "synthetic-project-token", host: "https://127.0.0.1", fetch: send, randomId: () => "random-session" });
    unsafe.setConsent(true);
    await unsafe.capture({ code: "download_requested" });
    expect(send).not.toHaveBeenCalled();
  });
  it("omits cookies/referrer/PII and aborts pending sends without retry on revocation", async () => {
    let signal: AbortSignal | undefined;
    let body = "";
    const send = vi.fn<typeof fetch>(async (_url, request) => {
      signal = request?.signal ?? undefined;
      body = String(request?.body);
      await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return new Response();
    });
    const analytics = new ConsentAnalytics({ key: "synthetic-project-token", fetch: send, randomId: () => "random-session" });
    analytics.setConsent(true);
    const pending = analytics.capture({ code: "download_requested", filename: sensitive, url: sensitive, email: sensitive });
    expect(send).toHaveBeenCalledTimes(1);
    expect(body.includes(sensitive)).toBe(false);
    expect(JSON.parse(body).properties.$process_person_profile).toBe(false);
    expect(send.mock.calls[0][1]?.credentials).toBe("omit");
    expect(send.mock.calls[0][1]?.referrerPolicy).toBe("no-referrer");
    analytics.setConsent(false);
    expect(signal?.aborted).toBe(true);
    await pending;
    await analytics.capture({ code: "download_requested" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
