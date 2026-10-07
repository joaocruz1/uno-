import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { auditLogs, conversions, memberships, organizations, outboxEvents, subscriptions, templateReleases, templates, usagePeriods, user, type UnoDatabase } from "@/db";
import { ENGINE_VERSION, TEMPLATE_KEY, TEMPLATE_VERSION } from "@/engine/types";
import {
  adminOverview,
  assertPlatformAdmin,
  canonicalJson,
  listAdminConversions,
  listAdminFailures,
  listAdminJobs,
  listAdminOrganizations,
  listAdminSubscriptions,
  listAdminTemplates,
  listAdminUsage,
  publishTemplateRelease,
} from "@/server/admin";
import { isPlatformAdmin } from "@/server/auth/actor";
import { assertTemplateEligible } from "@/server/conversions/templates";

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const ADMIN = id(1);
const ROLE_ONLY = id(2);
const LISTED_ONLY = id(3);
const ORG_OWNER = id(4);
const ORG = id(101);
const OTHER_ORG = id(102);
const TEMPLATE = id(10);
const OLD_TEMPLATE = id(11);
const NOW = new Date("2026-10-07T12:00:00.000Z");
const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;
const admin = { userId: ADMIN };
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const previousAllowlist = process.env.ADMIN_EMAILS;

const CODES = [
  { role: "logistics_barcode", format: "CODE_128", value: "SYNTH-001" },
  { role: "logistics_qr", format: "QR_CODE", value: "https://example.invalid/synthetic/uno/001" },
  { role: "danfe_barcode", format: "CODE_128", value: "35100100000000000000" },
] as const;

function automaticReport(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runId: id(900),
    createdAt: "2026-10-06T10:00:00.000Z",
    fixture: "synthetic-pdf-v1",
    variants: { scanned: false, additional: false },
    inputSha256: "a".repeat(64),
    outputSha256: "b".repeat(64),
    versions: { engine: ENGINE_VERSION, templateKey: TEMPLATE_KEY, template: TEMPLATE_VERSION },
    widthMm: 100,
    heightMm: 150,
    pageCount: 1,
    validation: { contentPreserved: true, geometryValid: true, codesEquivalent: true },
    validationPolicy: { codesDpi: [203, 300], pixelContentDpi: [203] },
    timingsMs: { analyze: 1, detect: 1, extract: 1, layout: 1, compose: 1, validate: 1 },
    syntheticExpectedCodes: CODES,
    physicalApproval: "NOT VERIFIED",
    ...overrides,
  }, null, 2);
}

function physicalProof(report: string, overrides: Record<string, unknown> = {}) {
  return {
    runId: id(900),
    fixture: "synthetic-pdf-v1",
    inputSha256: "a".repeat(64),
    outputSha256: "b".repeat(64),
    automaticReportSha256: sha(report),
    template: TEMPLATE_KEY,
    templateVersion: TEMPLATE_VERSION,
    engineVersion: ENGINE_VERSION,
    widthMm: 100,
    heightMm: 150,
    dpi: 203,
    printer: "Impressora sintética modelo T1 firmware 1.0",
    driver: "Sistema sintético, driver genérico, sem ajuste",
    scalePercent: 100,
    acceptedDimensionToleranceMm: 0.5,
    measuredWidthMm: 100.2,
    measuredHeightMm: 149.8,
    noClipping: true,
    contentPreserved: true,
    scanner: "Leitor sintético 2D modelo L1",
    codes: CODES.map((code) => ({ role: code.role, format: code.format, measuredWidthMm: 30, measuredHeightMm: 20, readings: [code.value, code.value, code.value], allThreeMatchExpected: true })),
    operator: "Operador sintético",
    testedAt: "2026-10-07T09:00:00.000Z",
    ...overrides,
  };
}

function release(reportOverrides: Record<string, unknown> = {}, proofOverrides: Record<string, unknown> = {}, inputOverrides: Record<string, unknown> = {}) {
  const report = automaticReport(reportOverrides);
  return { widthMm: 100, heightMm: 150, automaticReportJson: report, physicalProof: physicalProof(report, proofOverrides), attestation: { physicalProofPerformed: true }, ...inputOverrides };
}

