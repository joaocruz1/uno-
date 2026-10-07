import { paidPlanIdSchema } from "@/lib/billing-model";
import { AppError } from "@/lib/errors";
import { createBillingCheckout } from "@/server/billing";
import { requireActor, withJsonHandler } from "@/server/http";
import { z } from "zod";

export const runtime = "nodejs";

export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(new Headers(request.headers));
  let body: unknown;
  try { body = await request.json(); } catch { throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400); }
  const parsed = z.object({ planId: paidPlanIdSchema }).strict().parse(body);
  const result = await createBillingCheckout(actor, parsed.planId, request.headers.get("idempotency-key"));
  return Response.json({ requestId, ...result }, { headers: { "cache-control": "no-store" } });
});
