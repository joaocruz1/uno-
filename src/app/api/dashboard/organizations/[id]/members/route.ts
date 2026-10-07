import { requireIdentity } from "@/server/auth/actor";
import { listMembers } from "@/server/organizations";
import { jsonResponse, managementRoute } from "@/server/organizations/http";

export const runtime = "nodejs";

export const GET = managementRoute<{ id: string }>(async ({ id, params, headers }) => {
  const identity = await requireIdentity(headers);
  return jsonResponse(id, await listMembers(identity, params.id));
});
