import { errorResponse, requestId, requireActor } from "@/server/http";
import { listWebhookDeliveries } from "@/server/webhooks";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const actor = await requireActor(new Headers(request.headers));
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    const result = await listWebhookDeliveries(actor, query);
    return Response.json({ requestId: id, ...result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
