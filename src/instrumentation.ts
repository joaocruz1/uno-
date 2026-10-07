export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeDiagnostics } = await import("@/lib/telemetry-server");
    await initializeDiagnostics();
  }
}

export async function onRequestError() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportDiagnostic } = await import("@/lib/telemetry-server");
    // Never forward the framework's error, request, URL, headers or user context.
    await reportDiagnostic({ code: "request_failed", stage: "request" });
  }
}
