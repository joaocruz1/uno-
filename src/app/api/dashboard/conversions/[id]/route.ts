import { readConversion } from "@/server/conversions";
import { errorResponse, requestId, requireActor } from "@/server/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = requestId(request);
  try {
    const actor = await requireActor(new Headers(request.headers));
    const { id: conversionId } = await context.params;
    const conversion = await readConversion(actor.organizationId, conversionId);
    return Response.json({ requestId: id, ...conversion }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
