import { formatBrlCents } from "./plans";

/** Card brands as Stripe names them, in the buyer's words. */
const BRANDS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  elo: "Elo",
  hipercard: "Hipercard",
  diners: "Diners",
  discover: "Discover",
  jcb: "JCB",
  unionpay: "UnionPay",
};

export function brandName(brand: string): string {
  return BRANDS[brand.toLowerCase()] ?? (brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "Cartão");
}

/** "Visa •••• 4242". Only display fields Stripe returns; never a card number. */
export function cardLabel(card: { brand: string; last4: string }): string {
  return `${brandName(card.brand)} •••• ${card.last4}`;
}

/** "12/34". */
export function cardExpiry(card: { expMonth: number; expYear: number }): string {
  return `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`;
}

const nbsp = (value: string) => value.replace(/\s/g, " ");

/**
 * The checkout submit button, with the explicit value and period from the
 * server's quote (NEX-52): "Assinar Pro · R$ 15,99 no 1º mês", "Assinar Pro ·
 * R$ 49,00/mês", "Contratar + API · R$ 50,00/mês"; with a kept card selected,
 * "Pagar com Visa •••• 4242 · …".
 */
export function submitLabel(input: {
  target: { kind: "plan"; planName: string } | { kind: "addon"; addonName: string };
  firstPaymentBrlCents: number;
  recurringBrlCents: number;
  savedCard?: { brand: string; last4: string } | null;
}): string {
  const { target, firstPaymentBrlCents, recurringBrlCents } = input;
  const amount = firstPaymentBrlCents < recurringBrlCents
    ? firstPaymentBrlCents === 0 ? "grátis no 1º mês" : `${formatBrlCents(firstPaymentBrlCents)} no 1º mês`
    : `${formatBrlCents(recurringBrlCents)}/mês`;
  const action = input.savedCard ? `Pagar com ${cardLabel(input.savedCard)}` : target.kind === "plan" ? `Assinar ${target.planName}` : `Contratar + ${target.addonName}`;
  return nbsp(`${action} · ${amount}`);
}
