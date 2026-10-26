import { readCheckoutConfig } from "@/server/billing";
import { errorResponse, requestId, requireActor } from "@/server/http";

export const runtime = "nodejs";

/** Publishable key and plan prices for the checkout in the plans dialog (NEX-52); the reason it is unavailable only for platform admins. */
export async function GET(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const actor = await requireActor(new Headers(request.headers));
    const config = await readCheckoutConfig(actor);
    return Response.json({ requestId: id, ...config }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, id);
  }
}
