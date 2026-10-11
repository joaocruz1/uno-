import { PDFDocument } from "pdf-lib";

import { errorResponse, withJsonHandler } from "@/server/http";
import { runPublicTrial, trialAvailable, trialCookie } from "@/server/trial";

export const runtime = "nodejs";

export const GET = withJsonHandler(async (request, id) =>
  Response.json({ requestId: id, available: await trialAvailable(new Headers(request.headers)) }, { headers: { "cache-control": "no-store" } }));

export const POST = withJsonHandler(async (request, id) => {
  try {
    const bytes = await runPublicTrial(request);
    let pages = 0;
    try { pages = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount(); } catch { /* page count is best-effort */ }
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="uno-etiqueta.pdf"',
        "cache-control": "no-store",
        "x-request-id": id,
        "x-uno-pages": String(pages),
        "set-cookie": trialCookie(),
      },
    });
  } catch (error) {
    return errorResponse(error, id);
  }
});
