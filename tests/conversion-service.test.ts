import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

import type { StorageGateway } from "@/server/storage";
import { conversionJobId } from "@/server/queue/conversion-queue";
import { createConversionFromUpload, type CreationDependencies } from "@/server/conversions/create";
import {
  assertEngineResultMatchesClaim,
  assertProcessingClaimSupported,
  type ClaimRow,
} from "@/server/conversions/processor";
import { assertTemplateEligible } from "@/server/conversions/templates";
import type { ConversionResult } from "@/engine/types";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000101";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const INTENT_ID = "00000000-0000-4000-8000-000000000201";
const PDF_BYTES = Buffer.from("%PDF-synthetic-only");

function storage() {
  const objects = new Map<string, Buffer>();
  const gateway: StorageGateway = {
    signUpload: vi.fn(),
    signDownload: vi.fn(),
    head: vi.fn(),
    getRange: vi.fn(),
    read: vi.fn(async (key) => objects.get(key) ?? Buffer.alloc(0)),
    putBytes: vi.fn(async (key, bytes) => { objects.set(key, Buffer.from(bytes)); }),
    delete: vi.fn(async (key) => { objects.delete(key); }),
    openReadStream: vi.fn(async (key) => Readable.from([objects.get(key) ?? Buffer.alloc(0)])),
    beginMultipartUpload: vi.fn(async () => "upload-id"),
    uploadPart: vi.fn(async () => "etag"),
    completeMultipartUpload: vi.fn(async () => undefined),
    abortMultipartUpload: vi.fn(async () => undefined),
  };
  return { gateway, objects };
}

function dependencies(overrides: Partial<CreationDependencies> = {}) {
  const stored = storage();
  const ids = [
    "00000000-0000-4000-8000-000000000301",
    "00000000-0000-4000-8000-000000000302",
    "00000000-0000-4000-8000-000000000303",
    "00000000-0000-4000-8000-000000000304",
  ];
  const dependency: CreationDependencies = {
    storage: stored.gateway,
    randomId: () => ids.shift()!,
    now: () => new Date("2026-10-07T12:00:00.000Z"),
    loadIntent: vi.fn(async () => ({
      id: INTENT_ID,
      organizationId: ORGANIZATION_ID,
      createdByUserId: USER_ID,
      objectKey: "organizations/test/uploads/synthetic.pdf",
      contentType: "application/pdf" as const,
      contentLength: PDF_BYTES.length,
      checksumSha256: null,
      originalFileName: "synthetic.pdf",
      expiresAt: new Date("2026-10-07T12:05:00.000Z"),
      consumedAt: null,
      createdAt: new Date("2026-10-07T11:59:00.000Z"),
    })),
    readUpload: vi.fn(async () => ({
      bytes: PDF_BYTES,
      contentLength: PDF_BYTES.length,
      contentType: "application/pdf" as const,
      checksumSha256: "a".repeat(64),
      originalFileName: "synthetic.pdf",
    })),
    commit: vi.fn(async (input) => ({ createdAt: input.now, outboxId: input.outboxId })),
    recoverCommitted: vi.fn(async () => null),
    publish: vi.fn(async () => undefined),
    ...overrides,
  };
  return { dependency, stored };
}

const request = {
  uploadIntentId: INTENT_ID,
  template: "mercado-livre@1.0.0",
  size: { preset: "custom", widthMm: 100, heightMm: 250 },
} as const;

