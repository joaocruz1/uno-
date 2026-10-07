import { getPublicBatch, publicApiErrorResponse } from "@/server/api-ingestion";
import { requestId } from "@/server/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const id = requestId(request);
  try {
    const { id: batchId } = await context.params;
    return Response.json({ requestId: id, ...await getPublicBatch(request, batchId) }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return publicApiErrorResponse(error, id);
  }
}
