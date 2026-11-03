import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { AppError } from "@/lib/errors";
import { getPlanCatalog } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";
import { createMarketplaceLote, type AcceptedLote } from "@/server/marketplace/create";
import { convertShopeeSync, convertTikTokSync, convertZplSync, type SyncResult, ZPL_MAX_BYTES } from "@/server/marketplace/sync";
import { enforceRateLimit } from "@/server/rate-limit";
import { getStorage } from "@/server/storage";
import { insertUploadIntentWithPendingLimit, pendingUploadLimit, uploadIntentRateLimit } from "@/server/uploads";

export const extensionMarketplaceSchema = z.enum(["mercado-livre", "mercado-livre-full", "shopee", "tiktok"]);
export type ExtensionMarketplace = z.infer<typeof extensionMarketplaceSchema>;

export type ExtensionConversion =
  | { kind: "pdf"; result: SyncResult }
  | { kind: "lote"; lote: AcceptedLote };

const INTENT_TTL_MS = 5 * 60_000;

/**
 * Stages bytes the server already holds as an upload intent, so the Mercado
 * Livre lote goes through exactly the same `createMarketplaceLote` path (split,
 * snapshot, quota, outbox) as the dashboard's presigned upload.
 */
async function stageUpload(actor: Pick<Actor, "organizationId" | "userId" | "planId">, bytes: Uint8Array, fileName: string | undefined): Promise<string> {
  const id = randomUUID();
  const objectKey = `organizations/${actor.organizationId}/uploads/${randomUUID()}.pdf`;
  await getStorage().putBytes(objectKey, Buffer.from(bytes), "application/pdf", bytes.length);
  await insertUploadIntentWithPendingLimit({
    id,
    organizationId: actor.organizationId,
    createdByUserId: actor.userId,
    objectKey,
    contentType: "application/pdf",
    contentLength: bytes.length,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    originalFileName: fileName?.slice(0, 255),
    expiresAt: new Date(Date.now() + INTENT_TTL_MS),
  }, pendingUploadLimit(actor));
  return id;
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

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (marketplace === "shopee") return { kind: "pdf", result: await convertShopeeSync([bytes]) };
  if (marketplace === "tiktok") return { kind: "pdf", result: await convertTikTokSync([bytes], []) };

  const uploadIntentId = await stageUpload(actor, bytes, file.name || undefined);
  const lote = await createMarketplaceLote(actor, {
    uploadIntentIds: [uploadIntentId],
    marketplace: "mercado-livre",
    size: { preset: "100x150" },
  });
  return { kind: "lote", lote };
}
