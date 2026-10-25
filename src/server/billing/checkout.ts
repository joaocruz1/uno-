import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";

import { billingCheckoutIntents, getDb, subscriptions, user, type UnoDatabase } from "@/db";
import type { PaidPlanId, SubscribeResult } from "@/lib/billing-model";
import { AppError } from "@/lib/errors";
import { getApiAddon, getPlanCatalog } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";

import { apiAddonConfigured, apiAddonPriceId, billingProviderConfigured, billingUrls, PAID_PLAN_IDS, stripePriceId } from "./config";
import { quoteCheckout } from "./coupons";
import { effectivePlanId, lockOrganizationBilling } from "./entitlements";
import { reconcileStripeCustomer } from "./reconcile";
import { getBillingProvider, type BillingProvider, type StripeSubscriptionSnapshot, type SubscriptionPaymentSnapshot } from "./stripe";

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/;
/** Stripe expires a subscription whose first invoice stays unpaid for 23 hours (incomplete_expired). */
const INCOMPLETE_LIFETIME_MS = 23 * 60 * 60 * 1_000;

export type CheckoutDependencies = {
  database: UnoDatabase;
  provider: BillingProvider;
  now(): Date;
  randomId(): string;
  /** Applies a subscription that is already paid (nothing due today) without waiting for the webhook. */
  reconcile?(customerId: string): Promise<unknown>;
};

function defaults(): CheckoutDependencies {
  const database = getDb();
  const provider = getBillingProvider();
  const now = () => new Date();
  return { database, provider, now, randomId: randomUUID, reconcile: (customerId) => reconcileStripeCustomer(customerId, { database, provider, now }) };
}

export function assertManager(actor: Pick<Actor, "membershipRole">): void {
  if (actor.membershipRole !== "OWNER" && actor.membershipRole !== "ADMIN") {
    throw new AppError("forbidden", "Acesso negado.", 403);
  }
}

function safeProviderError(error: unknown): never {
  if (error instanceof AppError) throw error;
  throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
}

function assertPortalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "billing.stripe.com") throw new Error();
    return parsed.toString();
  } catch {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
}

const subscriptionExists = () => new AppError("subscription_exists", "Sua organização já tem uma assinatura. Troque de plano ou gerencie a cobrança em Assinatura.", 409);
const inProgress = () => new AppError("checkout_in_progress", "Já existe uma contratação em andamento.", 409);
const addonAlreadyActive = () => new AppError("addon_already_active", "O adicional de API já está contratado. Gerencie a assinatura em Assinatura.", 409);

/** What a checkout buys: a paid plan (with the coupon the buyer typed, if any), or the API add-on on top of one. */
type CheckoutTarget = { planId: PaidPlanId; addon: null; promotionCode: string | null } | { planId: null; addon: "API"; promotionCode: null };

/** The discount the server chose for a plan checkout, recorded on the intent for audit. */
type ChosenDiscount = { appliedDiscount: "COUPON" | "FIRST_MONTH" | "NONE" | null; couponId: string | null };

function requestHash(target: CheckoutTarget): string {
  // Without a coupon the hash stays exactly what it was before coupons existed.
  const subject = target.addon ? { addon: target.addon } : target.promotionCode ? { planId: target.planId, promotionCode: target.promotionCode } : { planId: target.planId };
  return createHash("sha256").update(JSON.stringify(subject)).digest("hex");
}

function sameTarget(intent: Pick<typeof billingCheckoutIntents.$inferSelect, "planId" | "addon" | "promotionCode">, target: CheckoutTarget): boolean {
  return intent.planId === target.planId && intent.addon === target.addon && (intent.promotionCode ?? null) === target.promotionCode;
}

type PreparedIntent = {
  intentId: string;
  customerId: string | null;
  providerAttempt: number;
  /** The incomplete subscription already created for this intent (retry, refresh, second tab). */
  subscriptionId?: string;
  /** An open intent for another target (or a hosted Checkout from before NEX-52) that must be closed first. */
  supersede?: { intentId: string; subscriptionId: string | null; sessionId: string | null };
};

