import { readUsageState } from "@/server/billing";
import { requireExtensionActor } from "@/server/extension/tokens";
import { errorResponse, requestId } from "@/server/http";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const actor = await requireExtensionActor(request.headers);
    const usage = await readUsageState(actor);
    return Response.json({
      requestId: id,
      organizationName: actor.organizationName,
      userName: actor.name,
      planId: actor.planId,
      usage: { used: usage.current.reserved + usage.current.confirmed, limit: usage.current.limit },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
