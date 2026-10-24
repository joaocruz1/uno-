import { and, eq, isNull } from "drizzle-orm";

import { getDb, subscriptions } from "@/db";
import type { BillingPlanChangeResult, PaidPlanId, RefundEligibility, RefundResult } from "@/lib/billing-model";
import { AppError } from "@/lib/errors";
import { getPlanCatalog } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";

import { apiAddonPriceId, billingProviderConfigured, PAID_PLAN_IDS, stripePriceId } from "./config";
import { lockOrganizationBilling } from "./entitlements";
import { reconcileStripeCustomer, type ReconcileDependencies } from "./reconcile";
import { getBillingProvider, type PaidInvoiceSnapshot, type StripeSubscriptionSnapshot } from "./stripe";

/** Direito de arrependimento (CDC art. 49): 7 days counted from the first paid invoice. */
export const REFUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/;

export type ManageDependencies = ReconcileDependencies;

type ManagerActor = Pick<Actor, "organizationId" | "membershipRole">;

function defaults(): ManageDependencies {
  return { database: getDb(), provider: getBillingProvider(), now: () => new Date() };
}

function assertManager(actor: Pick<Actor, "membershipRole">): void {
  if (actor.membershipRole !== "OWNER" && actor.membershipRole !== "ADMIN") {
    throw new AppError("forbidden", "Acesso negado.", 403);
  }
}

function assertIdempotencyKey(key: string | null): string {
  if (!key || !IDEMPOTENCY_KEY.test(key)) throw new AppError("invalid_idempotency_key", "Idempotency-Key inválida.", 400);
  return key;
}

function assertConfigured(): void {
  if (!billingProviderConfigured()) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
}

function safeProviderError(error: unknown): never {
  if (error instanceof AppError) throw error;
  throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
}

const isLive = (snapshot: StripeSubscriptionSnapshot) => snapshot.status !== "canceled" && snapshot.status !== "incomplete_expired";
const isPaidUp = (snapshot: StripeSubscriptionSnapshot) => snapshot.status === "active" || snapshot.status === "trialing";

