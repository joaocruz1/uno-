import { safeSentryEvent, safeTelemetry } from "./telemetry";

let initialized: Promise<void> | undefined;
export function initializeDiagnostics(): Promise<void> {
  initialized ??= (async () => {
    if (!process.env.SENTRY_DSN) return;
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      defaultIntegrations: false,
      enhanceFetchErrorMessages: false,
      tracesSampleRate: 0,
      beforeSend: (event) => {
        const approved = safeSentryEvent(event);
        return approved ? { ...approved, type: undefined } : null;
      },
      beforeSendTransaction: () => null,
      beforeBreadcrumb: () => null,
    });
  })();
  return initialized;
}
export async function reportDiagnostic(input: unknown): Promise<void> {
  const approved = safeTelemetry(input);
  if (!approved || !process.env.SENTRY_DSN) return;
  try {
    await initializeDiagnostics();
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureEvent({ extra: { uno: approved } });
  } catch { /* provider availability never becomes an application failure */ }
}
