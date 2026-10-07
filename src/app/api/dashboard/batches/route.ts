import { listBatches, submitBatch } from "@/server/batches";
import { AppError } from "@/lib/errors";
import { errorResponse, requestId, requireActor, withJsonHandler } from "@/server/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    const actor = await requireActor(request.headers);
    const query = Object.fromEntries(new URL(request.url).searchParams.entries());
    const result = await listBatches(actor.organizationId, query);
    return Response.json({ requestId: id, ...result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}

export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(request.headers);
  let body: unknown;
  try { body = await request.json(); } catch { throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400); }
  const accepted = await submitBatch(actor, body, request.headers.get("idempotency-key"));
  return Response.json({ requestId, ...accepted }, { status: 202, headers: { "cache-control": "no-store" } });
});
