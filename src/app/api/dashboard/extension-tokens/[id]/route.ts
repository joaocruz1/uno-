import { revokeExtensionToken } from "@/server/extension/tokens";
import { assertSameOrigin, errorResponse, requestId, requireActor } from "@/server/http";

export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const id = requestId(request);
  try {
    assertSameOrigin(request);
    const actor = await requireActor(request.headers);
    const { id: tokenId } = await context.params;
    await revokeExtensionToken(actor, tokenId);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