async function migrate() {
  const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const migration = await readFile(`${directory}/${name}`, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await pglite.exec(statement);
  }
}

beforeAll(async () => {
  await migrate();
  await database.insert(user).values([
    { id: ADMIN, name: "Plataforma", email: "platform@example.test", emailVerified: true, platformRole: "ADMIN" },
    { id: ROLE_ONLY, name: "Só papel", email: "role-only@example.test", emailVerified: true, platformRole: "ADMIN" },
    { id: LISTED_ONLY, name: "Só lista", email: "listed-only@example.test", emailVerified: true, platformRole: "USER" },
    { id: ORG_OWNER, name: "Dona", email: "org-owner@example.test", emailVerified: true, platformRole: "USER" },
  ]);
  await database.insert(organizations).values([
    { id: ORG, name: "Org A", slug: "admin-a", ownerUserId: ORG_OWNER, createdAt: new Date("2026-09-01T00:00:00.000Z") },
    { id: OTHER_ORG, name: "Org B", slug: "admin-b", ownerUserId: LISTED_ONLY, createdAt: new Date("2026-09-02T00:00:00.000Z") },
  ]);
  await database.insert(memberships).values([
    { organizationId: ORG, userId: ORG_OWNER, role: "OWNER" },
    { organizationId: ORG, userId: ROLE_ONLY, role: "ADMIN" },
    { organizationId: OTHER_ORG, userId: LISTED_ONLY, role: "OWNER" },
  ]);
  await database.insert(subscriptions).values([
    { organizationId: ORG, planId: "PRO", status: "ACTIVE", stripeCustomerId: "cus_synthetic_secret", stripeSubscriptionId: "sub_synthetic_secret", createdAt: new Date("2026-09-01T00:00:00.000Z") },
    { organizationId: OTHER_ORG, planId: "FREE", status: "ACTIVE", createdAt: new Date("2026-09-02T00:00:00.000Z") },
  ]);
  await database.insert(usagePeriods).values({ organizationId: ORG, periodStart: new Date("2026-10-01"), periodEnd: new Date("2026-11-01"), limit: 100, reserved: 2, confirmed: 5 });
});

beforeEach(async () => {
  process.env.ADMIN_EMAILS = "platform@example.test, LISTED-ONLY@example.test";
  await database.delete(auditLogs);
  await database.delete(outboxEvents);
  await database.delete(conversions);
  await database.delete(templateReleases);
  await database.delete(templates);
  await database.insert(templates).values([
    { id: TEMPLATE, key: TEMPLATE_KEY, version: TEMPLATE_VERSION, displayName: "Mercado Livre", engineVersion: ENGINE_VERSION, status: "DRAFT", definition: { releasedSizes: [] } },
    { id: OLD_TEMPLATE, key: TEMPLATE_KEY, version: "0.0.1", displayName: "Antigo", engineVersion: "0.0.1", status: "DRAFT", definition: { releasedSizes: [] } },
  ]);
});