async function prepareIntent(
  actor: Pick<Actor, "organizationId" | "userId">,
  target: CheckoutTarget,
  idempotencyKey: string,
  deps: CheckoutDependencies,
  discount: ChosenDiscount,
): Promise<PreparedIntent> {
  const hash = requestHash(target);
  return deps.database.transaction(async (transaction) => {
    await lockOrganizationBilling(actor.organizationId, transaction);
    const now = deps.now();
    await transaction.update(billingCheckoutIntents).set({ status: "EXPIRED", updatedAt: now })
      .where(and(
        eq(billingCheckoutIntents.organizationId, actor.organizationId),
        eq(billingCheckoutIntents.status, "OPEN"),
        isNotNull(billingCheckoutIntents.expiresAt),
        lte(billingCheckoutIntents.expiresAt, now),
      ));
    const byKey = await transaction.select().from(billingCheckoutIntents).where(and(
      eq(billingCheckoutIntents.organizationId, actor.organizationId),
      eq(billingCheckoutIntents.idempotencyKey, idempotencyKey),
    )).limit(1).for("update");
    const existingByKey = byKey[0];
    if (existingByKey && existingByKey.requestHash !== hash) {
      throw new AppError("idempotency_conflict", "A chave de idempotência já foi usada com outros parâmetros.", 409);
    }
    const subscriptionsRows = await transaction.select().from(subscriptions)
      .where(eq(subscriptions.organizationId, actor.organizationId)).limit(1).for("update");
    let subscription = subscriptionsRows[0];
    if (!subscription) {
      const inserted = await transaction.insert(subscriptions).values({ organizationId: actor.organizationId }).returning();
      subscription = inserted[0]!;
    }
    // An interrupted 7-day refund must finish before anything new is bought.
    if (subscription.refundStartedAt && !subscription.refundedAt) {
      throw new AppError("refund_in_progress", "Há um reembolso em andamento. Conclua o reembolso antes de contratar.", 409);
    }
    if (target.addon) {
      // The add-on only exists on top of a paid plan in force, and only once.
      if (effectivePlanId(subscription, now) === "FREE") {
        throw new AppError("paid_plan_required", "O adicional de API exige um plano pago ativo.", 409);
      }
      // A paid plan granted without a Stripe subscription would be reset to Free by
      // the reconciliation that the add-on purchase triggers on this customer.
      if (!subscription.stripeSubscriptionId) {
        throw new AppError("paid_plan_required", "O adicional de API só pode ser contratado em um plano pago com cobrança ativa.", 409);
      }
      if (subscription.apiAddonSubscriptionId && subscription.apiAddonStatus !== "CANCELED") throw addonAlreadyActive();
    } else if (subscription.stripeSubscriptionId && subscription.status !== "CANCELED") {
      // Never a second paid contract: plan changes happen in Assinatura.
      throw subscriptionExists();
    }
    const customerId = subscription.stripeCustomerId;
    if (existingByKey?.status === "OPEN" && existingByKey.stripeSubscriptionId) {
      return { intentId: existingByKey.id, customerId, providerAttempt: existingByKey.providerAttempt, subscriptionId: existingByKey.stripeSubscriptionId };
    }
    const active = await transaction.select().from(billingCheckoutIntents).where(and(
      eq(billingCheckoutIntents.organizationId, actor.organizationId),
      inArray(billingCheckoutIntents.status, ["CREATING", "OPEN"]),
    )).limit(1).for("update");
    const reusable = existingByKey?.status === "CREATING" ? existingByKey : active[0];
    if (reusable?.status === "OPEN") {
      const legacy = !reusable.stripeSubscriptionId;
      if (!legacy && sameTarget(reusable, target)) {
        return { intentId: reusable.id, customerId, providerAttempt: reusable.providerAttempt, subscriptionId: reusable.stripeSubscriptionId! };
      }
      // A buyer who comes back for another plan or coupon gets a new subscription;
      // the stale one is canceled first. Only a new request (a key never seen) may
      // do it: a retry from an old tab, whose intent was itself superseded, must
      // not cancel the newer one (no ping-pong between tabs). A hosted Checkout
      // left by the flow before NEX-52 is always replaced.
      if (legacy || !existingByKey) {
        return { intentId: reusable.id, customerId, providerAttempt: reusable.providerAttempt, supersede: { intentId: reusable.id, subscriptionId: reusable.stripeSubscriptionId, sessionId: reusable.stripeSessionId } };
      }
      throw inProgress();
    }
    if (reusable) {
      if (!sameTarget(reusable, target)) throw inProgress();
      return { intentId: reusable.id, customerId, providerAttempt: reusable.providerAttempt };
    }
    if (existingByKey) {
      await transaction.update(billingCheckoutIntents).set({
        planId: target.planId, addon: target.addon, requestHash: hash, stripeSessionId: null, checkoutUrl: null, stripeSubscriptionId: null,
        promotionCode: target.promotionCode, appliedDiscount: discount.appliedDiscount, couponId: discount.couponId,
        status: "CREATING", expiresAt: null, providerAttempt: existingByKey.providerAttempt + 1, updatedAt: now,
      }).where(eq(billingCheckoutIntents.id, existingByKey.id));
      return { intentId: existingByKey.id, customerId, providerAttempt: existingByKey.providerAttempt + 1 };
    }
    const intentId = deps.randomId();
    await transaction.insert(billingCheckoutIntents).values({
      id: intentId,
      organizationId: actor.organizationId,
      createdByUserId: actor.userId,
      planId: target.planId,
      addon: target.addon,
      idempotencyKey,
      requestHash: hash,
      promotionCode: target.promotionCode,
      appliedDiscount: discount.appliedDiscount,
      couponId: discount.couponId,
      createdAt: now,
      updatedAt: now,
    });
    return { intentId, customerId, providerAttempt: 1 };
  });
}

