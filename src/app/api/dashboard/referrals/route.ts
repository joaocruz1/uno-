import { errorResponse, requestId, requireActor } from "@/server/http";
import { referralProgress } from "@/server/billing/referrals";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const id = requestId(request);
  try {
    const actor = await requireActor(request.headers);
    const progress = await referralProgress(actor.userId);
    return Response.json({ requestId: id, ...progress }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
