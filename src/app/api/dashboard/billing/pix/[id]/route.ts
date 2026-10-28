import { errorResponse, requestId, requireActor } from "@/server/http";
import { reconcilePixPurchase } from "@/server/billing/pix/purchase";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  try {
    const actor = await requireActor(request.headers);
    const { id: chargeId } = await context.params;
    const purchase = await reconcilePixPurchase(actor.organizationId, chargeId);
    return Response.json({ requestId: id, ...purchase }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
