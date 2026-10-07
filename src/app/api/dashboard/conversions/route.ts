import { createConversionFromUpload, listConversionHistory } from "@/server/conversions";
import { errorResponse, requestId, requireActor, withJsonHandler } from "@/server/http";

export async function GET(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const actor = await requireActor(new Headers(request.headers));
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    const history = await listConversionHistory(actor.organizationId, query);
    return Response.json({ requestId: id, ...history }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}

export const POST = withJsonHandler(async (request, id) => {
  const actor = await requireActor(new Headers(request.headers));
  const accepted = await createConversionFromUpload(actor, await request.json());
  return Response.json({ requestId: id, ...accepted }, {
    status: 202,
    headers: { "cache-control": "no-store" },
  });
});
