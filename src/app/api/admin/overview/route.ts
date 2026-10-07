import { adminOverview, requirePlatformAdmin } from "@/server/admin";
import { jsonResponse, managementRoute } from "@/server/organizations/http";
import { enforceAdminRateLimit } from "@/server/organizations/limits";

export const runtime = "nodejs";

export const GET = managementRoute(async ({ id, headers }) => {
  const admin = await requirePlatformAdmin(headers);
  await enforceAdminRateLimit(admin.userId);
  return jsonResponse(id, await adminOverview(admin));
});
