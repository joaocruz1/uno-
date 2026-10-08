import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";

import { billingCheckoutIntents, getDb, subscriptions, type UnoDatabase } from "@/db";
import type { PaidPlanId } from "@/lib/billing-model";
import { AppError } from "@/lib/errors";
import { getApiAddon, getPlanCatalog } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";

import { apiAddonConfigured, apiAddonPriceId, billingProviderConfigured, billingUrls, PAID_PLAN_IDS, stripePriceId } from "./config";
import { effectivePlanId, lockOrganizationBilling } from "./entitlements";
import { checkoutIntegrationIdentifier, getBillingProvider, type BillingProvider } from "./stripe";

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/;

export type CheckoutDependencies = {
  database: UnoDatabase;
  provider: BillingProvider;
  now(): Date;
  randomId(): string;
};

function defaults(): CheckoutDependencies {
  return { database: getDb(), provider: getBillingProvider(), now: () => new Date(), randomId: randomUUID };
}

function assertManager(actor: Pick<Actor, "membershipRole">): void {
  if (actor.membershipRole !== "OWNER" && actor.membershipRole !== "ADMIN") {
    throw new AppError("forbidden", "Acesso negado.", 403);
  }
}

function safeProviderError(error: unknown): never {
  if (error instanceof AppError) throw error;
  throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
}

function assertBillingUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || (parsed.hostname !== "checkout.stripe.com" && parsed.hostname !== "billing.stripe.com")) throw new Error();
    return parsed.toString();
  } catch {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
}

/** What a checkout buys: a paid plan, or the API add-on on top of one. */
type CheckoutTarget = { planId: PaidPlanId; addon: null } | { planId: null; addon: "API" };

function requestHash(target: CheckoutTarget): string {
  return createHash("sha256").update(JSON.stringify(target.addon ? { addon: target.addon } : { planId: target.planId })).digest("hex");
}

function sameTarget(intent: Pick<typeof billingCheckoutIntents.$inferSelect, "planId" | "addon">, target: CheckoutTarget): boolean {
  return intent.planId === target.planId && intent.addon === target.addon;
}

type PreparedCheckout = {
  intentId: string;
  customerId: string | null;
  organizationName: string;
  completedUrl?: string;
  portalInstead: boolean;
  providerAttempt: number;
};

async function prepareCheckout(
  actor: Pick<Actor, "organizationId" | "organizationName" | "userId">,
  target: CheckoutTarget,
  idempotencyKey: string,
  deps: CheckoutDependencies,
): Promise<PreparedCheckout> {
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
      const inserted = await transaction.insert(subscriptions).values({ organizationId: actor.organizationId })
        .returning();
      subscription = inserted[0]!;
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
      if (subscription.apiAddonSubscriptionId && subscription.apiAddonStatus !== "CANCELED") {
        throw new AppError("addon_already_active", "O adicional de API já está contratado. Gerencie a assinatura no portal.", 409);
      }
    }
    const portalInstead = !target.addon && Boolean(subscription.stripeSubscriptionId) && subscription.status !== "CANCELED";
    if (portalInstead) {
      return { intentId: existingByKey?.id ?? deps.randomId(), customerId: subscription.stripeCustomerId, organizationName: actor.organizationName, portalInstead, providerAttempt: existingByKey?.providerAttempt ?? 1 };
    }
    if (existingByKey?.status === "OPEN" && existingByKey.expiresAt && existingByKey.expiresAt > now && existingByKey.checkoutUrl) {
      return { intentId: existingByKey.id, customerId: subscription.stripeCustomerId, organizationName: actor.organizationName, completedUrl: existingByKey.checkoutUrl, portalInstead: false, providerAttempt: existingByKey.providerAttempt };
    }
    const active = await transaction.select().from(billingCheckoutIntents).where(and(
      eq(billingCheckoutIntents.organizationId, actor.organizationId),
      inArray(billingCheckoutIntents.status, ["CREATING", "OPEN"]),
    )).limit(1).for("update");
    const reusable = existingByKey?.status === "CREATING" ? existingByKey : active[0];
    if (reusable && !sameTarget(reusable, target)) {
      throw new AppError("checkout_in_progress", "Já existe uma contratação em andamento.", 409);
    }
    if (reusable?.status === "OPEN" && reusable.expiresAt && reusable.expiresAt > now && reusable.checkoutUrl) {
      return { intentId: reusable.id, customerId: subscription.stripeCustomerId, organizationName: actor.organizationName, completedUrl: reusable.checkoutUrl, portalInstead: false, providerAttempt: reusable.providerAttempt };
    }
    if (reusable) return { intentId: reusable.id, customerId: subscription.stripeCustomerId, organizationName: actor.organizationName, portalInstead: false, providerAttempt: reusable.providerAttempt };
    if (existingByKey) {
      await transaction.update(billingCheckoutIntents).set({
        planId: target.planId, addon: target.addon, requestHash: hash, stripeSessionId: null, checkoutUrl: null,
        status: "CREATING", expiresAt: null, providerAttempt: existingByKey.providerAttempt + 1, updatedAt: now,
      }).where(eq(billingCheckoutIntents.id, existingByKey.id));
      return { intentId: existingByKey.id, customerId: subscription.stripeCustomerId, organizationName: actor.organizationName, portalInstead: false, providerAttempt: existingByKey.providerAttempt + 1 };
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
      createdAt: now,
      updatedAt: now,
    });
    return { intentId, customerId: subscription.stripeCustomerId, organizationName: actor.organizationName, portalInstead: false, providerAttempt: 1 };
  });
}

