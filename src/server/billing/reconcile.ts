import { createHash } from "node:crypto";

import { and, asc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type Stripe from "stripe";

import {
  billingCheckoutIntents,
  getDb,
  processedStripeEvents,
  subscriptions,
  type UnoDatabase,
} from "@/db";
import { positiveIntegerEnv, requiredEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { getPlanCatalog, type PlanId } from "@/lib/plans";

import { PAID_PLAN_IDS, stripePriceId } from "./config";
import { effectivePlanId, lockCurrentUsagePeriod, lockOrganizationBilling } from "./entitlements";
import { getBillingProvider, type BillingProvider, type StripeSubscriptionSnapshot } from "./stripe";

const SUPPORTED_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
]);
const PROCESSING_STALE_SECONDS = 300;

export type ReconcileDependencies = {
  database: UnoDatabase;
  provider: BillingProvider;
  now(): Date;
};

function defaults(): ReconcileDependencies {
  return { database: getDb(), provider: getBillingProvider(), now: () => new Date() };
}

function pricePlanMap(): Map<string, Exclude<PlanId, "FREE">> {
  const map = new Map<string, Exclude<PlanId, "FREE">>();
  for (const planId of PAID_PLAN_IDS) {
    const priceId = stripePriceId(planId);
    if (map.has(priceId)) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    map.set(priceId, planId);
  }
  return map;
}

function objectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  return null;
}

function customerFromEvent(event: Stripe.Event): string | null {
  const object = event.data.object as unknown as { customer?: unknown };
  return objectId(object.customer);
}

function checkoutSessionId(event: Stripe.Event): string | null {
  if (!event.type.startsWith("checkout.session.")) return null;
  return objectId(event.data.object);
}

function mappedStatus(status: StripeSubscriptionSnapshot["status"]) {
  switch (status) {
    case "trialing": return "TRIALING" as const;
    case "active": return "ACTIVE" as const;
    case "past_due": return "PAST_DUE" as const;
    case "canceled": return "CANCELED" as const;
    case "unpaid": return "UNPAID" as const;
    case "paused": return "PAUSED" as const;
    case "incomplete_expired": return "CANCELED" as const;
    default: return "INCOMPLETE" as const;
  }
}

type Claim = { organizationId: string; subscriptionId: string; version: number; customerId: string };

async function claimReconciliation(customerId: string, deps: ReconcileDependencies): Promise<Claim | null> {
  return deps.database.transaction(async (transaction) => {
    const rows = await transaction.select().from(subscriptions).where(eq(subscriptions.stripeCustomerId, customerId)).limit(1).for("update");
    const row = rows[0];
    if (!row) return null;
    const version = row.reconciliationVersion + 1;
    await transaction.update(subscriptions).set({ reconciliationVersion: version, updatedAt: deps.now() }).where(eq(subscriptions.id, row.id));
    return { organizationId: row.organizationId, subscriptionId: row.id, version, customerId };
  });
}

function chooseSubscription(
  localSubscriptionId: string | null,
  snapshots: StripeSubscriptionSnapshot[],
  prices: Map<string, Exclude<PlanId, "FREE">>,
): StripeSubscriptionSnapshot | null {
  const local = localSubscriptionId ? snapshots.find((snapshot) => snapshot.id === localSubscriptionId) : undefined;
  if (local && local.status !== "canceled" && local.status !== "incomplete_expired") return local;
  const recognized = snapshots.filter((snapshot) => snapshot.priceIds.length === 1 && prices.has(snapshot.priceIds[0]!));
  const manageable = recognized.filter((snapshot) => snapshot.status !== "canceled" && snapshot.status !== "incomplete_expired");
  if (manageable.length > 1) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  return manageable[0] ?? local ?? recognized[0] ?? null;
}

