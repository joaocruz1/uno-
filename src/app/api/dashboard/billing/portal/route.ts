import { createBillingPortal } from "@/server/billing";
import { requireActor, withJsonHandler } from "@/server/http";

export const runtime = "nodejs";

export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(new Headers(request.headers));
  const result = await createBillingPortal(actor);
  return Response.json({ requestId, ...result }, { headers: { "cache-control": "no-store" } });
});
