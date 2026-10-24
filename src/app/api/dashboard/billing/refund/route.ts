import { readRefundEligibility, requestBillingRefund } from "@/server/billing";
import { errorResponse, requestId, requireActor, withJsonHandler } from "@/server/http";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const actor = await requireActor(new Headers(request.headers));
    const result = await readRefundEligibility(actor);
    return Response.json({ requestId: id, ...result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}

export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(new Headers(request.headers));
  const result = await requestBillingRefund(actor, request.headers.get("idempotency-key"));
  return Response.json({ requestId, ...result }, { headers: { "cache-control": "no-store" } });
});
