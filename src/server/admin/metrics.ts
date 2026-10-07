import { and, count, desc, eq, gt, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import {
  conversions,
  getDb,
  memberships,
  organizations,
  outboxEvents,
  subscriptions,
  usagePeriods,
  user,
  webhookDeliveries,
  type UnoDatabase,
} from "@/db";
import {
  adminConversionPageSchema,
  adminJobPageSchema,
  adminOrganizationPageSchema,
  adminOverviewSchema,
  adminSubscriptionPageSchema,
  adminUsagePageSchema,
  pageQuerySchema,
  type AdminConversion,
  type AdminJob,
  type AdminOrganization,
  type AdminOverview,
  type AdminPage,
  type AdminSubscription,
  type AdminUsage,
} from "@/lib/admin-model";
import { AppError } from "@/lib/errors";

import { assertPlatformAdmin, type AdminIdentity } from "./access";

/*
 * Administration reads are metadata only: identifiers, states, versions,
 * timings, counters and safe error codes. Object keys, file names, error
 * messages, payloads, provider identifiers and secrets are never selected.
 */

type Reader = Pick<UnoDatabase, "select">;
type Cursor = { at: string; id: string };

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2}){0,2}$/;

function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string" && CURSOR_TIMESTAMP.test(parsed[0]) && parsed[1].length <= 64) {
      return { at: parsed[0], id: parsed[1] };
    }
  } catch {
    // Reported below as an invalid request.
  }
  throw new AppError("invalid_request", "A solicitação contém dados inválidos.", 400);
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), "utf8").toString("base64url");
}

function pageInput(raw: unknown) {
  const parsed = pageQuerySchema.parse(raw ?? {});
  return { limit: parsed.limit, cursor: decodeCursor(parsed.cursor) };
}

/** Keyset predicate on (created_at, id) descending, using the database's own timestamp text. */
function before(createdAt: PgColumn, id: PgColumn, cursor: Cursor | undefined): SQL | undefined {
  return cursor ? sql`(${createdAt}, ${id}) < (${cursor.at}::timestamptz, ${cursor.id})` : undefined;
}

function paginate<Row extends { id: string; cursorAt: string }, Item>(rows: Row[], limit: number, map: (row: Row) => Item): AdminPage<Item> {
  const visible = rows.slice(0, limit);
  const last = visible[visible.length - 1];
  return { items: visible.map(map), nextCursor: rows.length > limit && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null };
}

const iso = (value: Date | null) => value?.toISOString() ?? null;
const cursorText = (column: PgColumn) => sql<string>`${column}::text`;

function tally(rows: Array<{ key: string | null; value: number }>): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.key ?? "unknown", Number(row.value)]));
}

export async function adminOverview(identity: AdminIdentity, database: Reader = getDb(), now = new Date()): Promise<AdminOverview> {
  await assertPlatformAdmin(identity, database);
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const recent = sql`${conversions.createdAt} > ${since}::timestamptz`;
  const organizationTotal = await database.select({ value: count() }).from(organizations);
  const userTotal = await database.select({ value: count() }).from(user);
  const byPlan = await database.select({ key: sql<string>`${subscriptions.planId}::text`, value: count() }).from(subscriptions).groupBy(subscriptions.planId);
  const bySubscriptionStatus = await database.select({ key: sql<string>`${subscriptions.status}::text`, value: count() }).from(subscriptions).groupBy(subscriptions.status);
  const byConversionStatus = await database.select({ key: sql<string>`${conversions.status}::text`, value: count() }).from(conversions).groupBy(conversions.status);
  const recentTotal = await database.select({ value: count() }).from(conversions).where(recent);
  const failureCodes = await database.select({ key: conversions.errorCode, value: count() }).from(conversions)
    .where(and(eq(conversions.status, "failed"), recent)).groupBy(conversions.errorCode).orderBy(desc(count())).limit(10);
  const byOutboxStatus = await database.select({ key: sql<string>`${outboxEvents.status}::text`, value: count() }).from(outboxEvents).groupBy(outboxEvents.status);
  const byDeliveryStatus = await database.select({ key: sql<string>`${webhookDeliveries.status}::text`, value: count() }).from(webhookDeliveries).groupBy(webhookDeliveries.status);
  const usage = await database.select({
    activePeriods: count(),
    reserved: sql<number>`coalesce(sum(${usagePeriods.reserved}), 0)::integer`,
    confirmed: sql<number>`coalesce(sum(${usagePeriods.confirmed}), 0)::integer`,
  }).from(usagePeriods).where(gt(usagePeriods.periodEnd, now));

  return adminOverviewSchema.parse({
    generatedAt: now.toISOString(),
    organizations: Number(organizationTotal[0]?.value ?? 0),
    users: Number(userTotal[0]?.value ?? 0),
    subscriptionsByPlan: tally(byPlan),
    subscriptionsByStatus: tally(bySubscriptionStatus),
    conversionsByStatus: tally(byConversionStatus),
    conversionsLast24h: Number(recentTotal[0]?.value ?? 0),
    failuresLast24h: failureCodes.reduce((total, row) => total + Number(row.value), 0),
    failureCodesLast24h: failureCodes.map((row) => ({ code: row.key ?? "unknown", count: Number(row.value) })),
    outboxByStatus: tally(byOutboxStatus),
    webhookDeliveriesByStatus: tally(byDeliveryStatus),
    usage: {
      activePeriods: Number(usage[0]?.activePeriods ?? 0),
      reserved: Number(usage[0]?.reserved ?? 0),
      confirmed: Number(usage[0]?.confirmed ?? 0),
    },
  });
}