describe("conversion creation service", () => {
  it("keeps the committed snapshot and returns accepted when immediate queue publication fails", async () => {
    const { dependency, stored } = dependencies({ publish: vi.fn(async () => { throw new Error("provider detail"); }) });
    const accepted = await createConversionFromUpload({ organizationId: ORGANIZATION_ID, userId: USER_ID }, request, dependency);

    expect(accepted).toEqual({
      id: "00000000-0000-4000-8000-000000000301",
      status: "queued",
      progress: 0,
      createdAt: "2026-10-07T12:00:00.000Z",
    });
    expect(stored.gateway.putBytes).toHaveBeenCalledOnce();
    expect(stored.gateway.delete).not.toHaveBeenCalled();
    expect(stored.objects.size).toBe(1);
  });

  it("deletes only the orphan snapshot when the business transaction does not commit", async () => {
    const { dependency, stored } = dependencies({ commit: vi.fn(async () => { throw new Error("transaction failed"); }) });
    await expect(createConversionFromUpload(
      { organizationId: ORGANIZATION_ID, userId: USER_ID },
      request,
      dependency,
    )).rejects.toThrow("transaction failed");
    expect(stored.gateway.delete).toHaveBeenCalledOnce();
    expect(stored.objects.size).toBe(0);
  });

  it("keeps and publishes the snapshot when a lost commit acknowledgement is reconciled", async () => {
    const { dependency, stored } = dependencies({
      commit: vi.fn(async () => { throw new Error("connection lost after commit"); }),
      recoverCommitted: vi.fn(async () => ({
        createdAt: new Date("2026-10-07T12:00:01.000Z"),
        outboxId: "00000000-0000-4000-8000-000000000399",
      })),
    });

    const accepted = await createConversionFromUpload(
      { organizationId: ORGANIZATION_ID, userId: USER_ID },
      request,
      dependency,
    );

    expect(accepted.createdAt).toBe("2026-10-07T12:00:01.000Z");
    expect(dependency.publish).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000399");
    expect(stored.gateway.delete).not.toHaveBeenCalled();
    expect(stored.objects.size).toBe(1);
  });

  it("preserves the snapshot when commit reconciliation is indeterminate", async () => {
    const { dependency, stored } = dependencies({
      commit: vi.fn(async () => { throw new Error("connection lost"); }),
      recoverCommitted: vi.fn(async () => { throw new Error("database unavailable"); }),
    });

    await expect(createConversionFromUpload(
      { organizationId: ORGANIZATION_ID, userId: USER_ID },
      request,
      dependency,
    )).rejects.toThrow("connection lost");
    expect(stored.gateway.delete).not.toHaveBeenCalled();
    expect(stored.objects.size).toBe(1);
  });

  it("uses a deterministic colon-free queue job id", () => {
    expect(conversionJobId(
      "00000000-0000-4000-8000-000000000301",
      "00000000-0000-4000-8000-000000000302",
    )).toBe("conversion-00000000-0000-4000-8000-000000000301-00000000-0000-4000-8000-000000000302");
    expect(conversionJobId("unsafe:value", "event:value")).not.toContain(":");
  });

  it("accepts draft templates only behind the explicit local gate and released sizes only with both proofs", () => {
    const base = {
      id: "00000000-0000-4000-8000-000000000010",
      key: "mercado-livre",
      version: "1.0.0",
      displayName: "Mercado Livre",
      engineVersion: "0.1.0",
      releasedAt: new Date("2026-10-07T12:00:00.000Z"),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(() => assertTemplateEligible({ ...base, status: "DRAFT", definition: {} }, request.size, false)).toThrow();
    expect(() => assertTemplateEligible({ ...base, status: "DRAFT", definition: {} }, request.size, true)).not.toThrow();
    expect(() => assertTemplateEligible({
      ...base,
      status: "RELEASED",
      definition: { releasedSizes: [{
        widthMm: 100,
        heightMm: 250,
        automaticReportSha256: "a".repeat(64),
        physicalProofSha256: "b".repeat(64),
        approvedAt: "2026-10-07T12:00:00.000Z",
      }] },
    }, request.size, false)).not.toThrow();
  });
});

function supportedClaim(overrides: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: "00000000-0000-4000-8000-000000000501",
    organizationId: ORGANIZATION_ID,
    inputObjectKey: "organizations/test/input.pdf",
    inputSha256: "a".repeat(64),
    sourceByteLength: 100,
    outputPreset: "custom",
    outputWidthMm: "100",
    outputHeightMm: "250",
    templateKey: "mercado-livre",
    templateVersion: "1.0.0",
    engineVersion: "0.1.0",
    templateStatus: "RELEASED",
    templateDefinition: { releasedSizes: [{
      widthMm: 100,
      heightMm: 250,
      automaticReportSha256: "a".repeat(64),
      physicalProofSha256: "b".repeat(64),
      approvedAt: "2026-10-07T12:00:00.000Z",
    }] },
    templateReleasedAt: new Date("2026-10-07T12:00:00.000Z"),
    attempts: 1,
    maxAttempts: 3,
    token: "attempt-token",
    ...overrides,
  };
}

function resultVersions(overrides: Partial<ConversionResult["versions"]> = {}): ConversionResult {
  return {
    bytes: new Uint8Array([1]),
    pageCount: 1,
    widthMm: 100,
    heightMm: 250,
    versions: { engine: "0.1.0", templateKey: "mercado-livre", template: "1.0.0", ...overrides },
    validation: { contentPreserved: true, geometryValid: true, codesEquivalent: true },
    timingsMs: { analyze: 1, detect: 1, extract: 1, layout: 1, compose: 1, validate: 1 },
    pages: [],
  };
}

describe("conversion processing version fences", () => {
  it("rejects unsupported pinned processor and template versions before processing", () => {
    expect(() => assertProcessingClaimSupported(supportedClaim({ engineVersion: "0.0.9" })))
      .toThrow("versão do processador");
    expect(() => assertProcessingClaimSupported(supportedClaim({ templateVersion: "0.9.0" })))
      .toThrow("versão do modelo");
    expect(() => assertProcessingClaimSupported(supportedClaim())).not.toThrow();
  });

  it("rejects an engine result whose versions differ from the database pins", () => {
    const claim = supportedClaim();
    expect(() => assertEngineResultMatchesClaim(claim, resultVersions())).not.toThrow();
    expect(() => assertEngineResultMatchesClaim(claim, resultVersions({ engine: "0.0.9" as "0.1.0" })))
      .toThrow("não corresponde");
  });
});
