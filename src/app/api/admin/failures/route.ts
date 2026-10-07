import { listAdminFailures, requirePlatformAdmin } from "@/server/admin";
import { jsonResponse, managementRoute } from "@/server/organizations/http";
import { enforceAdminRateLimit } from "@/server/organizations/limits";

export const runtime = "nodejs";

export const GET = managementRoute(async ({ request, id, headers }) => {
  const admin = await requirePlatformAdmin(headers);
  await enforceAdminRateLimit(admin.userId);
  const query = Object.fromEntries(new URL(request.url).searchParams);
  return jsonResponse(id, await listAdminFailures(admin, { limit: query.limit, cursor: query.cursor }));
});
