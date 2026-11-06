import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "@/lib/concurrency";

describe("mapWithConcurrency", () => {
  it("keeps input order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithConcurrency([30, 5, 20, 1, 10, 2], 3, async (delay, index) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, delay));
      running -= 1;
      return index * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40, 50]);
    expect(peak).toBe(3);
  });

  it("handles an empty list and rejects on the first failure", async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
    await expect(mapWithConcurrency([1, 2], 2, async (value) => {
      if (value === 2) throw new Error("boom");
      return value;
    })).rejects.toThrow("boom");
  });
});
