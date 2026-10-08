import { createHash, randomBytes, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";

import { apiKeys, batches, closeDb, conversions, getDb, organizations, subscriptions, user } from "@/db";
import { getStorage } from "@/server/storage";
import { syntheticPdf } from "./fixtures/synthetic-pdf";

// Opt-in: needs the local app, worker, PostgreSQL, Redis and S3 emulator running.
const enabled = process.env.UNO_RUN_NATIVE_API === "1";
const baseUrl = process.env.UNO_TEST_URL ?? "http://127.0.0.1:3100";
const createdOrganizations: string[] = [];
const createdUsers: string[] = [];

async function seedTenant(planId: "FREE" | "PRO"): Promise<{ organizationId: string; secret: string }> {
  const database = getDb();
  const userId = randomUUID();
  const organizationId = randomUUID();
  const secret = `uno_${randomBytes(32).toString("base64url")}`;
  const now = new Date();
  createdUsers.push(userId);
  createdOrganizations.push(organizationId);
  await database.insert(user).values({ id: userId, name: "Synthetic API", email: `${userId}@example.test`, emailVerified: true });
  await database.insert(organizations).values({ id: organizationId, name: "Synthetic API", slug: `synthetic-api-${organizationId}`, ownerUserId: userId });
  await database.insert(subscriptions).values({
    organizationId, planId, status: "ACTIVE",
    ...(planId === "PRO" ? { currentPeriodStart: new Date(now.getTime() - 60_000), currentPeriodEnd: new Date(now.getTime() + 86_400_000), apiAddonStatus: "ACTIVE" as const, apiAddonCurrentPeriodEnd: new Date(now.getTime() + 86_400_000) } : {}),
  });
  await database.insert(apiKeys).values({
    organizationId, createdByUserId: userId, name: "synthetic-http", prefix: secret.slice(0, 12),
    keyHash: createHash("sha256").update(secret, "utf8").digest("hex"),
  });
  return { organizationId, secret };
}

function form(files: Array<{ field: string; name: string; bytes: Uint8Array; type?: string }>, fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.append(name, value);
  for (const file of files) body.append(file.field, new Blob([Buffer.from(file.bytes)], { type: file.type ?? "application/pdf" }), file.name);
  return body;
}

async function call(path: string, secret: string | undefined, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers = new Headers(init.headers);
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  if (init.idempotencyKey) headers.set("idempotency-key", init.idempotencyKey);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  return { response, body: await response.json() as Record<string, unknown> };
}

async function poll(path: string, secret: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const { response, body } = await call(path, secret);
    expect(response.status).toBe(200);
    if (body.status === "completed" || body.status === "failed") return body;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("resource did not reach a terminal state");
}

afterAll(async () => {
  if (!enabled) return;
  const database = getDb();
  const storage = getStorage();
  for (const organizationId of createdOrganizations) {
    try {
      const rows = await database.select({ input: conversions.inputObjectKey, output: conversions.outputObjectKey })
        .from(conversions).where(eq(conversions.organizationId, organizationId));
      const archives = await database.select({ key: batches.zipObjectKey }).from(batches).where(eq(batches.organizationId, organizationId));
      for (const key of [...rows.flatMap((row) => [row.input, row.output]), ...archives.map((row) => row.key)]) {
        if (key) await storage.delete(key).catch(() => undefined);
      }
      await database.delete(conversions).where(eq(conversions.organizationId, organizationId));
      await database.delete(batches).where(eq(batches.organizationId, organizationId));
      await database.delete(organizations).where(eq(organizations.id, organizationId));
    } catch { /* synthetic rows may remain in the local database */ }
  }
  for (const userId of createdUsers) await database.delete(user).where(eq(user.id, userId)).catch(() => undefined);
  await closeDb();
});

describe.skipIf(!enabled)("public API over HTTP", () => {
  it("authenticates, gates by plan, converts asynchronously, replays idempotently and isolates tenants", async () => {
    const pro = await seedTenant("PRO");
    const other = await seedTenant("PRO");
    const free = await seedTenant("FREE");
    const pdf = await syntheticPdf();
    const size = { size: "custom", widthMm: "100", heightMm: "250" };

    expect((await call("/api/v1/usage", undefined)).response.status).toBe(401);
    const denied = await call("/api/v1/usage", free.secret);
    expect(denied.response.status).toBe(403);
    expect((denied.body.error as { code: string }).code).toBe("plan_required");

    const usageBefore = await call("/api/v1/usage", pro.secret);
    expect(usageBefore.response.status).toBe(200);
    expect(usageBefore.body).toMatchObject({ planId: "PRO", confirmed: 0, reserved: 0 });
    expect(String(usageBefore.body.requestId)).toMatch(/^req_/);

    const unknownField = await call("/api/v1/conversions", pro.secret, {
      method: "POST", body: form([{ field: "file", name: "synthetic.pdf", bytes: pdf }], { ...size, callbackUrl: "x" }),
    });
    expect(unknownField.response.status).toBe(400);
    const notPdf = await call("/api/v1/conversions", pro.secret, {
      method: "POST", body: form([{ field: "file", name: "synthetic.pdf", bytes: Buffer.from("plain text, not a document") }], size),
    });
    expect(notPdf.response.status).toBe(422);
    expect((notPdf.body.error as { code: string }).code).toBe("invalid_pdf");

    const key = `synthetic-${randomUUID()}`;
    const created = await call("/api/v1/conversions", pro.secret, {
      method: "POST", idempotencyKey: key, body: form([{ field: "file", name: "synthetic.pdf", bytes: pdf }], size),
    });
    expect(created.response.status).toBe(202);
    expect(created.body).toMatchObject({ status: "queued", progress: 0 });
    const conversionId = String(created.body.id);

    const replay = await call("/api/v1/conversions", pro.secret, {
      method: "POST", idempotencyKey: key, body: form([{ field: "file", name: "synthetic.pdf", bytes: pdf }], size),
    });
    expect(replay.response.status).toBe(202);
    expect(replay.body.id).toBe(conversionId);
    const conflict = await call("/api/v1/conversions", pro.secret, {
      method: "POST", idempotencyKey: key, body: form([{ field: "file", name: "synthetic.pdf", bytes: pdf }], { ...size, heightMm: "260" }),
    });
    expect(conflict.response.status).toBe(409);
    expect((conflict.body.error as { code: string }).code).toBe("idempotency_conflict");

    const foreign = await call(`/api/v1/conversions/${conversionId}`, other.secret);
    expect(foreign.response.status).toBe(404);

    const finished = await poll(`/api/v1/conversions/${conversionId}`, pro.secret);
    expect(finished.status).toBe("completed");
    expect(finished.progress).toBe(100);
    for (const field of ["template", "templateVersion", "engineVersion", "createdAt", "updatedAt"]) expect(typeof finished[field]).toBe("string");
    const download = finished.download as { url: string; expiresAt: string };
    expect(Date.parse(download.expiresAt)).toBeGreaterThan(Date.now());
    const output = await fetch(download.url);
    expect(output.status).toBe(200);
    const document = await PDFDocument.load(new Uint8Array(await output.arrayBuffer()));
    expect(document.getPageCount()).toBe(1);

    const labelled = await call("/api/v1/conversions", pro.secret, {
      method: "POST",
      body: form([{ field: "file", name: "synthetic-fiscal.pdf", bytes: await syntheticPdf({ fiscalSummary: true }) }], {
        size: "100x150", productTitle: "Produto sintetico de teste", quantity: "2", sku: "SKU-SINTETICO-01", variation: "Cor: Verde",
      }),
    });
    expect(labelled.response.status).toBe(202);
    const compact = await poll(`/api/v1/conversions/${String(labelled.body.id)}`, pro.secret);
    expect(compact.status).toBe("completed");
    expect(compact.size).toMatchObject({ preset: "100x150", widthMm: 100, heightMm: 150 });
    const badQuantity = await call("/api/v1/conversions", pro.secret, {
      method: "POST", body: form([{ field: "file", name: "synthetic.pdf", bytes: pdf }], { ...size, productTitle: "Produto", quantity: "zero" }),
    });
    expect(badQuantity.response.status).toBe(400);
    const batchWithProduct = await call("/api/v1/batches", pro.secret, {
      method: "POST", body: form([{ field: "files", name: "synthetic.pdf", bytes: pdf }], { ...size, productTitle: "Produto" }),
    });
    expect(batchWithProduct.response.status).toBe(400);

    const batch = await call("/api/v1/batches", pro.secret, {
      method: "POST", idempotencyKey: `synthetic-${randomUUID()}`,
      body: form([
        { field: "files", name: "synthetic-a.pdf", bytes: pdf },
        { field: "files", name: "synthetic-b.pdf", bytes: await syntheticPdf({ additionalInformation: true }) },
      ], size),
    });
    expect(batch.response.status).toBe(202);
    expect(batch.body).toMatchObject({ status: "queued", progress: 0, itemCount: 2 });
    expect((await call(`/api/v1/batches/${String(batch.body.id)}`, other.secret)).response.status).toBe(404);
    const packaged = await poll(`/api/v1/batches/${String(batch.body.id)}`, pro.secret);
    expect(packaged.status).toBe("completed");
    expect(packaged.counts).toMatchObject({ total: 2, completed: 2, failed: 0 });
    const archive = await fetch((packaged.download as { url: string }).url);
    expect(archive.status).toBe(200);
    expect(Buffer.from(await archive.arrayBuffer()).subarray(0, 2).toString("ascii")).toBe("PK");

    const usageAfter = await call("/api/v1/usage", pro.secret);
    expect(usageAfter.body).toMatchObject({ confirmed: 4, reserved: 0 });
    expect((await call("/api/v1/usage", other.secret)).body).toMatchObject({ confirmed: 0, reserved: 0 });
  }, 240_000);
});
