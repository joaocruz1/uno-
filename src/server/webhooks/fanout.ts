import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { conversions, getDb, outboxEvents, webhookDeliveries, webhookEndpoints, type UnoDatabase } from "@/db";
import { WEBHOOK_EVENT_TYPES, webhookEventDataSchema, type WebhookEventData, type WebhookEventType } from "@/lib/webhook-model";

import { isWebhookPlan, lockWebhookOrganization } from "./endpoints";

type Transaction = Parameters<Parameters<UnoDatabase["transaction"]>[0]>[0];
type OutboxEvent = typeof outboxEvents.$inferSelect;

export type WebhookFanoutDependencies = {
  database: UnoDatabase;
  randomId(): string;
  now(): Date;
};

function defaults(): WebhookFanoutDependencies {
  return { database: getDb(), randomId: () => crypto.randomUUID(), now: () => new Date() };
}

const GENERIC_FAILURE_MESSAGE = "Não foi possível concluir a conversão.";
const conversionPayloadSchema = z.object({ conversionId: z.uuid(), errorCode: z.string().regex(/^[a-z0-9_]{1,64}$/).optional() });
const batchPayloadSchema = z.object({
  batchId: z.uuid(),
  status: z.enum(["completed", "failed"]),
  completedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
});

/**
 * Builds the whitelisted `data` object. Only identifiers, status, counters and
 * the same safe error code/message exposed by polling are copied; anything else
 * present in the outbox payload is dropped.
 */
async function buildEventData(event: OutboxEvent, transaction: Transaction): Promise<WebhookEventData | null> {
  let candidate: unknown = null;
  if (event.type === "conversion.completed") {
    const payload = conversionPayloadSchema.safeParse(event.payload);
    if (payload.success) candidate = { type: event.type, data: { conversionId: payload.data.conversionId, status: "completed" } };
  } else if (event.type === "conversion.failed") {
    const payload = conversionPayloadSchema.safeParse(event.payload);
    if (payload.success) {
      const rows = await transaction.select({ code: conversions.errorCode, message: conversions.errorMessage }).from(conversions)
        .where(and(eq(conversions.organizationId, event.organizationId), eq(conversions.id, payload.data.conversionId))).limit(1);
      const code = payload.data.errorCode ?? "conversion_failed";
      const stored = rows[0];
      const message = stored?.code === code && stored.message ? stored.message.slice(0, 300) : GENERIC_FAILURE_MESSAGE;
      candidate = { type: event.type, data: { conversionId: payload.data.conversionId, status: "failed", error: { code, message } } };
    }
  } else if (event.type === "batch.completed") {
    const payload = batchPayloadSchema.safeParse(event.payload);
    if (payload.success) {
      candidate = {
        type: event.type,
        data: {
          batchId: payload.data.batchId,
          status: payload.data.status,
          counts: { completed: payload.data.completedCount, failed: payload.data.failedCount },
        },
      };
    }
  }
  const parsed = webhookEventDataSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** The exact bytes transmitted on every attempt; serialized once per event. */
export function serializeWebhookBody(event: Pick<OutboxEvent, "id" | "createdAt" | "organizationId">, payload: WebhookEventData): string {
  return JSON.stringify({
    id: event.id,
    type: payload.type,
    createdAt: event.createdAt.toISOString(),
    organizationId: event.organizationId,
    data: payload.data,
  });
}

async function fanOutNextEvent(dependencies: WebhookFanoutDependencies): Promise<"none" | "published"> {
  return dependencies.database.transaction(async (transaction) => {
    const claimed = await transaction.select().from(outboxEvents).where(and(
      inArray(outboxEvents.type, [...WEBHOOK_EVENT_TYPES]),
      inArray(outboxEvents.status, ["PENDING", "FAILED"]),
      lte(outboxEvents.availableAt, sql`now()`),
    )).orderBy(outboxEvents.createdAt, outboxEvents.id).limit(1).for("update", { skipLocked: true });
    const event = claimed[0];
    if (!event) return "none";
    const now = dependencies.now();
    let note: string | null = null;
    const planId = await lockWebhookOrganization(event.organizationId, transaction, now);
    if (isWebhookPlan(planId)) {
      const payload = await buildEventData(event, transaction);
      if (!payload) {
        note = "invalid_payload";
      } else {
        // Only endpoints enabled (and never toggled) since before the event
        // occurred and subscribed to its type receive it; nothing is replayed
        // to endpoints created or re-enabled afterwards.
        const endpoints = await transaction.select({ id: webhookEndpoints.id }).from(webhookEndpoints).where(and(
          eq(webhookEndpoints.organizationId, event.organizationId),
          eq(webhookEndpoints.active, true),
          lte(webhookEndpoints.createdAt, event.createdAt),
          lte(webhookEndpoints.updatedAt, event.createdAt),
          sql`${event.type as WebhookEventType} = any(${webhookEndpoints.subscribedEvents})`,
        ));
        if (endpoints.length) {
          const body = serializeWebhookBody(event, payload);
          await transaction.insert(webhookDeliveries).values(endpoints.map((endpoint) => ({
            id: dependencies.randomId(),
            organizationId: event.organizationId,
            endpointId: endpoint.id,
            outboxEventId: event.id,
            eventType: event.type,
            body,
            status: "PENDING" as const,
            nextAttemptAt: now,
            createdAt: now,
            updatedAt: now,
          }))).onConflictDoNothing({ target: [webhookDeliveries.endpointId, webhookDeliveries.outboxEventId] });
        }
      }
    }
    await transaction.update(outboxEvents).set({
      status: "PUBLISHED",
      attempts: event.attempts + 1,
      publishedAt: now,
      lastError: note,
      updatedAt: now,
    }).where(eq(outboxEvents.id, event.id));
    return "published";
  });
}

/**
 * Turns pending webhook-type outbox events into one delivery per eligible
 * endpoint. Each event is handled in a single transaction, so a crash leaves it
 * pending and the unique (endpoint, event) index keeps a replay idempotent.
 */
export async function fanOutPendingWebhookEvents(
  options: { limit?: number } = {},
  dependencies: WebhookFanoutDependencies = defaults(),
): Promise<number> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  let published = 0;
  for (let index = 0; index < limit; index += 1) {
    if (await fanOutNextEvent(dependencies) === "none") break;
    published += 1;
  }
  return published;
}