/** The organization's Stripe Customer, created once (with the buyer's phone, NEX-51) and stored before use. */
export async function ensureCustomer(
  actor: Pick<Actor, "organizationId" | "organizationName" | "userId">,
  knownCustomerId: string | null,
  deps: Pick<CheckoutDependencies, "database" | "provider" | "now">,
): Promise<string> {
  if (knownCustomerId) return knownCustomerId;
  const existing = await deps.database.select({ customerId: subscriptions.stripeCustomerId }).from(subscriptions)
    .where(eq(subscriptions.organizationId, actor.organizationId)).limit(1);
  if (existing[0]?.customerId) return existing[0].customerId;
  const buyer = await deps.database.select({ phone: user.phone }).from(user).where(eq(user.id, actor.userId)).limit(1);
  const created = await deps.provider.createCustomer({ organizationId: actor.organizationId, organizationName: actor.organizationName, phone: buyer[0]?.phone ?? null }, `uno-customer-${actor.organizationId}`);
  return deps.database.transaction(async (transaction) => {
    await lockOrganizationBilling(actor.organizationId, transaction);
    const rows = await transaction.select().from(subscriptions).where(eq(subscriptions.organizationId, actor.organizationId)).limit(1).for("update");
    let current = rows[0];
    if (!current) {
      const inserted = await transaction.insert(subscriptions).values({ organizationId: actor.organizationId }).returning();
      current = inserted[0]!;
    }
    if (current.stripeCustomerId && current.stripeCustomerId !== created.id) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    if (!current.stripeCustomerId) await transaction.update(subscriptions).set({ stripeCustomerId: created.id, updatedAt: deps.now() }).where(eq(subscriptions.id, current.id));
    return current.stripeCustomerId ?? created.id;
  });
}

