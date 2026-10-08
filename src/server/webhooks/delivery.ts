import { and, eq, inArray, isNull, lt, lte } from "drizzle-orm";

import {
  auditLogs,
  getDb,
  subscriptions,
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookEndpoints,
  type UnoDatabase,
} from "@/db";
import { AppError } from "@/lib/errors";
import type { Actor } from "@/server/auth/actor";
import { effectivePlanFromSubscription, subscriptionEntitlementColumns } from "@/server/billing/entitlements";

import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS, webhookTimeoutMs } from "./config";
import { decryptWebhookSecret, loadWebhookKeyring, signWebhookBody, type WebhookKeyring } from "./crypto";
import { assertWebhookEntitlement, assertWebhookManager, lockWebhookOrganization } from "./endpoints";
import { defaultWebhookTransport, sendWebhookRequest, WebhookSendError, type WebhookTransport } from "./network";

type Transaction = Parameters<Parameters<UnoDatabase["transaction"]>[0]>[0];

export type WebhookDeliveryDependencies = {
  database: UnoDatabase;
  transport: WebhookTransport;
  keyring(): WebhookKeyring;
  timeoutMs: number;
  randomId(): string;
  now(): Date;
};

export function webhookDeliveryDefaults(): WebhookDeliveryDependencies {
  return {
    database: getDb(),
    transport: defaultWebhookTransport(),
    keyring: loadWebhookKeyring,
    timeoutMs: webhookTimeoutMs(),
    randomId: () => crypto.randomUUID(),
    now: () => new Date(),
  };
}

export type WebhookDeliveryClaim = {
  id: string;
  organizationId: string;
  endpointId: string;
  token: string;
  attemptNumber: number;
  body: string;
  url: string;
  secret: {
    secretCiphertext: string;
    secretIv: string;
    secretAuthTag: string;
    encryptionKeyVersion: string;
  };
};

export type WebhookAttemptOutcome = { status: number } | { error: string };

/** Lease outlives the request deadline so a live attempt is never reclaimed. */
function leaseMs(timeoutMs: number): number {
  return timeoutMs + 30_000;
}

async function hasWebhookEntitlement(organizationId: string, transaction: Transaction, now: Date): Promise<boolean> {
  const rows = await transaction.select({
    ...subscriptionEntitlementColumns,
  }).from(subscriptions).where(eq(subscriptions.organizationId, organizationId)).limit(1);
  return effectivePlanFromSubscription(rows[0], now).plan.api;
}

/**
 * Applies a failed attempt to a delivery that is still PROCESSING: schedules the
 * next retry (1m/5m/30m/2h/12h after this failure) or marks it FAILED after the
 * sixth attempt.
 */
function failureState(attemptCount: number, error: string, responseStatus: number | null, now: Date) {
  const delay = WEBHOOK_RETRY_DELAYS_MS[attemptCount - 1];
  const terminal = attemptCount >= WEBHOOK_MAX_ATTEMPTS || delay === undefined;
  return {
    status: terminal ? "FAILED" as const : "PENDING" as const,
    nextAttemptAt: terminal ? now : new Date(now.getTime() + delay),
    claimToken: null,
    leaseExpiresAt: null,
    lastResponseStatus: responseStatus,
    lastError: error,
    updatedAt: now,
  };
}

/**
 * Releases claims whose lease expired (worker crashed or hung). The abandoned
 * attempt counts as a failure; its late result can no longer be written because
 * the claim token is cleared. The receiver may still have got the request, which
 * is why receivers must deduplicate by delivery id.
 */
