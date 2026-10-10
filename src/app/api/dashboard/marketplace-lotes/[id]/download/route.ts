import { errorResponse, requestId, requireActor } from "@/server/http";
import { signMarketplaceLoteDownload } from "@/server/marketplace/read";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  try {
    const actor = await requireActor(request.headers);
    const { id: loteId } = await context.params;
    const download = await signMarketplaceLoteDownload(actor.organizationId, loteId);
    return Response.json({ requestId: id, ...download }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
