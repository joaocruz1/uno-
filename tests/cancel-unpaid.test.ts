import { describe, expect, it } from "vitest";

import { cancelUnpaidSubscription, type CancelUnpaidOperations, type UnpaidInvoiceView, type UnpaidSubscriptionView } from "@/server/billing/cancel-unpaid";

/** In-memory Stripe for one subscription and its first invoice; hooks simulate a payment landing at a given step. */
function fakeStripe(options: { status?: string; invoice?: Partial<UnpaidInvoiceView> | null; payAt?: "beforeVoid" | "afterCancel" } = {}) {
  const calls: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const refunds: Array<{ paymentIntentId: string; key: string }> = [];
  let invoice: UnpaidInvoiceView | null = options.invoice === null ? null : { id: "in_1", status: "open", paymentIntentIds: [], ...options.invoice };
  const pay = () => { if (invoice) invoice = { ...invoice, status: "paid", paymentIntentIds: ["pi_1"] }; };
  const subscription = (): UnpaidSubscriptionView => ({ status: options.status ?? "incomplete", organizationId: "org_1", invoice: invoice ? { ...invoice } : null });
  const operations: CancelUnpaidOperations = {
    retrieve: async () => { calls.push("retrieve"); const view = subscription(); if (options.payAt === "beforeVoid") pay(); return view; },
    retrieveInvoice: async () => { calls.push("retrieveInvoice"); return { ...invoice! }; },
    voidInvoice: async () => {
      calls.push("void");
      if (invoice?.status !== "open") return "refused";
      invoice = { ...invoice, status: "void" };
      return "voided";
    },
    cancel: async () => { calls.push("cancel"); if (options.payAt === "afterCancel") pay(); },
    refund: async (paymentIntentId, _metadata, key) => { calls.push("refund"); refunds.push({ paymentIntentId, key }); },
    log: (entry) => { logs.push(entry); },
  };
  return { operations, calls, logs, refunds };
}

describe("canceling an unpaid subscription without racing its payment (NEX-52)", () => {
  it("voids the first invoice, then cancels", async () => {
    const stripe = fakeStripe();
    expect(await cancelUnpaidSubscription(stripe.operations, "sub_1", "key")).toBe("canceled");
    expect(stripe.calls).toEqual(["retrieve", "void", "cancel", "retrieveInvoice"]);
    expect(stripe.refunds).toEqual([]);
  });

  it("never cancels when the payment succeeds between the read and the cancel: the void is refused", async () => {
    const stripe = fakeStripe({ payAt: "beforeVoid" });
    expect(await cancelUnpaidSubscription(stripe.operations, "sub_1", "key")).toBe("paid");
    expect(stripe.calls).not.toContain("cancel");
  });

  it("answers paid without touching anything when Stripe already reports it", async () => {
    for (const stripe of [fakeStripe({ status: "active" }), fakeStripe({ invoice: { status: "paid" } })]) {
      expect(await cancelUnpaidSubscription(stripe.operations, "sub_1", "key")).toBe("paid");
      expect(stripe.calls).toEqual(["retrieve"]);
    }
  });

  it("refunds and alerts if the invoice still turns out paid after the cancel", async () => {
    const stripe = fakeStripe({ payAt: "afterCancel" });
    expect(await cancelUnpaidSubscription(stripe.operations, "sub_1", "key")).toBe("canceled");
    expect(stripe.refunds).toEqual([{ paymentIntentId: "pi_1", key: "uno-supersede-refund-in_1" }]);
    expect(stripe.logs).toEqual([{ event: "billing.checkout.paid_after_cancel", organizationId: "org_1", subscriptionId: "sub_1", invoiceId: "in_1" }]);
  });

  it("treats an already terminal subscription as canceled", async () => {
    const stripe = fakeStripe({ status: "incomplete_expired" });
    expect(await cancelUnpaidSubscription(stripe.operations, "sub_1", "key")).toBe("canceled");
    expect(stripe.calls).toEqual(["retrieve"]);
  });
});
