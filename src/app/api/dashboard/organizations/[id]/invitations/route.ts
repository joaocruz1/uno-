import { requireIdentity } from "@/server/auth/actor";
import { inviteMember, listInvitations, requireMembership } from "@/server/organizations";
import { jsonResponse, managementRoute, readJson } from "@/server/organizations/http";
import { enforceInvitationRateLimit, enforceManagementRateLimit } from "@/server/organizations/limits";

export const runtime = "nodejs";

export const GET = managementRoute<{ id: string }>(async ({ id, params, headers }) => {
  const identity = await requireIdentity(headers);
  return jsonResponse(id, await listInvitations(identity, params.id));
});

export const POST = managementRoute<{ id: string }>(async ({ request, id, params, headers }) => {
  const identity = await requireIdentity(headers);
  await enforceManagementRateLimit(identity.userId);
  // Membership first, so a foreign caller cannot consume another organization's e-mail budget.
  const { organizationId } = await requireMembership(identity, params.id);
  await enforceInvitationRateLimit(organizationId);
  return jsonResponse(id, await inviteMember(identity, organizationId, await readJson(request)), { status: 201 });
});
