import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { apiKeys, batches, conversions, subscriptions, templates, type UnoDatabase } from "@/db";
import { readPublicBatch, readPublicConversion } from "@/server/api-ingestion/read";
import { listBatchItems, readBatch, signBatchDownload } from "@/server/batches";
import { readConversion } from "@/server/conversions/read";
import type { StorageGateway } from "@/server/storage";

import nextConfig, { contentSecurityPolicy, securityHeaders } from "../next.config";

function directive(policy: string, name: string): string[] {
  const entry = policy.split("; ").find((part) => part.startsWith(`${name} `));
  return entry ? entry.split(" ").slice(1) : [];
}

describe("HTTP security headers", () => {
  const production = { NODE_ENV: "production", S3_ENDPOINT: "https://storage.example.test", S3_BUCKET: "uno-private" };

  it("applies the hardening headers to every route", async () => {
    const routes = await nextConfig.headers!();
    expect(routes).toHaveLength(1);
    expect(routes[0]?.source).toBe("/:path*");
    const headers = new Map(securityHeaders(production).map((header) => [header.key, header.value]));
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("Permissions-Policy")).toContain("camera=()");
    expect(headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("sends HSTS and insecure-request upgrades only in production", () => {
    const development = securityHeaders({ NODE_ENV: "development", S3_ENDPOINT: "http://localhost:4568" });
    expect(development.some((header) => header.key === "Strict-Transport-Security")).toBe(false);
    const policy = contentSecurityPolicy({ NODE_ENV: "development", S3_ENDPOINT: "http://localhost:4568" });
    expect(policy).not.toContain("upgrade-insecure-requests");
    expect(directive(policy, "script-src")).toContain("'unsafe-eval'");
    expect(directive(policy, "connect-src")).toEqual(["'self'", "http://localhost:4568", "ws:", "wss:"]);
  });

  it("limits production fetches to the app, the private storage origin and configured analytics", () => {
    const policy = contentSecurityPolicy(production);
    expect(directive(policy, "default-src")).toEqual(["'self'"]);
    expect(directive(policy, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(policy, "object-src")).toEqual(["'none'"]);
    expect(directive(policy, "base-uri")).toEqual(["'self'"]);
    expect(directive(policy, "form-action")).toEqual(["'self'"]);
    expect(directive(policy, "worker-src")).toEqual(["'self'", "blob:"]);
    expect(directive(policy, "script-src")).toEqual(["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"]);
    expect(directive(policy, "connect-src")).toEqual(["'self'", "https://storage.example.test", "https://uno-private.storage.example.test"]);
    expect(policy.endsWith("upgrade-insecure-requests")).toBe(true);
    expect(policy).not.toContain("posthog");

    const analytics = contentSecurityPolicy({ ...production, NEXT_PUBLIC_POSTHOG_KEY: "phc_synthetic", NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com" });
    expect(directive(analytics, "connect-src")).toContain("https://eu.i.posthog.com");
    const untrusted = contentSecurityPolicy({ ...production, NEXT_PUBLIC_POSTHOG_KEY: "phc_synthetic", NEXT_PUBLIC_POSTHOG_HOST: "https://collector.example.test" });
    expect(untrusted).not.toContain("collector.example.test");
  });

  it("stays functional without a build-time storage origin and rejects invalid overrides explicitly", () => {
    expect(directive(contentSecurityPolicy({ NODE_ENV: "production" }), "connect-src")).toEqual(["'self'", "https:"]);
    expect(directive(contentSecurityPolicy({ NODE_ENV: "production", UNO_CSP_CONNECT_SRC: "https://cdn.example.test" }), "connect-src"))
      .toEqual(["'self'", "https://cdn.example.test"]);
    for (const value of ["*", "http://storage.example.test", "https://storage.example.test/path", "https://user:secret@storage.example.test", "javascript:alert(1)"]) {
      expect(() => contentSecurityPolicy({ NODE_ENV: "production", UNO_CSP_CONNECT_SRC: value })).toThrowError(/UNO_CSP_CONNECT_SRC/);
    }
  });
});

describe("tenant isolation on read paths", () => {
  const USER = "00000000-0000-4000-8000-000000000001";
  const ORG = "00000000-0000-4000-8000-000000000101";
  const OTHER_ORG = "00000000-0000-4000-8000-000000000102";
  const TEMPLATE = "00000000-0000-4000-8000-000000000201";
  const KEY = "00000000-0000-4000-8000-000000000601";
  const OTHER_KEY = "00000000-0000-4000-8000-000000000602";
  const NOW = new Date("2026-10-07T12:00:00.000Z");
  const conversionId = randomUUID();
  const batchId = randomUUID();
  const pglite = new PGlite();
  const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;
  const touched: string[] = [];
  const storage = new Proxy({}, {
    get: (_target, property) => async (key: string) => {
      touched.push(`${String(property)}:${key}`);
      throw new Error("storage must not be reached for another tenant");
    },
  }) as StorageGateway;

  beforeAll(async () => {
    const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
    const names = (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
    for (const name of names) {
      const migration = await readFile(`${directory}/${name}`, "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await pglite.exec(statement);
      }
    }
    await database.insert(schema.user).values({ id: USER, name: "Synthetic", email: "isolation@example.test", emailVerified: true });
    await database.insert(schema.organizations).values([
      { id: ORG, name: "Owner", slug: "isolation-owner", ownerUserId: USER },
      { id: OTHER_ORG, name: "Other", slug: "isolation-other", ownerUserId: USER },
    ]);
    await database.insert(subscriptions).values([
      { organizationId: ORG, planId: "PRO", status: "ACTIVE" },
      { organizationId: OTHER_ORG, planId: "PRO", status: "ACTIVE" },
    ]);
    await database.insert(templates).values({
      id: TEMPLATE, key: "mercado-livre", version: "1.0.0", displayName: "Mercado Livre", engineVersion: "0.1.0",
      status: "RELEASED", releasedAt: NOW, definition: {},
    });
    await database.insert(apiKeys).values([
      { id: KEY, organizationId: ORG, createdByUserId: USER, name: "owner", prefix: "uno_owner", keyHash: "a".repeat(64) },
      { id: OTHER_KEY, organizationId: OTHER_ORG, createdByUserId: USER, name: "other", prefix: "uno_other", keyHash: "b".repeat(64) },
    ]);
    const expiresAt = new Date(NOW.getTime() + 3_600_000);
    await database.insert(batches).values({
      id: batchId, organizationId: ORG, apiKeyId: KEY, status: "completed", phase: "completed", itemCount: 1, completedCount: 1, progress: 100,
      archiveStatus: "READY", zipObjectKey: `organizations/${ORG}/batch-archives/${batchId}/published/uno-lote-${batchId}.zip`, zipByteLength: 10,
      artifactsExpireAt: expiresAt, completedAt: NOW, createdAt: NOW, updatedAt: NOW,
    });
    await database.insert(conversions).values({
      id: conversionId, organizationId: ORG, apiKeyId: KEY, batchId, templateId: TEMPLATE, templateVersion: "1.0.0", engineVersion: "0.1.0",
      status: "completed", source: "api", progress: 100, outputPreset: "custom", outputWidthMm: "100", outputHeightMm: "250",
      inputObjectKey: `organizations/${ORG}/conversion-inputs/${conversionId}.pdf`, inputSha256: "c".repeat(64),
      outputObjectKey: `organizations/${ORG}/conversion-outputs/${conversionId}/committed.pdf`, sourceByteLength: 10,
      artifactsExpireAt: expiresAt, completedAt: NOW, createdAt: NOW, updatedAt: NOW,
    });
  });

  afterAll(() => pglite.close());

  it("answers another organization exactly like a missing record and never touches storage", async () => {
    const intruder = { organizationId: OTHER_ORG, apiKeyId: OTHER_KEY, planId: "PRO" as const };
    const notFound = { code: "not_found", status: 404 };
    await expect(readPublicConversion(intruder, conversionId, database)).rejects.toMatchObject(notFound);
    await expect(readPublicConversion(intruder, randomUUID(), database)).rejects.toMatchObject(notFound);
    await expect(readPublicBatch(intruder, batchId, database)).rejects.toMatchObject(notFound);
    await expect(readConversion(OTHER_ORG, conversionId, { database, storage, now: () => NOW })).rejects.toMatchObject(notFound);
    await expect(readBatch(OTHER_ORG, batchId, database)).rejects.toMatchObject(notFound);
    await expect(listBatchItems(OTHER_ORG, batchId, {}, database)).rejects.toMatchObject(notFound);
    await expect(signBatchDownload(OTHER_ORG, batchId, { database, storage, now: () => NOW })).rejects.toMatchObject(notFound);
    expect(touched).toHaveLength(0);
  });

  it("still serves the owning organization", async () => {
    const detail = await readBatch(ORG, batchId, database);
    expect(detail).toMatchObject({ id: batchId, status: "completed", counts: { total: 1, completed: 1, failed: 0 } });
    expect((await listBatchItems(ORG, batchId, {}, database)).items.map((item) => item.id)).toEqual([conversionId]);
  });
});