export async function recoverExpiredWebhookClaims(
  dependencies: Pick<WebhookDeliveryDependencies, "database" | "now"> = webhookDeliveryDefaults(),
  limit = 100,
): Promise<number> {
  const now = dependencies.now();
  return dependencies.database.transaction(async (transaction) => {
    const expired = await transaction.select({ id: webhookDeliveries.id, attemptCount: webhookDeliveries.attemptCount })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.status, "PROCESSING"), lt(webhookDeliveries.leaseExpiresAt, now)))
      .orderBy(webhookDeliveries.leaseExpiresAt).limit(limit).for("update", { skipLocked: true });
    for (const row of expired) {
      await transaction.update(webhookDeliveries).set(failureState(row.attemptCount, "lease_expired", null, now))
        .where(eq(webhookDeliveries.id, row.id));
      await transaction.update(webhookDeliveryAttempts).set({ finishedAt: now, error: "lease_expired" }).where(and(
        eq(webhookDeliveryAttempts.deliveryId, row.id),
        eq(webhookDeliveryAttempts.attemptNumber, row.attemptCount),
        isNull(webhookDeliveryAttempts.finishedAt),
      ));
    }
    return expired.length;
  });
}

/**
 * Cancels pending deliveries of organizations that lost the API plan, so they
 * are not sent later if the plan comes back. Disabled endpoints are already
 * canceled when they are disabled and re-checked on every claim.
 */
export async function cancelUnentitledWebhookDeliveries(
  dependencies: Pick<WebhookDeliveryDependencies, "database" | "now"> = webhookDeliveryDefaults(),
  limit = 200,
): Promise<number> {
  const now = dependencies.now();
  const organizations = await dependencies.database.selectDistinct({ organizationId: webhookDeliveries.organizationId })
    .from(webhookDeliveries).where(eq(webhookDeliveries.status, "PENDING")).limit(limit);
  let canceled = 0;
  for (const { organizationId } of organizations) {
    canceled += await dependencies.database.transaction(async (transaction) => {
      if (await lockWebhookOrganization(organizationId, transaction, now)) return 0;
      const rows = await transaction.update(webhookDeliveries).set({
        status: "CANCELED", claimToken: null, leaseExpiresAt: null, lastError: "plan_required", updatedAt: now,
      }).where(and(eq(webhookDeliveries.organizationId, organizationId), eq(webhookDeliveries.status, "PENDING")))
        .returning({ id: webhookDeliveries.id });
      return rows.length;
    });
  }
  return canceled;
}

/**
 * Claims one due delivery with a fresh token and lease. Endpoint state and plan
 * entitlement are re-read under lock for every attempt: a disabled endpoint or a
 * lost plan cancels the delivery instead of sending it.
 */
export async function claimDueWebhookDelivery(
  dependencies: Pick<WebhookDeliveryDependencies, "database" | "now" | "randomId" | "timeoutMs">,
  deliveryId?: string,
): Promise<WebhookDeliveryClaim | "canceled" | null> {
  const now = dependencies.now();
  return dependencies.database.transaction(async (transaction) => {
    const due = await transaction.select().from(webhookDeliveries).where(and(
      eq(webhookDeliveries.status, "PENDING"),
      lte(webhookDeliveries.nextAttemptAt, now),
      ...(deliveryId ? [eq(webhookDeliveries.id, deliveryId)] : []),
    )).orderBy(webhookDeliveries.nextAttemptAt, webhookDeliveries.createdAt).limit(1).for("update", { skipLocked: true });
    const delivery = due[0];
    if (!delivery) return null;
    const cancel = async (reason: string) => {
      await transaction.update(webhookDeliveries).set({
        status: "CANCELED", claimToken: null, leaseExpiresAt: null, lastError: reason, updatedAt: now,
      }).where(eq(webhookDeliveries.id, delivery.id));
      return "canceled" as const;
    };
    const endpoints = await transaction.select().from(webhookEndpoints).where(and(
      eq(webhookEndpoints.organizationId, delivery.organizationId),
      eq(webhookEndpoints.id, delivery.endpointId),
    )).limit(1);
    // Not row-locked on purpose: disabling locks endpoint -> deliveries, so a
    // lock here would invert that order. A concurrent disable still cancels this
    // delivery right after the claim commits and fences the late result.
    const endpoint = endpoints[0];
    if (!endpoint || !endpoint.active) return cancel("endpoint_disabled");
    if (!await hasWebhookEntitlement(delivery.organizationId, transaction, now)) return cancel("plan_required");
    if (delivery.attemptCount >= WEBHOOK_MAX_ATTEMPTS) {
      await transaction.update(webhookDeliveries).set({ status: "FAILED", updatedAt: now }).where(eq(webhookDeliveries.id, delivery.id));
      return null;
    }
    const token = dependencies.randomId();
    const attemptNumber = delivery.attemptCount + 1;
    await transaction.update(webhookDeliveries).set({
      status: "PROCESSING",
      claimToken: token,
      leaseExpiresAt: new Date(now.getTime() + leaseMs(dependencies.timeoutMs)),
      attemptCount: attemptNumber,
      updatedAt: now,
    }).where(eq(webhookDeliveries.id, delivery.id));
    await transaction.insert(webhookDeliveryAttempts).values({
      id: dependencies.randomId(),
      organizationId: delivery.organizationId,
      deliveryId: delivery.id,
      attemptNumber,
      scheduledAt: delivery.nextAttemptAt,
      startedAt: now,
      createdAt: now,
    });
    return {
      id: delivery.id,
      organizationId: delivery.organizationId,
      endpointId: delivery.endpointId,
      token,
      attemptNumber,
      body: delivery.body,
      url: endpoint.url,
      secret: {
        secretCiphertext: endpoint.secretCiphertext,
        secretIv: endpoint.secretIv,
        secretAuthTag: endpoint.secretAuthTag,
        encryptionKeyVersion: endpoint.encryptionKeyVersion,
      },
    };
  });
}

