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
import type { PlanId } from "@/lib/plans";

import { apiAddonPriceId, PAID_PLAN_IDS, stripePriceId } from "./config";
import { effectivePlanFromSubscription, lockCurrentUsagePeriod, lockOrganizationBilling } from "./entitlements";
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

const isLive = (snapshot: StripeSubscriptionSnapshot) => snapshot.status !== "canceled" && snapshot.status !== "incomplete_expired";

/** The prices of a subscription that are not the API add-on, i.e. its plan side. */
function planPriceIds(snapshot: StripeSubscriptionSnapshot, addonPriceId: string | null): string[] {
  return snapshot.priceIds.filter((priceId) => priceId !== addonPriceId);
}

function carriesAddon(snapshot: StripeSubscriptionSnapshot, addonPriceId: string | null): boolean {
  return addonPriceId !== null && snapshot.priceIds.includes(addonPriceId);
}

function chooseSubscription(
  localSubscriptionId: string | null,
  snapshots: StripeSubscriptionSnapshot[],
  prices: Map<string, Exclude<PlanId, "FREE">>,
  addonPriceId: string | null,
): StripeSubscriptionSnapshot | null {
  const local = localSubscriptionId ? snapshots.find((snapshot) => snapshot.id === localSubscriptionId) : undefined;
  if (local && isLive(local)) return local;
  const recognized = snapshots.filter((snapshot) => {
    const planPrices = planPriceIds(snapshot, addonPriceId);
    return planPrices.length === 1 && prices.has(planPrices[0]!);
  });
  const manageable = recognized.filter(isLive);
  if (manageable.length > 1) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  return manageable[0] ?? local ?? recognized[0] ?? null;
}

/**
 * Picks the subscription that carries the API add-on price. Unlike plans, a
 * duplicate never blocks reconciliation: the one that grants access wins.
 */
function chooseAddonSubscription(
  localAddonSubscriptionId: string | null,
  snapshots: StripeSubscriptionSnapshot[],
  addonPriceId: string,
): StripeSubscriptionSnapshot | null {
  const carrying = snapshots.filter((snapshot) => carriesAddon(snapshot, addonPriceId));
  const rank = (snapshot: StripeSubscriptionSnapshot) =>
    (snapshot.status === "active" || snapshot.status === "trialing" ? 4 : isLive(snapshot) ? 2 : 0) +
    (snapshot.id === localAddonSubscriptionId ? 1 : 0);
  return [...carrying].sort((left, right) =>
    rank(right) - rank(left) ||
    (right.currentPeriodEnd?.getTime() ?? 0) - (left.currentPeriodEnd?.getTime() ?? 0) ||
    left.id.localeCompare(right.id),
  )[0] ?? null;
}

export async function reconcileStripeCustomer(customerId: string, dependencies: ReconcileDependencies = defaults()): Promise<string | null> {
  const claim = await claimReconciliation(customerId, dependencies);
  if (!claim) return null;
  const local = await dependencies.database.select({
    stripeSubscriptionId: subscriptions.stripeSubscriptionId,
    apiAddonSubscriptionId: subscriptions.apiAddonSubscriptionId,
  }).from(subscriptions).where(eq(subscriptions.id, claim.subscriptionId)).limit(1);
  const snapshots = await dependencies.provider.listSubscriptions(customerId);
  if (snapshots.some((snapshot) => snapshot.customerId !== customerId)) {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
  const prices = pricePlanMap();
  const addonPriceId = apiAddonPriceId();
  if (addonPriceId && prices.has(addonPriceId)) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  // Classify by price: a subscription that only carries the add-on is never a
  // plan subscription; one that carries a plan price and the add-on counts for both.
  const planSnapshots = snapshots.filter((snapshot) => !carriesAddon(snapshot, addonPriceId) || planPriceIds(snapshot, addonPriceId).length > 0);
  const selected = chooseSubscription(local[0]?.stripeSubscriptionId ?? null, planSnapshots, prices, addonPriceId);
  const selectedPlanPrices = selected ? planPriceIds(selected, addonPriceId) : [];
  const priceId = selectedPlanPrices.length === 1 ? selectedPlanPrices[0]! : null;
  const recognizedPlan = priceId ? prices.get(priceId) : undefined;
  if (selected && !recognizedPlan) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  const addon = addonPriceId ? chooseAddonSubscription(local[0]?.apiAddonSubscriptionId ?? null, snapshots, addonPriceId) : null;
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
    // Without a configured add-on price nothing can be classified as the
    // add-on, so its stored state is left as it is instead of being revoked.
    const addonState = addonPriceId ? {
      apiAddonSubscriptionId: addon?.id ?? null,
      apiAddonStatus: addon ? mappedStatus(addon.status) : null,
      apiAddonCurrentPeriodEnd: addon?.currentPeriodEnd ?? null,
    } : {
      apiAddonSubscriptionId: current.apiAddonSubscriptionId,
      apiAddonStatus: current.apiAddonStatus,
      apiAddonCurrentPeriodEnd: current.apiAddonCurrentPeriodEnd,
    };
    const entitlement = effectivePlanFromSubscription({
      planId, status, currentPeriodStart, currentPeriodEnd,
      apiAddonStatus: addonState.apiAddonStatus,
      apiAddonCurrentPeriodEnd: addonState.apiAddonCurrentPeriodEnd,
      // Reconciliation never writes the prepaid columns; carry them so a prepaid
      // org keeps its quota period even when the Stripe side reconciles to FREE.
      prepaidPlanId: current.prepaidPlanId,
      prepaidPeriodEnd: current.prepaidPeriodEnd,
    }, now);
    await transaction.update(subscriptions).set({
      planId,
      status,
      stripeSubscriptionId: selected?.id ?? null,
      stripePriceId: recognizedPlan ? priceId : null,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd: selected?.cancelAtPeriodEnd ?? false,
      ...addonState,
      lastReconciledAt: now,
      updatedAt: now,
    }).where(and(eq(subscriptions.id, current.id), eq(subscriptions.reconciliationVersion, claim.version)));
    await lockCurrentUsagePeriod(claim.organizationId, entitlement, now, transaction, {
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
