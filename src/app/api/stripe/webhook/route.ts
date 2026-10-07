import { positiveIntegerEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { processStripeWebhook } from "@/server/billing";
import { errorResponse, requestId } from "@/server/http";

export const runtime = "nodejs";

async function limitedBody(request: Request): Promise<Buffer> {
  const limit = positiveIntegerEnv("UNO_STRIPE_WEBHOOK_MAX_BYTES", 1_048_576);
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
    const result = await processStripeWebhook(await limitedBody(request), request.headers.get("stripe-signature"));
    return Response.json({ requestId: id, received: true, duplicate: result.duplicate }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
