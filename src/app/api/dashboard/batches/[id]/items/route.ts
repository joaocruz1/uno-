import { listBatchItems } from "@/server/batches";
import { errorResponse, requestId, requireActor } from "@/server/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = requestId(request);
  try {
    const actor = await requireActor(request.headers);
    const { id: batchId } = await context.params;
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    const items = await listBatchItems(actor.organizationId, batchId, query);
    return Response.json({ requestId: id, ...items }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
