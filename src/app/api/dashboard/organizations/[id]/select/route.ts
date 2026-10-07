import { requireIdentity } from "@/server/auth/actor";
import { selectOrganization } from "@/server/organizations";
import { jsonResponse, managementRoute, selectionCookie } from "@/server/organizations/http";
import { enforceManagementRateLimit } from "@/server/organizations/limits";

export const runtime = "nodejs";

export const POST = managementRoute<{ id: string }>(async ({ id, params, headers }) => {
  const identity = await requireIdentity(headers);
  await enforceManagementRateLimit(identity.userId);
  const selected = await selectOrganization(identity, params.id);
  return jsonResponse(id, selected, { headers: { "set-cookie": selectionCookie(selected.id) } });
});
