import { publishTemplateRelease, requirePlatformAdmin } from "@/server/admin";
import { jsonResponse, managementRoute, readJson } from "@/server/organizations/http";
import { enforceAdminRateLimit } from "@/server/organizations/limits";

export const runtime = "nodejs";

export const POST = managementRoute<{ id: string }>(async ({ request, id, params, headers }) => {
  const admin = await requirePlatformAdmin(headers);
  await enforceAdminRateLimit(admin.userId);
  const published = await publishTemplateRelease(admin, params.id, await readJson(request));
  return jsonResponse(id, published, { status: published.created ? 201 : 200 });
});
