import { assertSameOrigin, errorResponse, requestId, requireActor } from "@/server/http";
import { retryWebhookDelivery } from "@/server/webhooks";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const id = requestId(request);
  try {
    assertSameOrigin(request);
    const actor = await requireActor(new Headers(request.headers));
    const { id: deliveryId } = await context.params;
    await retryWebhookDelivery(actor, deliveryId);
    return Response.json({ requestId: id, accepted: true }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