async function ensureCustomer(actor: Pick<Actor, "organizationId" | "organizationName">, prepared: PreparedCheckout, deps: CheckoutDependencies): Promise<string> {
  if (prepared.customerId) return prepared.customerId;
  const created = await deps.provider.createCustomer({ organizationId: actor.organizationId, organizationName: actor.organizationName }, `uno-customer-${actor.organizationId}`);
  return deps.database.transaction(async (transaction) => {
    await lockOrganizationBilling(actor.organizationId, transaction);
    const rows = await transaction.select().from(subscriptions).where(eq(subscriptions.organizationId, actor.organizationId)).limit(1).for("update");
    const current = rows[0];
    if (!current) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    if (current.stripeCustomerId && current.stripeCustomerId !== created.id) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    if (!current.stripeCustomerId) await transaction.update(subscriptions).set({ stripeCustomerId: created.id, updatedAt: deps.now() }).where(eq(subscriptions.id, current.id));
    return current.stripeCustomerId ?? created.id;
  });
}

export async function createBillingCheckout(
  actor: Pick<Actor, "organizationId" | "organizationName" | "userId" | "membershipRole">,
  planId: PaidPlanId,
  idempotencyKey: string | null,
  dependencies: CheckoutDependencies = defaults(),
): Promise<{ url: string }> {
  assertManager(actor);
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new AppError("invalid_idempotency_key", "Idempotency-Key inválida.", 400);
  if (!billingProviderConfigured()) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  try {
    const prepared = await prepareCheckout(actor, { planId, addon: null }, idempotencyKey, dependencies);
    if (prepared.completedUrl) return { url: assertBillingUrl(prepared.completedUrl) };
    const customerId = await ensureCustomer(actor, prepared, dependencies);
    if (prepared.portalInstead) {
      const portal = await dependencies.provider.createPortal(customerId, billingUrls().portalReturn, `uno-portal-checkout-${prepared.intentId}`);
      await dependencies.database.update(billingCheckoutIntents).set({ status: "COMPLETED", updatedAt: dependencies.now() })
        .where(and(eq(billingCheckoutIntents.organizationId, actor.organizationId), eq(billingCheckoutIntents.id, prepared.intentId), eq(billingCheckoutIntents.status, "CREATING")));
      return { url: assertBillingUrl(portal.url) };
    }
    const knownPrices = new Set(PAID_PLAN_IDS.map(stripePriceId));
    if (knownPrices.size !== PAID_PLAN_IDS.length) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    const addonPriceId = apiAddonPriceId();
    if (addonPriceId && knownPrices.has(addonPriceId)) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    const providerSubscriptions = await dependencies.provider.listSubscriptions(customerId);
    // A subscription that only carries the API add-on is not a plan subscription.
    const manageable = providerSubscriptions.filter((subscription) =>
      subscription.customerId === customerId &&
      subscription.status !== "canceled" && subscription.status !== "incomplete_expired" &&
      subscription.priceIds.some((id) => id !== addonPriceId),
    );
    if (manageable.length > 0) {
      const portal = await dependencies.provider.createPortal(customerId, billingUrls().portalReturn, `uno-portal-checkout-${prepared.intentId}`);
      await dependencies.database.update(billingCheckoutIntents).set({ status: "COMPLETED", updatedAt: dependencies.now() })
        .where(and(eq(billingCheckoutIntents.organizationId, actor.organizationId), eq(billingCheckoutIntents.id, prepared.intentId), eq(billingCheckoutIntents.status, "CREATING")));
      return { url: assertBillingUrl(portal.url) };
    }
    const priceId = stripePriceId(planId);
    const price = await dependencies.provider.retrievePrice(priceId);
    const configured = getPlanCatalog()[planId];
    if (price.id !== priceId || !price.active || price.currency !== "brl" || price.unitAmount !== configured.priceBrlCents || price.recurringInterval !== "month" || price.recurringIntervalCount !== 1) {
      throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    }
    const urls = billingUrls();
    const checkout = await dependencies.provider.createCheckout({
      customerId, priceId, organizationId: actor.organizationId,
      successUrl: urls.success, cancelUrl: urls.cancel,
      integrationIdentifier: checkoutIntegrationIdentifier(`${prepared.intentId}:${prepared.providerAttempt}`),
    }, `uno-checkout-${prepared.intentId}-${prepared.providerAttempt}`);
    const url = assertBillingUrl(checkout.url);
    await dependencies.database.transaction(async (transaction) => {
      await lockOrganizationBilling(actor.organizationId, transaction);
      await transaction.update(billingCheckoutIntents).set({
        stripeSessionId: checkout.id, checkoutUrl: url, expiresAt: checkout.expiresAt,
        status: "OPEN", updatedAt: dependencies.now(),
      }).where(and(eq(billingCheckoutIntents.organizationId, actor.organizationId), eq(billingCheckoutIntents.id, prepared.intentId), eq(billingCheckoutIntents.status, "CREATING")));
    });
    return { url };
  } catch (error) {
    return safeProviderError(error);
  }
}

