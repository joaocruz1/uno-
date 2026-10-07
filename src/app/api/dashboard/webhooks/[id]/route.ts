import { AppError } from "@/lib/errors";
import { assertSameOrigin, errorResponse, requestId, requireActor } from "@/server/http";
import { deleteWebhookEndpoint, setWebhookEndpointActive } from "@/server/webhooks";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const id = requestId(request);
  try {
    assertSameOrigin(request);
    const actor = await requireActor(new Headers(request.headers));
    const { id: endpointId } = await context.params;
    let body: unknown;
    try { body = await request.json(); } catch { throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400); }
    const result = await setWebhookEndpointActive(actor, endpointId, body);
    return Response.json({ requestId: id, ...result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const id = requestId(request);
  try {
    assertSameOrigin(request);
    const actor = await requireActor(new Headers(request.headers));
    const { id: endpointId } = await context.params;
    await deleteWebhookEndpoint(actor, endpointId);
    return new Response(null, { status: 204, headers: { "x-request-id": id, "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
