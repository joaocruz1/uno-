import { requireIdentity, selectedOrganizationPreference } from "@/server/auth/actor";
import { createOrganization, listOrganizations } from "@/server/organizations";
import { jsonResponse, managementRoute, readJson, selectionCookie } from "@/server/organizations/http";
import { enforceManagementRateLimit } from "@/server/organizations/limits";

export const runtime = "nodejs";

// Identity only: listing and creating must work without a valid selection.
export const GET = managementRoute(async ({ id, headers }) => {
  const identity = await requireIdentity(headers);
  return jsonResponse(id, await listOrganizations(identity, selectedOrganizationPreference(headers)));
});

export const POST = managementRoute(async ({ request, id, headers }) => {
  const identity = await requireIdentity(headers);
  await enforceManagementRateLimit(identity.userId);
  const created = await createOrganization(identity, await readJson(request));
  return jsonResponse(id, created, { status: 201, headers: { "set-cookie": selectionCookie(created.id) } });
});
