import { reprocessConversion } from "@/server/conversions";
import { AppError } from "@/lib/errors";
import { assertSameOrigin, errorResponse, requestId, requireActor } from "@/server/http";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = requestId(request);
  try {
    assertSameOrigin(request);
    const actor = await requireActor(new Headers(request.headers));
    const { id: sourceConversionId } = await context.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400);
    }
    const conversion = await reprocessConversion(
      actor,
      sourceConversionId,
      request.headers.get("idempotency-key"),
      body,
    );
    return Response.json({ requestId: id, ...conversion }, {
      status: 202,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, id);
  }
}
