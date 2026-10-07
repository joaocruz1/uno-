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
  uploadIntents,
  usagePeriods,
  usageReservations,
  user,
} from "@/db";
import {
  commitConversion,
  claimConversion,
  createConversionFromUpload,
  processConversion,
  readConversion,
  recoverQueuedConversion,
  recoverCommittedConversion,
} from "@/server/conversions";
import { closeConversionQueue } from "@/server/queue/conversion-queue";
import { publishPendingConversionJobs } from "@/server/queue/outbox";
import { getStorage } from "@/server/storage";
import { findUploadIntentForOrganization, readValidatedUpload } from "@/server/uploads";
import { startConversionWorker } from "@/workers/conversion-worker";
import { syntheticPdf } from "./fixtures/synthetic-pdf";

const enabled = process.env.UNO_RUN_NATIVE_CONVERSION === "1";
const createdOrganizations: string[] = [];
const createdUsers: string[] = [];
const objectKeys: string[] = [];

afterAll(async () => {
  if (!enabled) return;
  const database = getDb();
  const storage = getStorage();
  for (const organizationId of createdOrganizations) {
    const rows = await database.select({ input: conversions.inputObjectKey, output: conversions.outputObjectKey })
      .from(conversions).where(eq(conversions.organizationId, organizationId));
    for (const row of rows) {
      objectKeys.push(row.input);
      if (row.output) objectKeys.push(row.output);
    }
    await database.delete(organizations).where(eq(organizations.id, organizationId));
  }
  for (const userId of createdUsers) await database.delete(user).where(eq(user.id, userId));
  for (const key of new Set(objectKeys)) await storage.delete(key).catch(() => undefined);
  await closeDb();
});

