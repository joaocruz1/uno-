import { getPublicUsage, publicApiErrorResponse } from "@/server/api-ingestion";
import { requestId } from "@/server/http";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    return Response.json({ requestId: id, ...await getPublicUsage(request) }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return publicApiErrorResponse(error, id);
  }
}
