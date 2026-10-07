import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";
import { errorResponse } from "@/server/http";
import { enforceRateLimit, type FixedWindowStore } from "@/server/rate-limit";
import type { StorageGateway, StoredObjectHead } from "@/server/storage";
import {
  createUploadIntent,
  readValidatedUpload,
  validateUpload,
  type UploadDependencies,
  type UploadIntentRecord,
} from "@/server/uploads";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const ORG_ID = "00000000-0000-4000-8000-000000000101";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const INTENT_ID = "00000000-0000-4000-8000-000000000501";
const OBJECT_ID = "00000000-0000-4000-8000-000000000502";
const PDF = Buffer.from("%PDF-1.7\nsynthetic upload fixture\n%%EOF", "ascii");

class MemoryStorage implements StorageGateway {
  bytes = PDF;
  headValue: StoredObjectHead = { contentLength: PDF.length, contentType: "application/pdf" };
  signedInput?: Parameters<StorageGateway["signUpload"]>[0];

  async signUpload(input: Parameters<StorageGateway["signUpload"]>[0]) {
    this.signedInput = input;
    return {
      url: "http://storage.test/private-signed-put",
      headers: {
        "content-type": input.contentType,
        "content-length": String(input.contentLength),
        ...(input.checksumSha256 ? { "x-amz-checksum-sha256": input.checksumSha256 } : {}),
      },
      expiresAt: new Date(NOW.getTime() + 300_000),
    };
  }

  async signDownload() {
    return { url: "http://storage.test/private-signed-get", expiresAt: new Date(NOW.getTime() + 300_000) };
  }

  async head() {
    return this.headValue;
  }

  async getRange(_key: string, maxBytes: number) {
    return this.bytes.subarray(0, maxBytes);
  }

  async read(_key: string, maxBytes: number) {
    if (this.bytes.length > maxBytes) throw new AppError("file_too_large", "too large", 413);
    return this.bytes;
  }

  async putBytes() {}
  async delete() {}
}

