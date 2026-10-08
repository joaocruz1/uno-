/**
 * Adaptive polling for conversion and batch status. Most jobs finish within a few
 * seconds, so the first 15 s poll fast; long-running work backs off to spare the API.
 */
export function pollingDelayMs(elapsedMs: number): number {
  if (elapsedMs < 15_000) return 400;
  if (elapsedMs < 60_000) return 1_000;
  return 2_000;
}

/**
 * Starts the elapsed clock for one polling session (one id / one manual refresh) and
 * returns a function giving the delay before the next request.
 */
export function startPollingClock(now: () => number = Date.now): () => number {
  const startedAt = now();
  return () => pollingDelayMs(now() - startedAt);
}