describe.skipIf(!enabled)("native conversion pipeline", () => {
  it("snapshots, reserves, converts, validates, publishes and confirms exactly one unit", async () => {
    const database = getDb();
    const storage = getStorage();
    const userId = randomUUID();
    const organizationId = randomUUID();
    const uploadIntentId = randomUUID();
    const uploadKey = `organizations/${organizationId}/uploads/${randomUUID()}.pdf`;
    createdUsers.push(userId);
    createdOrganizations.push(organizationId);
    objectKeys.push(uploadKey);
    const bytes = Buffer.from(await syntheticPdf({ additionalInformation: true }));
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const worker = startConversionWorker();

    try {
      await database.insert(user).values({ id: userId, name: "Synthetic Conversion", email: `${userId}@example.test`, emailVerified: true });
      await database.insert(organizations).values({ id: organizationId, name: "Synthetic Conversion", slug: `synthetic-${organizationId}`, ownerUserId: userId });
      await database.insert(subscriptions).values({ organizationId, planId: "FREE", status: "ACTIVE" });
      await storage.putBytes(uploadKey, bytes, "application/pdf", bytes.length);
      await database.insert(uploadIntents).values({
        id: uploadIntentId,
        organizationId,
        createdByUserId: userId,
        objectKey: uploadKey,
        contentLength: bytes.length,
        contentType: "application/pdf",
        checksumSha256: checksum,
        originalFileName: "synthetic.pdf",
        expiresAt: new Date(Date.now() + 300_000),
      });

      const accepted = await createConversionFromUpload(
        { organizationId, userId },
        { uploadIntentId, template: "mercado-livre@1.0.0", size: { preset: "custom", widthMm: 100, heightMm: 250 } },
        {
          storage,
          loadIntent: findUploadIntentForOrganization,
          readUpload: (intent, gateway) => readValidatedUpload(intent, { storage: gateway }),
          commit: async (input) => {
            await commitConversion(input, database);
            throw new Error("synthetic lost commit acknowledgement");
          },
          recoverCommitted: (input) => recoverCommittedConversion(input, database),
          publish: async () => { throw new Error("synthetic queue outage"); },
          randomId: randomUUID,
          now: () => new Date(),
        },
      );
      const pendingOutbox = await database.select({ status: outboxEvents.status }).from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, accepted.id));
      expect(pendingOutbox).toEqual([{ status: "PENDING" }]);
      expect(await publishPendingConversionJobs({ limit: 10 })).toBeGreaterThanOrEqual(1);
      let view = await readConversion(organizationId, accepted.id);
      const deadline = Date.now() + 30_000;
      while ((view.status === "queued" || view.status === "processing") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        view = await readConversion(organizationId, accepted.id);
      }
      expect(view.status).toBe("completed");
      expect(view.progress).toBe(100);
      expect(view.download?.url).toMatch(/^https?:/);
      expect(view.original?.url).toMatch(/^https?:/);
      expect(view.events.map((event) => event.stage)).toEqual([
        "processing", "analyze", "detect", "extract", "layout", "compose", "validate", "completed",
      ]);

      const periods = await database.select({ reserved: usagePeriods.reserved, confirmed: usagePeriods.confirmed })
        .from(usagePeriods).where(eq(usagePeriods.organizationId, organizationId));
      expect(periods).toEqual([{ reserved: 0, confirmed: 1 }]);
      const reservations = await database.select({ status: usageReservations.status }).from(usageReservations)
        .where(eq(usageReservations.conversionId, accepted.id));
      expect(reservations).toEqual([{ status: "CONFIRMED" }]);

      const tooSmallIntentId = randomUUID();
      const tooSmallUploadKey = `organizations/${organizationId}/uploads/${randomUUID()}.pdf`;
      objectKeys.push(tooSmallUploadKey);
      await storage.putBytes(tooSmallUploadKey, bytes, "application/pdf", bytes.length);
      await database.insert(uploadIntents).values({
        id: tooSmallIntentId,
        organizationId,
        createdByUserId: userId,
        objectKey: tooSmallUploadKey,
        contentLength: bytes.length,
        contentType: "application/pdf",
        checksumSha256: checksum,
        expiresAt: new Date(Date.now() + 300_000),
      });
      const tooSmall = await createConversionFromUpload(
        { organizationId, userId },
        { uploadIntentId: tooSmallIntentId, template: "mercado-livre@1.0.0", size: { preset: "100x150" } },
        {
          storage,
          loadIntent: findUploadIntentForOrganization,
          readUpload: (intent, gateway) => readValidatedUpload(intent, { storage: gateway }),
          commit: (input) => commitConversion(input, database),
          recoverCommitted: (input) => recoverCommittedConversion(input, database),
          publish: async () => { throw new Error("synthetic queue outage"); },
          randomId: randomUUID,
          now: () => new Date(),
        },
      );
      await publishPendingConversionJobs({ limit: 10 });
      let failedView = await readConversion(organizationId, tooSmall.id);
      const failureDeadline = Date.now() + 30_000;
      while ((failedView.status === "queued" || failedView.status === "processing") && Date.now() < failureDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        failedView = await readConversion(organizationId, tooSmall.id);
      }
      expect(failedView.status).toBe("failed");
      expect(failedView.error?.code).toBe("format_too_small");
      const countersAfterFailure = await database.select({ reserved: usagePeriods.reserved, confirmed: usagePeriods.confirmed })
        .from(usagePeriods).where(eq(usagePeriods.organizationId, organizationId));
      expect(countersAfterFailure).toEqual([{ reserved: 0, confirmed: 1 }]);
      const allReservationStatuses = await database.select({ status: usageReservations.status }).from(usageReservations)
        .where(eq(usageReservations.organizationId, organizationId));
      expect(allReservationStatuses.map(({ status }) => status).sort()).toEqual(["CONFIRMED", "RELEASED"]);

      const claimedId = randomUUID();
      const templateId = await database.query.templates.findFirst({ columns: { id: true } });
      expect(templateId).toBeDefined();
      await database.insert(conversions).values({
        id: claimedId,
        organizationId,
        templateId: templateId!.id,
        templateVersion: "1.0.0",
        engineVersion: "0.1.0",
        status: "queued",
        outputPreset: "custom",
        outputWidthMm: "100",
        outputHeightMm: "250",
        inputObjectKey: `synthetic/claim/${claimedId}.pdf`,
        inputSha256: checksum,
        sourceByteLength: bytes.length,
      });
      const processorDependencies = {
        database,
        storage,
        convert: async () => { throw new Error("unused"); },
        randomId: randomUUID,
        now: () => new Date(),
      };
      const firstClaim = await claimConversion(claimedId, randomUUID(), processorDependencies);
      expect(firstClaim?.attempts).toBe(1);
      const busyClaim = await claimConversion(claimedId, randomUUID(), processorDependencies);
      expect(busyClaim).toBeUndefined();
      await database.update(conversions).set({ processingLeaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(conversions.id, claimedId));
      const recoveredClaim = await claimConversion(claimedId, randomUUID(), processorDependencies);
      expect(recoveredClaim?.attempts).toBe(2);
      expect(recoveredClaim?.token).not.toBe(firstClaim?.token);
      await database.update(conversions).set({ processingLeaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(conversions.id, claimedId));
      const finalLiveClaim = await claimConversion(claimedId, randomUUID(), processorDependencies);
      expect(finalLiveClaim?.attempts).toBe(3);
      await processConversion(claimedId, processorDependencies);
      const afterBusyDuplicate = await database.select({
        status: conversions.status,
        token: conversions.processingToken,
        attempts: conversions.attempts,
      }).from(conversions).where(eq(conversions.id, claimedId));
      expect(afterBusyDuplicate).toEqual([{ status: "processing", token: finalLiveClaim?.token, attempts: 3 }]);

      const preClaimFailureId = randomUUID();
      await database.insert(conversions).values({
        id: preClaimFailureId,
        organizationId,
        templateId: templateId!.id,
        templateVersion: "1.0.0",
        engineVersion: "0.1.0",
        status: "queued",
        outputPreset: "custom",
        outputWidthMm: "100",
        outputHeightMm: "250",
        inputObjectKey: `synthetic/preclaim/${preClaimFailureId}.pdf`,
        inputSha256: checksum,
        sourceByteLength: bytes.length,
      });
      expect(await recoverQueuedConversion(preClaimFailureId, "failed-job", processorDependencies)).toBe(true);
      expect(await recoverQueuedConversion(preClaimFailureId, "failed-job", processorDependencies)).toBe(true);
      const recoveryEvents = await database.select({ value: count() }).from(outboxEvents).where(and(
        eq(outboxEvents.aggregateId, preClaimFailureId),
        eq(outboxEvents.deduplicationKey, `conversion.queue-recovery.${preClaimFailureId}.failed-job`),
      ));
      expect(recoveryEvents[0]?.value).toBe(1);
    } finally {
      await worker.close();
      await closeConversionQueue();
    }
  }, 60_000);
});
