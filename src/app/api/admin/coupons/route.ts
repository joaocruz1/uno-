import { requirePlatformAdmin } from "@/server/admin";
import { createAdminCoupon, listAdminCoupons } from "@/server/admin/coupons";
import { jsonResponse, managementRoute, readJson } from "@/server/organizations/http";
import { enforceAdminRateLimit } from "@/server/organizations/limits";

export const runtime = "nodejs";

/** Platform admin: discount coupons with their usage (NEX-51). */
export const GET = managementRoute(async ({ id, headers }) => {
  const admin = await requirePlatformAdmin(headers);
  return jsonResponse(id, { coupons: await listAdminCoupons(admin) });
});

/** Platform admin: creates the Stripe Coupon + Promotion Code and records it. */
export const POST = managementRoute(async ({ request, id, headers }) => {
  const admin = await requirePlatformAdmin(headers);
  await enforceAdminRateLimit(admin.userId);
  const coupon = await createAdminCoupon(admin, await readJson(request));
  return jsonResponse(id, { coupon }, { status: 201 });
});
