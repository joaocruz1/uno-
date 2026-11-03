import { requireExtensionActor, revokeExtensionToken } from "@/server/extension/tokens";
import { errorResponse, requestId } from "@/server/http";

export const runtime = "nodejs";

/** "Desconectar" in the extension: revokes the calling token. */
export async function DELETE(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const actor = await requireExtensionActor(request.headers);
    await revokeExtensionToken({ ...actor, membershipRole: "OWNER" }, actor.extensionTokenId);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
