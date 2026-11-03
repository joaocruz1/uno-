import { createExtensionToken, listExtensionTokens } from "@/server/extension/tokens";
import { errorResponse, requestId, requireActor, withJsonHandler } from "@/server/http";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const actor = await requireActor(request.headers);
    return Response.json({ requestId: id, items: await listExtensionTokens(actor) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}

/** Connects a browser: returns the token once, for the /extensao/conectar handoff. */
export const POST = withJsonHandler(async (request, id) => {
  const actor = await requireActor(request.headers);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400);
  }
  const created = await createExtensionToken(actor, body);
  return Response.json({ requestId: id, ...created }, { status: 201, headers: { "cache-control": "no-store" } });
});
