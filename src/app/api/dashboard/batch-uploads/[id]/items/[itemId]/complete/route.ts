import { completeBatchItemUpload } from "@/server/batch-uploads";
import { assertSameOrigin, errorResponse, requestId, requireActor } from "@/server/http";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  const id = requestId(request);
  try {
    assertSameOrigin(request);
    const actor = await requireActor(request.headers);
    const { id: sessionId, itemId } = await context.params;
    const result = await completeBatchItemUpload(actor, sessionId, itemId);
    return Response.json({ requestId: id, ...result.session }, {
      status: result.preparing ? 202 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, id);
  }
}
