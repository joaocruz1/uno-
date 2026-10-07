import { readBatchUploadSession } from "@/server/batch-uploads";
import { errorResponse, requestId, requireActor } from "@/server/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  try {
    const actor = await requireActor(request.headers);
    const { id: sessionId } = await context.params;
    const session = await readBatchUploadSession(actor.organizationId, sessionId);
    return Response.json({ requestId: id, ...session }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
