import { describe, it, expect } from "vitest";
import { API_ADDON, hasFirstMonthPromo, PLANS } from "@/lib/plans";
describe("commercial entitlements", () => {
  it("includes the API in no plan and sells it as the API add-on", () => {
    for (const plan of Object.values(PLANS)) expect(plan.api).toBe(false);
    expect(API_ADDON).toEqual({ id: "API", name: "API", priceBrlCents: 5_000 });
  });
  it("prices the plans in BRL cents with a matching fractional price", () => {
    expect([PLANS.FREE.priceBrlCents, PLANS.STARTER.priceBrlCents, PLANS.PRO.priceBrlCents, PLANS.BUSINESS.priceBrlCents]).toEqual([0, 1_900, 4_900, 13_900]);
    for (const plan of Object.values(PLANS)) expect(Math.round(plan.price * 100)).toBe(plan.priceBrlCents);
  });
  it("charges a cheaper first month on the paid plans, never a surcharge", () => {
    expect([PLANS.FREE.firstMonthPriceBrlCents, PLANS.STARTER.firstMonthPriceBrlCents, PLANS.PRO.firstMonthPriceBrlCents, PLANS.BUSINESS.firstMonthPriceBrlCents]).toEqual([0, 999, 1_599, 2_990]);
    for (const plan of Object.values(PLANS)) expect(plan.firstMonthPriceBrlCents).toBeLessThanOrEqual(plan.priceBrlCents);
    expect(hasFirstMonthPromo(PLANS.FREE)).toBe(false);
    expect(hasFirstMonthPromo(PLANS.STARTER)).toBe(true);
  });
  it("keeps upload/batch/retention limits monotonic", () => {
    const plans = Object.values(PLANS);
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i].monthlyLimit).toBeGreaterThan(plans[i - 1].monthlyLimit);
      expect(plans[i].maxFileMB).toBeGreaterThanOrEqual(plans[i - 1].maxFileMB);
      expect(plans[i].retentionDays).toBeGreaterThan(plans[i - 1].retentionDays);
    }
  });
});
