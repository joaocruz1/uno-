import { AppError } from "@/lib/errors";
import { convertForExtension, extensionMarketplaceSchema } from "@/server/extension/convert";
import { requireExtensionActor } from "@/server/extension/tokens";
import { errorResponse, requestId } from "@/server/http";
import { pdfResponse, syncErrorResponse } from "@/server/marketplace/sync";

export const runtime = "nodejs";

/**
 * Converts one file the extension captured from a marketplace download. Bearer
 * token only (never ambient), so there is no CSRF check. Shopee, TikTok and ML
 * Full answer with the PDF; Mercado Livre answers 202 with a lote to poll.
 */
export async function POST(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    const actor = await requireExtensionActor(request.headers);
    const parsed = extensionMarketplaceSchema.safeParse(new URL(request.url).searchParams.get("marketplace"));
    if (!parsed.success) throw new AppError("invalid_request", "Marketplace não suportado pela extensão.", 400);

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new AppError("invalid_request", "Envie o arquivo no campo file.", 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("invalid_request", "Envie o arquivo no campo file.", 400);

    const conversion = await convertForExtension(actor, parsed.data, file);
    if (conversion.kind === "pdf") return pdfResponse(conversion.result);
    return Response.json({ requestId: id, loteId: conversion.lote.id, itemCount: conversion.lote.itemCount }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return syncErrorResponse(error) ?? errorResponse(error, id);
  }
}
