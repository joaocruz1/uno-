import { createHash, randomUUID } from "node:crypto";

import { and, count, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, uploadIntents, type UnoDatabase } from "@/db";
import { AppError } from "@/lib/errors";
import { PLANS } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";
import { enforceRateLimit } from "@/server/rate-limit";
import { getStorage, type StorageGateway } from "@/server/storage";

const PDF_CONTENT_TYPE = "application/pdf";
const PDF_MAGIC_SCAN_BYTES = 1_024;
const MAX_UPLOAD_BYTES = PLANS.BUSINESS.maxFileMB * 1_024 * 1_024;

export const uploadIntentInputSchema = z
  .object({
    contentLength: z.number().int().positive(),
    contentType: z.literal(PDF_CONTENT_TYPE),
    checksumSha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .transform((value) => value.toLowerCase())
      .optional(),
    originalFileName: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine((value) => !/[\x00-\x1f\x7f/\\]/u.test(value))
      .optional(),
  })
  .strict();

export type UploadIntentInput = z.infer<typeof uploadIntentInputSchema>;
export type UploadIntentRecord = typeof uploadIntents.$inferSelect;

export type UploadIntentResponse = {
  id: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export type ValidatedUpload = {
  contentLength: number;
  contentType: typeof PDF_CONTENT_TYPE;
  checksumSha256?: string;
  originalFileName?: string;
};

export type ReadValidatedUpload = ValidatedUpload & {
  bytes: Buffer;
  checksumSha256: string;
};

type UploadIntentInsert = Pick<
  typeof uploadIntents.$inferInsert,
  | "id"
  | "organizationId"
  | "createdByUserId"
  | "objectKey"
  | "contentType"
  | "contentLength"
  | "checksumSha256"
  | "originalFileName"
  | "expiresAt"
>;

export type UploadDependencies = {
  storage: StorageGateway;
  enforceRateLimit(organizationId: string, limit: number): Promise<void>;
  insertIntent(values: UploadIntentInsert, pendingLimit: number): Promise<void>;
  randomId(): string;
};

function defaultDependencies(): UploadDependencies {
  return {
    storage: getStorage(),
    randomId: randomUUID,
    async enforceRateLimit(organizationId, limit) {
      await enforceRateLimit({ namespace: "upload-intent", identifier: organizationId, limit });
    },
    async insertIntent(values, pendingLimit) {
      await insertUploadIntentWithPendingLimit(values, pendingLimit);
    },
  };
}

export async function insertUploadIntentWithPendingLimit(
  values: UploadIntentInsert,
  pendingLimit: number,
  database: Pick<UnoDatabase, "transaction"> = getDb(),
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${values.organizationId}, 0))`,
    );
    const rows = await transaction
      .select({ value: count() })
      .from(uploadIntents)
      .where(
        and(
          eq(uploadIntents.organizationId, values.organizationId),
          isNull(uploadIntents.consumedAt),
          sql`${uploadIntents.expiresAt} > now()`,
        ),
      );
    if ((rows[0]?.value ?? 0) >= pendingLimit) {
      throw new AppError(
        "pending_upload_limit_exceeded",
        "Há muitos uploads pendentes. Aguarde antes de tentar novamente.",
        429,
        { retryAfterSeconds: 60 },
      );
    }
    await transaction.insert(uploadIntents).values(values);
  });
}

function sha256Base64(checksumHex: string): string {
  return Buffer.from(checksumHex, "hex").toString("base64");
}

export function maxUploadBytes(actor: Pick<Actor, "planId">): number {
  return PLANS[actor.planId].maxFileMB * 1_024 * 1_024;
}

export function uploadIntentRateLimit(actor: Pick<Actor, "planId">): number {
  return PLANS[actor.planId].rateLimit || 30;
}

export function pendingUploadLimit(actor: Pick<Actor, "planId">): number {
  return Math.max(10, PLANS[actor.planId].batchLimit);
}

export async function createUploadIntent(
  actor: Pick<Actor, "organizationId" | "userId" | "planId">,
  rawInput: unknown,
  dependencies: UploadDependencies = defaultDependencies(),
): Promise<UploadIntentResponse> {
  const input = uploadIntentInputSchema.parse(rawInput);
  if (input.contentLength > maxUploadBytes(actor)) {
    throw new AppError("file_too_large", "O arquivo excede o limite permitido pelo plano.", 413);
  }
  await dependencies.enforceRateLimit(actor.organizationId, uploadIntentRateLimit(actor));

  const id = dependencies.randomId();
  const objectId = dependencies.randomId();
  const objectKey = `organizations/${actor.organizationId}/uploads/${objectId}.pdf`;
  const signed = await dependencies.storage.signUpload({
    key: objectKey,
    contentLength: input.contentLength,
    contentType: input.contentType,
    checksumSha256: input.checksumSha256 ? sha256Base64(input.checksumSha256) : undefined,
    expiresInSeconds: 300,
  });

  await dependencies.insertIntent(
    {
      id,
      organizationId: actor.organizationId,
      createdByUserId: actor.userId,
      objectKey,
      contentType: input.contentType,
      contentLength: input.contentLength,
      checksumSha256: input.checksumSha256,
      originalFileName: input.originalFileName,
      expiresAt: signed.expiresAt,
    },
    pendingUploadLimit(actor),
  );

  return {
    id,
    uploadUrl: signed.url,
    headers: signed.headers,
    expiresAt: signed.expiresAt.toISOString(),
  };
}

function assertUsable(intent: UploadIntentRecord, now: Date): void {
  if (intent.consumedAt) throw new AppError("upload_consumed", "Este upload já foi utilizado.", 409);
  if (intent.expiresAt.getTime() <= now.getTime()) {
    throw new AppError("upload_expired", "Este upload expirou.", 410);
  }
  if (intent.contentLength < 1 || intent.contentLength > MAX_UPLOAD_BYTES) {
    throw new AppError("invalid_upload", "Upload inválido.", 400);
  }
}

function hasPdfMagic(bytes: Buffer): boolean {
  return bytes.subarray(0, PDF_MAGIC_SCAN_BYTES).includes(Buffer.from("%PDF-", "ascii"));
}

function normalizedMediaType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

async function inspectHead(intent: UploadIntentRecord, storage: StorageGateway): Promise<void> {
  const head = await storage.head(intent.objectKey);
  if (head.contentLength !== intent.contentLength) {
    throw new AppError("invalid_upload", "O tamanho enviado não corresponde à intenção.", 400);
  }
  if (normalizedMediaType(head.contentType) !== PDF_CONTENT_TYPE) {
    throw new AppError("invalid_file_type", "O arquivo enviado não é um PDF.", 415);
  }
}

function assertChecksum(bytes: Buffer, expected?: string): string {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (expected && actual !== expected) {
    throw new AppError("checksum_mismatch", "A integridade do upload não pôde ser confirmada.", 400);
  }
  return actual;
}

export async function validateUpload(
  intent: UploadIntentRecord,
  options: { storage?: StorageGateway; now?: Date } = {},
): Promise<ValidatedUpload> {
  const storage = options.storage ?? getStorage();
  assertUsable(intent, options.now ?? new Date());
  await inspectHead(intent, storage);
  const leadingBytes = await storage.getRange(intent.objectKey, Math.min(PDF_MAGIC_SCAN_BYTES, intent.contentLength));
  if (!hasPdfMagic(leadingBytes)) throw new AppError("invalid_pdf", "O arquivo enviado não possui assinatura PDF válida.", 400);
  if (intent.checksumSha256) {
    const bytes = await storage.read(intent.objectKey, intent.contentLength);
    assertChecksum(bytes, intent.checksumSha256);
  }
  return {
    contentLength: intent.contentLength,
    contentType: PDF_CONTENT_TYPE,
    checksumSha256: intent.checksumSha256 ?? undefined,
    originalFileName: intent.originalFileName ?? undefined,
  };
}

/**
 * Reads and validates the upload without marking the intent as consumed.
 * Phase 6 must copy these bytes to a new immutable key and consume the intent
 * in the same transaction that reserves quota and creates the conversion.
 */
export async function readValidatedUpload(
  intent: UploadIntentRecord,
  options: { storage?: StorageGateway; now?: Date } = {},
): Promise<ReadValidatedUpload> {
  const storage = options.storage ?? getStorage();
  assertUsable(intent, options.now ?? new Date());
  await inspectHead(intent, storage);
  const bytes = await storage.read(intent.objectKey, intent.contentLength);
  if (bytes.length !== intent.contentLength) throw new AppError("invalid_upload", "Upload incompleto.", 400);
  if (!hasPdfMagic(bytes)) throw new AppError("invalid_pdf", "O arquivo enviado não possui assinatura PDF válida.", 400);
  const checksumSha256 = assertChecksum(bytes, intent.checksumSha256 ?? undefined);
  return {
    bytes,
    contentLength: intent.contentLength,
    contentType: PDF_CONTENT_TYPE,
    checksumSha256,
    originalFileName: intent.originalFileName ?? undefined,
  };
}

export async function findUploadIntentForOrganization(
  organizationId: string,
  intentId: string,
  database: Pick<UnoDatabase, "select"> = getDb(),
): Promise<UploadIntentRecord> {
  const rows = await database
    .select()
    .from(uploadIntents)
    .where(and(eq(uploadIntents.organizationId, organizationId), eq(uploadIntents.id, intentId)))
    .limit(1);
  const intent = rows[0];
  if (!intent) {
    throw new AppError("upload_not_found", "Upload não encontrado.", 404);
  }
  return intent;
}
