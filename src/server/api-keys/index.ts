import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, count, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { apiKeys, getDb, subscriptions, type UnoDatabase } from "@/db";
import { apiKeyCreatedSchema, apiKeyListSchema, apiKeyNameSchema, type ApiKeyCreated, type ApiKeyList } from "@/lib/api-model";
import { AppError } from "@/lib/errors";
import type { PlanId } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";
import { API_ADDON_REQUIRED_MESSAGE, effectivePlanFromSubscription, subscriptionEntitlementColumns, type EffectivePlan } from "@/server/billing/entitlements";

const MAX_ACTIVE_KEYS = 20;
const createInputSchema = z.object({
  name: apiKeyNameSchema,
  expiresAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

/** Minimum spacing between two `last_used_at` writes for the same key. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export type ApiActor = {
  organizationId: string;
  apiKeyId: string;
  planId: PlanId;
};

function assertManager(actor: Pick<Actor, "membershipRole">): void {
  if (actor.membershipRole !== "OWNER" && actor.membershipRole !== "ADMIN") {
    throw new AppError("forbidden", "Acesso negado.", 403);
  }
}

/** The code stays `plan_required` (public contract); the entitlement is the API add-on on a paid plan. */
function assertApiEntitlement(entitlement: EffectivePlan): void {
  if (!entitlement.plan.api) {
    throw new AppError("plan_required", API_ADDON_REQUIRED_MESSAGE, 403);
  }
}

function secretHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function publicKey(row: typeof apiKeys.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listApiKeys(
  actor: Pick<Actor, "organizationId" | "membershipRole">,
  database: UnoDatabase = getDb(),
): Promise<ApiKeyList> {
  assertManager(actor);
  const rows = await database.select().from(apiKeys)
    .where(eq(apiKeys.organizationId, actor.organizationId)).orderBy(apiKeys.createdAt);
  return apiKeyListSchema.parse({ items: rows.map(publicKey) });
}

export async function createApiKey(
  actor: Pick<Actor, "organizationId" | "userId" | "membershipRole">,
  rawInput: unknown,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<ApiKeyCreated> {
  assertManager(actor);
  const input = createInputSchema.parse(rawInput);
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt <= now) throw new AppError("invalid_request", "A validade da chave deve estar no futuro.", 400);
  const secret = `uno_${randomBytes(32).toString("base64url")}`;
  const prefix = secret.slice(0, 12);
  const id = randomUUID();
  const row = await database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${actor.organizationId}, 31))`);
    const subscriptionRows = await transaction.select({
      ...subscriptionEntitlementColumns,
    }).from(subscriptions).where(eq(subscriptions.organizationId, actor.organizationId)).limit(1).for("update");
    const entitlement = effectivePlanFromSubscription(subscriptionRows[0], now);
    assertApiEntitlement(entitlement);
    const active = await transaction.select({ value: count() }).from(apiKeys).where(and(
      eq(apiKeys.organizationId, actor.organizationId),
      isNull(apiKeys.revokedAt),
      or(isNull(apiKeys.expiresAt), sql`${apiKeys.expiresAt} > ${now}`),
    ));
    if ((active[0]?.value ?? 0) >= MAX_ACTIVE_KEYS) throw new AppError("api_key_limit_exceeded", "A organização atingiu o limite de chaves ativas.", 409);
    const inserted = await transaction.insert(apiKeys).values({
      id,
      organizationId: actor.organizationId,
      createdByUserId: actor.userId,
      name: input.name,
      prefix,
      keyHash: secretHash(secret),
      expiresAt,
      createdAt: now,
    }).returning();
    return inserted[0]!;
  });
  return apiKeyCreatedSchema.parse({ ...publicKey(row), key: secret });
}

export async function revokeApiKey(
  actor: Pick<Actor, "organizationId" | "membershipRole">,
  apiKeyId: string,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<void> {
  assertManager(actor);
  const revoked = await database.update(apiKeys).set({ revokedAt: now }).where(and(
    eq(apiKeys.organizationId, actor.organizationId),
    eq(apiKeys.id, apiKeyId),
  )).returning({ id: apiKeys.id });
  if (!revoked[0]) throw new AppError("not_found", "Chave de API não encontrada.", 404);
}

function bearerSecret(headers: Headers): string {
  const authorization = headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{40,160})$/.exec(authorization);
  if (!match) throw new AppError("unauthorized", "Chave de API inválida.", 401);
  return match[1]!;
}

export async function requireApiActor(
  headers: Headers,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<ApiActor> {
  const hash = secretHash(bearerSecret(headers));
  const rows = await database.select({
    id: apiKeys.id,
    organizationId: apiKeys.organizationId,
    revokedAt: apiKeys.revokedAt,
    expiresAt: apiKeys.expiresAt,
    lastUsedAt: apiKeys.lastUsedAt,
    ...subscriptionEntitlementColumns,
  }).from(apiKeys).innerJoin(subscriptions, eq(subscriptions.organizationId, apiKeys.organizationId))
    .where(eq(apiKeys.keyHash, hash)).limit(1);
  const row = rows[0];
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= now)) {
    throw new AppError("unauthorized", "Chave de API inválida.", 401);
  }
  const entitlement = effectivePlanFromSubscription(row, now);
  assertApiEntitlement(entitlement);
  // "Last used" is informational. Clients poll results several times per
  // second, so the write is skipped while the stored value is recent.
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_WRITE_INTERVAL_MS) {
    await database.update(apiKeys).set({ lastUsedAt: now }).where(and(eq(apiKeys.organizationId, row.organizationId), eq(apiKeys.id, row.id)));
  }
  return { organizationId: row.organizationId, apiKeyId: row.id, planId: entitlement.planId };
}

export async function requireFreshApiActor(
  actor: Pick<ApiActor, "organizationId" | "apiKeyId">,
  database: UnoDatabase,
  now = new Date(),
): Promise<ApiActor> {
  const rows = await database.select({
    id: apiKeys.id,
    organizationId: apiKeys.organizationId,
    revokedAt: apiKeys.revokedAt,
    expiresAt: apiKeys.expiresAt,
    ...subscriptionEntitlementColumns,
  }).from(apiKeys).innerJoin(subscriptions, eq(subscriptions.organizationId, apiKeys.organizationId)).where(and(
    eq(apiKeys.organizationId, actor.organizationId),
    eq(apiKeys.id, actor.apiKeyId),
  )).limit(1).for("update");
  const row = rows[0];
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= now)) throw new AppError("unauthorized", "Chave de API inválida.", 401);
  const entitlement = effectivePlanFromSubscription(row, now);
  assertApiEntitlement(entitlement);
  return { organizationId: row.organizationId, apiKeyId: row.id, planId: entitlement.planId };
}

export { createInputSchema as createApiKeyInputSchema };
