import { createConversionFromUpload } from "@/server/conversions";
import { requireActor, withJsonHandler } from "@/server/http";

export const POST = withJsonHandler(async (request, id) => {
  const actor = await requireActor(new Headers(request.headers));
  const accepted = await createConversionFromUpload(actor, await request.json());
  return Response.json({ requestId: id, ...accepted }, {
    status: 202,
    headers: { "cache-control": "no-store" },
  });
});