export async function reconcileStripeCustomer(customerId: string, dependencies: ReconcileDependencies = defaults()): Promise<string | null> {
  const claim = await claimReconciliation(customerId, dependencies);
  if (!claim) return null;
  const local = await dependencies.database.select({ stripeSubscriptionId: subscriptions.stripeSubscriptionId })
    .from(subscriptions).where(eq(subscriptions.id, claim.subscriptionId)).limit(1);
  const snapshots = await dependencies.provider.listSubscriptions(customerId);
  if (snapshots.some((snapshot) => snapshot.customerId !== customerId)) {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
  const prices = pricePlanMap();
  const selected = chooseSubscription(local[0]?.stripeSubscriptionId ?? null, snapshots, prices);
  const priceId = selected?.priceIds.length === 1 ? selected.priceIds[0]! : null;
  const recognizedPlan = priceId ? prices.get(priceId) : undefined;
  if (selected && !recognizedPlan) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  const now = dependencies.now();
  await dependencies.database.transaction(async (transaction) => {
    await lockOrganizationBilling(claim.organizationId, transaction);
    const rows = await transaction.select().from(subscriptions).where(and(
      eq(subscriptions.id, claim.subscriptionId),
      eq(subscriptions.reconciliationVersion, claim.version),
      eq(subscriptions.stripeCustomerId, customerId),
    )).limit(1).for("update");
    const current = rows[0];
    if (!current) return;
    const status = selected ? mappedStatus(selected.status) : "CANCELED";
    const planId: PlanId = recognizedPlan ?? "FREE";
    const currentPeriodStart = selected?.currentPeriodStart ?? null;
    const currentPeriodEnd = selected?.currentPeriodEnd ?? null;
    const subscription = { planId, status, currentPeriodStart, currentPeriodEnd };
    const effective = effectivePlanId(subscription, now);
    const plan = getPlanCatalog()[effective];
    await transaction.update(subscriptions).set({
      planId,
      status,
      stripeSubscriptionId: selected?.id ?? null,
      stripePriceId: recognizedPlan ? priceId : null,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd: selected?.cancelAtPeriodEnd ?? false,
      lastReconciledAt: now,
      updatedAt: now,
    }).where(and(eq(subscriptions.id, current.id), eq(subscriptions.reconciliationVersion, claim.version)));
    await lockCurrentUsagePeriod(claim.organizationId, { planId: effective, plan, subscription }, now, transaction, {
      alignPeriodEnd: !current.stripeSubscriptionId && Boolean(selected),
    });
  });
  return claim.organizationId;
}

type EventClaim = { duplicate: boolean };

async function claimEvent(event: Stripe.Event, payloadHash: string, deps: ReconcileDependencies): Promise<EventClaim> {
  const now = deps.now();
  return deps.database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${event.id}, 23))`);
    const rows = await transaction.select().from(processedStripeEvents)
      .where(eq(processedStripeEvents.stripeEventId, event.id)).limit(1).for("update");
    const existing = rows[0];
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new AppError("invalid_webhook", "Webhook inválido.", 400);
      if (existing.status === "PROCESSED") return { duplicate: true };
      const staleBefore = new Date(now.getTime() - PROCESSING_STALE_SECONDS * 1_000);
      if (existing.status === "PROCESSING" && existing.updatedAt > staleBefore) return { duplicate: true };
      await transaction.update(processedStripeEvents).set({
        status: "PROCESSING", attempts: existing.attempts + 1, error: null, updatedAt: now,
      }).where(eq(processedStripeEvents.id, existing.id));
      return { duplicate: false };
    }
    await transaction.insert(processedStripeEvents).values({
      stripeEventId: event.id,
      eventType: event.type,
      payloadHash,
      stripeCreatedAt: new Date(event.created * 1_000),
      receivedAt: now,
      updatedAt: now,
    });
    return { duplicate: false };
  });
}

export async function processStripeWebhook(
  rawBody: Buffer,
  signature: string | null,
  dependencies: ReconcileDependencies = defaults(),
): Promise<{ duplicate: boolean }> {
  if (!signature || signature.length > 4_096) throw new AppError("invalid_webhook", "Webhook inválido.", 400);
  let event: Stripe.Event;
  try {
    event = dependencies.provider.constructEvent(rawBody, signature, requiredEnv("STRIPE_WEBHOOK_SECRET"));
  } catch (error) {
    if (error instanceof AppError && error.code === "service_unavailable") throw error;
    throw new AppError("invalid_webhook", "Webhook inválido.", 400);
  }
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  const claim = await claimEvent(event, payloadHash, dependencies);
  if (claim.duplicate) return claim;
  let organizationId: string | null = null;
  try {
    if (SUPPORTED_EVENT_TYPES.has(event.type)) {
      const customerId = customerFromEvent(event);
      if (customerId) organizationId = await reconcileStripeCustomer(customerId, dependencies);
      const sessionId = checkoutSessionId(event);
      if (sessionId && organizationId) {
        await dependencies.database.update(billingCheckoutIntents).set({ status: "COMPLETED", updatedAt: dependencies.now() })
          .where(and(eq(billingCheckoutIntents.organizationId, organizationId), eq(billingCheckoutIntents.stripeSessionId, sessionId)));
      }
    }
    await dependencies.database.update(processedStripeEvents).set({
      organizationId, status: "PROCESSED", processedAt: dependencies.now(), updatedAt: dependencies.now(), error: null,
    }).where(eq(processedStripeEvents.stripeEventId, event.id));
    return { duplicate: false };
  } catch {
    await dependencies.database.update(processedStripeEvents).set({
      status: "FAILED", error: "billing_reconciliation_failed", updatedAt: dependencies.now(),
    }).where(eq(processedStripeEvents.stripeEventId, event.id)).catch(() => undefined);
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
}

export async function reconcileStaleSubscriptions(
  dependencies: ReconcileDependencies = defaults(),
  limit = 25,
): Promise<number> {
  const staleBefore = new Date(dependencies.now().getTime() - positiveIntegerEnv("UNO_BILLING_RECONCILE_STALE_SECONDS", 21_600) * 1_000);
  const retryBefore = new Date(dependencies.now().getTime() - 5 * 60_000);
  const rows = await dependencies.database.select({ customerId: subscriptions.stripeCustomerId }).from(subscriptions).where(and(
    isNotNull(subscriptions.stripeCustomerId),
    or(lt(subscriptions.lastReconciledAt, staleBefore), isNull(subscriptions.lastReconciledAt)),
    lt(subscriptions.updatedAt, retryBefore),
  )).orderBy(asc(subscriptions.updatedAt)).limit(limit);
  let reconciled = 0;
  for (const row of rows) {
    if (!row.customerId) continue;
    try {
      await reconcileStripeCustomer(row.customerId, dependencies);
      reconciled += 1;
    } catch {
      // claimReconciliation persisted updatedAt before the provider call, which
      // supplies a five-minute retry backoff without exposing provider errors.
    }
  }
  return reconciled;
}
