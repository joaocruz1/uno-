import { AppError } from "@/lib/errors";
import { requireActor, withJsonHandler } from "@/server/http";
import { createMarketplaceLote } from "@/server/marketplace/create";

export const runtime = "nodejs";

export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(request.headers);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400);
  }
  const accepted = await createMarketplaceLote(actor, body);
  return Response.json({ requestId, ...accepted }, { status: 202, headers: { "cache-control": "no-store" } });
});
