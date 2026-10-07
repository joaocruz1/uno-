import { requireIdentity } from "@/server/auth/actor";
import { revokeInvitation } from "@/server/organizations";
import { emptyResponse, managementRoute } from "@/server/organizations/http";
import { enforceManagementRateLimit } from "@/server/organizations/limits";

export const runtime = "nodejs";

export const DELETE = managementRoute<{ id: string; invitationId: string }>(async ({ id, params, headers }) => {
  const identity = await requireIdentity(headers);
  await enforceManagementRateLimit(identity.userId);
  await revokeInvitation(identity, params.id, params.invitationId);
  return emptyResponse(id);
});
