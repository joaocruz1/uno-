import { requireActor, withJsonHandler } from "@/server/http";
import { claimReferralReward } from "@/server/billing/referrals";

export const runtime = "nodejs";

/** Grants the referral bonus once the referrer reaches the goal; idempotent. */
export const POST = withJsonHandler(async (request, requestId) => {
  const actor = await requireActor(request.headers);
  const result = await claimReferralReward(actor.userId);
  return Response.json({ requestId, ...result }, { headers: { "cache-control": "no-store" } });
});
