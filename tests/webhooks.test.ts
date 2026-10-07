import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import {
  auditLogs,
  organizations,
  outboxEvents,
  subscriptions,
  user,
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookEndpoints,
  type UnoDatabase,
} from "@/db";
import {
  cancelUnentitledWebhookDeliveries,
  claimDueWebhookDelivery,
  completeWebhookAttempt,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  deliverDueWebhooks,
  fanOutPendingWebhookEvents,
  listWebhookDeliveries,
  listWebhookEndpoints,
  recoverExpiredWebhookClaims,
  retryWebhookDelivery,
  setWebhookEndpointActive,
  WEBHOOK_RETRY_DELAYS_MS,
  WebhookSendError,
  type PinnedRequest,
  type ResolvedAddress,
  type WebhookDeliveryClaim,
  type WebhookKeyring,
} from "@/server/webhooks";

const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000111";
const OTHER_ORG = "00000000-0000-4000-8000-000000000112";
const CONVERSION = "00000000-0000-4000-8000-000000000501";
const BATCH = "00000000-0000-4000-8000-000000000601";
const START = new Date("2026-10-07T12:00:00.000Z");
const PUBLIC_ADDRESS: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const TIMEOUT_MS = 10_000;

const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;
const keyring: WebhookKeyring = { currentVersion: "v1", keys: new Map([["v1", randomBytes(32)]]) };

let clock = START;
let dnsAnswer: ResolvedAddress[] = [PUBLIC_ADDRESS];
let dnsLookups = 0;
let responses: (number | Error)[] = [];
let requests: PinnedRequest[] = [];

const now = () => clock;
const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
const resolve = async () => { dnsLookups += 1; return dnsAnswer; };

const endpointDeps = (maxActiveEndpoints = 10) => ({ database, resolve, keyring: () => keyring, maxActiveEndpoints, dnsTimeoutMs: 1_000, now });
const deliveryDeps = () => ({
  database,
  keyring: () => keyring,
  timeoutMs: TIMEOUT_MS,
  randomId: () => randomUUID(),
  now,
  transport: {
    resolve,
    connect: async (request: PinnedRequest) => {
      requests.push(request);
      const next = responses.shift() ?? 200;
      if (next instanceof Error) throw next;
      return { status: next };
    },
  },
});
const fanoutDeps = () => ({ database, randomId: () => randomUUID(), now });
const deliver = () => deliverDueWebhooks({ concurrency: 1 }, deliveryDeps());

const owner = { organizationId: ORG, userId: USER, membershipRole: "OWNER" as const };
const admin = { ...owner, membershipRole: "ADMIN" as const };
const member = { ...owner, membershipRole: "MEMBER" as const };
const stranger = { organizationId: OTHER_ORG, userId: USER, membershipRole: "OWNER" as const };
const URL_A = "https://receiver.example.com/hooks/uno";

async function migrate() {
  const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const migration = await readFile(`${directory}/${name}`, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await pglite.exec(statement);
  }
}

