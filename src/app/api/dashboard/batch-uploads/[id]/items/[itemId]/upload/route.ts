import { issueBatchItemUpload } from "@/server/batch-uploads";
import { assertSameOrigin, errorResponse, requestId, requireActor } from "@/server/http";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  const id = requestId(request);
  try {
    assertSameOrigin(request);
    const actor = await requireActor(request.headers);
    const { id: sessionId, itemId } = await context.params;
    const upload = await issueBatchItemUpload(actor, sessionId, itemId);
    return Response.json({ requestId: id, ...upload }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