/**
 * Starts the Checkout of the API add-on: its own single-item subscription on
 * the organization's existing Stripe customer, so the plan subscription stays
 * manageable by the Customer Portal.
 */
export async function createApiAddonCheckout(
  actor: Pick<Actor, "organizationId" | "organizationName" | "userId" | "membershipRole">,
  idempotencyKey: string | null,
  dependencies: CheckoutDependencies = defaults(),
): Promise<{ url: string }> {
  assertManager(actor);
  if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new AppError("invalid_idempotency_key", "Idempotency-Key inválida.", 400);
  if (!billingProviderConfigured()) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  if (!apiAddonConfigured()) throw new AppError("addon_unavailable", "O adicional de API não está disponível nesta instalação.", 503);
  try {
    const priceId = apiAddonPriceId()!;
    if (PAID_PLAN_IDS.some((planId) => stripePriceId(planId) === priceId)) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    const prepared = await prepareCheckout(actor, { planId: null, addon: "API" }, idempotencyKey, dependencies);
    if (prepared.completedUrl) return { url: assertBillingUrl(prepared.completedUrl) };
    const customerId = await ensureCustomer(actor, prepared, dependencies);
    const closeIntent = () => dependencies.database.update(billingCheckoutIntents).set({ status: "FAILED", updatedAt: dependencies.now() })
      .where(and(eq(billingCheckoutIntents.organizationId, actor.organizationId), eq(billingCheckoutIntents.id, prepared.intentId), eq(billingCheckoutIntents.status, "CREATING")));
    // The provider is the source of truth: never sell a second add-on while one is still alive there.
    const providerSubscriptions = await dependencies.provider.listSubscriptions(customerId);
    const alive = providerSubscriptions.some((subscription) =>
      subscription.customerId === customerId &&
      subscription.status !== "canceled" && subscription.status !== "incomplete_expired" &&
      subscription.priceIds.includes(priceId),
    );
    if (alive) {
      await closeIntent();
      throw new AppError("addon_already_active", "O adicional de API já está contratado. Gerencie a assinatura no portal.", 409);
    }
    const price = await dependencies.provider.retrievePrice(priceId);
    if (price.id !== priceId || !price.active || price.currency !== "brl" || price.unitAmount !== getApiAddon().priceBrlCents || price.recurringInterval !== "month" || price.recurringIntervalCount !== 1) {
      await closeIntent();
      throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    }
    const urls = billingUrls();
    const checkout = await dependencies.provider.createCheckout({
      customerId, priceId, organizationId: actor.organizationId, addon: "API",
      successUrl: urls.success, cancelUrl: urls.cancel,
      integrationIdentifier: checkoutIntegrationIdentifier(`${prepared.intentId}:${prepared.providerAttempt}`),
    }, `uno-checkout-${prepared.intentId}-${prepared.providerAttempt}`);
    const url = assertBillingUrl(checkout.url);
    await dependencies.database.transaction(async (transaction) => {
      await lockOrganizationBilling(actor.organizationId, transaction);
      await transaction.update(billingCheckoutIntents).set({
        stripeSessionId: checkout.id, checkoutUrl: url, expiresAt: checkout.expiresAt,
        status: "OPEN", updatedAt: dependencies.now(),
      }).where(and(eq(billingCheckoutIntents.organizationId, actor.organizationId), eq(billingCheckoutIntents.id, prepared.intentId), eq(billingCheckoutIntents.status, "CREATING")));
    });
    return { url };
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
    return { url: assertBillingUrl(portal.url) };
  } catch (error) {
    return safeProviderError(error);
  }
}
