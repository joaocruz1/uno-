import { positiveIntegerEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { errorResponse, requestId } from "@/server/http";
import { getPixProvider } from "@/server/billing/pix/provider";
import { confirmPixPayment } from "@/server/billing/pix/purchase";

export const runtime = "nodejs";

async function limitedBody(request: Request): Promise<Buffer> {
  const limit = positiveIntegerEnv("UNO_PIX_WEBHOOK_MAX_BYTES", 1_048_576);
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new AppError("payload_too_large", "Webhook excede o limite permitido.", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}

export async function POST(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const raw = await limitedBody(request);
    const provider = getPixProvider();
    const notification = provider.parseWebhook(request.headers, raw.toString("utf8"));
    if (notification) await confirmPixPayment(notification.providerChargeId);
    return Response.json({ requestId: id, received: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