/** Known plan prices, refusing a configuration where a plan and the add-on share a Price. */
function planPrices(): Map<string, PaidPlanId> {
  const map = new Map<string, PaidPlanId>();
  for (const planId of PAID_PLAN_IDS) map.set(stripePriceId(planId), planId);
  const addon = apiAddonPriceId();
  if (map.size !== PAID_PLAN_IDS.length || (addon && map.has(addon))) {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
  return map;
}

async function loadSubscriptionRow(organizationId: string, deps: ManageDependencies) {
  const rows = await deps.database.select().from(subscriptions).where(eq(subscriptions.organizationId, organizationId)).limit(1);
  return rows[0];
}

type CardContext = {
  customerId: string;
  /** The organization's plan subscription in the provider (may already be canceled during a refund retry). */
  plan: StripeSubscriptionSnapshot;
  planId: PaidPlanId;
  planPriceId: string;
  /** Subscriptions carrying only the add-on price. */
  addons: StripeSubscriptionSnapshot[];
};

/**
 * Loads the organization's card plan subscription from the provider. The
 * Customer is the ownership boundary: only subscriptions of the organization's
 * own Customer, matching the locally reconciled id, are ever touched.
 */
async function loadCardContext(
  row: { stripeCustomerId: string | null; stripeSubscriptionId: string | null } | undefined,
  deps: ManageDependencies,
): Promise<CardContext | null> {
  if (!row?.stripeCustomerId || !row.stripeSubscriptionId) return null;
  const customerId = row.stripeCustomerId;
  const snapshots = await deps.provider.listSubscriptions(customerId);
  if (snapshots.some((snapshot) => snapshot.customerId !== customerId)) {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
  const prices = planPrices();
  const addonPriceId = apiAddonPriceId();
  const plan = snapshots.find((snapshot) => snapshot.id === row.stripeSubscriptionId);
  if (!plan) return null;
  const planSide = plan.priceIds.filter((priceId) => priceId !== addonPriceId);
  const planId = planSide.length === 1 ? prices.get(planSide[0]!) : undefined;
  if (!planId) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  const addons = addonPriceId
    ? snapshots.filter((snapshot) => snapshot.id !== plan.id && snapshot.priceIds.includes(addonPriceId) && snapshot.priceIds.every((priceId) => priceId === addonPriceId))
    : [];
  return { customerId, plan, planId, planPriceId: planSide[0]!, addons };
}

function assertNoRefundInProgress(row: { refundStartedAt: Date | null; refundedAt: Date | null } | undefined): void {
  if (row?.refundStartedAt && !row.refundedAt) {
    throw new AppError("refund_in_progress", "Há um reembolso em andamento. Conclua o reembolso antes de alterar a assinatura.", 409);
  }
}

async function reconcile(customerId: string, deps: ManageDependencies): Promise<void> {
  await reconcileStripeCustomer(customerId, deps);
}

/**
 * Swaps the plan of the live card subscription in place. An upgrade charges
 * the prorated difference immediately; a downgrade takes effect without credit. Without a card subscription the caller uses
 * the regular Checkout instead.
 */
export async function changeBillingPlan(
  actor: ManagerActor,
  planId: PaidPlanId,
  idempotencyKey: string | null,
  dependencies: ManageDependencies = defaults(),
): Promise<BillingPlanChangeResult> {
  assertManager(actor);
  const key = assertIdempotencyKey(idempotencyKey);
  assertConfigured();
  try {
    const row = await loadSubscriptionRow(actor.organizationId, dependencies);
    assertNoRefundInProgress(row);
    const context = await loadCardContext(row, dependencies);
    if (!context || !isLive(context.plan)) return { checkout: true };
    if (!isPaidUp(context.plan)) {
      throw new AppError("payment_pending", "Regularize o pagamento da assinatura antes de trocar de plano.", 409);
    }
    if (context.planId === planId) throw new AppError("same_plan", "Este já é o seu plano atual.", 409);
    const toPriceId = stripePriceId(planId);
    const price = await dependencies.provider.retrievePrice(toPriceId);
    const configured = getPlanCatalog()[planId];
    if (price.id !== toPriceId || !price.active || price.currency !== "brl" || price.unitAmount !== configured.priceBrlCents || price.recurringInterval !== "month" || price.recurringIntervalCount !== 1) {
      throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    }
    // An upgrade is charged now; a downgrade earns no credit for unused time.
    const upgrade = configured.priceBrlCents > getPlanCatalog()[context.planId].priceBrlCents;
    await dependencies.provider.changeSubscriptionPrice(
      { subscriptionId: context.plan.id, fromPriceId: context.planPriceId, toPriceId, upgrade },
      `uno-plan-${context.plan.id}-${planId}-${key}`,
    );
    await reconcile(context.customerId, dependencies);
    return { checkout: false, planId };
  } catch (error) {
    return safeProviderError(error);
  }
}

async function setCancellation(
  actor: ManagerActor,
  cancel: boolean,
  options: { alsoAddon?: boolean },
  idempotencyKey: string | null,
  deps: ManageDependencies,
): Promise<{ cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null }> {
  assertManager(actor);
  const key = assertIdempotencyKey(idempotencyKey);
  assertConfigured();
  try {
    const row = await loadSubscriptionRow(actor.organizationId, deps);
    assertNoRefundInProgress(row);
    const context = await loadCardContext(row, deps);
    if (!context || !isLive(context.plan)) {
      throw new AppError("no_card_subscription", "Não há assinatura no cartão para alterar.", 409);
    }
    if (!isPaidUp(context.plan)) {
      throw new AppError("payment_pending", "Regularize o pagamento da assinatura no portal antes de alterá-la.", 409);
    }
    const action = cancel ? "cancel" : "resume";
    if (context.plan.cancelAtPeriodEnd !== cancel) {
      await deps.provider.setCancelAtPeriodEnd(context.plan.id, cancel, `uno-${action}-${context.plan.id}-${key}`);
    }
    // The add-on grants nothing without a paid plan, so by default it follows the plan.
    if (options.alsoAddon ?? true) {
      for (const addon of context.addons.filter(isLive)) {
        if (addon.cancelAtPeriodEnd !== cancel) {
          await deps.provider.setCancelAtPeriodEnd(addon.id, cancel, `uno-${action}-${addon.id}-${key}`);
        }
      }
    }
    await reconcile(context.customerId, deps);
    return { cancelAtPeriodEnd: cancel, currentPeriodEnd: context.plan.currentPeriodEnd?.toISOString() ?? null };
  } catch (error) {
    return safeProviderError(error);
  }
}

/** Schedules the cancellation at period end: rights are kept until then. */
export function cancelBillingSubscription(
  actor: ManagerActor,
  options: { alsoAddon?: boolean },
  idempotencyKey: string | null,
  dependencies: ManageDependencies = defaults(),
) {
  return setCancellation(actor, true, options, idempotencyKey, dependencies);
}

/** Withdraws a scheduled cancellation. */
export function resumeBillingSubscription(
  actor: ManagerActor,
  options: { alsoAddon?: boolean },
  idempotencyKey: string | null,
  dependencies: ManageDependencies = defaults(),
) {
  return setCancellation(actor, false, options, idempotencyKey, dependencies);
}

type RefundItem = { invoiceId: string; paymentIntentId: string; amount: number; remaining: number };

type RefundPlan = {
  eligibility: RefundEligibility;
  context: CardContext | null;
  items: RefundItem[];
};

function ineligible(reason: NonNullable<RefundEligibility["reason"]>, deadline: Date | null = null): RefundPlan {
  return { eligibility: { eligible: false, reason, deadline: deadline?.toISOString() ?? null, amountBrlCents: 0, inProgress: false }, context: null, items: [] };
}

async function refundItems(invoices: PaidInvoiceSnapshot[], deps: ManageDependencies): Promise<RefundItem[]> {
  const items: RefundItem[] = [];
  for (const invoice of invoices) {
    if (invoice.currency !== "brl") continue;
    for (const payment of invoice.payments) {
      const refunded = await deps.provider.refundedAmount(payment.paymentIntentId);
      items.push({ invoiceId: invoice.id, paymentIntentId: payment.paymentIntentId, amount: payment.amount, remaining: Math.max(0, payment.amount - refunded) });
    }
  }
  return items;
}

/**
 * Works out the 7-day refund: the window opens at the first paid invoice of
 * the plan subscription; every plan and add-on invoice paid inside it is
 * refunded. A request already started is always allowed to finish.
 */
async function planRefund(organizationId: string, deps: ManageDependencies): Promise<RefundPlan> {
  const row = await loadSubscriptionRow(organizationId, deps);
  if (row?.refundedAt) return ineligible("already_refunded");
  const inProgress = Boolean(row?.refundStartedAt);
  const context = await loadCardContext(row, deps);
  if (!context || (!inProgress && !isLive(context.plan))) return ineligible("no_card_subscription");
  const planInvoices = await deps.provider.listPaidInvoices(context.plan.id);
  const first = planInvoices.find((invoice) => invoice.payments.length > 0);
  if (!first) return ineligible("no_paid_invoice");
  const windowStart = first.paidAt;
  const deadline = new Date(windowStart.getTime() + REFUND_WINDOW_MS);
  if (!inProgress && deps.now().getTime() > deadline.getTime()) return ineligible("window_expired", deadline);
  const inWindow = (invoice: PaidInvoiceSnapshot) => invoice.paidAt >= windowStart && invoice.paidAt <= deadline;
  const invoices = planInvoices.filter(inWindow);
  for (const addon of context.addons) invoices.push(...(await deps.provider.listPaidInvoices(addon.id)).filter(inWindow));
  const items = await refundItems(invoices, deps);
  const amount = items.reduce((total, item) => total + item.remaining, 0);
  if (amount === 0 && !inProgress) return ineligible("no_paid_invoice", deadline);
  return {
    eligibility: { eligible: true, reason: null, deadline: deadline.toISOString(), amountBrlCents: amount, inProgress },
    context,
    items,
  };
}

/** Eligibility for the 7-day refund, for the subscription screen. */
export async function readRefundEligibility(
  actor: ManagerActor,
  dependencies: ManageDependencies = defaults(),
): Promise<RefundEligibility> {
  assertManager(actor);
  if (!billingProviderConfigured()) return ineligible("no_card_subscription").eligibility;
  try {
    return (await planRefund(actor.organizationId, dependencies)).eligibility;
  } catch (error) {
    return safeProviderError(error);
  }
}

const REFUND_REASON_MESSAGES: Record<NonNullable<RefundEligibility["reason"]>, string> = {
  no_card_subscription: "Não há assinatura no cartão para reembolsar.",
  no_paid_invoice: "Não há pagamento no cartão a reembolsar.",
  window_expired: "O prazo de 7 dias para o reembolso terminou.",
  already_refunded: "O reembolso de 7 dias já foi usado por esta organização.",
};

/**
 * Automatic 7-day refund: refunds 100% of the plan and add-on invoices paid in
 * the window, ends those subscriptions now and reconciles the organization back
 * to Free. Once per organization. Safe to retry: the request is marked before
 * the provider calls, refunds use per-payment idempotency keys and payments
 * already refunded are skipped.
 */
export async function requestBillingRefund(
  actor: ManagerActor,
  idempotencyKey: string | null,
  dependencies: ManageDependencies = defaults(),
): Promise<RefundResult> {
  assertManager(actor);
  assertIdempotencyKey(idempotencyKey);
  assertConfigured();
  try {
    const plan = await planRefund(actor.organizationId, dependencies);
    if (!plan.eligibility.eligible || !plan.context) {
      const reason = plan.eligibility.reason ?? "no_card_subscription";
      throw new AppError(reason === "already_refunded" ? "refund_already_used" : "refund_not_eligible", REFUND_REASON_MESSAGES[reason], 409);
    }
    const context = plan.context;
    // Mark the commitment before touching the provider. One per organization.
    await dependencies.database.transaction(async (transaction) => {
      await lockOrganizationBilling(actor.organizationId, transaction);
      const rows = await transaction.select().from(subscriptions).where(eq(subscriptions.organizationId, actor.organizationId)).limit(1).for("update");
      const current = rows[0];
      if (!current || current.stripeCustomerId !== context.customerId) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
      if (current.refundedAt) throw new AppError("refund_already_used", REFUND_REASON_MESSAGES.already_refunded, 409);
      if (!current.refundStartedAt) {
        await transaction.update(subscriptions).set({ refundStartedAt: dependencies.now(), updatedAt: dependencies.now() }).where(eq(subscriptions.id, current.id));
      }
    });
    // End the subscriptions first: an interruption after this point leaves the
    // customer on Free with money still due, which they have reason to retry,
    // never with the money back and the paid plan still running.
    // The plan ends now; an add-on without a paid plan grants nothing, so it ends too.
    for (const subscription of [context.plan, ...context.addons]) {
      if (isLive(subscription)) await dependencies.provider.cancelSubscriptionNow(subscription.id, `uno-refund-cancel-${subscription.id}`);
    }
    let refundedNow = 0;
    for (const item of plan.items) {
      if (item.remaining <= 0) continue;
      await dependencies.provider.createRefund({
        paymentIntentId: item.paymentIntentId,
        metadata: { organizationId: actor.organizationId, uno_refund: "7d", invoiceId: item.invoiceId },
      }, `uno-refund-${item.invoiceId}-${item.paymentIntentId}`);
      refundedNow += item.remaining;
    }
    await reconcile(context.customerId, dependencies);
    const refundedAt = dependencies.now();
    // Everything paid in the window, including what an interrupted attempt already refunded.
    const total = plan.items.reduce((sum, item) => sum + item.amount, 0);
    await dependencies.database.update(subscriptions).set({ refundedAt, updatedAt: refundedAt })
      .where(and(eq(subscriptions.organizationId, actor.organizationId), isNull(subscriptions.refundedAt)));
    console.log(JSON.stringify({
      event: "billing.refund.completed",
      organizationId: actor.organizationId,
      payments: plan.items.length,
      refundedBrlCents: total,
      refundedNowBrlCents: refundedNow,
      retry: plan.eligibility.inProgress,
    }));
    return { refundedBrlCents: total, refundedAt: refundedAt.toISOString() };
  } catch (error) {
    return safeProviderError(error);
  }
}
