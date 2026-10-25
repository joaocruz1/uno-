import { billingCancelRequestSchema } from "@/lib/billing-model";
import { AppError } from "@/lib/errors";
import { cancelBillingSubscription } from "@/server/billing";
import { requireActor, withJsonHandler } from "@/server/http";

export const runtime = "nodejs";

export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(new Headers(request.headers));
  let body: unknown;
  try { body = await request.json(); } catch { throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400); }
  const parsed = billingCancelRequestSchema.parse(body);
  const result = await cancelBillingSubscription(actor, parsed, request.headers.get("idempotency-key"));
  return Response.json({ requestId, ...result }, { headers: { "cache-control": "no-store" } });
});
