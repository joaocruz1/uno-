import { createBatchUploadSession } from "@/server/batch-uploads";
import { AppError } from "@/lib/errors";
import { requireActor, withJsonHandler } from "@/server/http";

export const runtime = "nodejs";

export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(request.headers);
  let body: unknown;
  try { body = await request.json(); } catch { throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400); }
  const session = await createBatchUploadSession(actor, body);
  return Response.json({ requestId, ...session }, { status: 201, headers: { "cache-control": "no-store" } });
});
