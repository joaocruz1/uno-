import type { CheckoutConfig, CouponPreview, PaidPlanId } from "@/lib/billing-model";
import { isPlatformAdmin, type Actor } from "@/server/auth/actor";

import { checkoutPublishableKeyStatus, PAID_PLAN_IDS, publishableKeyFix } from "./config";
import { quoteCheckout } from "./coupons";

type Viewer = Pick<Actor, "organizationId" | "email" | "platformRole" | "emailVerified">;

/**
 * What the own checkout needs on the page and in the plans dialog: the
 * publishable key (or null, payment disabled), the price of each plan as the
 * server will charge it without a coupon (no Stripe call), and, for platform
 * admins only, why the key cannot be used and how to fix it.
 */
export async function readCheckoutConfig(viewer: Viewer, quote: typeof quoteCheckout = quoteCheckout): Promise<CheckoutConfig> {
  const status = checkoutPublishableKeyStatus();
  const quotes = {} as Record<PaidPlanId, CouponPreview>;
  for (const planId of PAID_PLAN_IDS) quotes[planId] = (await quote(planId, null, viewer.organizationId)).preview;
  return {
    publishableKey: status.key,
    adminDetail: status.reason !== "ok" && isPlatformAdmin(viewer) ? publishableKeyFix(status) : null,
    quotes,
  };
}
