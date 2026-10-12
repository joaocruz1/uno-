import { z } from "zod";

import { paidPlanIdSchema } from "@/lib/billing-model";
import { AppError } from "@/lib/errors";
import { requirePlatformAdmin } from "@/server/admin";
import { grantTestEntitlement } from "@/server/admin/grant";
import { assertSameOrigin, errorResponse, requestId } from "@/server/http";
import { enforceAdminRateLimit } from "@/server/organizations/limits";

export const runtime = "nodejs";

const bodySchema = z.object({
  email: z.string().email(),
  planId: paidPlanIdSchema.optional(),
  days: z.number().int().min(1).max(3_650).optional(),
  apiAddon: z.boolean().optional(),
}).strict();

/**
 * Admin-only override that unlocks a paid plan (and, by default, the API add-on)
 * for an account by e-mail, with no payment — for testing. Same-origin and
 * platform-admin only. For a real, paid entitlement the owner uses Checkout.
 */
export async function POST(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    assertSameOrigin(request);
    const admin = await requirePlatformAdmin(request.headers);
    await enforceAdminRateLimit(admin.userId);
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new AppError("invalid_request", "Corpo inválido.", 400);
    }
    const body = bodySchema.parse(raw);
    const result = await grantTestEntitlement({
      email: body.email,
      planId: body.planId ?? "BUSINESS",
      days: body.days ?? 365,
      apiAddon: body.apiAddon ?? true,
    });
    return Response.json({ requestId: id, ...result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
