import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";

import { getDb, webhookDeliveries, webhookDeliveryAttempts, type UnoDatabase } from "@/db";
import { AppError } from "@/lib/errors";
import { webhookDeliveryListSchema, webhookDeliveryQuerySchema, type WebhookDeliveryList } from "@/lib/webhook-model";
import type { Actor } from "@/server/auth/actor";

import { canRetryWebhookDelivery } from "./delivery";
import { assertWebhookManager } from "./endpoints";

/** The cursor is only a position; every page is still filtered by organization. */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      const createdAt = new Date(parsed[0]);
      if (!Number.isNaN(createdAt.getTime()) && parsed[1].length <= 64) return { createdAt, id: parsed[1] };
    }
  } catch {
    // Falls through to the uniform error below.
  }
  throw new AppError("invalid_cursor", "Cursor inválido.", 400);
}

/**
 * Paginated delivery history of the actor's organization. It exposes state and
 * attempt metadata only: never the transmitted body, the secret or a response.
 */
export async function listWebhookDeliveries(
  actor: Pick<Actor, "organizationId" | "membershipRole">,
  rawQuery: unknown,
  database: UnoDatabase = getDb(),
): Promise<WebhookDeliveryList> {
  assertWebhookManager(actor);
  const query = webhookDeliveryQuerySchema.parse(rawQuery);
  const conditions: SQL[] = [eq(webhookDeliveries.organizationId, actor.organizationId)];
  if (query.endpointId) conditions.push(eq(webhookDeliveries.endpointId, query.endpointId));
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    conditions.push(or(
      lt(webhookDeliveries.createdAt, cursor.createdAt),
      and(eq(webhookDeliveries.createdAt, cursor.createdAt), lt(webhookDeliveries.id, cursor.id)),
    )!);
  }
  const rows = await database.select({
    id: webhookDeliveries.id,
    endpointId: webhookDeliveries.endpointId,
    outboxEventId: webhookDeliveries.outboxEventId,
    eventType: webhookDeliveries.eventType,
    status: webhookDeliveries.status,
    attemptCount: webhookDeliveries.attemptCount,
    nextAttemptAt: webhookDeliveries.nextAttemptAt,
    deliveredAt: webhookDeliveries.deliveredAt,
    lastResponseStatus: webhookDeliveries.lastResponseStatus,
    lastError: webhookDeliveries.lastError,
    createdAt: webhookDeliveries.createdAt,
  }).from(webhookDeliveries).where(and(...conditions))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id)).limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const attempts = page.length ? await database.select({
    deliveryId: webhookDeliveryAttempts.deliveryId,
    attemptNumber: webhookDeliveryAttempts.attemptNumber,
    scheduledAt: webhookDeliveryAttempts.scheduledAt,
    startedAt: webhookDeliveryAttempts.startedAt,
    finishedAt: webhookDeliveryAttempts.finishedAt,
    responseStatus: webhookDeliveryAttempts.responseStatus,
    error: webhookDeliveryAttempts.error,
  }).from(webhookDeliveryAttempts).where(and(
    eq(webhookDeliveryAttempts.organizationId, actor.organizationId),
    inArray(webhookDeliveryAttempts.deliveryId, page.map((row) => row.id)),
  )).orderBy(webhookDeliveryAttempts.attemptNumber) : [];
  return webhookDeliveryListSchema.parse({
    items: page.map((row) => ({
      id: row.id,
      endpointId: row.endpointId,
      eventId: row.outboxEventId,
      eventType: row.eventType,
      status: row.status.toLowerCase(),
      attemptCount: row.attemptCount,
      nextAttemptAt: row.status === "PENDING" ? row.nextAttemptAt.toISOString() : null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      lastResponseStatus: row.lastResponseStatus,
      lastError: row.lastError,
      canRetry: canRetryWebhookDelivery(row.status, row.attemptCount),
      createdAt: row.createdAt.toISOString(),
      attempts: attempts.filter((attempt) => attempt.deliveryId === row.id).map((attempt) => ({
        attemptNumber: attempt.attemptNumber,
        scheduledAt: attempt.scheduledAt.toISOString(),
        startedAt: attempt.startedAt?.toISOString() ?? null,
        finishedAt: attempt.finishedAt?.toISOString() ?? null,
        responseStatus: attempt.responseStatus,
        error: attempt.error,
      })),
    })),
    nextCursor: rows.length > query.limit && page.length ? encodeCursor(page.at(-1)!.createdAt, page.at(-1)!.id) : null,
  });
}
