import { revokeApiKey } from "@/server/api-keys";
import { assertSameOrigin, errorResponse, requestId, requireActor } from "@/server/http";

export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const id = requestId(request);
  try {
    assertSameOrigin(request);
    const actor = await requireActor(new Headers(request.headers));
    const { id: apiKeyId } = await context.params;
    await revokeApiKey(actor, apiKeyId);
    return new Response(null, { status: 204, headers: { "x-request-id": id, "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
