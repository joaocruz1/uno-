import { randomUUID } from "node:crypto";

import { and, count, eq, inArray, sql } from "drizzle-orm";

import { auditLogs, getDb, subscriptions, webhookDeliveries, webhookEndpoints, type UnoDatabase } from "@/db";
import { AppError } from "@/lib/errors";
import type { PlanId } from "@/lib/plans";
import {
  webhookEndpointCreateSchema,
  webhookEndpointCreatedSchema,
  webhookEndpointListSchema,
  webhookEndpointSchema,
  webhookEndpointUpdateSchema,
  type WebhookEndpoint,
  type WebhookEndpointCreated,
  type WebhookEndpointList,
} from "@/lib/webhook-model";
import type { Actor } from "@/server/auth/actor";
import { effectivePlanFromSubscription } from "@/server/billing/entitlements";

import { webhookMaxActiveEndpoints, webhookTimeoutMs } from "./config";
import { encryptWebhookSecret, generateWebhookSecret, loadWebhookKeyring, type WebhookKeyring } from "./crypto";
import { assertWebhookDestinationAllowed, systemDnsResolver, type DnsResolver } from "./network";

type Transaction = Parameters<Parameters<UnoDatabase["transaction"]>[0]>[0];
type ManagerActor = Pick<Actor, "organizationId" | "userId" | "membershipRole">;

export type WebhookEndpointDependencies = {
  database: UnoDatabase;
  resolve: DnsResolver;
  keyring(): WebhookKeyring;
  maxActiveEndpoints: number;
  dnsTimeoutMs: number;
  now(): Date;
};

export function webhookEndpointDefaults(): WebhookEndpointDependencies {
  return {
    database: getDb(),
    resolve: systemDnsResolver,
    keyring: loadWebhookKeyring,
    maxActiveEndpoints: webhookMaxActiveEndpoints(),
    dnsTimeoutMs: webhookTimeoutMs(),
    now: () => new Date(),
  };
}

export function assertWebhookManager(actor: Pick<Actor, "membershipRole">): void {
  if (actor.membershipRole !== "OWNER" && actor.membershipRole !== "ADMIN") {
    throw new AppError("forbidden", "Acesso negado.", 403);
  }
}

export function isWebhookPlan(planId: PlanId): boolean {
  return planId === "PRO" || planId === "BUSINESS";
}

