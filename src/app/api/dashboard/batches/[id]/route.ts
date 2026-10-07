import { readBatch } from "@/server/batches";
import { errorResponse, requestId, requireActor } from "@/server/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  try {
    const actor = await requireActor(request.headers);
    const { id: batchId } = await context.params;
    const batch = await readBatch(actor.organizationId, batchId);
    return Response.json({ requestId: id, ...batch }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
