import { createHash, randomUUID } from "node:crypto";

import { and, count, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  closeDb,
  conversions,
  getDb,
  organizations,
  outboxEvents,
  subscriptions,
  usagePeriods,
  usageReservations,
  user,
} from "@/db";
import {
  commitReprocessedConversion,
  recoverReprocessCommit,
  reprocessConversion,
} from "@/server/conversions/reprocess";
import { INITIAL_TEMPLATE_ID, seedInitialDraftTemplate } from "@/server/conversions/templates";
import { getStorage } from "@/server/storage";

const enabled = process.env.UNO_RUN_NATIVE_HISTORY === "1";
const organizationsToDelete: string[] = [];
const usersToDelete: string[] = [];
const objectKeys = new Set<string>();

afterAll(async () => {
  if (!enabled) return;
  const database = getDb();
  const storage = getStorage();
  for (const organizationId of organizationsToDelete) {
    const rows = await database.select({ input: conversions.inputObjectKey }).from(conversions)
      .where(eq(conversions.organizationId, organizationId));
    for (const row of rows) objectKeys.add(row.input);
    await database.delete(organizations).where(eq(organizations.id, organizationId));
  }
  for (const key of objectKeys) await storage.delete(key).catch(() => undefined);
  for (const userId of usersToDelete) await database.delete(user).where(eq(user.id, userId));
  await closeDb();
});

describe.skipIf(!enabled)("native history reprocess", () => {
  it("deduplicates concurrent requests and reserves exactly one unit", async () => {
    const database = getDb();
    const storage = getStorage();
    const userId = randomUUID();
    const organizationId = randomUUID();
    const sourceId = randomUUID();
    const sourceKey = `organizations/${organizationId}/conversion-inputs/${randomUUID()}.pdf`;
    const bytes = Buffer.from("%PDF-1.7\nsynthetic native history source\n%%EOF", "ascii");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    organizationsToDelete.push(organizationId);
    usersToDelete.push(userId);
    objectKeys.add(sourceKey);

    await database.insert(user).values({ id: userId, name: "Native History", email: `${userId}@example.test`, emailVerified: true });
    await database.insert(organizations).values({ id: organizationId, name: "Native History", slug: `history-${organizationId}`, ownerUserId: userId });
    await database.insert(subscriptions).values({ organizationId, planId: "FREE", status: "ACTIVE" });
    await seedInitialDraftTemplate(database);
    await storage.putBytes(sourceKey, bytes, "application/pdf", bytes.length);
    await database.insert(conversions).values({
      id: sourceId,
      organizationId,
      createdByUserId: userId,
      templateId: INITIAL_TEMPLATE_ID,
      templateVersion: "1.0.0",
      engineVersion: "0.1.0",
      status: "completed",
      progress: 100,
      source: "dashboard",
      originalFileName: "synthetic.pdf",
      outputPreset: "custom",
      outputWidthMm: "100",
      outputHeightMm: "250",
      inputObjectKey: sourceKey,
      inputSha256: sha256,
      sourceByteLength: bytes.length,
      completedAt: new Date(),
      artifactsExpireAt: new Date(Date.now() + 3_600_000),
    });

    const dependencies = {
      database,
      storage,
      async enforceRateLimit() {},
      async publish() {},
      commit: (input: Parameters<typeof commitReprocessedConversion>[0]) => commitReprocessedConversion(input, database),
      recoverCommit: (input: Parameters<typeof recoverReprocessCommit>[0]) => recoverReprocessCommit(input, database),
      randomId: randomUUID,
      now: () => new Date(),
    };
    const actor = { organizationId, userId, planId: "FREE" as const };
    const idempotencyKey = "native-concurrent-key-0001";
    const [first, second] = await Promise.all([
      reprocessConversion(actor, sourceId, idempotencyKey, {}, dependencies),
      reprocessConversion(actor, sourceId, idempotencyKey, {}, dependencies),
    ]);
    expect(second.id).toBe(first.id);
    const childCount = await database.select({ value: count() }).from(conversions).where(and(
      eq(conversions.organizationId, organizationId),
      eq(conversions.sourceConversionId, sourceId),
    ));
    expect(childCount[0]?.value).toBe(1);
    const reservationCount = await database.select({ value: count() }).from(usageReservations)
      .where(eq(usageReservations.organizationId, organizationId));
    expect(reservationCount[0]?.value).toBe(1);
    const counters = await database.select({ reserved: usagePeriods.reserved, confirmed: usagePeriods.confirmed })
      .from(usagePeriods).where(eq(usagePeriods.organizationId, organizationId));
    expect(counters).toEqual([{ reserved: 1, confirmed: 0 }]);
    const queued = await database.select({ value: count() }).from(outboxEvents).where(and(
      eq(outboxEvents.organizationId, organizationId),
      eq(outboxEvents.aggregateId, first.id),
    ));
    expect(queued[0]?.value).toBe(1);
    await expect(reprocessConversion(
      actor,
      sourceId,
      idempotencyKey,
      { size: { preset: "custom", widthMm: 100, heightMm: 300 } },
      dependencies,
    )).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  }, 30_000);
});