/** Locks the organization's webhook configuration and returns its effective plan. */
export async function lockWebhookOrganization(organizationId: string, transaction: Transaction, now: Date): Promise<PlanId> {
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${organizationId}, 37))`);
  const rows = await transaction.select({
    planId: subscriptions.planId,
    status: subscriptions.status,
    currentPeriodStart: subscriptions.currentPeriodStart,
    currentPeriodEnd: subscriptions.currentPeriodEnd,
  }).from(subscriptions).where(eq(subscriptions.organizationId, organizationId)).limit(1);
  return effectivePlanFromSubscription(rows[0], now).planId;
}

function assertWebhookPlan(planId: PlanId): void {
  if (!isWebhookPlan(planId)) throw new AppError("plan_required", "Este recurso exige um plano Pro ou Business.", 403);
}

async function assertBelowActiveLimit(organizationId: string, limit: number, transaction: Transaction): Promise<void> {
  const active = await transaction.select({ value: count() }).from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.organizationId, organizationId), eq(webhookEndpoints.active, true)));
  if ((active[0]?.value ?? 0) >= limit) {
    throw new AppError("webhook_endpoint_limit_exceeded", "A organização atingiu o limite de endpoints ativos.", 409);
  }
}

/** Audit rows carry identifiers, action and actor only. */
async function audit(actor: ManagerActor, action: string, endpointId: string, transaction: Transaction, now: Date): Promise<void> {
  await transaction.insert(auditLogs).values({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    actorType: "user",
    action,
    resourceType: "webhook_endpoint",
    resourceId: endpointId,
    metadata: {},
    createdAt: now,
  });
}

function publicEndpoint(row: typeof webhookEndpoints.$inferSelect): WebhookEndpoint {
  return webhookEndpointSchema.parse({
    id: row.id,
    url: row.url,
    events: row.subscribedEvents,
    active: row.active,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function listWebhookEndpoints(
  actor: Pick<Actor, "organizationId" | "membershipRole">,
  dependencies: Pick<WebhookEndpointDependencies, "database" | "maxActiveEndpoints"> = webhookEndpointDefaults(),
): Promise<WebhookEndpointList> {
  assertWebhookManager(actor);
  const rows = await dependencies.database.select().from(webhookEndpoints)
    .where(eq(webhookEndpoints.organizationId, actor.organizationId)).orderBy(webhookEndpoints.createdAt, webhookEndpoints.id);
  return webhookEndpointListSchema.parse({ items: rows.map(publicEndpoint), maxActiveEndpoints: dependencies.maxActiveEndpoints });
}

export async function createWebhookEndpoint(
  actor: ManagerActor,
  rawInput: unknown,
  dependencies: WebhookEndpointDependencies = webhookEndpointDefaults(),
): Promise<WebhookEndpointCreated> {
  assertWebhookManager(actor);
  const input = webhookEndpointCreateSchema.parse(rawInput);
  // Deny by plan before any outbound DNS lookup; the transaction below re-checks under lock.
  const preliminary = await dependencies.database.select({
    planId: subscriptions.planId,
    status: subscriptions.status,
    currentPeriodStart: subscriptions.currentPeriodStart,
    currentPeriodEnd: subscriptions.currentPeriodEnd,
  }).from(subscriptions).where(eq(subscriptions.organizationId, actor.organizationId)).limit(1);
  assertWebhookPlan(effectivePlanFromSubscription(preliminary[0], dependencies.now()).planId);
  const keyring = dependencies.keyring();
  const url = await assertWebhookDestinationAllowed(input.url, dependencies.resolve, dependencies.dnsTimeoutMs);
  const now = dependencies.now();
  const id = randomUUID();
  const secret = generateWebhookSecret();
  const encrypted = encryptWebhookSecret(secret, { organizationId: actor.organizationId, endpointId: id }, keyring);
  const row = await dependencies.database.transaction(async (transaction) => {
    assertWebhookPlan(await lockWebhookOrganization(actor.organizationId, transaction, now));
    await assertBelowActiveLimit(actor.organizationId, dependencies.maxActiveEndpoints, transaction);
    const inserted = await transaction.insert(webhookEndpoints).values({
      id,
      organizationId: actor.organizationId,
      url: url.href,
      ...encrypted,
      subscribedEvents: [...input.events],
      active: true,
      createdByUserId: actor.userId,
      createdAt: now,
      updatedAt: now,
    }).returning();
    await audit(actor, "webhook_endpoint.created", id, transaction, now);
    return inserted[0]!;
  });
  return webhookEndpointCreatedSchema.parse({ ...publicEndpoint(row), secret });
}

/**
 * Enables or disables an endpoint. `updatedAt` is the moment of the last
 * enable/disable, which fan-out uses to skip events that occurred while the
 * endpoint was not enabled. Disabling cancels every pending delivery; they are
 * not re-sent when the endpoint is enabled again.
 */
export async function setWebhookEndpointActive(
  actor: ManagerActor,
  endpointId: string,
  rawInput: unknown,
  dependencies: WebhookEndpointDependencies = webhookEndpointDefaults(),
): Promise<WebhookEndpoint> {
  assertWebhookManager(actor);
  const input = webhookEndpointUpdateSchema.parse(rawInput);
  const now = dependencies.now();
  return dependencies.database.transaction(async (transaction) => {
    const planId = await lockWebhookOrganization(actor.organizationId, transaction, now);
    const rows = await transaction.select().from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.organizationId, actor.organizationId), eq(webhookEndpoints.id, endpointId)))
      .limit(1).for("update");
    const current = rows[0];
    if (!current) throw new AppError("not_found", "Endpoint de webhook não encontrado.", 404);
    if (current.active === input.active) return publicEndpoint(current);
    if (input.active) {
      assertWebhookPlan(planId);
      await assertBelowActiveLimit(actor.organizationId, dependencies.maxActiveEndpoints, transaction);
    }
    const updated = await transaction.update(webhookEndpoints).set({
      active: input.active,
      disabledAt: input.active ? null : now,
      updatedAt: now,
    }).where(and(eq(webhookEndpoints.organizationId, actor.organizationId), eq(webhookEndpoints.id, endpointId))).returning();
    if (!input.active) {
      await transaction.update(webhookDeliveries).set({
        status: "CANCELED",
        claimToken: null,
        leaseExpiresAt: null,
        lastError: "endpoint_disabled",
        updatedAt: now,
      }).where(and(
        eq(webhookDeliveries.organizationId, actor.organizationId),
        eq(webhookDeliveries.endpointId, endpointId),
        inArray(webhookDeliveries.status, ["PENDING", "PROCESSING"]),
      ));
    }
    await audit(actor, input.active ? "webhook_endpoint.enabled" : "webhook_endpoint.disabled", endpointId, transaction, now);
    return publicEndpoint(updated[0]!);
  });
}

/** Deleting removes the endpoint and (by cascade) its deliveries, so nothing is retried. */
export async function deleteWebhookEndpoint(
  actor: ManagerActor,
  endpointId: string,
  dependencies: Pick<WebhookEndpointDependencies, "database" | "now"> = webhookEndpointDefaults(),
): Promise<void> {
  assertWebhookManager(actor);
  const now = dependencies.now();
  await dependencies.database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${actor.organizationId}, 37))`);
    const deleted = await transaction.delete(webhookEndpoints)
      .where(and(eq(webhookEndpoints.organizationId, actor.organizationId), eq(webhookEndpoints.id, endpointId)))
      .returning({ id: webhookEndpoints.id });
    if (!deleted[0]) throw new AppError("not_found", "Endpoint de webhook não encontrado.", 404);
    await audit(actor, "webhook_endpoint.deleted", endpointId, transaction, now);
  });
}
