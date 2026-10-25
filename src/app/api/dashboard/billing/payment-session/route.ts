import { positiveIntegerEnv } from "@/lib/env";
import { createPaymentSession } from "@/server/billing";
import { requireActor, withJsonHandler } from "@/server/http";
import { enforceRateLimit } from "@/server/rate-limit";

export const runtime = "nodejs";

/** CustomerSession for the Payment Element on /checkout plus the cards Stripe keeps for the organization (NEX-52). */
export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(new Headers(request.headers));
  await enforceRateLimit({ namespace: "billing-payment-session", identifier: actor.userId, limit: positiveIntegerEnv("UNO_PAYMENT_SESSION_RATE_LIMIT", 30) });
  const session = await createPaymentSession(actor);
  return Response.json({ requestId, ...session }, { headers: { "cache-control": "no-store" } });
});
