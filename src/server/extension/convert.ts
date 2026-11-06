import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { AppError } from "@/lib/errors";
import { getPlanCatalog } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";
import { createMarketplaceLote, defaultMarketplaceCreationDependencies, type AcceptedLote } from "@/server/marketplace/create";
import { convertShopeeSync, convertTikTokSync, convertZplSync, type SyncResult, ZPL_MAX_BYTES } from "@/server/marketplace/sync";
import { enforceRateLimit } from "@/server/rate-limit";
import { getStorage } from "@/server/storage";
import { hasPdfMagic, insertUploadIntentWithPendingLimit, pendingUploadLimit, type ReadValidatedUpload, uploadIntentRateLimit } from "@/server/uploads";

export const extensionMarketplaceSchema = z.enum(["mercado-livre", "mercado-livre-full", "shopee", "tiktok"]);
export type ExtensionMarketplace = z.infer<typeof extensionMarketplaceSchema>;

export type ExtensionConversion =
  | { kind: "pdf"; result: SyncResult }
  | { kind: "lote"; lote: AcceptedLote };

const INTENT_TTL_MS = 5 * 60_000;

/**
 * Records bytes the server already holds as an upload intent, so the Mercado
 * Livre lote goes through exactly the same `createMarketplaceLote` path (split,
 * snapshot, quota, outbox) as the dashboard's presigned upload. The source copy
 * is stored in the background: the lote reads the bytes from memory instead of
 * paying a storage round trip.
 */
async function stageUpload(actor: Pick<Actor, "organizationId" | "userId" | "planId">, bytes: Buffer, fileName: string | undefined) {
  const id = randomUUID();
  const objectKey = `organizations/${actor.organizationId}/uploads/${randomUUID()}.pdf`;
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  // The lote never reads this copy back, so a failed upload does not fail it.
  const stored = getStorage().putBytes(objectKey, bytes, "application/pdf", bytes.length).catch(() => undefined);
  await insertUploadIntentWithPendingLimit({
    id,
    organizationId: actor.organizationId,
    createdByUserId: actor.userId,
    objectKey,
    contentType: "application/pdf",
    contentLength: bytes.length,
    checksumSha256,
    originalFileName: fileName?.slice(0, 255),
    expiresAt: new Date(Date.now() + INTENT_TTL_MS),
  }, pendingUploadLimit(actor));
  const upload: ReadValidatedUpload = {
    bytes,
    contentLength: bytes.length,
    contentType: "application/pdf",
    checksumSha256,
    originalFileName: fileName?.slice(0, 255),
  };
  return { id, upload, stored };
}

/**
 * Converts one file captured by the browser extension. The synchronous
 * marketplaces return the PDF at once; Mercado Livre becomes a metered lote the
 * extension polls, like the dashboard.
 */
export async function convertForExtension(
  actor: Pick<Actor, "organizationId" | "userId" | "planId">,
  marketplace: ExtensionMarketplace,
  file: File,
): Promise<ExtensionConversion> {
  await enforceRateLimit({ namespace: "extension-convert", identifier: actor.organizationId, limit: uploadIntentRateLimit(actor) });
  const plan = getPlanCatalog()[actor.planId];
  const maxBytes = marketplace === "mercado-livre-full" ? ZPL_MAX_BYTES : plan.maxFileMB * 1_024 * 1_024;
  if (file.size < 1) throw new AppError("invalid_request", "O arquivo está vazio.", 400);
  if (file.size > maxBytes) throw new AppError("file_too_large", "O arquivo excede o limite permitido pelo plano.", 413);

  if (marketplace === "mercado-livre-full") return { kind: "pdf", result: await convertZplSync(await file.text()) };

  const bytes = Buffer.from(await file.arrayBuffer());
  if (marketplace === "shopee") return { kind: "pdf", result: await convertShopeeSync([bytes]) };
  if (marketplace === "tiktok") return { kind: "pdf", result: await convertTikTokSync([bytes], []) };

  if (!hasPdfMagic(bytes)) throw new AppError("invalid_pdf", "O arquivo enviado não possui assinatura PDF válida.", 400);
  const staged = await stageUpload(actor, bytes, file.name || undefined);
  const dependencies = defaultMarketplaceCreationDependencies();
  const lote = await createMarketplaceLote(actor, {
    uploadIntentIds: [staged.id],
    marketplace: "mercado-livre",
    size: { preset: "100x150" },
  }, {
    ...dependencies,
    readUpload: async (intent, storage) => intent.id === staged.id ? staged.upload : dependencies.readUpload(intent, storage),
  });
  await staged.stored;
  return { kind: "lote", lote };
}
