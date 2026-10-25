import { billingPlanChangeRequestSchema } from "@/lib/billing-model";
import { AppError } from "@/lib/errors";
import { changeBillingPlan } from "@/server/billing";
import { requireActor, withJsonHandler } from "@/server/http";

export const runtime = "nodejs";

export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(new Headers(request.headers));
  let body: unknown;
  try { body = await request.json(); } catch { throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400); }
  const parsed = billingPlanChangeRequestSchema.parse(body);
  const result = await changeBillingPlan(actor, parsed.planId, request.headers.get("idempotency-key"));
  return Response.json({ requestId, ...result }, { headers: { "cache-control": "no-store" } });
});