export async function listAdminOrganizations(identity: AdminIdentity, rawQuery: unknown, database: Reader = getDb()): Promise<AdminPage<AdminOrganization>> {
  await assertPlatformAdmin(identity, database);
  const { limit, cursor } = pageInput(rawQuery);
  const rows = await database.select({
    id: organizations.id,
    name: organizations.name,
    ownerUserId: organizations.ownerUserId,
    memberCount: sql<number>`(select count(*)::integer from ${memberships} where ${memberships.organizationId} = ${organizations.id})`,
    planId: subscriptions.planId,
    subscriptionStatus: subscriptions.status,
    createdAt: organizations.createdAt,
    cursorAt: cursorText(organizations.createdAt),
  }).from(organizations).leftJoin(subscriptions, eq(subscriptions.organizationId, organizations.id))
    .where(before(organizations.createdAt, organizations.id, cursor))
    .orderBy(desc(organizations.createdAt), desc(organizations.id)).limit(limit + 1);
  return adminOrganizationPageSchema.parse(paginate(rows, limit, (row) => ({
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId,
    memberCount: Number(row.memberCount),
    planId: row.planId,
    subscriptionStatus: row.subscriptionStatus,
    createdAt: row.createdAt.toISOString(),
  })));
}

export async function listAdminSubscriptions(identity: AdminIdentity, rawQuery: unknown, database: Reader = getDb()): Promise<AdminPage<AdminSubscription>> {
  await assertPlatformAdmin(identity, database);
  const { limit, cursor } = pageInput(rawQuery);
  const rows = await database.select({
    id: subscriptions.id,
    organizationId: subscriptions.organizationId,
    planId: subscriptions.planId,
    status: subscriptions.status,
    billingLinked: sql<boolean>`${subscriptions.stripeSubscriptionId} is not null`,
    currentPeriodStart: subscriptions.currentPeriodStart,
    currentPeriodEnd: subscriptions.currentPeriodEnd,
    cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
    reconciliationVersion: subscriptions.reconciliationVersion,
    lastReconciledAt: subscriptions.lastReconciledAt,
    createdAt: subscriptions.createdAt,
    cursorAt: cursorText(subscriptions.createdAt),
  }).from(subscriptions).where(before(subscriptions.createdAt, subscriptions.id, cursor))
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id)).limit(limit + 1);
  return adminSubscriptionPageSchema.parse(paginate(rows, limit, (row) => ({
    id: row.id,
    organizationId: row.organizationId,
    planId: row.planId,
    status: row.status,
    billingLinked: Boolean(row.billingLinked),
    currentPeriodStart: iso(row.currentPeriodStart),
    currentPeriodEnd: iso(row.currentPeriodEnd),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    reconciliationVersion: row.reconciliationVersion,
    lastReconciledAt: iso(row.lastReconciledAt),
    createdAt: row.createdAt.toISOString(),
  })));
}

export async function listAdminUsage(identity: AdminIdentity, rawQuery: unknown, database: Reader = getDb()): Promise<AdminPage<AdminUsage>> {
  await assertPlatformAdmin(identity, database);
  const { limit, cursor } = pageInput(rawQuery);
  const rows = await database.select({
    id: usagePeriods.id,
    organizationId: usagePeriods.organizationId,
    periodStart: usagePeriods.periodStart,
    periodEnd: usagePeriods.periodEnd,
    limit: usagePeriods.limit,
    reserved: usagePeriods.reserved,
    confirmed: usagePeriods.confirmed,
    createdAt: usagePeriods.createdAt,
    cursorAt: cursorText(usagePeriods.createdAt),
  }).from(usagePeriods).where(before(usagePeriods.createdAt, usagePeriods.id, cursor))
    .orderBy(desc(usagePeriods.createdAt), desc(usagePeriods.id)).limit(limit + 1);
  return adminUsagePageSchema.parse(paginate(rows, limit, (row) => ({
    id: row.id,
    organizationId: row.organizationId,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    limit: row.limit,
    reserved: row.reserved,
    confirmed: row.confirmed,
    createdAt: row.createdAt.toISOString(),
  })));
}

