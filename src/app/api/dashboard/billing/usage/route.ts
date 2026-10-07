import { readUsageState } from "@/server/billing";
import { errorResponse, requestId, requireActor } from "@/server/http";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const actor = await requireActor(new Headers(request.headers));
    const result = await readUsageState(actor);
    return Response.json({ requestId: id, ...result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
