import { requireIdentity } from "@/server/auth/actor";
import { removeMember, updateMemberRole } from "@/server/organizations";
import { emptyResponse, jsonResponse, managementRoute, readJson } from "@/server/organizations/http";
import { enforceManagementRateLimit } from "@/server/organizations/limits";

export const runtime = "nodejs";

type Params = { id: string; userId: string };

export const PATCH = managementRoute<Params>(async ({ request, id, params, headers }) => {
  const identity = await requireIdentity(headers);
  await enforceManagementRateLimit(identity.userId);
  return jsonResponse(id, await updateMemberRole(identity, params.id, params.userId, await readJson(request)));
});

export const DELETE = managementRoute<Params>(async ({ id, params, headers }) => {
  const identity = await requireIdentity(headers);
  await enforceManagementRateLimit(identity.userId);
  await removeMember(identity, params.id, params.userId);
  return emptyResponse(id);
});
