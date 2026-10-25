import { removeCardRequestSchema } from "@/lib/billing-model";
import { AppError } from "@/lib/errors";
import { listSavedCards, removeSavedCard } from "@/server/billing";
import { errorResponse, requestId, requireActor, withJsonHandler } from "@/server/http";
import { enforceRateLimit } from "@/server/rate-limit";

export const runtime = "nodejs";

/** Cards Stripe keeps for the organization: brand, last four digits and expiry only (NEX-52). */
export async function GET(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const actor = await requireActor(new Headers(request.headers));
    return Response.json({ requestId: id, ...(await listSavedCards(actor)) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}

/** Removes a kept card (OWNER/ADMIN), never the only one paying a live subscription. */
export const DELETE = withJsonHandler(async (request, id) => {
  const actor = await requireActor(new Headers(request.headers));
  let body: unknown;
  try { body = await request.json(); } catch { throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400); }
  const parsed = removeCardRequestSchema.parse(body);
  await enforceRateLimit({ namespace: "billing-card-remove", identifier: actor.userId, limit: 10 });
  return Response.json({ requestId: id, ...(await removeSavedCard(actor, parsed.paymentMethodId)) }, { headers: { "cache-control": "no-store" } });
});
