import { AppError } from "@/lib/errors";

import { createMercadoPagoProvider } from "./mercadopago";

/** Normalized PIX payment status, mapped from whatever the gateway returns. */
export type PixPaymentStatus = "pending" | "approved" | "expired" | "failed";

export type PixChargeRequest = {
  amountBrlCents: number;
  description: string;
  /** Our pix_charges.id, echoed back by the gateway for correlation. */
  externalReference: string;
  payerEmail: string;
  payerCpf?: string;
  expiresInSeconds: number;
};

export type PixCharge = {
  providerChargeId: string;
  status: PixPaymentStatus;
  /** Copia-e-cola string. */
  qrCode: string;
  /** PNG of the QR code, base64 (no data: prefix). */
  qrCodeBase64: string;
  expiresAt: Date;
};

export type PixPayment = {
  providerChargeId: string;
  status: PixPaymentStatus;
  amountBrlCents: number;
  externalReference: string | null;
};

/** The id to reconsult, extracted from a signature-verified payment webhook; null if not applicable. */
export type PixWebhookNotification = { providerChargeId: string } | null;

export interface PixProvider {
  readonly name: string;
  createCharge(request: PixChargeRequest): Promise<PixCharge>;
  /** Authoritative re-read before granting anything. */
  getPayment(providerChargeId: string): Promise<PixPayment>;
  /** Verifies the signature over the raw body and returns the payment id to reconsult. Throws on invalid signature. */
  parseWebhook(headers: Headers, rawBody: string): PixWebhookNotification;
}

let override: PixProvider | null = null;

/** Tests inject a fake provider; production builds the configured gateway. */
export function setPixProvider(provider: PixProvider | null): void {
  override = provider;
}

export function getPixProvider(): PixProvider {
  if (override) return override;
  const provider = createMercadoPagoProvider();
  if (!provider) throw new AppError("pix_unavailable", "O pagamento por PIX não está configurado.", 503);
  return provider;
}
