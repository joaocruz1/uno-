import { createPublicResource, publicApiErrorResponse } from "@/server/api-ingestion";
import { requestId } from "@/server/http";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    return Response.json(await createPublicResource(request, id, "conversion"), {
      status: 202,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return publicApiErrorResponse(error, id);
  }
}
