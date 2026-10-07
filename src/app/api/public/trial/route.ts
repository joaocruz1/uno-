import { errorResponse, withJsonHandler } from "@/server/http";
import { runPublicTrial, trialAvailable, trialCookie } from "@/server/trial";

export const runtime = "nodejs";

export const GET = withJsonHandler(async (request, id) =>
  Response.json({ requestId: id, available: await trialAvailable(new Headers(request.headers)) }, { headers: { "cache-control": "no-store" } }));

export const POST = withJsonHandler(async (request, id) => {
  try {
    const bytes = await runPublicTrial(request);
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="uno-etiqueta-unificada.pdf"',
        "cache-control": "no-store",
        "x-request-id": id,
        "set-cookie": trialCookie(),
      },
    });
  } catch (error) {
    return errorResponse(error, id);
  }
});
