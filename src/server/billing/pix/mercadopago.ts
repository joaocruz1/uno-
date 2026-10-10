import { createHmac, timingSafeEqual } from "node:crypto";

import { AppError } from "@/lib/errors";

import type { PixCharge, PixChargeRequest, PixPayment, PixPaymentStatus, PixProvider, PixWebhookNotification } from "./provider";

const API_BASE = "https://api.mercadopago.com";

/** Maps a Mercado Pago payment status + detail to our normalized status. */
function mapStatus(status: string, detail?: string): PixPaymentStatus {
  if (status === "approved") return "approved";
  if (status === "pending" || status === "in_process" || status === "authorized") return "pending";
  if (status === "cancelled" && detail === "expired") return "expired";
  return "failed";
}

type MpPaymentResponse = {
  id: number | string;
  status: string;
  status_detail?: string;
  transaction_amount: number;
  external_reference?: string | null;
  date_of_expiration?: string;
  point_of_interaction?: { transaction_data?: { qr_code?: string; qr_code_base64?: string } };
};

function parseSignatureHeader(value: string | null): { ts: string; v1: string } | null {
  if (!value) return null;
  const parts = new Map<string, string>();
  for (const piece of value.split(",")) {
    const index = piece.indexOf("=");
    if (index > 0) parts.set(piece.slice(0, index).trim(), piece.slice(index + 1).trim());
  }
  const ts = parts.get("ts");
  const v1 = parts.get("v1");
  return ts && v1 ? { ts, v1 } : null;
}

function signaturesMatch(expectedHex: string, providedHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  return expected.length === provided.length && expected.length > 0 && timingSafeEqual(expected, provided);
}

class MercadoPagoProvider implements PixProvider {
  readonly name = "mercadopago";

  constructor(
    private readonly accessToken: string,
    private readonly webhookSecret: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(`${API_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json", ...init.headers },
    });
    if (!response.ok) {
      throw new AppError("pix_unavailable", "Falha ao falar com o provedor de pagamento.", 502);
    }
    return response.json();
  }

  async createCharge(request: PixChargeRequest): Promise<PixCharge> {
    const body = {
      transaction_amount: Math.round(request.amountBrlCents) / 100,
      description: request.description,
      payment_method_id: "pix",
      external_reference: request.externalReference,
      date_of_expiration: new Date(Date.now() + request.expiresInSeconds * 1_000).toISOString(),
      payer: {
        email: request.payerEmail,
        ...(request.payerCpf ? { identification: { type: "CPF", number: request.payerCpf } } : {}),
      },
    };
    const payment = await this.request("/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": request.externalReference },
      body: JSON.stringify(body),
    }) as MpPaymentResponse;
    const data = payment.point_of_interaction?.transaction_data;
    if (!data?.qr_code || !data.qr_code_base64) {
      throw new AppError("pix_unavailable", "O provedor não retornou o QR Code do PIX.", 502);
    }
    return {
      providerChargeId: String(payment.id),
      status: mapStatus(payment.status, payment.status_detail),
      qrCode: data.qr_code,
      qrCodeBase64: data.qr_code_base64,
      expiresAt: payment.date_of_expiration ? new Date(payment.date_of_expiration) : new Date(Date.now() + request.expiresInSeconds * 1_000),
    };
  }

  async getPayment(providerChargeId: string): Promise<PixPayment> {
    const payment = await this.request(`/v1/payments/${encodeURIComponent(providerChargeId)}`, { method: "GET" }) as MpPaymentResponse;
    return {
      providerChargeId: String(payment.id),
      status: mapStatus(payment.status, payment.status_detail),
      amountBrlCents: Math.round(payment.transaction_amount * 100),
      externalReference: payment.external_reference ?? null,
    };
  }

  parseWebhook(headers: Headers, rawBody: string): PixWebhookNotification {
    let body: { type?: string; action?: string; data?: { id?: string | number } };
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new AppError("invalid_request", "Notificação inválida.", 400);
    }
    const dataId = body.data?.id !== undefined ? String(body.data.id) : null;
    const isPayment = body.type === "payment" || (body.action ?? "").startsWith("payment.");
    if (!dataId || !isPayment) return null;

    // Signature is required in production; a missing secret means the webhook is not trusted.
    if (!this.webhookSecret) throw new AppError("pix_unavailable", "Webhook de PIX não configurado.", 503);
    const signature = parseSignatureHeader(headers.get("x-signature"));
    const requestId = headers.get("x-request-id") ?? "";
    if (!signature) throw new AppError("invalid_signature", "Assinatura ausente.", 401);
    // Mercado Pago manifest: alphanumeric data.id is lowercased.
    const manifestId = /[a-z]/i.test(dataId) ? dataId.toLowerCase() : dataId;
    const manifest = `id:${manifestId};request-id:${requestId};ts:${signature.ts};`;
    const expected = createHmac("sha256", this.webhookSecret).update(manifest).digest("hex");
    if (!signaturesMatch(expected, signature.v1)) throw new AppError("invalid_signature", "Assinatura inválida.", 401);
    return { providerChargeId: dataId };
  }
}

/** Builds the Mercado Pago provider, or null when `MP_ACCESS_TOKEN` is absent. */
export function createMercadoPagoProvider(environment: NodeJS.ProcessEnv = process.env): PixProvider | null {
  const accessToken = environment.MP_ACCESS_TOKEN?.trim();
  if (!accessToken) return null;
  return new MercadoPagoProvider(accessToken, environment.MP_WEBHOOK_SECRET?.trim() || undefined);
}

export { MercadoPagoProvider };
