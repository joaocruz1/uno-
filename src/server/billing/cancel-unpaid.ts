/**
 * Cancels a subscription that was never paid, without ever canceling one whose
 * first payment goes through at the same moment (NEX-52).
 *
 * Reading the status and then canceling is not atomic: the browser may confirm
 * the PaymentIntent in between. So payment is first made impossible atomically
 * by voiding the first invoice (Stripe cancels its PaymentIntent, and refuses
 * the void when the invoice is already paid or its payment is processing). A
 * refused void means "paid": nothing is canceled and the webhook completes the
 * purchase. Only after a successful void is the subscription canceled. As a
 * safety net the invoice is read again afterwards; if it still turns out paid,
 * the payment is refunded and a structured alert is logged.
 */
export type UnpaidInvoiceView = { id: string; status: string | null; paymentIntentIds: string[] };

export type UnpaidSubscriptionView = {
  status: string;
  organizationId: string | null;
  invoice: UnpaidInvoiceView | null;
};

export type CancelUnpaidOperations = {
  retrieve(subscriptionId: string): Promise<UnpaidSubscriptionView>;
  retrieveInvoice(invoiceId: string): Promise<UnpaidInvoiceView>;
  /** "refused" when Stripe will not void it (paid, payment processing, already void). */
  voidInvoice(invoiceId: string, idempotencyKey: string): Promise<"voided" | "refused">;
  cancel(subscriptionId: string, idempotencyKey: string): Promise<void>;
  refund(paymentIntentId: string, metadata: Record<string, string>, idempotencyKey: string): Promise<void>;
  log(entry: Record<string, unknown>): void;
};

const PAID_INVOICE = new Set(["paid"]);

export async function cancelUnpaidSubscription(
  operations: CancelUnpaidOperations,
  subscriptionId: string,
  idempotencyKey: string,
): Promise<"canceled" | "paid"> {
  const subscription = await operations.retrieve(subscriptionId);
  if (subscription.status === "canceled" || subscription.status === "incomplete_expired") return "canceled";
  if (subscription.status !== "incomplete") return "paid";
  const invoice = subscription.invoice;
  if (invoice) {
    if (invoice.status && PAID_INVOICE.has(invoice.status)) return "paid";
    if (invoice.status === "open") {
      const voided = await operations.voidInvoice(invoice.id, `${idempotencyKey}-void-${invoice.id}`);
      if (voided === "refused") {
        // Paid or being paid right now: leave it to the webhook.
        const current = await operations.retrieveInvoice(invoice.id);
        if (current.status !== "void") return "paid";
      }
    } else if (invoice.status !== "void" && invoice.status !== "uncollectible" && invoice.status !== "draft") {
      return "paid";
    }
  }
  await operations.cancel(subscriptionId, idempotencyKey);
  if (invoice) {
    const after = await operations.retrieveInvoice(invoice.id);
    if (after.status && PAID_INVOICE.has(after.status)) {
      operations.log({ event: "billing.checkout.paid_after_cancel", organizationId: subscription.organizationId, subscriptionId, invoiceId: invoice.id });
      for (const [index, paymentIntentId] of after.paymentIntentIds.entries()) {
        await operations.refund(
          paymentIntentId,
          { organizationId: subscription.organizationId ?? "", uno_refund: "superseded_checkout", subscriptionId },
          index === 0 ? `uno-supersede-refund-${invoice.id}` : `uno-supersede-refund-${invoice.id}-${paymentIntentId}`,
        );
      }
    }
  }
  return "canceled";
}
