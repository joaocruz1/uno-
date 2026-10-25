import { z } from "zod";

import { requirePlatformAdmin } from "@/server/admin";
import { setAdminCouponActive } from "@/server/admin/coupons";
import { jsonResponse, managementRoute, readJson } from "@/server/organizations/http";
import { enforceAdminRateLimit } from "@/server/organizations/limits";

export const runtime = "nodejs";

const bodySchema = z.object({ active: z.boolean() }).strict();

/** Platform admin: activates or deactivates a coupon here and on Stripe. */
export const PATCH = managementRoute<{ id: string }>(async ({ request, id, params, headers }) => {
  const admin = await requirePlatformAdmin(headers);
  await enforceAdminRateLimit(admin.userId);
  const body = bodySchema.parse(await readJson(request));
  const coupon = await setAdminCouponActive(admin, z.uuid().parse(params.id), body.active);
  return jsonResponse(id, { coupon });
});
