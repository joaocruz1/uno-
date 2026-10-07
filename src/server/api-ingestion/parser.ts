import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import Busboy from "busboy";
import { and, eq } from "drizzle-orm";

import { apiRequestUploads, getDb, type UnoDatabase } from "@/db";
import { positiveIntegerEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { getStorage, type StorageGateway } from "@/server/storage";

const PART_BYTES = 8 * 1_024 * 1_024;
const MAGIC_SCAN_BYTES = 1_024;
const MAX_FIELDS = 8;

export type PreparedApiUpload = {
  trackingId: string;
  ordinal: number;
  objectKey: string;
  originalFileName: string;
  contentLength: number;
  checksumSha256: string;
};

export type ParsedApiMultipart = {
  fields: Record<string, string>;
  files: PreparedApiUpload[];
};

export type ParserDependencies = {
  database: UnoDatabase;
  storage: StorageGateway;
  randomId(): string;
  now(): Date;
};

function defaults(): ParserDependencies {
  return { database: getDb(), storage: getStorage(), randomId: randomUUID, now: () => new Date() };
}

function safeFileName(value: string): string {
  const name = value.normalize("NFC").trim();
  if (!name || name.length > 160 || /[\x00-\x1f\x7f/\\]/u.test(name)) {
    throw new AppError("invalid_request", "Nome de arquivo inválido.", 400);
  }
  return name;
}

function hasPdfMagic(bytes: Buffer): boolean {
  return bytes.subarray(0, MAGIC_SCAN_BYTES).includes(Buffer.from("%PDF-", "ascii"));
}

async function uploadFile(
  stream: Readable & { truncated?: boolean },
  info: { filename: string; mimeType: string },
  context: {
    organizationId: string;
    apiRequestId: string;
    attempt: number;
    ordinal: number;
    maxFileBytes: number;
    signal: AbortSignal;
    capacity?: { addBytes(bytes: number): Promise<void> };
  },
  dependencies: ParserDependencies,
): Promise<PreparedApiUpload> {
  const originalFileName = safeFileName(info.filename);
  if (info.mimeType.split(";", 1)[0]?.trim().toLowerCase() !== "application/pdf") {
    stream.resume();
    throw new AppError("invalid_file_type", "O arquivo enviado não é um PDF.", 415);
  }
  const trackingId = dependencies.randomId();
  const objectKey = `organizations/${context.organizationId}/api-staging/${dependencies.randomId()}.pdf`;
  const cleanupAfter = new Date(dependencies.now().getTime() + 24 * 60 * 60_000);
  await dependencies.database.insert(apiRequestUploads).values({
    id: trackingId,
    organizationId: context.organizationId,
    apiRequestId: context.apiRequestId,
    attempt: context.attempt,
    ordinal: context.ordinal,
    objectKey,
    originalFileName,
    contentType: "application/pdf",
    cleanupAfter,
  });

  let uploadId: string | undefined;
  let completed = false;
  try {
    uploadId = await dependencies.storage.beginMultipartUpload(objectKey, "application/pdf", context.signal);
    await dependencies.database.update(apiRequestUploads).set({ multipartUploadId: uploadId, updatedAt: dependencies.now() })
      .where(eq(apiRequestUploads.id, trackingId));
    const hash = createHash("sha256");
    const leading: Buffer[] = [];
    let leadingLength = 0;
    let length = 0;
    let partNumber = 1;
    let partBuffer = Buffer.allocUnsafe(PART_BYTES);
    let partOffset = 0;
    const parts: Array<{ partNumber: number; etag: string }> = [];

    for await (const raw of stream) {
      if (context.signal.aborted) throw new AppError("request_aborted", "A transferência foi interrompida.", 499);
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      await context.capacity?.addBytes(chunk.length);
      length += chunk.length;
      if (length > context.maxFileBytes) throw new AppError("file_too_large", "O arquivo excede o limite permitido pelo plano.", 413);
      hash.update(chunk);
      if (leadingLength < MAGIC_SCAN_BYTES) {
        const slice = chunk.subarray(0, Math.min(chunk.length, MAGIC_SCAN_BYTES - leadingLength));
        leading.push(Buffer.from(slice));
        leadingLength += slice.length;
      }
      let offset = 0;
      while (offset < chunk.length) {
        const copied = chunk.copy(partBuffer, partOffset, offset, Math.min(chunk.length, offset + PART_BYTES - partOffset));
        partOffset += copied;
        offset += copied;
        if (partOffset === PART_BYTES) {
          const etag = await dependencies.storage.uploadPart(objectKey, uploadId, partNumber, partBuffer, context.signal);
          parts.push({ partNumber, etag });
          partNumber += 1;
          partBuffer = Buffer.allocUnsafe(PART_BYTES);
          partOffset = 0;
        }
      }
    }
    if (stream.truncated || length < 1) throw new AppError(stream.truncated ? "file_too_large" : "invalid_pdf", stream.truncated ? "O arquivo excede o limite permitido pelo plano." : "O arquivo PDF está vazio.", stream.truncated ? 413 : 422);
    if (!hasPdfMagic(Buffer.concat(leading, leadingLength))) throw new AppError("invalid_pdf", "O arquivo enviado não possui assinatura PDF válida.", 422);
    if (partOffset > 0) {
      const etag = await dependencies.storage.uploadPart(objectKey, uploadId, partNumber, partBuffer.subarray(0, partOffset), context.signal);
      parts.push({ partNumber, etag });
    }
    await dependencies.storage.completeMultipartUpload(objectKey, uploadId, parts, context.signal);
    completed = true;
    const checksumSha256 = hash.digest("hex");
    await dependencies.database.update(apiRequestUploads).set({
      status: "READY",
      contentLength: length,
      checksumSha256,
      updatedAt: dependencies.now(),
    }).where(eq(apiRequestUploads.id, trackingId));
    return { trackingId, ordinal: context.ordinal, objectKey, originalFileName, contentLength: length, checksumSha256 };
  } catch (error) {
    if (uploadId && !completed) await dependencies.storage.abortMultipartUpload(objectKey, uploadId, context.signal).catch(() => undefined);
    if (completed) await dependencies.storage.delete(objectKey, context.signal).catch(() => undefined);
    await dependencies.database.update(apiRequestUploads).set({ status: "ABORTED", updatedAt: dependencies.now() })
      .where(eq(apiRequestUploads.id, trackingId)).catch(() => undefined);
    throw error;
  }
}

export async function cleanupPreparedUploads(
  organizationId: string,
  apiRequestId: string,
  attempt: number,
  dependencies: Pick<ParserDependencies, "database" | "storage" | "now"> = defaults(),
): Promise<void> {
  const rows = await dependencies.database.select().from(apiRequestUploads).where(and(
    eq(apiRequestUploads.organizationId, organizationId),
    eq(apiRequestUploads.apiRequestId, apiRequestId),
    eq(apiRequestUploads.attempt, attempt),
  ));
  for (const row of rows) {
    if (row.status === "COMMITTED") continue;
    if (row.multipartUploadId && row.status === "PREPARING") {
      await dependencies.storage.abortMultipartUpload(row.objectKey, row.multipartUploadId).catch(() => undefined);
    }
    await dependencies.storage.delete(row.objectKey).catch(() => undefined);
    await dependencies.database.update(apiRequestUploads).set({ status: "ABORTED", updatedAt: dependencies.now() })
      .where(eq(apiRequestUploads.id, row.id));
  }
}

export async function parseApiMultipart(
  request: Request,
  input: {
    organizationId: string;
    apiRequestId: string;
    attempt: number;
    expectedFileField: "file" | "files";
    maxFiles: number;
    maxFileBytes: number;
    capacity?: { addBytes(bytes: number): Promise<void> };
  },
  dependencies: ParserDependencies = defaults(),
): Promise<ParsedApiMultipart> {
  if (!request.body) throw new AppError("invalid_request", "Corpo multipart ausente.", 400);
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) throw new AppError("invalid_request", "Content-Type multipart inválido.", 400);
  const controller = new AbortController();
  let source: Readable | undefined;
  let parser: ReturnType<typeof Busboy> | undefined;
  const activeStreams = new Set<Readable>();
  const abort = () => {
    controller.abort();
    for (const stream of activeStreams) stream.destroy();
    source?.destroy();
    parser?.destroy();
  };
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, positiveIntegerEnv("UNO_API_UPLOAD_DEADLINE_MS", 30 * 60_000));
  timer.unref();
  const fields: Record<string, string> = {};
  const files: PreparedApiUpload[] = [];
  const allowedFields = new Set(["template", "size", "widthMm", "heightMm", "quantity", "productTitle", "sku", "variation"]);
  let ordinal = 0;
  let terminalError: unknown;
  let chain = Promise.resolve();
  const fileTasks: Promise<void>[] = [];

  try {
    const currentParser = Busboy({
      headers: { "content-type": contentType },
      limits: { files: input.maxFiles, fileSize: input.maxFileBytes, fields: MAX_FIELDS, fieldSize: 512, parts: input.maxFiles + MAX_FIELDS },
    });
    parser = currentParser;
    currentParser.on("field", (name, value, info) => {
      if (info.nameTruncated || info.valueTruncated || !allowedFields.has(name) || Object.hasOwn(fields, name)) {
        terminalError ??= new AppError("invalid_request", "Campos multipart inválidos.", 400);
        return;
      }
      fields[name] = value;
    });
    currentParser.on("file", (name, stream, info) => {
      const current = ordinal++;
      activeStreams.add(stream);
      stream.pause();
      const task = chain.then(async () => {
        if (terminalError) { stream.resume(); return; }
        if (name !== input.expectedFileField) {
          stream.resume();
          throw new AppError("invalid_request", "Campo de arquivo inválido.", 400);
        }
        files.push(await uploadFile(stream, info, { ...input, ordinal: current, signal: controller.signal }, dependencies));
      }).finally(() => activeStreams.delete(stream));
      chain = task.catch((error) => { terminalError ??= error; });
      fileTasks.push(task);
    });
    currentParser.on("filesLimit", () => { terminalError ??= new AppError("batch_limit_exceeded", "A quantidade de arquivos excede o limite do plano.", 413); });
    currentParser.on("fieldsLimit", () => { terminalError ??= new AppError("invalid_request", "Há campos multipart em excesso.", 400); });
    currentParser.on("partsLimit", () => { terminalError ??= new AppError("invalid_request", "Há partes multipart em excesso.", 400); });
    const finished = new Promise<void>((resolve, reject) => {
      currentParser.once("close", resolve);
      currentParser.once("error", reject);
    });
    source = Readable.fromWeb(request.body as never);
    source.once("error", (error) => {
      terminalError ??= error;
      parser?.destroy();
    });
    if (request.signal.aborted) abort();
    source.pipe(currentParser);
    await finished;
    await Promise.allSettled(fileTasks);
    if (controller.signal.aborted) throw new AppError("request_aborted", "A transferência foi interrompida.", 499);
    if (terminalError) throw terminalError;
    if (files.length < 1 || (input.expectedFileField === "file" && files.length !== 1)) {
      throw new AppError("invalid_request", "Envie exatamente o número esperado de arquivos PDF.", 400);
    }
    files.sort((left, right) => left.ordinal - right.ordinal);
    return { fields, files };
  } catch (error) {
    await cleanupPreparedUploads(input.organizationId, input.apiRequestId, input.attempt, dependencies);
    if (error instanceof AppError) throw error;
    throw new AppError("invalid_request", "Corpo multipart inválido.", 400);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}
