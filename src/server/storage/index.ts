import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";

import { AppError } from "@/lib/errors";

export const MAX_SIGNED_URL_SECONDS = 300;

export type StoredObjectHead = {
  contentLength: number;
  contentType?: string;
  checksumSha256?: string;
};

export type SignedUploadRequest = {
  key: string;
  contentLength: number;
  contentType: string;
  checksumSha256?: string;
  expiresInSeconds?: number;
};

export type SignedUpload = {
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
};

export interface StorageGateway {
  signUpload(input: SignedUploadRequest): Promise<SignedUpload>;
  signDownload(key: string, expiresInSeconds?: number): Promise<{ url: string; expiresAt: Date }>;
  head(key: string): Promise<StoredObjectHead>;
  getRange(key: string, maxBytes: number): Promise<Buffer>;
  read(key: string, maxBytes: number): Promise<Buffer>;
  putBytes(key: string, bytes: Buffer, contentType: string, maxBytes: number): Promise<void>;
  delete(key: string, abortSignal?: AbortSignal): Promise<void>;
  openReadStream(key: string, abortSignal?: AbortSignal): Promise<Readable>;
  beginMultipartUpload(key: string, contentType: string, abortSignal?: AbortSignal): Promise<string>;
  uploadPart(key: string, uploadId: string, partNumber: number, bytes: Buffer, abortSignal?: AbortSignal): Promise<string>;
  completeMultipartUpload(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>, abortSignal?: AbortSignal): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string, abortSignal?: AbortSignal): Promise<void>;
}

type StorageState = { client?: S3Client; gateway?: StorageGateway };
const globalStorage = globalThis as typeof globalThis & { __unoStorage?: StorageState };
const state = globalStorage.__unoStorage ?? {};
if (process.env.NODE_ENV !== "production") globalStorage.__unoStorage = state;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  return value;
}

function bucket(): string {
  return required("S3_BUCKET");
}

