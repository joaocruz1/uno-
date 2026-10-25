import { eq } from "drizzle-orm";

import { getDb, subscriptions, type UnoDatabase } from "@/db";
import type { PaymentSession, SavedCard } from "@/lib/billing-model";
import { AppError } from "@/lib/errors";
import type { Actor } from "@/server/auth/actor";

import { assertManager, ensureCustomer } from "./checkout";
import { billingProviderConfigured } from "./config";
import { getBillingProvider, type BillingProvider, type StripeSubscriptionSnapshot } from "./stripe";

/**
 * Saved cards (NEX-52). The card lives only in Stripe, attached to the
 * organization's Customer: the UNO never receives the number or the CVC, stores
 * nothing about it and reads brand, last four digits and expiry from Stripe when
 * a page asks. Every operation is OWNER/ADMIN and scoped to the organization's
 * own Customer; a card of any other Customer is "not found".
 */
export type CardDependencies = {
  database: UnoDatabase;
  provider: BillingProvider;
  now(): Date;
};

function defaults(): CardDependencies {
  return { database: getDb(), provider: getBillingProvider(), now: () => new Date() };
}

function unavailable(): never {
  throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
}

async function organizationCustomer(organizationId: string, database: UnoDatabase): Promise<string | null> {
  const rows = await database.select({ customerId: subscriptions.stripeCustomerId }).from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId)).limit(1);
  return rows[0]?.customerId ?? null;
}

/** Subscriptions that will charge a card again (anything paid and not over). */
const charging = (snapshot: StripeSubscriptionSnapshot) => snapshot.status !== "canceled" && snapshot.status !== "incomplete_expired" && snapshot.status !== "incomplete";

async function cardsOf(customerId: string, deps: CardDependencies): Promise<{ cards: SavedCard[]; defaultPaymentMethodId: string | null; live: StripeSubscriptionSnapshot[] }> {
  const [stored, providerSubscriptions] = await Promise.all([deps.provider.listCards(customerId), deps.provider.listSubscriptions(customerId)]);
  if (providerSubscriptions.some((snapshot) => snapshot.customerId !== customerId)) unavailable();
  const live = providerSubscriptions.filter(charging);
  // A subscription without its own default card charges the Customer's default.
  const payer = (snapshot: StripeSubscriptionSnapshot) => snapshot.defaultPaymentMethodId ?? stored.defaultPaymentMethodId;
  const cards = stored.cards
    .filter((card) => card.customerId === customerId)
    .map((card) => ({
      id: card.id,
      brand: card.brand,
      last4: card.last4,
      expMonth: card.expMonth,
      expYear: card.expYear,
      isDefault: card.id === stored.defaultPaymentMethodId,
      inUse: live.some((snapshot) => payer(snapshot) === card.id),
    }));
  return { cards, defaultPaymentMethodId: stored.defaultPaymentMethodId, live };
}

export async function listSavedCards(actor: Pick<Actor, "organizationId" | "membershipRole">, deps: CardDependencies = defaults()): Promise<{ cards: SavedCard[] }> {
  assertManager(actor);
  if (!billingProviderConfigured()) return { cards: [] };
  const customerId = await organizationCustomer(actor.organizationId, deps.database);
  if (!customerId) return { cards: [] };
  try {
    return { cards: (await cardsOf(customerId, deps)).cards };
  } catch (error) {
    if (error instanceof AppError) throw error;
    return unavailable();
  }
}

/**
 * The Payment Element session for the checkout page: a CustomerSession of the
 * organization's own Customer (created on first use), so a returning buyer sees
 * the kept cards and a new one gets the "save" checkbox.
 */
export async function createPaymentSession(
  actor: Pick<Actor, "organizationId" | "organizationName" | "userId" | "membershipRole">,
  deps: CardDependencies = defaults(),
): Promise<PaymentSession> {
  assertManager(actor);
  if (!billingProviderConfigured()) unavailable();
  try {
    const customerId = await ensureCustomer(actor, await organizationCustomer(actor.organizationId, deps.database), deps);
    const [session, saved] = await Promise.all([deps.provider.createCustomerSession(customerId), cardsOf(customerId, deps)]);
    return { customerSessionClientSecret: session.clientSecret, cards: saved.cards };
  } catch (error) {
    if (error instanceof AppError) throw error;
    return unavailable();
  }
}

/**
 * Removes a kept card. The only card paying a live subscription is never
 * removed (the next renewal would fail); with another card on file, that one
 * takes over as the default of the Customer and of those subscriptions first.
 */
export async function removeSavedCard(
  actor: Pick<Actor, "organizationId" | "membershipRole">,
  paymentMethodId: string,
  deps: CardDependencies = defaults(),
): Promise<{ removed: true; replacedBy: string | null }> {
  assertManager(actor);
  if (!billingProviderConfigured()) unavailable();
  const customerId = await organizationCustomer(actor.organizationId, deps.database);
  if (!customerId) throw new AppError("card_not_found", "Cartão não encontrado.", 404);
  try {
    const { cards, defaultPaymentMethodId, live } = await cardsOf(customerId, deps);
    const card = cards.find((candidate) => candidate.id === paymentMethodId);
    if (!card) throw new AppError("card_not_found", "Cartão não encontrado.", 404);
    const others = cards.filter((candidate) => candidate.id !== paymentMethodId);
    const dependents = live.filter((snapshot) => (snapshot.defaultPaymentMethodId ?? defaultPaymentMethodId) === paymentMethodId);
    if (dependents.length > 0 && others.length === 0) {
      throw new AppError("card_in_use", "Este é o único cartão da sua assinatura ativa e pagaria a próxima renovação. Cadastre outro cartão em Trocar cartão antes de remover este, ou cancele a assinatura.", 409);
    }
    let replacedBy: string | null = null;
    if (others.length > 0 && (dependents.length > 0 || card.isDefault)) {
      const replacement = others.find((candidate) => candidate.isDefault) ?? others[0]!;
      replacedBy = replacement.id;
      await deps.provider.setDefaultCard({
        customerId,
        paymentMethodId: replacement.id,
        subscriptionIds: dependents.filter((snapshot) => snapshot.defaultPaymentMethodId === paymentMethodId).map((snapshot) => snapshot.id),
      }, `uno-card-replace-${paymentMethodId}-${replacement.id}`);
    }
    await deps.provider.detachCard(paymentMethodId, `uno-card-detach-${paymentMethodId}`);
    console.log(JSON.stringify({ event: "billing.card.removed", organizationId: actor.organizationId, replaced: Boolean(replacedBy) }));
    return { removed: true, replacedBy };
  } catch (error) {
    if (error instanceof AppError) throw error;
    return unavailable();
  }
}