afterAll(async () => {
  if (previousAllowlist === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = previousAllowlist;
  await pglite.close();
});

describe("platform administration access", () => {
  it("requires the stored ADMIN role and the allowlist together", async () => {
    expect(isPlatformAdmin({ email: "Platform@Example.test", platformRole: "ADMIN" })).toBe(true);
    expect(isPlatformAdmin({ email: "role-only@example.test", platformRole: "ADMIN" })).toBe(false);
    expect(isPlatformAdmin({ email: "listed-only@example.test", platformRole: "USER" })).toBe(false);
    await expect(assertPlatformAdmin(admin, database)).resolves.toBeUndefined();

    const denied = { code: "forbidden", status: 403 };
    for (const userId of [ROLE_ONLY, LISTED_ONLY, ORG_OWNER, id(999)]) {
      const caller = { userId };
      await expect(adminOverview(caller, database, NOW)).rejects.toMatchObject(denied);
      await expect(listAdminOrganizations(caller, {}, database)).rejects.toMatchObject(denied);
      await expect(listAdminSubscriptions(caller, {}, database)).rejects.toMatchObject(denied);
      await expect(listAdminUsage(caller, {}, database)).rejects.toMatchObject(denied);
      await expect(listAdminConversions(caller, {}, database)).rejects.toMatchObject(denied);
      await expect(listAdminFailures(caller, {}, database)).rejects.toMatchObject(denied);
      await expect(listAdminJobs(caller, {}, database)).rejects.toMatchObject(denied);
      await expect(listAdminTemplates(caller, database)).rejects.toMatchObject(denied);
      await expect(publishTemplateRelease(caller, TEMPLATE, release(), database, NOW)).rejects.toMatchObject(denied);
    }
    expect(await database.select().from(templateReleases)).toHaveLength(0);

    // Losing either credential takes effect on the next operation.
    process.env.ADMIN_EMAILS = "";
    await expect(adminOverview(admin, database, NOW)).rejects.toMatchObject(denied);
    process.env.ADMIN_EMAILS = "platform@example.test";
    await database.update(user).set({ emailVerified: false }).where(eq(user.id, ADMIN));
    await expect(adminOverview(admin, database, NOW)).rejects.toMatchObject(denied);
    await database.update(user).set({ emailVerified: true }).where(eq(user.id, ADMIN));
  });
});

describe("administration metadata", () => {
  it("returns paginated metadata without documents, keys, messages or provider identifiers", async () => {
    await database.insert(conversions).values([
      { id: id(201), organizationId: ORG, templateId: TEMPLATE, templateVersion: TEMPLATE_VERSION, engineVersion: ENGINE_VERSION, status: "completed", originalFileName: "etiqueta-cliente-sintetico.pdf", outputPreset: "100x150", outputWidthMm: "100.00", outputHeightMm: "150.00", inputObjectKey: "organizations/synthetic/input-1.pdf", outputObjectKey: "organizations/synthetic/output-1.pdf", sourceByteLength: 10, processingTimeMs: 1200, createdAt: new Date("2026-10-07T10:00:00.000Z") },
      { id: id(202), organizationId: ORG, templateId: TEMPLATE, templateVersion: TEMPLATE_VERSION, engineVersion: ENGINE_VERSION, status: "failed", originalFileName: "falha-sintetica.pdf", outputPreset: "100x150", outputWidthMm: "100.00", outputHeightMm: "150.00", inputObjectKey: "organizations/synthetic/input-2.pdf", sourceByteLength: 10, errorCode: "validation_failed", errorMessage: "mensagem interna sintética", createdAt: new Date("2026-10-07T11:00:00.000Z") },
      { id: id(203), organizationId: OTHER_ORG, templateId: TEMPLATE, templateVersion: TEMPLATE_VERSION, engineVersion: ENGINE_VERSION, status: "queued", outputPreset: "100x150", outputWidthMm: "100.00", outputHeightMm: "150.00", inputObjectKey: "organizations/synthetic/input-3.pdf", sourceByteLength: 10, createdAt: new Date("2026-10-01T11:00:00.000Z") },
    ]);
    await database.insert(outboxEvents).values({ id: id(301), organizationId: ORG, type: "conversion.completed", aggregateType: "conversion", aggregateId: id(201), deduplicationKey: "synthetic-dedupe", payload: { secretField: "payload-synthetic-secret" }, status: "FAILED", attempts: 2, lastError: "erro bruto sintético" });

    const overview = await adminOverview(admin, database, NOW);
    expect(overview).toMatchObject({
      organizations: 2,
      users: 4,
      subscriptionsByPlan: { PRO: 1, FREE: 1 },
      conversionsByStatus: { completed: 1, failed: 1, queued: 1 },
      conversionsLast24h: 2,
      failuresLast24h: 1,
      failureCodesLast24h: [{ code: "validation_failed", count: 1 }],
      outboxByStatus: { FAILED: 1 },
      usage: { activePeriods: 1, reserved: 2, confirmed: 5 },
    });

    const firstPage = await listAdminConversions(admin, { limit: "2" }, database);
    expect(firstPage.items.map((item) => item.id)).toEqual([id(202), id(201)]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = await listAdminConversions(admin, { limit: 2, cursor: firstPage.nextCursor }, database);
    expect(secondPage).toMatchObject({ items: [{ id: id(203), status: "queued" }], nextCursor: null });
    await expect(listAdminConversions(admin, { cursor: "not-a-cursor" }, database)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(listAdminConversions(admin, { limit: 1000 }, database)).rejects.toThrow();

    const failures = await listAdminFailures(admin, {}, database);
    expect(failures.items).toMatchObject([{ id: id(202), errorCode: "validation_failed", organizationId: ORG }]);
    const organizationPage = await listAdminOrganizations(admin, {}, database);
    expect(organizationPage.items).toMatchObject([{ id: OTHER_ORG, memberCount: 1, planId: "FREE" }, { id: ORG, memberCount: 2, planId: "PRO" }]);
    const subscriptionPage = await listAdminSubscriptions(admin, {}, database);
    expect(subscriptionPage.items.find((item) => item.organizationId === ORG)).toMatchObject({ planId: "PRO", billingLinked: true });
    const usagePage = await listAdminUsage(admin, {}, database);
    expect(usagePage.items).toMatchObject([{ organizationId: ORG, limit: 100, reserved: 2, confirmed: 5 }]);
    const jobs = await listAdminJobs(admin, {}, database);
    expect(jobs.items).toMatchObject([{ id: id(301), status: "FAILED", attempts: 2, hasError: true }]);

    const everything = JSON.stringify([overview, firstPage, secondPage, failures, organizationPage, subscriptionPage, usagePage, jobs]);
    for (const leaked of [".pdf", "organizations/synthetic", "mensagem interna", "erro bruto", "payload-synthetic-secret", "cus_synthetic", "sub_synthetic", "synthetic-dedupe", "@example.test"]) {
      expect(everything).not.toContain(leaked);
    }
  });
});

describe("template releases", () => {
  it("publishes a recognized template from complete evidence and hashes the persisted bytes", async () => {
    const input = release();
    const published = await publishTemplateRelease(admin, TEMPLATE, input, database, NOW);
    expect(published.created).toBe(true);
    expect(published.release).toMatchObject({ templateId: TEMPLATE, widthMm: 100, heightMm: 150, attestedByUserId: ADMIN, approvedAt: NOW.toISOString() });

    const stored = (await database.select().from(templateReleases))[0]!;
    const persistedReport = stored.automaticReport as { source: string };
    expect(persistedReport.source).toBe(input.automaticReportJson);
    expect(stored.automaticReportSha256).toBe(sha(persistedReport.source));
    expect(stored.physicalProofSha256).toBe(sha(canonicalJson(stored.physicalProof)));
    expect(stored.physicalProof).toMatchObject({ operator: "Operador sintético", scalePercent: 100 });

    const template = (await database.select().from(templates).where(eq(templates.id, TEMPLATE)))[0]!;
    expect(template.status).toBe("RELEASED");
    expect(template.releasedAt?.toISOString()).toBe(NOW.toISOString());
    expect(() => assertTemplateEligible(template, { preset: "100x150" }, false)).not.toThrow();
    // Approval is never extrapolated to another size.
    expect(() => assertTemplateEligible(template, { preset: "100x100" }, false)).toThrow();
    expect(() => assertTemplateEligible(template, { preset: "a6" }, false)).toThrow();

    const audit = await database.select().from(auditLogs);
    expect(audit).toMatchObject([{ action: "template.release_published", actorUserId: ADMIN, actorType: "platform_admin", resourceId: stored.id }]);
    expect(JSON.stringify(audit)).not.toContain("SYNTH-001");

    const listed = await listAdminTemplates(admin, database);
    expect(listed.items.find((item) => item.id === TEMPLATE)).toMatchObject({ status: "RELEASED", recognizedByEngine: true, releases: [{ id: stored.id }] });
    expect(listed.items.find((item) => item.id === OLD_TEMPLATE)).toMatchObject({ recognizedByEngine: false, releases: [] });
  });

  it("rejects templates the engine does not recognize", async () => {
    await expect(publishTemplateRelease(admin, OLD_TEMPLATE, release(), database, NOW)).rejects.toMatchObject({ code: "template_not_recognized", status: 409 });
    await expect(publishTemplateRelease(admin, id(12), release(), database, NOW)).rejects.toMatchObject({ code: "not_found" });
    await database.update(templates).set({ status: "RETIRED" }).where(eq(templates.id, TEMPLATE));
    await expect(publishTemplateRelease(admin, TEMPLATE, release(), database, NOW)).rejects.toMatchObject({ code: "template_not_recognized" });
    expect(await database.select().from(templateReleases)).toHaveLength(0);
  });

  it("never releases from missing, empty or hash-only evidence", async () => {
    const invalid = { code: "release_evidence_invalid", status: 422 };
    const complete = release();
    const attempts: unknown[] = [
      undefined,
      {},
      { ...complete, automaticReportJson: undefined },
      { ...complete, automaticReportJson: "" },
      { ...complete, automaticReportJson: "{}" },
      { ...complete, automaticReportJson: "not json" },
      { ...complete, physicalProof: undefined },
      { ...complete, physicalProof: {} },
      { ...complete, attestation: undefined },
      { ...complete, attestation: { physicalProofPerformed: false } },
      // Declared hashes without the reports are not evidence.
      { widthMm: 100, heightMm: 150, automaticReportSha256: "c".repeat(64), physicalProofSha256: "d".repeat(64), attestation: { physicalProofPerformed: true } },
      // The blank protocol form is not an approval.
      { ...complete, physicalProof: { ...complete.physicalProof, measuredWidthMm: null, noClipping: false } },
      release({ validation: { contentPreserved: true, geometryValid: true, codesEquivalent: false } }),
      release({ syntheticExpectedCodes: [] }),
      release({ syntheticExpectedCodes: [CODES[0], CODES[0], CODES[2]] }),
      release({}, { scalePercent: 97 }),
      release({}, { contentPreserved: false }),
      release({}, { operator: "" }),
      release({}, { printer: undefined }),
      release({}, { codes: [] }),
      release({}, { codes: physicalProof("").codes.map((code) => ({ ...code, allThreeMatchExpected: false })) }),
      release({}, { codes: physicalProof("").codes.map((code) => ({ ...code, readings: [code.readings[0], code.readings[1]] })) }),
    ];
    for (const attempt of attempts) {
      await expect(publishTemplateRelease(admin, TEMPLATE, attempt, database, NOW)).rejects.toMatchObject(invalid);
    }
    expect(await database.select().from(templateReleases)).toHaveLength(0);
    expect((await database.select().from(templates).where(eq(templates.id, TEMPLATE)))[0]).toMatchObject({ status: "DRAFT", releasedAt: null, definition: { releasedSizes: [] } });
    expect(await database.select().from(auditLogs)).toHaveLength(0);
  });

  it("never releases when the proof diverges from the report, the template or the size", async () => {
    const divergent = (fields: string[]) => ({ code: "release_evidence_divergent", status: 422, details: { fields: expect.arrayContaining(fields) } });
    const wrongReadings = physicalProof("").codes.map((code, index) => index === 1 ? { ...code, readings: [code.readings[0], "https://example.invalid/other", code.readings[2]] } : code);
    const cases: Array<[unknown, string[]]> = [
      [release({}, { automaticReportSha256: "e".repeat(64) }), ["physicalProof.automaticReportSha256"]],
      [release({}, { runId: id(901) }), ["physicalProof.runId"]],
      [release({}, { outputSha256: "f".repeat(64) }), ["physicalProof.outputSha256"]],
      [release({}, { templateVersion: "9.9.9" }), ["physicalProof.templateVersion"]],
      [release({ versions: { engine: "9.9.9", templateKey: TEMPLATE_KEY, template: TEMPLATE_VERSION } }), ["automaticReport.versions.engine"]],
      [release({}, {}, { heightMm: 100 }), ["automaticReport.heightMm", "physicalProof.heightMm"]],
      [release({}, { measuredWidthMm: 101 }), ["physicalProof.measuredWidthMm"]],
      [release({}, { acceptedDimensionToleranceMm: 5, measuredWidthMm: 104 }), ["physicalProof.acceptedDimensionToleranceMm"]],
      [release({}, { codes: wrongReadings }), ["physicalProof.codes.logistics_qr.readings"]],
      // The report must cover every code the engine protects, and the proof every code of the report.
      [release({ syntheticExpectedCodes: CODES.slice(0, 2) }, { codes: physicalProof("").codes.slice(0, 2) }), ["automaticReport.syntheticExpectedCodes"]],
      [release({}, { codes: physicalProof("").codes.slice(0, 2) }), ["physicalProof.codes"]],
      [release({}, { codes: physicalProof("").codes.map((code, index) => index === 0 ? { ...code, format: "QR_CODE" } : code) }), ["physicalProof.codes.logistics_barcode.format"]],
      [release({}, { testedAt: "2026-10-05T09:00:00.000Z" }), ["physicalProof.testedAt"]],
      [release({}, { testedAt: "2026-10-08T09:00:00.000Z" }), ["physicalProof.testedAt"]],
    ];
    for (const [attempt, fields] of cases) {
      await expect(publishTemplateRelease(admin, TEMPLATE, attempt, database, NOW)).rejects.toMatchObject(divergent(fields));
    }
    // Reformatting the report changes its bytes, so the operator's recorded hash no longer matches.
    const original = release();
    const reformatted = { ...original, automaticReportJson: JSON.stringify(JSON.parse(original.automaticReportJson)) };
    await expect(publishTemplateRelease(admin, TEMPLATE, reformatted, database, NOW)).rejects.toMatchObject(divergent(["physicalProof.automaticReportSha256"]));
    expect(await database.select().from(templateReleases)).toHaveLength(0);
    expect((await database.select().from(templates).where(eq(templates.id, TEMPLATE)))[0]!.status).toBe("DRAFT");
  });

  it("publishes once under concurrency and is idempotent for the same evidence", async () => {
    const input = release();
    const results = await Promise.all(Array.from({ length: 4 }, () => publishTemplateRelease(admin, TEMPLATE, input, database, NOW)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.release.id)).size).toBe(1);
    expect(await database.select().from(templateReleases)).toHaveLength(1);
    expect(await database.select().from(auditLogs)).toHaveLength(1);
    const template = (await database.select().from(templates).where(eq(templates.id, TEMPLATE)))[0]!;
    expect((template.definition as { releasedSizes: unknown[] }).releasedSizes).toHaveLength(1);

    // Different evidence for the same combination is a conflict, not an overwrite.
    const other = release({ runId: id(902) }, { runId: id(902) });
    await expect(publishTemplateRelease(admin, TEMPLATE, other, database, new Date(NOW.getTime() + 1_000))).rejects.toMatchObject({ code: "release_conflict", status: 409 });
    expect((await database.select().from(templateReleases))[0]!.evidenceSha256).toBe(results[0]!.release.evidenceSha256);

    // Another size needs its own proof and is released independently.
    const square = release({ heightMm: 100 }, { heightMm: 100, measuredHeightMm: 100 }, { heightMm: 100 });
    const racing = await Promise.allSettled([
      publishTemplateRelease(admin, TEMPLATE, square, database, NOW),
      publishTemplateRelease(admin, TEMPLATE, release({ heightMm: 100, runId: id(903) }, { heightMm: 100, measuredHeightMm: 100, runId: id(903) }, { heightMm: 100 }), database, NOW),
    ]);
    expect(racing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(racing.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "release_conflict" } });
    const released = (await database.select().from(templates).where(eq(templates.id, TEMPLATE)))[0]!;
    expect(await database.select().from(templateReleases)).toHaveLength(2);
    expect(() => assertTemplateEligible(released, { preset: "100x100" }, false)).not.toThrow();
    expect(() => assertTemplateEligible(released, { preset: "100x150" }, false)).not.toThrow();
  });
});