/**
 * Records an attempt result. The update is fenced by the claim token: a result
 * from an expired or superseded claim matches nothing and changes nothing.
 */
export async function completeWebhookAttempt(
  claim: Pick<WebhookDeliveryClaim, "id" | "token" | "attemptNumber">,
  outcome: WebhookAttemptOutcome,
  dependencies: Pick<WebhookDeliveryDependencies, "database" | "now">,
): Promise<boolean> {
  const now = dependencies.now();
  const responseStatus = "status" in outcome ? outcome.status : null;
  const delivered = responseStatus !== null && responseStatus >= 200 && responseStatus <= 299;
  const error = delivered ? null : "error" in outcome ? outcome.error : "http_status";
  return dependencies.database.transaction(async (transaction) => {
    const updated = await transaction.update(webhookDeliveries).set(delivered ? {
      status: "DELIVERED" as const,
      deliveredAt: now,
      claimToken: null,
      leaseExpiresAt: null,
      lastResponseStatus: responseStatus,
      lastError: null,
      updatedAt: now,
    } : failureState(claim.attemptNumber, error ?? "http_status", responseStatus, now)).where(and(
      eq(webhookDeliveries.id, claim.id),
      eq(webhookDeliveries.status, "PROCESSING"),
      eq(webhookDeliveries.claimToken, claim.token),
      eq(webhookDeliveries.attemptCount, claim.attemptNumber),
    )).returning({ id: webhookDeliveries.id });
    if (!updated[0]) return false;
    await transaction.update(webhookDeliveryAttempts).set({ finishedAt: now, responseStatus, error }).where(and(
      eq(webhookDeliveryAttempts.deliveryId, claim.id),
      eq(webhookDeliveryAttempts.attemptNumber, claim.attemptNumber),
      isNull(webhookDeliveryAttempts.finishedAt),
    ));
    return true;
  });
}

/** Headers for one attempt: stable delivery id, fresh timestamp and signature. */
export function webhookRequestHeaders(deliveryId: string, secret: string, body: string, now: Date): Record<string, string> {
  const timestamp = Math.floor(now.getTime() / 1_000);
  return {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body, "utf8")),
    "user-agent": "UNO-Webhooks/1",
    "x-label-timestamp": String(timestamp),
    "x-label-delivery": deliveryId,
    "x-label-signature": signWebhookBody(secret, timestamp, body),
  };
}

