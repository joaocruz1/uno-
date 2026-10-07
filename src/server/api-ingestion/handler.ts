import { getPlanCatalog } from "@/lib/plans";
import { positiveIntegerEnv } from "@/lib/env";
import { enforceRateLimit } from "@/server/rate-limit";

import { requireApiActor, type ApiActor } from "../api-keys";
import { admitPublicBatch, admitPublicConversion, beginPublicRequest, failPublicRequest, type PublicRequestClaim } from "./admission";
import { acquireApiCapacity, type ApiCapacityLease } from "./capacity";
import { parseApiMultipart } from "./parser";
import { readPublicBatch, readPublicConversion, readPublicUsage } from "./read";

const MEBIBYTE = 1_024 * 1_024;
const ENGINE_MAX_FILE_BYTES = 100 * MEBIBYTE;

async function authenticateAndLimit(request: Request): Promise<ApiActor> {
  const actor = await requireApiActor(new Headers(request.headers));
  const plan = getPlanCatalog()[actor.planId];
  // One budget per organization across every /api/v1 route, as the public contract states.
  await enforceRateLimit({
    namespace: "public-api",
    identifier: actor.organizationId,
    limit: plan.rateLimit,
  });
  return actor;
}

export async function createPublicResource(
  request: Request,
  requestId: string,
  kind: "conversion" | "batch",
): Promise<Record<string, unknown>> {
  const route = kind === "conversion" ? "/api/v1/conversions" : "/api/v1/batches";
  const actor = await authenticateAndLimit(request);
  const plan = getPlanCatalog()[actor.planId];
  let claim: PublicRequestClaim | undefined;
  let capacity: ApiCapacityLease | undefined;
  try {
    claim = await beginPublicRequest(actor, {
      route,
      method: "POST",
      idempotencyKey: request.headers.get("idempotency-key"),
      requestId,
    });
    const maxFiles = kind === "conversion" ? 1 : plan.batchLimit;
    const maxFileBytes = Math.min(ENGINE_MAX_FILE_BYTES, plan.maxFileMB * MEBIBYTE);
    const maxRequests = Math.max(2, Math.min(10, plan.batchLimit));
    const deadlineMs = positiveIntegerEnv("UNO_API_UPLOAD_DEADLINE_MS", 30 * 60_000);
    capacity = await acquireApiCapacity({
      organizationId: actor.organizationId,
      maxRequests,
      maxBytes: maxFileBytes * Math.max(maxFiles, maxRequests),
      ttlSeconds: Math.ceil(deadlineMs / 1_000) + 60,
    });
    const parsed = await parseApiMultipart(request, {
      organizationId: actor.organizationId,
      apiRequestId: claim.id,
      attempt: claim.attempt,
      expectedFileField: kind === "conversion" ? "file" : "files",
      maxFiles,
      maxFileBytes,
      capacity,
    });
    const accepted = kind === "conversion"
      ? await admitPublicConversion(actor, claim, parsed)
      : await admitPublicBatch(actor, claim, parsed);
    return { requestId, ...accepted };
  } catch (error) {
    if (claim) await failPublicRequest(actor.organizationId, claim).catch(() => undefined);
    throw error;
  } finally {
    await capacity?.release();
  }
}

export async function getPublicConversion(request: Request, conversionId: string) {
  const actor = await authenticateAndLimit(request);
  return readPublicConversion(actor, conversionId);
}

export async function getPublicBatch(request: Request, batchId: string) {
  const actor = await authenticateAndLimit(request);
  return readPublicBatch(actor, batchId);
}

export async function getPublicUsage(request: Request) {
  const actor = await authenticateAndLimit(request);
  return readPublicUsage(actor);
}
