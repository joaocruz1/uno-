import { couponPreviewRequestSchema } from "@/lib/billing-model";
import { AppError } from "@/lib/errors";
import { enforceCouponIpRateLimit, enforceCouponRateLimit, previewCoupon } from "@/server/billing/coupons";
import { requireActor, withJsonHandler } from "@/server/http";

export const runtime = "nodejs";

/**
 * Prices a paid plan with a coupon before paying (NEX-51). The result is only
 * informative: checkout recomputes it on the server. Rate limited per user so
 * codes cannot be enumerated; per address too.
 */
export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(new Headers(request.headers));
  let body: unknown;
  try { body = await request.json(); } catch { throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400); }
  const parsed = couponPreviewRequestSchema.parse(body);
  await enforceCouponIpRateLimit(request.headers);
  await enforceCouponRateLimit(actor.userId);
  const preview = await previewCoupon(parsed.planId, parsed.code, actor.organizationId);
  return Response.json({ requestId, ...preview }, { headers: { "cache-control": "no-store" } });
});
