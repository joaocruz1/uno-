import { billingCheckoutRequestSchema } from "@/lib/billing-model";
import { positiveIntegerEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { createApiAddonCheckout, createBillingCheckout } from "@/server/billing";
import { enforceCouponIpRateLimit, enforceCouponRateLimit } from "@/server/billing/coupons";
import { requireActor, withJsonHandler } from "@/server/http";
import { enforceRateLimit } from "@/server/rate-limit";

export const runtime = "nodejs";

/**
 * Own checkout (NEX-52): creates (or returns again, for the same Idempotency-Key
 * and target) the incomplete subscription and the client secret the Payment
 * Element confirms. OWNER/ADMIN, same origin. Grants nothing: the webhook does.
 */
export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(new Headers(request.headers));
  let body: unknown;
  try { body = await request.json(); } catch { throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400); }
  const parsed = billingCheckoutRequestSchema.parse(body);
  const idempotencyKey = request.headers.get("idempotency-key");
  await enforceRateLimit({ namespace: "billing-subscribe", identifier: actor.userId, limit: positiveIntegerEnv("UNO_SUBSCRIBE_RATE_LIMIT", 20) });
  if ("planId" in parsed && parsed.promotionCode) {
    await enforceCouponIpRateLimit(request.headers);
    await enforceCouponRateLimit(actor.userId);
  }
  const result = "addon" in parsed
    ? await createApiAddonCheckout(actor, idempotencyKey)
    : await createBillingCheckout(actor, parsed.planId, idempotencyKey, undefined, { promotionCode: parsed.promotionCode ?? null });
  return Response.json({ requestId, ...result }, { headers: { "cache-control": "no-store" } });
});
