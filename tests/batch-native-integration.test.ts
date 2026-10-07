import { randomUUID } from "node:crypto";

import { count, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  batches,
  batchUploadItems,
  batchUploadSessions,
  closeDb,
  conversions,
  getDb,
  organizations,
  subscriptions,
  templates,
  usageReservations,
  user,
} from "@/db";
import { submitBatch } from "@/server/batches";
import { getStorage } from "@/server/storage";

const enabled = process.env.UNO_BATCH_INTEGRATION === "1";
const createdUsers: string[] = [];
const createdOrganizations: string[] = [];
const createdTemplates: string[] = [];

afterAll(async () => {
  if (!enabled) return;
  const database = getDb();
  for (const organizationId of createdOrganizations) await database.delete(organizations).where(eq(organizations.id, organizationId));
  for (const templateId of createdTemplates) await database.delete(templates).where(eq(templates.id, templateId));
  for (const userId of createdUsers) await database.delete(user).where(eq(user.id, userId));
  await closeDb();
});

describe.skipIf(!enabled)("native batch transaction", () => {
  it("returns one operation under concurrent idempotent submissions", async () => {
    const database = getDb();
    const userId = randomUUID();
    const organizationId = randomUUID();
    const templateId = randomUUID();
    const sessionId = randomUUID();
    createdUsers.push(userId);
    createdOrganizations.push(organizationId);
    createdTemplates.push(templateId);
    await database.insert(user).values({ id: userId, name: "Synthetic Batch", email: `${userId}@example.test`, emailVerified: true });
    await database.insert(organizations).values({ id: organizationId, name: "Synthetic Batch", slug: `batch-${organizationId}`, ownerUserId: userId });
    await database.insert(subscriptions).values({ organizationId, planId: "STARTER", status: "ACTIVE" });
    await database.insert(templates).values({
      id: templateId,
      key: "mercado-livre",
      version: "9.9.9",
      displayName: "Synthetic Batch",
      engineVersion: "0.1.0",
      status: "RELEASED",
      releasedAt: new Date(),
      definition: { releasedSizes: [{
        widthMm: 100,
        heightMm: 250,
        automaticReportSha256: "a".repeat(64),
        physicalProofSha256: "b".repeat(64),
        approvedAt: new Date().toISOString(),
      }] },
    });
    await database.insert(batchUploadSessions).values({
      id: sessionId,
      organizationId,
      createdByUserId: userId,
      templateReference: "mercado-livre@9.9.9",
      outputPreset: "custom",
      outputWidthMm: "100",
      outputHeightMm: "250",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await database.insert(batchUploadItems).values(Array.from({ length: 2 }, (_, index) => ({
      id: randomUUID(),
      organizationId,
      sessionId,
      clientItemId: randomUUID(),
      originalFileName: `synthetic-${index}.pdf`,
      contentLength: 100,
      status: "READY" as const,
      readyObjectKey: `organizations/${organizationId}/conversion-inputs/${randomUUID()}.pdf`,
      readySha256: "a".repeat(64),
      completedAt: new Date(),
    })));
    const dependency = {
      database,
      storage: getStorage(),
      randomId: randomUUID,
      now: () => new Date(),
      publish: async () => undefined,
      rateLimit: async () => undefined,
    };
    const submissions = await Promise.all(Array.from({ length: 12 }, () => submitBatch(
      { organizationId, userId, planId: "STARTER" },
      { uploadSessionId: sessionId },
      "native-concurrent-batch-key",
      dependency,
    )));
    expect(new Set(submissions.map((result) => result.id)).size).toBe(1);
    expect((await database.select({ value: count() }).from(batches).where(eq(batches.organizationId, organizationId)))[0]?.value).toBe(1);
    expect((await database.select({ value: count() }).from(conversions).where(eq(conversions.organizationId, organizationId)))[0]?.value).toBe(2);
    expect((await database.select({ value: count() }).from(usageReservations).where(eq(usageReservations.organizationId, organizationId)))[0]?.value).toBe(2);
  });
});