function intent(overrides: Partial<UploadIntentRecord> = {}): UploadIntentRecord {
  return {
    id: INTENT_ID,
    organizationId: ORG_ID,
    createdByUserId: USER_ID,
    objectKey: `organizations/${ORG_ID}/uploads/${OBJECT_ID}.pdf`,
    contentType: "application/pdf",
    contentLength: PDF.length,
    checksumSha256: null,
    originalFileName: "documento.pdf",
    expiresAt: new Date(NOW.getTime() + 300_000),
    consumedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof AppError ? error.code : undefined;
}

describe("private upload intents", () => {
  it("creates a private signed upload whose key never includes the display filename", async () => {
    const storage = new MemoryStorage();
    const inserted: Array<Record<string, unknown>> = [];
    const ids = [INTENT_ID, OBJECT_ID];
    const checksum = createHash("sha256").update(PDF).digest("hex");
    const dependencies: UploadDependencies = {
      storage,
      randomId: () => ids.shift()!,
      async enforceRateLimit(organizationId, limit) {
        expect(organizationId).toBe(ORG_ID);
        expect(limit).toBe(30);
      },
      async insertIntent(values, pendingLimit) {
        expect(pendingLimit).toBe(10);
        inserted.push(values);
      },
    };

    const result = await createUploadIntent(
      { organizationId: ORG_ID, userId: USER_ID, planId: "FREE" },
      {
        contentLength: PDF.length,
        contentType: "application/pdf",
        checksumSha256: checksum.toUpperCase(),
        originalFileName: " etiqueta 123.pdf ",
      },
      dependencies,
    );

    expect(result).toEqual({
      id: INTENT_ID,
      uploadUrl: "http://storage.test/private-signed-put",
      headers: {
        "content-type": "application/pdf",
        "content-length": String(PDF.length),
        "x-amz-checksum-sha256": Buffer.from(checksum, "hex").toString("base64"),
      },
      expiresAt: "2026-10-07T12:05:00.000Z",
    });
    expect(storage.signedInput?.key).toBe(`organizations/${ORG_ID}/uploads/${OBJECT_ID}.pdf`);
    expect(storage.signedInput?.key).not.toContain("etiqueta");
    expect(inserted[0]).toMatchObject({
      id: INTENT_ID,
      organizationId: ORG_ID,
      objectKey: `organizations/${ORG_ID}/uploads/${OBJECT_ID}.pdf`,
      checksumSha256: checksum,
      originalFileName: "etiqueta 123.pdf",
    });
  });

  it("rejects files above the actor plan before signing or writing", async () => {
    const storage = new MemoryStorage();
    let inserted = false;
    await expect(
      createUploadIntent(
        { organizationId: ORG_ID, userId: USER_ID, planId: "FREE" },
        { contentLength: 5 * 1_024 * 1_024 + 1, contentType: "application/pdf" },
        {
          storage,
          randomId: () => INTENT_ID,
          async enforceRateLimit() {},
          async insertIntent() { inserted = true; },
        },
      ),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "file_too_large");
    expect(storage.signedInput).toBeUndefined();
    expect(inserted).toBe(false);
  });

  it.each(["../secret.pdf", "folder/document.pdf", "bad\u0000name.pdf", ""])(
    "rejects unsafe display filename %j",
    async (originalFileName) => {
      const storage = new MemoryStorage();
      await expect(
        createUploadIntent(
          { organizationId: ORG_ID, userId: USER_ID, planId: "FREE" },
          { contentLength: PDF.length, contentType: "application/pdf", originalFileName },
          { storage, randomId: () => INTENT_ID, async enforceRateLimit() {}, async insertIntent() {} },
        ),
      ).rejects.toBeDefined();
      expect(storage.signedInput).toBeUndefined();
    },
  );

  it("blocks a rate-limited organization before signing or inserting", async () => {
    const storage = new MemoryStorage();
    let inserted = false;
    await expect(
      createUploadIntent(
        { organizationId: ORG_ID, userId: USER_ID, planId: "PRO" },
        { contentLength: PDF.length, contentType: "application/pdf" },
        {
          storage,
          randomId: () => INTENT_ID,
          async enforceRateLimit(_organizationId, limit) {
            expect(limit).toBe(60);
            throw new AppError("rate_limit_exceeded", "blocked", 429, { retryAfterSeconds: 17 });
          },
          async insertIntent() { inserted = true; },
        },
      ),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "rate_limit_exceeded");
    expect(storage.signedInput).toBeUndefined();
    expect(inserted).toBe(false);
  });

  it("never returns a signed URL when the atomic pending-intent cap rejects insertion", async () => {
    const storage = new MemoryStorage();
    await expect(
      createUploadIntent(
        { organizationId: ORG_ID, userId: USER_ID, planId: "STARTER" },
        { contentLength: PDF.length, contentType: "application/pdf" },
        {
          storage,
          randomId: () => INTENT_ID,
          async enforceRateLimit(_organizationId, limit) { expect(limit).toBe(30); },
          async insertIntent(_values, pendingLimit) {
            expect(pendingLimit).toBe(50);
            throw new AppError("pending_upload_limit_exceeded", "blocked", 429, { retryAfterSeconds: 60 });
          },
        },
      ),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "pending_upload_limit_exceeded");
    expect(storage.signedInput).toBeDefined();
  });

  it("validates the real size, media type, PDF magic, and checksum", async () => {
    const storage = new MemoryStorage();
    const checksum = createHash("sha256").update(PDF).digest("hex");
    const result = await readValidatedUpload(intent({ checksumSha256: checksum }), { storage, now: NOW });
    expect(result).toMatchObject({
      bytes: PDF,
      contentLength: PDF.length,
      contentType: "application/pdf",
      checksumSha256: checksum,
      originalFileName: "documento.pdf",
    });
  });

  it("rejects an object whose actual size differs from the signed intent", async () => {
    const storage = new MemoryStorage();
    storage.headValue.contentLength += 1;
    await expect(validateUpload(intent(), { storage, now: NOW })).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "invalid_upload",
    );
  });

  it("rejects an object whose stored media type is not PDF", async () => {
    const storage = new MemoryStorage();
    storage.headValue.contentType = "text/plain";
    await expect(validateUpload(intent(), { storage, now: NOW })).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "invalid_file_type",
    );
  });

  it("rejects content without PDF magic in the bounded leading range", async () => {
    const storage = new MemoryStorage();
    storage.bytes = Buffer.from("plain text with no signature", "ascii");
    storage.headValue.contentLength = storage.bytes.length;
    await expect(
      validateUpload(intent({ contentLength: storage.bytes.length }), { storage, now: NOW }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_pdf");
  });

  it("rejects a checksum mismatch after reading the bounded object", async () => {
    const storage = new MemoryStorage();
    await expect(
      readValidatedUpload(intent({ checksumSha256: "0".repeat(64) }), { storage, now: NOW }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "checksum_mismatch");
  });

  it("rejects expired and already consumed intents before touching storage", async () => {
    const storage = new MemoryStorage();
    await expect(
      validateUpload(intent({ expiresAt: NOW }), { storage, now: NOW }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "upload_expired");
    await expect(
      validateUpload(intent({ consumedAt: NOW }), { storage, now: NOW }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "upload_consumed");
  });
});

describe("distributed upload rate limit", () => {
  it("uses a fixed window and reports the remaining wait on overflow", async () => {
    const values = new Map<string, number>();
    const expirations = new Map<string, number>();
    const store: FixedWindowStore = {
      async increment(key, expiresAtUnixSeconds) {
        expirations.set(key, expiresAtUnixSeconds);
        const value = (values.get(key) ?? 0) + 1;
        values.set(key, value);
        return value;
      },
    };
    const input = {
      namespace: "upload-intent",
      identifier: ORG_ID,
      limit: 2,
      windowSeconds: 60,
      now: new Date("2026-10-07T12:00:43.000Z"),
    };
    await enforceRateLimit(input, store);
    await enforceRateLimit(input, store);
    await expect(enforceRateLimit(input, store)).rejects.toMatchObject({
      code: "rate_limit_exceeded",
      status: 429,
      details: { retryAfterSeconds: 17 },
    });
    expect([...expirations.values()]).toEqual([1_791_374_460]);

    await expect(
      enforceRateLimit({ ...input, now: new Date("2026-10-07T12:01:00.000Z") }, store),
    ).resolves.toBeUndefined();
    expect(values.size).toBe(2);
  });

  it("maps retry metadata to the HTTP Retry-After header", async () => {
    const response = errorResponse(
      new AppError("rate_limit_exceeded", "Muitas solicitações.", 429, { retryAfterSeconds: 17 }),
      "req_upload_test",
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    await expect(response.json()).resolves.toMatchObject({
      requestId: "req_upload_test",
      error: { code: "rate_limit_exceeded", details: { retryAfterSeconds: 17 } },
    });
  });
});
