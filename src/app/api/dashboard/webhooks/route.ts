import { AppError } from "@/lib/errors";
import { errorResponse, requestId, requireActor, withJsonHandler } from "@/server/http";
import { createWebhookEndpoint, listWebhookEndpoints } from "@/server/webhooks";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const actor = await requireActor(new Headers(request.headers));
    const result = await listWebhookEndpoints(actor);
    return Response.json({ requestId: id, ...result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}

export const POST = withJsonHandler(async (request, id) => {
  const actor = await requireActor(new Headers(request.headers));
  let body: unknown;
  try { body = await request.json(); } catch { throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400); }
  const result = await createWebhookEndpoint(actor, body);
  return Response.json({ requestId: id, ...result }, { status: 201, headers: { "cache-control": "no-store" } });
});
