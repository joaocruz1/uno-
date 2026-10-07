import { AppError } from "@/lib/errors";
import { requireActor, withJsonHandler } from "@/server/http";
import { createUploadIntent } from "@/server/uploads";

export const runtime = "nodejs";

export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(request.headers);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400);
  }
  const intent = await createUploadIntent(actor, body);
  return Response.json(
    { requestId, ...intent },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
});
