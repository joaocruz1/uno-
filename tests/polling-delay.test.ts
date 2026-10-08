import { describe, expect, it } from "vitest";

import { pollingDelayMs, startPollingClock } from "@/components/conversion/use-polling-delay";

describe("adaptive polling delay", () => {
  it("polls fast first, then backs off at 15 s and 60 s", () => {
    expect(pollingDelayMs(0)).toBe(400);
    expect(pollingDelayMs(14_999)).toBe(400);
    expect(pollingDelayMs(15_000)).toBe(1_000);
    expect(pollingDelayMs(59_999)).toBe(1_000);
    expect(pollingDelayMs(60_000)).toBe(2_000);
    expect(pollingDelayMs(3_600_000)).toBe(2_000);
  });

  it("measures elapsed time from when the polling session starts", () => {
    let now = 1_000_000;
    const nextDelay = startPollingClock(() => now);
    expect(nextDelay()).toBe(400);
    now += 20_000;
    expect(nextDelay()).toBe(1_000);
    now += 40_000;
    expect(nextDelay()).toBe(2_000);
    const restarted = startPollingClock(() => now);
    expect(restarted()).toBe(400);
  });
});