async function attemptWebhookDelivery(claim: WebhookDeliveryClaim, dependencies: WebhookDeliveryDependencies): Promise<WebhookAttemptOutcome> {
  let secret: string;
  try {
    secret = decryptWebhookSecret(claim.secret, { organizationId: claim.organizationId, endpointId: claim.endpointId }, dependencies.keyring());
  } catch {
    return { error: "secret_unavailable" };
  }
  try {
    return await sendWebhookRequest({
      url: claim.url,
      headers: webhookRequestHeaders(claim.id, secret, claim.body, dependencies.now()),
      body: claim.body,
      timeoutMs: dependencies.timeoutMs,
    }, dependencies.transport);
  } catch (error) {
    return { error: error instanceof WebhookSendError ? error.code : "network_error" };
  }
}

/** Claims and sends due deliveries; returns how many attempts were made. */
export async function deliverDueWebhooks(
  options: { limit?: number; concurrency?: number } = {},
  dependencies: WebhookDeliveryDependencies = webhookDeliveryDefaults(),
): Promise<number> {
  let budget = Math.min(500, Math.max(1, options.limit ?? 50));
  const concurrency = Math.min(10, Math.max(1, options.concurrency ?? 4));
  let attempts = 0;
  const lane = async () => {
    while (budget > 0) {
      budget -= 1;
      const claim = await claimDueWebhookDelivery(dependencies);
      if (claim === null) return;
      if (claim === "canceled") continue;
      const outcome = await attemptWebhookDelivery(claim, dependencies);
      await completeWebhookAttempt(claim, outcome, dependencies);
      attempts += 1;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, lane));
  return attempts;
}

/**
 * Manual retry by an OWNER/ADMIN. It keeps the same delivery id, event and body
 * and touches no quota. It brings a waiting retry forward or re-queues a
 * canceled delivery; a delivery that already used its six attempts stays FAILED
 * because the attempt history is capped at six entries.
 */
export async function retryWebhookDelivery(
  actor: Pick<Actor, "organizationId" | "userId" | "membershipRole">,
  deliveryId: string,
  dependencies: Pick<WebhookDeliveryDependencies, "database" | "now"> = webhookDeliveryDefaults(),
): Promise<void> {
  assertWebhookManager(actor);
  const now = dependencies.now();
  await dependencies.database.transaction(async (transaction) => {
    const entitled = await lockWebhookOrganization(actor.organizationId, transaction, now);
    const rows = await transaction.select({
      id: webhookDeliveries.id,
      status: webhookDeliveries.status,
      attemptCount: webhookDeliveries.attemptCount,
      endpointActive: webhookEndpoints.active,
    }).from(webhookDeliveries).innerJoin(webhookEndpoints, and(
      eq(webhookEndpoints.organizationId, webhookDeliveries.organizationId),
      eq(webhookEndpoints.id, webhookDeliveries.endpointId),
    )).where(and(eq(webhookDeliveries.organizationId, actor.organizationId), eq(webhookDeliveries.id, deliveryId)))
      .limit(1).for("update", { of: webhookDeliveries });
    const delivery = rows[0];
    if (!delivery) throw new AppError("not_found", "Entrega de webhook não encontrada.", 404);
    assertWebhookEntitlement(entitled);
    if (!delivery.endpointActive) throw new AppError("webhook_endpoint_disabled", "Ative o endpoint antes de reenviar.", 409);
    if (!canRetryWebhookDelivery(delivery.status, delivery.attemptCount)) {
      throw new AppError("webhook_retry_unavailable", "Esta entrega não pode ser reenviada.", 409);
    }
    await transaction.update(webhookDeliveries).set({
      status: "PENDING", nextAttemptAt: now, claimToken: null, leaseExpiresAt: null, updatedAt: now,
    }).where(and(
      eq(webhookDeliveries.organizationId, actor.organizationId),
      eq(webhookDeliveries.id, deliveryId),
      inArray(webhookDeliveries.status, ["PENDING", "CANCELED"]),
    ));
    await transaction.insert(auditLogs).values({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorType: "user",
      action: "webhook_delivery.retry_requested",
      resourceType: "webhook_delivery",
      resourceId: deliveryId,
      metadata: {},
      createdAt: now,
    });
  });
}

export function canRetryWebhookDelivery(status: string, attemptCount: number): boolean {
  return (status === "PENDING" || status === "CANCELED") && attemptCount < WEBHOOK_MAX_ATTEMPTS;
}