function client(): S3Client {
  if (state.client) return state.client;
  const endpoint = required("S3_ENDPOINT");
  state.client = new S3Client({
    endpoint,
    region: required("S3_REGION"),
    credentials: {
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    },
    // Path-style keeps signed URLs on the endpoint host itself, which is the origin the
    // Content-Security-Policy allows. R2 and MinIO both accept it; opt out with "false".
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return state.client;
}

function expiration(seconds = MAX_SIGNED_URL_SECONDS): { seconds: number; expiresAt: Date } {
  const bounded = Math.min(MAX_SIGNED_URL_SECONDS, Math.max(1, Math.trunc(seconds)));
  return { seconds: bounded, expiresAt: new Date(Date.now() + bounded * 1_000) };
}

function storageError(error: unknown): AppError {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (candidate?.name === "NoSuchKey" || candidate?.name === "NotFound" || candidate?.$metadata?.httpStatusCode === 404) {
    return new AppError("upload_not_found", "Upload não encontrado.", 404);
  }
  if (error instanceof AppError) return error;
  return new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
}

async function bodyToBuffer(body: unknown, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new AppError("invalid_upload", "Upload inválido.", 400);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  if (!body || !(Symbol.asyncIterator in Object(body))) {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
  for await (const rawChunk of body as AsyncIterable<Uint8Array | string>) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    length += chunk.length;
    if (length > maxBytes) throw new AppError("file_too_large", "O arquivo excede o limite permitido.", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

class S3StorageGateway implements StorageGateway {
  async signUpload(input: SignedUploadRequest): Promise<SignedUpload> {
    const { seconds, expiresAt } = expiration(input.expiresInSeconds);
    const headers: Record<string, string> = {
      "content-type": input.contentType,
      "content-length": String(input.contentLength),
    };
    if (input.checksumSha256) headers["x-amz-checksum-sha256"] = input.checksumSha256;
    try {
      const url = await getSignedUrl(
        client(),
        new PutObjectCommand({
          Bucket: bucket(),
          Key: input.key,
          ContentType: input.contentType,
          ContentLength: input.contentLength,
          ChecksumSHA256: input.checksumSha256,
        }),
        // Keep the checksum as a signed header: R2 rejects it when hoisted into the query string.
        { expiresIn: seconds, unhoistableHeaders: new Set(["x-amz-checksum-sha256"]) },
      );
      return { url, headers, expiresAt };
    } catch (error) {
      throw storageError(error);
    }
  }

  async signDownload(key: string, expiresInSeconds?: number): Promise<{ url: string; expiresAt: Date }> {
    const { seconds, expiresAt } = expiration(expiresInSeconds);
    try {
      const url = await getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn: seconds });
      return { url, expiresAt };
    } catch (error) {
      throw storageError(error);
    }
  }

  async head(key: string): Promise<StoredObjectHead> {
    try {
      const output = await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
      if (output.ContentLength === undefined) throw new AppError("invalid_upload", "Upload inválido.", 400);
      return {
        contentLength: output.ContentLength,
        contentType: output.ContentType,
        checksumSha256: output.ChecksumSHA256,
      };
    } catch (error) {
      throw storageError(error);
    }
  }

  async getRange(key: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new AppError("invalid_upload", "Upload inválido.", 400);
    try {
      const output = await client().send(
        new GetObjectCommand({ Bucket: bucket(), Key: key, Range: `bytes=0-${maxBytes - 1}` }),
      );
      return await bodyToBuffer(output.Body, maxBytes);
    } catch (error) {
      throw storageError(error);
    }
  }

  async read(key: string, maxBytes: number): Promise<Buffer> {
    try {
      const output = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
      if (output.ContentLength !== undefined && output.ContentLength > maxBytes) {
        throw new AppError("file_too_large", "O arquivo excede o limite permitido.", 413);
      }
      return await bodyToBuffer(output.Body, maxBytes);
    } catch (error) {
      throw storageError(error);
    }
  }

  async putBytes(key: string, bytes: Buffer, contentType: string, maxBytes: number): Promise<void> {
    if (bytes.length > maxBytes) throw new AppError("file_too_large", "O arquivo excede o limite permitido.", 413);
    try {
      await client().send(
        new PutObjectCommand({ Bucket: bucket(), Key: key, Body: bytes, ContentLength: bytes.length, ContentType: contentType }),
      );
    } catch (error) {
      throw storageError(error);
    }
  }

  async delete(key: string, abortSignal?: AbortSignal): Promise<void> {
    try {
      await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }), { abortSignal });
    } catch (error) {
      throw storageError(error);
    }
  }

  async openReadStream(key: string, abortSignal?: AbortSignal): Promise<Readable> {
    try {
      const output = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }), { abortSignal });
      if (!output.Body || !(Symbol.asyncIterator in Object(output.Body))) {
        throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
      }
      return Readable.from(output.Body as AsyncIterable<Uint8Array>);
    } catch (error) {
      throw storageError(error);
    }
  }

  async beginMultipartUpload(key: string, contentType: string, abortSignal?: AbortSignal): Promise<string> {
    try {
      const output = await client().send(new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), { abortSignal });
      if (!output.UploadId) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
      return output.UploadId;
    } catch (error) {
      throw storageError(error);
    }
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, bytes: Buffer, abortSignal?: AbortSignal): Promise<string> {
    try {
      const output = await client().send(new UploadPartCommand({
        Bucket: bucket(), Key: key, UploadId: uploadId, PartNumber: partNumber, Body: bytes, ContentLength: bytes.length,
      }), { abortSignal });
      if (!output.ETag) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
      return output.ETag;
    } catch (error) {
      throw storageError(error);
    }
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>, abortSignal?: AbortSignal): Promise<void> {
    try {
      await client().send(new CompleteMultipartUploadCommand({
        Bucket: bucket(), Key: key, UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
      }), { abortSignal });
    } catch (error) {
      throw storageError(error);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string, abortSignal?: AbortSignal): Promise<void> {
    try {
      await client().send(new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }), { abortSignal });
    } catch (error) {
      throw storageError(error);
    }
  }
}

export function getStorage(): StorageGateway {
  state.gateway ??= new S3StorageGateway();
  return state.gateway;
}

export const signPrivateUpload = (input: SignedUploadRequest) => getStorage().signUpload(input);
export const signPrivateDownload = (key: string, expiresInSeconds?: number) => getStorage().signDownload(key, expiresInSeconds);
export const headPrivateObject = (key: string) => getStorage().head(key);
export const getPrivateObjectRange = (key: string, maxBytes: number) => getStorage().getRange(key, maxBytes);
export const readPrivateObject = (key: string, maxBytes: number) => getStorage().read(key, maxBytes);
export const putPrivateBytes = (key: string, bytes: Buffer, contentType: string, maxBytes: number) =>
  getStorage().putBytes(key, bytes, contentType, maxBytes);
export const deletePrivateObject = (key: string) => getStorage().delete(key);