async function setPlan(organizationId: string, planId: "FREE" | "PRO" | "BUSINESS") {
  await database.update(subscriptions).set(planId === "FREE"
    ? { planId, currentPeriodStart: null, currentPeriodEnd: null }
    : { planId, status: "ACTIVE", currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-12-01") })
    .where(eq(subscriptions.organizationId, organizationId));
}

async function emit(
  type: string,
  payload: Record<string, unknown>,
  options: { organizationId?: string; createdAt?: Date } = {},
): Promise<string> {
  const id = randomUUID();
  const createdAt = options.createdAt ?? clock;
  await database.insert(outboxEvents).values({
    id,
    organizationId: options.organizationId ?? ORG,
    type,
    aggregateType: type.split(".")[0]!,
    aggregateId: String(payload.conversionId ?? payload.batchId ?? id),
    deduplicationKey: `${type}.${id}`,
    payload,
    availableAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt,
    updatedAt: createdAt,
  });
  return id;
}

async function deliveries() {
  return database.select().from(webhookDeliveries).orderBy(asc(webhookDeliveries.createdAt), asc(webhookDeliveries.id));
}

async function singleDelivery() {
  const rows = await deliveries();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** One subscribed endpoint and one fanned-out, not yet attempted delivery. */
async function pendingDelivery() {
  const endpoint = await createWebhookEndpoint(owner, { url: URL_A, events: ["conversion.completed"] }, endpointDeps());
  advance(1_000);
  const eventId = await emit("conversion.completed", { conversionId: CONVERSION });
  await fanOutPendingWebhookEvents({}, fanoutDeps());
  return { endpoint, eventId, delivery: await singleDelivery() };
}

beforeAll(async () => {
  await migrate();
  await database.insert(user).values({ id: USER, name: "Webhook", email: "webhook@example.test", emailVerified: true });
  await database.insert(organizations).values([
    { id: ORG, name: "Webhook Org", slug: "webhook-org", ownerUserId: USER },
    { id: OTHER_ORG, name: "Other", slug: "webhook-other", ownerUserId: USER },
  ]);
});

beforeEach(async () => {
  clock = START;
  dnsAnswer = [PUBLIC_ADDRESS];
  dnsLookups = 0;
  responses = [];
  requests = [];
  await database.delete(webhookEndpoints);
  await database.delete(outboxEvents);
  await database.delete(auditLogs);
  await database.delete(subscriptions);
  await database.insert(subscriptions).values([
    { organizationId: ORG, planId: "PRO", status: "ACTIVE", currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-12-01") },
    { organizationId: OTHER_ORG, planId: "BUSINESS", status: "ACTIVE", currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-12-01") },
  ]);
});

afterAll(async () => { await pglite.close(); });

describe("webhook endpoint management", () => {
  it("shows the secret once, stores only ciphertext and audits identifiers only", async () => {
    const created = await createWebhookEndpoint(owner, { url: "https://Receiver.example.com:443/hooks/uno", events: ["conversion.completed", "batch.completed"] }, endpointDeps());
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(created).toMatchObject({ url: URL_A, events: ["conversion.completed", "batch.completed"], active: true, disabledAt: null });

    const stored = (await database.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, created.id)))[0]!;
    expect(stored.encryptionKeyVersion).toBe("v1");
    expect(JSON.stringify(stored)).not.toContain(created.secret);

    const listed = await listWebhookEndpoints(admin, endpointDeps());
    expect(listed.maxActiveEndpoints).toBe(10);
    expect(listed.items).toEqual([{ ...created, secret: undefined }]);
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(created.secret);
    expect(serialized).not.toContain(stored.secretCiphertext);
    expect(serialized).not.toMatch(/secret|ciphertext|authTag|iv"/i);

    const audit = await database.select().from(auditLogs);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      organizationId: ORG, actorUserId: USER, actorType: "user", action: "webhook_endpoint.created",
      resourceType: "webhook_endpoint", resourceId: created.id, metadata: {},
    });
    expect(JSON.stringify(audit)).not.toContain("receiver.example.com");
  });

  it("enforces role, input, destination, plan and the active endpoint limit", async () => {
    const input = { url: URL_A, events: ["conversion.completed"] };
    await expect(createWebhookEndpoint(member, input, endpointDeps())).rejects.toMatchObject({ code: "forbidden" });
    await expect(listWebhookEndpoints(member, endpointDeps())).rejects.toMatchObject({ code: "forbidden" });
    await expect(createWebhookEndpoint(owner, { url: URL_A, events: [] }, endpointDeps())).rejects.toThrow();
    await expect(createWebhookEndpoint(owner, { url: URL_A, events: ["conversion.queued"] }, endpointDeps())).rejects.toThrow();
    await expect(createWebhookEndpoint(owner, { url: URL_A, events: ["batch.completed", "batch.completed"] }, endpointDeps())).rejects.toThrow();
    await expect(createWebhookEndpoint(owner, { ...input, secret: "chosen" }, endpointDeps())).rejects.toThrow();
    await expect(createWebhookEndpoint(owner, { ...input, url: "http://receiver.example.com/hook" }, endpointDeps()))
      .rejects.toMatchObject({ code: "invalid_webhook_url" });
    await expect(createWebhookEndpoint(owner, { ...input, url: "https://10.0.0.8/hook" }, endpointDeps()))
      .rejects.toMatchObject({ code: "invalid_webhook_url" });

    dnsAnswer = [PUBLIC_ADDRESS, { address: "10.0.0.8", family: 4 }];
    await expect(createWebhookEndpoint(owner, input, endpointDeps())).rejects.toMatchObject({ code: "webhook_destination_not_allowed" });
    dnsAnswer = [PUBLIC_ADDRESS];
    expect(await database.select().from(webhookEndpoints)).toHaveLength(0);

    const first = await createWebhookEndpoint(owner, input, endpointDeps(2));
    const second = await createWebhookEndpoint(owner, input, endpointDeps(2));
    await expect(createWebhookEndpoint(owner, input, endpointDeps(2))).rejects.toMatchObject({ code: "webhook_endpoint_limit_exceeded", status: 409 });
    await setWebhookEndpointActive(owner, first.id, { active: false }, endpointDeps(2));
    const third = await createWebhookEndpoint(owner, input, endpointDeps(2));
    await expect(setWebhookEndpointActive(owner, first.id, { active: true }, endpointDeps(2))).rejects.toMatchObject({ code: "webhook_endpoint_limit_exceeded" });

    await setPlan(ORG, "FREE");
    await expect(createWebhookEndpoint(owner, input, endpointDeps())).rejects.toMatchObject({ code: "plan_required", status: 403 });
    await expect(setWebhookEndpointActive(owner, first.id, { active: true }, endpointDeps())).rejects.toMatchObject({ code: "plan_required" });
    await expect(listWebhookEndpoints(owner, endpointDeps())).resolves.toMatchObject({ items: expect.any(Array) });
    await expect(setWebhookEndpointActive(owner, second.id, { active: false }, endpointDeps())).resolves.toMatchObject({ active: false });
    await expect(deleteWebhookEndpoint(owner, third.id, endpointDeps())).resolves.toBeUndefined();
    expect((await listWebhookEndpoints(owner, endpointDeps())).items.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
  });

  it("isolates organizations for every operation", async () => {
    const { endpoint, delivery } = await pendingDelivery();
    const foreign = await createWebhookEndpoint(stranger, { url: "https://other.example.org/hook", events: ["conversion.completed"] }, endpointDeps());

    expect((await listWebhookEndpoints(stranger, endpointDeps())).items.map((item) => item.id)).toEqual([foreign.id]);
    expect((await listWebhookDeliveries(stranger, {}, database)).items).toEqual([]);
    await expect(listWebhookDeliveries(stranger, { endpointId: endpoint.id }, database)).resolves.toMatchObject({ items: [] });
    await expect(setWebhookEndpointActive(stranger, endpoint.id, { active: false }, endpointDeps())).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteWebhookEndpoint(stranger, endpoint.id, endpointDeps())).rejects.toMatchObject({ code: "not_found" });
    await expect(retryWebhookDelivery(stranger, delivery.id, deliveryDeps())).rejects.toMatchObject({ code: "not_found" });
    expect((await singleDelivery()).status).toBe("PENDING");
    expect((await listWebhookEndpoints(owner, endpointDeps())).items[0]).toMatchObject({ id: endpoint.id, active: true });

    // An event of the other organization never reaches this organization's endpoint.
    advance(1_000);
    await emit("conversion.completed", { conversionId: CONVERSION }, { organizationId: OTHER_ORG });
    await fanOutPendingWebhookEvents({}, fanoutDeps());
    const all = await deliveries();
    expect(all.filter((row) => row.organizationId === ORG)).toHaveLength(1);
    expect(all.filter((row) => row.organizationId === OTHER_ORG).map((row) => row.endpointId)).toEqual([foreign.id]);
  });
});

describe("webhook fan-out", () => {
  it("creates one immutable delivery per eligible endpoint and is idempotent", async () => {
    const subscribed = await createWebhookEndpoint(owner, { url: URL_A, events: ["conversion.completed"] }, endpointDeps());
    const both = await createWebhookEndpoint(owner, { url: "https://second.example.com/hook", events: ["conversion.completed", "conversion.failed"] }, endpointDeps());
    const otherType = await createWebhookEndpoint(owner, { url: URL_A, events: ["batch.completed"] }, endpointDeps());
    const disabled = await createWebhookEndpoint(owner, { url: URL_A, events: ["conversion.completed"] }, endpointDeps());
    const toggled = await createWebhookEndpoint(owner, { url: URL_A, events: ["conversion.completed"] }, endpointDeps());
    await setWebhookEndpointActive(owner, disabled.id, { active: false }, endpointDeps());
    await setWebhookEndpointActive(owner, toggled.id, { active: false }, endpointDeps());

    advance(1_000);
    const occurredAt = clock;
    const eventId = await emit("conversion.completed", {
      conversionId: CONVERSION,
      originalFileName: "etiqueta-sintetica.pdf",
      downloadUrl: "https://storage.example.com/signed?X-Amz-Signature=abc",
      apiKey: "uno_synthetic",
    });

    // Created or re-enabled after the event occurred: never receives it retroactively.
    advance(1_000);
    const late = await createWebhookEndpoint(owner, { url: URL_A, events: ["conversion.completed"] }, endpointDeps());
    await setWebhookEndpointActive(owner, toggled.id, { active: true }, endpointDeps());

    expect(await fanOutPendingWebhookEvents({}, fanoutDeps())).toBe(1);
    const rows = await deliveries();
    expect(rows.map((row) => row.endpointId).sort()).toEqual([subscribed.id, both.id].sort());
    expect(rows.map((row) => row.endpointId)).not.toContain(otherType.id);
    expect(rows.map((row) => row.endpointId)).not.toContain(late.id);

    const expectedBody = JSON.stringify({
      id: eventId,
      type: "conversion.completed",
      createdAt: occurredAt.toISOString(),
      organizationId: ORG,
      data: { conversionId: CONVERSION, status: "completed" },
    });
    for (const row of rows) {
      expect(row.body).toBe(expectedBody);
      expect(row).toMatchObject({ status: "PENDING", attemptCount: 0, eventType: "conversion.completed", outboxEventId: eventId });
      expect(row.body).not.toMatch(/etiqueta|pdf|signed|Signature|uno_synthetic/);
    }
    expect((await database.select().from(outboxEvents).where(eq(outboxEvents.id, eventId)))[0]).toMatchObject({ status: "PUBLISHED" });

    // Replaying the same outbox event (crash before commit, manual requeue) adds nothing.
    expect(await fanOutPendingWebhookEvents({}, fanoutDeps())).toBe(0);
    await database.update(outboxEvents).set({ status: "PENDING" }).where(eq(outboxEvents.id, eventId));
    expect(await fanOutPendingWebhookEvents({}, fanoutDeps())).toBe(1);
    const replayed = await deliveries();
    expect(replayed.map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
    expect(replayed.every((row) => row.body === expectedBody)).toBe(true);
  });

  it("serializes safe data for failures and batches and ignores other event types", async () => {
    const endpoint = await createWebhookEndpoint(owner, { url: URL_A, events: ["conversion.failed", "batch.completed"] }, endpointDeps());
    advance(1_000);
    const failedId = await emit("conversion.failed", { conversionId: CONVERSION, errorCode: "codes_unreadable", text: "conteudo sintetico" });
    advance(1);
    const batchId = await emit("batch.completed", { batchId: BATCH, status: "failed", completedCount: 3, failedCount: 2, itemNames: ["a.pdf"] });
    advance(1);
    const queuedId = await emit("conversion.queued", { conversionId: CONVERSION });
    const invalidId = await emit("batch.completed", { batchId: "not-a-uuid", status: "completed", completedCount: 1, failedCount: 0 });

    expect(await fanOutPendingWebhookEvents({}, fanoutDeps())).toBe(3);
    const rows = await deliveries();
    expect(rows.map((row) => row.endpointId)).toEqual([endpoint.id, endpoint.id]);
    const bodies = new Map(rows.map((row) => [row.outboxEventId, JSON.parse(row.body) as Record<string, unknown>]));
    expect(bodies.get(failedId)).toMatchObject({
      id: failedId, type: "conversion.failed", organizationId: ORG,
      data: { conversionId: CONVERSION, status: "failed", error: { code: "codes_unreadable", message: expect.any(String) } },
    });
    expect(Object.keys(bodies.get(failedId)!)).toEqual(["id", "type", "createdAt", "organizationId", "data"]);
    expect(bodies.get(batchId)!.data).toEqual({ batchId: BATCH, status: "failed", counts: { completed: 3, failed: 2 } });
    expect(rows.map((row) => row.body).join("")).not.toMatch(/sintetico|a\.pdf|itemNames/);
    // conversion.queued belongs to the job publisher and is left untouched.
    expect((await database.select().from(outboxEvents).where(eq(outboxEvents.id, queuedId)))[0]).toMatchObject({ status: "PENDING" });
    expect((await database.select().from(outboxEvents).where(eq(outboxEvents.id, invalidId)))[0]).toMatchObject({ status: "PUBLISHED", lastError: "invalid_payload" });
  });

  it("creates no deliveries for an organization without the API plan", async () => {
    await createWebhookEndpoint(owner, { url: URL_A, events: ["conversion.completed"] }, endpointDeps());
    await setPlan(ORG, "FREE");
    advance(1_000);
    const eventId = await emit("conversion.completed", { conversionId: CONVERSION });
    expect(await fanOutPendingWebhookEvents({}, fanoutDeps())).toBe(1);
    expect(await deliveries()).toHaveLength(0);
    await setPlan(ORG, "PRO");
    expect(await fanOutPendingWebhookEvents({}, fanoutDeps())).toBe(0);
    expect(await deliveries()).toHaveLength(0);
    expect((await database.select().from(outboxEvents).where(eq(outboxEvents.id, eventId)))[0]!.status).toBe("PUBLISHED");
  });
});

describe("webhook delivery", () => {
  it("sends the exact stored body with timestamp, stable delivery id and signature", async () => {
    const { endpoint, delivery } = await pendingDelivery();
    advance(2_500);
    expect(await deliver()).toBe(1);

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const timestamp = Math.floor(clock.getTime() / 1_000);
    expect(request.body).toBe(delivery.body);
    expect(request).toMatchObject({ address: PUBLIC_ADDRESS.address, family: 4, port: 443, hostname: "receiver.example.com", path: "/hooks/uno" });
    expect(request.headers["x-label-timestamp"]).toBe(String(timestamp));
    expect(request.headers["x-label-delivery"]).toBe(delivery.id);
    expect(request.headers["x-label-signature"]).toBe(
      `v1=${createHmac("sha256", endpoint.secret).update(`${timestamp}.${request.body}`, "utf8").digest("hex")}`,
    );
    expect(request.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(request.headers["content-length"]).toBe(String(Buffer.byteLength(delivery.body)));

    const stored = await singleDelivery();
    expect(stored).toMatchObject({ status: "DELIVERED", attemptCount: 1, lastResponseStatus: 200, lastError: null, claimToken: null, leaseExpiresAt: null, body: delivery.body });
    expect(stored.deliveredAt?.toISOString()).toBe(clock.toISOString());
    const attempts = await database.select().from(webhookDeliveryAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ deliveryId: delivery.id, organizationId: ORG, attemptNumber: 1, responseStatus: 200, error: null });
    expect(attempts[0]!.finishedAt).not.toBeNull();
    expect(await deliver()).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("retries after 1m/5m/30m/2h/12h with the same id and body, then fails terminally", async () => {
    const { endpoint, delivery } = await pendingDelivery();
    responses = [500, new WebhookSendError("timeout"), 302, new WebhookSendError("network_error"), 429, 503];
    const expectedErrors = ["http_status", "timeout", "http_status", "network_error", "http_status", "http_status"];
    const expectedStatuses = [500, null, 302, null, 429, 503];

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect(await deliver()).toBe(1);
      const stored = await singleDelivery();
      expect(stored.attemptCount).toBe(attempt);
      expect(stored.lastError).toBe(expectedErrors[attempt - 1]);
      expect(stored.lastResponseStatus).toBe(expectedStatuses[attempt - 1]);
      expect(stored.claimToken).toBeNull();
      if (attempt < 6) {
        const delay = WEBHOOK_RETRY_DELAYS_MS[attempt - 1]!;
        expect(stored.status).toBe("PENDING");
        expect(stored.nextAttemptAt.getTime() - clock.getTime()).toBe(delay);
        // Not due one millisecond early.
        advance(delay - 1);
        expect(await deliver()).toBe(0);
        advance(1);
      } else {
        expect(stored.status).toBe("FAILED");
      }
    }
    expect(WEBHOOK_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 43_200_000]);

    expect(requests).toHaveLength(6);
    expect(new Set(requests.map((request) => request.headers["x-label-delivery"]))).toEqual(new Set([delivery.id]));
    expect(new Set(requests.map((request) => request.body))).toEqual(new Set([delivery.body]));
    expect(new Set(requests.map((request) => request.headers["x-label-timestamp"])).size).toBe(6);
    expect(new Set(requests.map((request) => request.headers["x-label-signature"])).size).toBe(6);
    for (const request of requests) {
      const timestamp = request.headers["x-label-timestamp"]!;
      expect(request.headers["x-label-signature"]).toBe(`v1=${createHmac("sha256", endpoint.secret).update(`${timestamp}.${request.body}`).digest("hex")}`);
    }

    const attempts = await database.select().from(webhookDeliveryAttempts).orderBy(asc(webhookDeliveryAttempts.attemptNumber));
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(attempts.map((attempt) => attempt.error)).toEqual(expectedErrors);
    expect(attempts.map((attempt) => attempt.responseStatus)).toEqual(expectedStatuses);

    // Terminal: no seventh attempt, automatic or manual.
    advance(7 * 24 * 3_600_000);
    expect(await deliver()).toBe(0);
    await expect(retryWebhookDelivery(owner, delivery.id, deliveryDeps())).rejects.toMatchObject({ code: "webhook_retry_unavailable", status: 409 });
    expect(requests).toHaveLength(6);
    expect((await singleDelivery()).status).toBe("FAILED");
  });

  it("ignores the result of a stale claim after the lease expired", async () => {
    const { delivery } = await pendingDelivery();
    const stale = await claimDueWebhookDelivery(deliveryDeps()) as WebhookDeliveryClaim;
    expect(stale).toMatchObject({ id: delivery.id, attemptNumber: 1 });
    expect(await claimDueWebhookDelivery(deliveryDeps())).toBeNull();

    // Within the lease nothing is reclaimed.
    advance(TIMEOUT_MS);
    expect(await recoverExpiredWebhookClaims(deliveryDeps())).toBe(0);
    advance(60_000);
    expect(await recoverExpiredWebhookClaims(deliveryDeps())).toBe(1);
    const recovered = await singleDelivery();
    expect(recovered).toMatchObject({ status: "PENDING", attemptCount: 1, lastError: "lease_expired", claimToken: null });
    expect(recovered.nextAttemptAt.getTime() - clock.getTime()).toBe(60_000);

    advance(60_000);
    const fresh = await claimDueWebhookDelivery(deliveryDeps()) as WebhookDeliveryClaim;
    expect(fresh).toMatchObject({ id: delivery.id, attemptNumber: 2 });
    expect(fresh.token).not.toBe(stale.token);

    // The first worker finally reports success: it must not overwrite newer state.
    expect(await completeWebhookAttempt(stale, { status: 200 }, deliveryDeps())).toBe(false);
    expect(await singleDelivery()).toMatchObject({ status: "PROCESSING", attemptCount: 2, claimToken: fresh.token, deliveredAt: null });
    const first = (await database.select().from(webhookDeliveryAttempts).where(eq(webhookDeliveryAttempts.attemptNumber, 1)))[0]!;
    expect(first).toMatchObject({ error: "lease_expired", responseStatus: null });

    expect(await completeWebhookAttempt(fresh, { status: 204 }, deliveryDeps())).toBe(true);
    expect(await singleDelivery()).toMatchObject({ status: "DELIVERED", attemptCount: 2, lastResponseStatus: 204 });
    // A duplicate completion of an already settled claim is also a no-op.
    expect(await completeWebhookAttempt(fresh, { error: "timeout" }, deliveryDeps())).toBe(false);
    expect((await singleDelivery()).status).toBe("DELIVERED");
  });

  it("cancels pending deliveries on downgrade and does not resend after the plan returns", async () => {
    const { delivery } = await pendingDelivery();
    await setPlan(ORG, "FREE");
    expect(await deliver()).toBe(0);
    expect(await singleDelivery()).toMatchObject({ id: delivery.id, status: "CANCELED", lastError: "plan_required", attemptCount: 0 });
    await setPlan(ORG, "PRO");
    advance(3_600_000);
    expect(await deliver()).toBe(0);
    expect(requests).toHaveLength(0);
    expect((await singleDelivery()).status).toBe("CANCELED");
  });

  it("cancels a scheduled retry when the plan is lost before it is due", async () => {
    await pendingDelivery();
    responses = [500];
    expect(await deliver()).toBe(1);
    expect((await singleDelivery()).status).toBe("PENDING");
    await setPlan(ORG, "FREE");
    expect(await cancelUnentitledWebhookDeliveries(deliveryDeps())).toBe(1);
    expect(await singleDelivery()).toMatchObject({ status: "CANCELED", lastError: "plan_required", attemptCount: 1 });
    await setPlan(ORG, "BUSINESS");
    expect(await cancelUnentitledWebhookDeliveries(deliveryDeps())).toBe(0);
    advance(24 * 3_600_000);
    expect(await deliver()).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("cancels pending and in-flight deliveries when the endpoint is disabled or deleted", async () => {
    const { endpoint, delivery } = await pendingDelivery();
    await setWebhookEndpointActive(owner, endpoint.id, { active: false }, endpointDeps());
    expect(await singleDelivery()).toMatchObject({ status: "CANCELED", lastError: "endpoint_disabled" });
    const reenabled = await setWebhookEndpointActive(owner, endpoint.id, { active: true }, endpointDeps());
    expect(reenabled).toMatchObject({ active: true, disabledAt: null });
    advance(3_600_000);
    expect(await deliver()).toBe(0);
    expect(requests).toHaveLength(0);
    expect((await singleDelivery()).status).toBe("CANCELED");
    expect((await database.select().from(auditLogs)).map((row) => row.action)).toEqual([
      "webhook_endpoint.created", "webhook_endpoint.disabled", "webhook_endpoint.enabled",
    ]);

    // Disabled while an attempt is in flight: its late result is discarded.
    advance(1_000);
    await emit("conversion.completed", { conversionId: CONVERSION });
    await fanOutPendingWebhookEvents({}, fanoutDeps());
    const claim = await claimDueWebhookDelivery(deliveryDeps()) as WebhookDeliveryClaim;
    expect(claim.id).not.toBe(delivery.id);
    await setWebhookEndpointActive(owner, endpoint.id, { active: false }, endpointDeps());
    expect(await completeWebhookAttempt(claim, { status: 200 }, deliveryDeps())).toBe(false);
    expect((await deliveries()).map((row) => row.status)).toEqual(["CANCELED", "CANCELED"]);

    // A delivery that raced the disable is canceled at claim time, never sent.
    await database.update(webhookDeliveries).set({ status: "PENDING", nextAttemptAt: clock }).where(eq(webhookDeliveries.id, claim.id));
    expect(await claimDueWebhookDelivery(deliveryDeps())).toBe("canceled");
    expect(requests).toHaveLength(0);

    await deleteWebhookEndpoint(owner, endpoint.id, endpointDeps());
    expect(await deliveries()).toHaveLength(0);
    expect(await database.select().from(webhookDeliveryAttempts)).toHaveLength(0);
    await expect(deleteWebhookEndpoint(owner, endpoint.id, endpointDeps())).rejects.toMatchObject({ code: "not_found" });
  });

  it("revalidates DNS on every send and never connects to a rebound private address", async () => {
    await pendingDelivery();
    expect(dnsLookups).toBe(1);
    dnsAnswer = [{ address: "169.254.169.254", family: 4 }];
    expect(await deliver()).toBe(1);
    expect(requests).toHaveLength(0);
    expect(await singleDelivery()).toMatchObject({ status: "PENDING", attemptCount: 1, lastError: "destination_not_allowed", lastResponseStatus: null });

    dnsAnswer = [PUBLIC_ADDRESS, { address: "::ffff:127.0.0.1", family: 6 }];
    advance(60_000);
    expect(await deliver()).toBe(1);
    expect(requests).toHaveLength(0);

    dnsAnswer = [{ address: "8.8.4.4", family: 4 }];
    advance(300_000);
    const lookupsBefore = dnsLookups;
    expect(await deliver()).toBe(1);
    expect(dnsLookups).toBe(lookupsBefore + 1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ address: "8.8.4.4", hostname: "receiver.example.com" });
    expect(await singleDelivery()).toMatchObject({ status: "DELIVERED", attemptCount: 3 });
  });

  it("fails closed when the stored secret cannot be decrypted", async () => {
    const { endpoint } = await pendingDelivery();
    await database.update(webhookEndpoints).set({ organizationId: ORG, secretAuthTag: Buffer.alloc(16).toString("base64") }).where(eq(webhookEndpoints.id, endpoint.id));
    expect(await deliver()).toBe(1);
    expect(requests).toHaveLength(0);
    expect(await singleDelivery()).toMatchObject({ status: "PENDING", attemptCount: 1, lastError: "secret_unavailable" });
  });
});

describe("webhook delivery history and manual retry", () => {
  it("paginates deliveries of the organization without exposing bodies", async () => {
    const endpoint = await createWebhookEndpoint(owner, { url: URL_A, events: ["conversion.completed"] }, endpointDeps());
    const eventIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      advance(1_000);
      eventIds.push(await emit("conversion.completed", { conversionId: CONVERSION }));
      await fanOutPendingWebhookEvents({}, fanoutDeps());
    }
    responses = [200, 500];
    expect(await deliverDueWebhooks({ concurrency: 1, limit: 2 }, deliveryDeps())).toBe(2);

    await expect(listWebhookDeliveries(member, {}, database)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listWebhookDeliveries(owner, { limit: 500 }, database)).rejects.toThrow();
    await expect(listWebhookDeliveries(owner, { cursor: "bm90LWEtY3Vyc29y" }, database)).rejects.toMatchObject({ code: "invalid_cursor" });

    const first = await listWebhookDeliveries(owner, { limit: "2" }, database);
    expect(first.items.map((item) => item.eventId)).toEqual([eventIds[4], eventIds[3]]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await listWebhookDeliveries(owner, { limit: 2, cursor: first.nextCursor! }, database);
    const third = await listWebhookDeliveries(owner, { limit: 2, cursor: second.nextCursor!, endpointId: endpoint.id }, database);
    expect([...second.items, ...third.items].map((item) => item.eventId)).toEqual([eventIds[2], eventIds[1], eventIds[0]]);
    expect(third.nextCursor).toBeNull();

    const oldest = third.items[0]!;
    expect(oldest).toMatchObject({ status: "delivered", attemptCount: 1, lastResponseStatus: 200, nextAttemptAt: null, canRetry: false, eventType: "conversion.completed" });
    expect(oldest.attempts).toEqual([expect.objectContaining({ attemptNumber: 1, responseStatus: 200, error: null })]);
    expect(second.items[1]).toMatchObject({ status: "pending", attemptCount: 1, lastResponseStatus: 500, lastError: "http_status", canRetry: true });
    expect(JSON.stringify([first, second, third])).not.toMatch(/"body"|whsec_|ciphertext/);
  });

  it("lets a manager bring a retry forward or re-queue a canceled delivery with the same id and body", async () => {
    const { endpoint, delivery } = await pendingDelivery();
    responses = [500, 500, 200];
    expect(await deliver()).toBe(1);
    await expect(retryWebhookDelivery(member, delivery.id, deliveryDeps())).rejects.toMatchObject({ code: "forbidden" });
    await expect(retryWebhookDelivery(owner, randomUUID(), deliveryDeps())).rejects.toMatchObject({ code: "not_found" });
    expect(await deliver()).toBe(0);

    advance(5_000);
    await retryWebhookDelivery(admin, delivery.id, deliveryDeps());
    expect(await deliver()).toBe(1);
    expect(await singleDelivery()).toMatchObject({ id: delivery.id, status: "PENDING", attemptCount: 2, body: delivery.body });

    await setWebhookEndpointActive(owner, endpoint.id, { active: false }, endpointDeps());
    await expect(retryWebhookDelivery(owner, delivery.id, deliveryDeps())).rejects.toMatchObject({ code: "webhook_endpoint_disabled" });
    await setWebhookEndpointActive(owner, endpoint.id, { active: true }, endpointDeps());
    await setPlan(ORG, "FREE");
    await expect(retryWebhookDelivery(owner, delivery.id, deliveryDeps())).rejects.toMatchObject({ code: "plan_required" });
    await setPlan(ORG, "PRO");
    expect(await deliver()).toBe(0);

    await retryWebhookDelivery(owner, delivery.id, deliveryDeps());
    expect(await deliver()).toBe(1);
    expect(await singleDelivery()).toMatchObject({ id: delivery.id, status: "DELIVERED", attemptCount: 3, body: delivery.body });
    expect(requests.map((request) => request.headers["x-label-delivery"])).toEqual([delivery.id, delivery.id, delivery.id]);
    expect(new Set(requests.map((request) => request.body)).size).toBe(1);
    await expect(retryWebhookDelivery(owner, delivery.id, deliveryDeps())).rejects.toMatchObject({ code: "webhook_retry_unavailable" });
    const actions = (await database.select().from(auditLogs).orderBy(asc(auditLogs.createdAt))).map((row) => row.action);
    expect(actions.filter((action) => action === "webhook_delivery.retry_requested")).toHaveLength(2);
    expect((await database.select().from(auditLogs)).every((row) => Object.keys(row.metadata).length === 0)).toBe(true);
  });
});