async function conversionPage(rawQuery: unknown, database: Reader, onlyFailures: boolean): Promise<AdminPage<AdminConversion>> {
  const { limit, cursor } = pageInput(rawQuery);
  const rows = await database.select({
    id: conversions.id,
    organizationId: conversions.organizationId,
    batchId: conversions.batchId,
    status: conversions.status,
    source: conversions.source,
    templateVersion: conversions.templateVersion,
    engineVersion: conversions.engineVersion,
    widthMm: conversions.outputWidthMm,
    heightMm: conversions.outputHeightMm,
    progress: conversions.progress,
    stage: conversions.currentStage,
    attempts: conversions.attempts,
    maxAttempts: conversions.maxAttempts,
    inputPages: conversions.inputPages,
    outputPages: conversions.outputPages,
    processingTimeMs: conversions.processingTimeMs,
    errorCode: conversions.errorCode,
    queuedAt: conversions.queuedAt,
    processingStartedAt: conversions.processingStartedAt,
    completedAt: conversions.completedAt,
    createdAt: conversions.createdAt,
    cursorAt: cursorText(conversions.createdAt),
  }).from(conversions)
    .where(and(onlyFailures ? eq(conversions.status, "failed") : undefined, before(conversions.createdAt, conversions.id, cursor)))
    .orderBy(desc(conversions.createdAt), desc(conversions.id)).limit(limit + 1);
  return adminConversionPageSchema.parse(paginate(rows, limit, (row) => ({
    id: row.id,
    organizationId: row.organizationId,
    batchId: row.batchId,
    status: row.status,
    source: row.source,
    templateVersion: row.templateVersion,
    engineVersion: row.engineVersion,
    widthMm: Number(row.widthMm),
    heightMm: Number(row.heightMm),
    progress: row.progress,
    stage: row.stage,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    inputPages: row.inputPages,
    outputPages: row.outputPages,
    processingTimeMs: row.processingTimeMs,
    errorCode: row.errorCode,
    queuedAt: row.queuedAt.toISOString(),
    processingStartedAt: iso(row.processingStartedAt),
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
  })));
}

export async function listAdminConversions(identity: AdminIdentity, rawQuery: unknown, database: Reader = getDb()): Promise<AdminPage<AdminConversion>> {
  await assertPlatformAdmin(identity, database);
  return conversionPage(rawQuery, database, false);
}

export async function listAdminFailures(identity: AdminIdentity, rawQuery: unknown, database: Reader = getDb()): Promise<AdminPage<AdminConversion>> {
  await assertPlatformAdmin(identity, database);
  return conversionPage(rawQuery, database, true);
}

/** Durable outbox jobs. Payloads and raw error text stay out of the response. */
export async function listAdminJobs(identity: AdminIdentity, rawQuery: unknown, database: Reader = getDb()): Promise<AdminPage<AdminJob>> {
  await assertPlatformAdmin(identity, database);
  const { limit, cursor } = pageInput(rawQuery);
  const rows = await database.select({
    id: outboxEvents.id,
    organizationId: outboxEvents.organizationId,
    type: outboxEvents.type,
    aggregateType: outboxEvents.aggregateType,
    aggregateId: outboxEvents.aggregateId,
    status: outboxEvents.status,
    attempts: outboxEvents.attempts,
    hasError: sql<boolean>`${outboxEvents.lastError} is not null`,
    availableAt: outboxEvents.availableAt,
    publishedAt: outboxEvents.publishedAt,
    createdAt: outboxEvents.createdAt,
    updatedAt: outboxEvents.updatedAt,
    cursorAt: cursorText(outboxEvents.createdAt),
  }).from(outboxEvents).where(before(outboxEvents.createdAt, outboxEvents.id, cursor))
    .orderBy(desc(outboxEvents.createdAt), desc(outboxEvents.id)).limit(limit + 1);
  return adminJobPageSchema.parse(paginate(rows, limit, (row) => ({
    id: row.id,
    organizationId: row.organizationId,
    type: row.type,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    status: row.status,
    attempts: row.attempts,
    hasError: Boolean(row.hasError),
    availableAt: row.availableAt.toISOString(),
    publishedAt: iso(row.publishedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })));
}
