import { AppError } from "@/lib/errors";
import { requireActor, withJsonHandler } from "@/server/http";
import { createPixPurchase } from "@/server/billing/pix/purchase";

export const runtime = "nodejs";

export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(request.headers);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400);
  }
  const purchase = await createPixPurchase(actor, body);
  return Response.json({ requestId, ...purchase }, { status: 201, headers: { "cache-control": "no-store" } });
});
