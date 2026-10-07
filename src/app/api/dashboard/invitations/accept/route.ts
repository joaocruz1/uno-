import { requireIdentity } from "@/server/auth/actor";
import { acceptInvitation } from "@/server/organizations";
import { jsonResponse, managementRoute, readJson, selectionCookie } from "@/server/organizations/http";
import { enforceInvitationAcceptRateLimit } from "@/server/organizations/limits";

export const runtime = "nodejs";

export const POST = managementRoute(async ({ request, id, headers }) => {
  const identity = await requireIdentity(headers);
  await enforceInvitationAcceptRateLimit(identity.userId);
  const accepted = await acceptInvitation(identity, await readJson(request));
  return jsonResponse(id, accepted, { headers: { "set-cookie": selectionCookie(accepted.organizationId) } });
});