function validatePrice(price: Awaited<ReturnType<BillingProvider["retrievePrice"]>>, priceId: string, amount: number): void {
  if (price.id !== priceId || !price.active || price.currency !== "brl" || price.unitAmount !== amount || price.recurringInterval !== "month" || price.recurringIntervalCount !== 1) {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
}

const unpaidOrGone = (status: StripeSubscriptionSnapshot["status"]) => status === "canceled" || status === "incomplete_expired" || status === "incomplete";

function result(intentId: string, snapshot: SubscriptionPaymentSnapshot, recurringBrlCents: number): SubscribeResult {
  if (snapshot.currency !== "brl") throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  return {
    intentId,
    confirmation: snapshot.confirmation,
    clientSecret: snapshot.confirmation === "none" ? null : snapshot.clientSecret,
    amountDueBrlCents: snapshot.amountDue,
    recurringBrlCents,
  };
}

async function closeIntent(organizationId: string, intentId: string, status: "EXPIRED" | "FAILED", deps: CheckoutDependencies): Promise<void> {
  await deps.database.update(billingCheckoutIntents).set({ status, updatedAt: deps.now() })
    .where(and(eq(billingCheckoutIntents.organizationId, organizationId), eq(billingCheckoutIntents.id, intentId), inArray(billingCheckoutIntents.status, ["CREATING", "OPEN"])));
}

type Purchase = {
  target: CheckoutTarget;
  discount: ChosenDiscount;
  priceId: string;
  catalogPrice: number;
  recurringBrlCents: number;
  couponId: string | null;
  promotionCodeId: string | null;
};

/**
 * Own checkout (NEX-52). One intent per organization and target holds one
 * incomplete Stripe subscription; retries, refreshes and second tabs get the
 * same subscription and client secret back. Nothing here grants a plan: the
 * webhook (reconcile) does, once Stripe reports the first invoice paid.
 */
async function subscribe(
  actor: Pick<Actor, "organizationId" | "organizationName" | "userId">,
  purchase: Purchase,
  idempotencyKey: string,
  deps: CheckoutDependencies,
): Promise<SubscribeResult> {
  const { target, discount } = purchase;
  const addonPriceId = apiAddonPriceId();
  // A stale intent closed in one round is replaced in the next.
  for (let round = 0; round < 3; round += 1) {
    const prepared = await prepareIntent(actor, target, idempotencyKey, deps, discount);
    if (prepared.supersede) {
      const previous = prepared.supersede;
      if (previous.subscriptionId) {
        const outcome = await deps.provider.cancelIncompleteSubscription(previous.subscriptionId, `uno-subscribe-cancel-${previous.intentId}-${previous.subscriptionId}`);
        // Already paid: the webhook completes it; never open a second contract.
        if (outcome === "paid") throw inProgress();
      } else if (previous.sessionId) {
        const outcome = await deps.provider.expireCheckout(previous.sessionId, `uno-checkout-expire-${previous.intentId}-${previous.sessionId}`);
        if (outcome === "complete") throw inProgress();
      }
      await closeIntent(actor.organizationId, previous.intentId, "EXPIRED", deps);
      continue;
    }
    if (prepared.subscriptionId) {
      const snapshot = await deps.provider.retrieveSubscriptionPayment(prepared.subscriptionId);
      if (!snapshot || snapshot.status === "canceled" || snapshot.status === "incomplete_expired") {
        await closeIntent(actor.organizationId, prepared.intentId, "EXPIRED", deps);
        continue;
      }
      return result(prepared.intentId, snapshot, purchase.recurringBrlCents);
    }
    const customerId = await ensureCustomer(actor, prepared.customerId, deps);
    const providerSubscriptions = await deps.provider.listSubscriptions(customerId);
    if (providerSubscriptions.some((subscription) => subscription.customerId !== customerId)) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    const sameKind = (subscription: StripeSubscriptionSnapshot) => target.addon
      ? addonPriceId !== null && subscription.priceIds.includes(addonPriceId)
      : subscription.priceIds.some((priceId) => priceId !== addonPriceId);
    // The provider is the source of truth: never sell a second contract it already holds.
    if (providerSubscriptions.some((subscription) => sameKind(subscription) && !unpaidOrGone(subscription.status))) {
      await closeIntent(actor.organizationId, prepared.intentId, "FAILED", deps);
      throw target.addon ? addonAlreadyActive() : subscriptionExists();
    }
    // Unpaid leftovers of lost intents are canceled so only one can ever be paid.
    for (const stale of providerSubscriptions.filter((subscription) => sameKind(subscription) && subscription.status === "incomplete" && subscription.checkoutIntentId !== prepared.intentId)) {
      const outcome = await deps.provider.cancelIncompleteSubscription(stale.id, `uno-subscribe-cancel-stale-${stale.id}`);
      if (outcome === "paid") throw inProgress();
    }
    const price = await deps.provider.retrievePrice(purchase.priceId);
    try {
      validatePrice(price, purchase.priceId, purchase.catalogPrice);
    } catch (error) {
      await closeIntent(actor.organizationId, prepared.intentId, "FAILED", deps);
      throw error;
    }
    const snapshot = await deps.provider.createSubscription({
      customerId,
      priceId: purchase.priceId,
      organizationId: actor.organizationId,
      checkoutIntentId: prepared.intentId,
      ...(target.addon ? { addon: target.addon } : {}),
      // Exactly one discount: the coupon's Promotion Code when it won, else the
      // first-month promo (a one-time coupon on the first invoice), if any.
      couponId: purchase.couponId,
      promotionCodeId: purchase.promotionCodeId,
    }, `uno-subscribe-${prepared.intentId}-${prepared.providerAttempt}`);
    if (snapshot.customerId !== customerId) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    const now = deps.now();
    await deps.database.transaction(async (transaction) => {
      await lockOrganizationBilling(actor.organizationId, transaction);
      await transaction.update(billingCheckoutIntents).set({
        stripeSubscriptionId: snapshot.id,
        expiresAt: new Date(now.getTime() + INCOMPLETE_LIFETIME_MS),
        status: "OPEN", updatedAt: now,
      }).where(and(eq(billingCheckoutIntents.organizationId, actor.organizationId), eq(billingCheckoutIntents.id, prepared.intentId), eq(billingCheckoutIntents.status, "CREATING")));
    });
    // Nothing due today: Stripe already marked it paid; apply it now (the webhook would too).
    if (snapshot.status === "active" || snapshot.status === "trialing") await deps.reconcile?.(customerId)?.catch(() => undefined);
    return result(prepared.intentId, snapshot, purchase.recurringBrlCents);
  }
  throw inProgress();
}

function assertCheckoutInput(actor: Pick<Actor, "membershipRole">, idempotencyKey: string | null): asserts idempotencyKey is string {
  assertManager(actor);
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new AppError("invalid_idempotency_key", "Idempotency-Key inválida.", 400);
  if (!billingProviderConfigured()) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
}

/** Starts (or resumes) the purchase of a paid plan on our own checkout page, with the server-chosen discount. */
export async function createBillingCheckout(
  actor: Pick<Actor, "organizationId" | "organizationName" | "userId" | "membershipRole">,
  planId: PaidPlanId,
  idempotencyKey: string | null,
  dependencies: CheckoutDependencies = defaults(),
  options: { promotionCode?: string | null } = {},
): Promise<SubscribeResult> {
  assertCheckoutInput(actor, idempotencyKey);
  try {
    const knownPrices = new Set(PAID_PLAN_IDS.map(stripePriceId));
    const addonPriceId = apiAddonPriceId();
    if (knownPrices.size !== PAID_PLAN_IDS.length || (addonPriceId && knownPrices.has(addonPriceId))) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    // The server prices the purchase and picks the single Stripe discount
    // (coupon or first-month promo, whichever makes the first payment lower).
    const quote = await quoteCheckout(planId, options.promotionCode, actor.organizationId, dependencies);
    if (!quote.preview.valid) throw new AppError("invalid_coupon", quote.preview.message, 400);
    return await subscribe(actor, {
      target: { planId, addon: null, promotionCode: quote.code },
      discount: { appliedDiscount: quote.promotionCodeId ? "COUPON" : quote.firstMonthCouponId ? "FIRST_MONTH" : "NONE", couponId: quote.couponId },
      priceId: stripePriceId(planId),
      catalogPrice: getPlanCatalog()[planId].priceBrlCents,
      recurringBrlCents: quote.preview.recurringBrlCents,
      couponId: quote.firstMonthCouponId,
      promotionCodeId: quote.promotionCodeId,
    }, idempotencyKey, dependencies);
  } catch (error) {
    return safeProviderError(error);
  }
}

/**
 * Starts the purchase of the API add-on: its own single-item subscription on
 * the organization's existing Stripe customer, so the plan subscription stays
 * manageable by the Customer Portal.
 */
export async function createApiAddonCheckout(
  actor: Pick<Actor, "organizationId" | "organizationName" | "userId" | "membershipRole">,
  idempotencyKey: string | null,
  dependencies: CheckoutDependencies = defaults(),
): Promise<SubscribeResult> {
  assertCheckoutInput(actor, idempotencyKey);
  if (!apiAddonConfigured()) throw new AppError("addon_unavailable", "O adicional de API não está disponível nesta instalação.", 503);
  try {
    const priceId = apiAddonPriceId()!;
    if (PAID_PLAN_IDS.some((planId) => stripePriceId(planId) === priceId)) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    const amount = getApiAddon().priceBrlCents;
    return await subscribe(actor, {
      target: { planId: null, addon: "API", promotionCode: null },
      discount: { appliedDiscount: null, couponId: null },
      priceId, catalogPrice: amount, recurringBrlCents: amount, couponId: null, promotionCodeId: null,
    }, idempotencyKey, dependencies);
  } catch (error) {
    return safeProviderError(error);
  }
}

export async function createBillingPortal(
  actor: Pick<Actor, "organizationId" | "membershipRole">,
  dependencies: Pick<CheckoutDependencies, "database" | "provider" | "randomId"> = defaults(),
): Promise<{ url: string }> {
  assertManager(actor);
  const rows = await dependencies.database.select({ customerId: subscriptions.stripeCustomerId })
    .from(subscriptions).where(eq(subscriptions.organizationId, actor.organizationId)).limit(1);
  if (!rows[0]?.customerId) throw new AppError("billing_not_configured", "Não há uma assinatura gerenciável.", 409);
  try {
    const portal = await dependencies.provider.createPortal(rows[0].customerId, billingUrls().portalReturn, `uno-portal-${actor.organizationId}-${dependencies.randomId()}`);
    return { url: assertPortalUrl(portal.url) };
  } catch (error) {
    return safeProviderError(error);
  }
}
