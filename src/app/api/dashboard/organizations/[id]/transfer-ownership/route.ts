import { requireIdentity } from "@/server/auth/actor";
import { transferOwnership } from "@/server/organizations";
import { jsonResponse, managementRoute, readJson } from "@/server/organizations/http";
import { enforceManagementRateLimit } from "@/server/organizations/limits";

export const runtime = "nodejs";

export const POST = managementRoute<{ id: string }>(async ({ request, id, params, headers }) => {
  const identity = await requireIdentity(headers);
  await enforceManagementRateLimit(identity.userId);
  return jsonResponse(id, await transferOwnership(identity, params.id, await readJson(request)));
});
