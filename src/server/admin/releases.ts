import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, templateReleases, templates, type UnoDatabase } from "@/db";
import { findTemplateDefinition } from "@/engine/templates";
import { ENGINE_VERSION } from "@/engine/types";
import {
  adminTemplateListSchema,
  automaticReportSchema,
  physicalProofSchema,
  publishedReleaseSchema,
  templateReleaseInputSchema,
  type AdminTemplateList,
  type AutomaticReport,
  type PhysicalProof,
  type PublishedRelease,
  type TemplateRelease,
} from "@/lib/admin-model";
import { AppError } from "@/lib/errors";
import { writeAudit } from "@/server/organizations/audit";

import { assertPlatformAdmin, type AdminIdentity } from "./access";

type TemplateRow = typeof templates.$inferSelect;
type ReleaseRow = typeof templateReleases.$inferSelect;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** Deterministic JSON: object keys sorted, no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Only a layout version registered in this engine build can be released. */
function engineDefinition(template: Pick<TemplateRow, "key" | "version" | "engineVersion">) {
  return template.engineVersion === ENGINE_VERSION ? findTemplateDefinition(template.key, template.version) : undefined;
}

function recognizedByEngine(template: Pick<TemplateRow, "key" | "version" | "engineVersion">): boolean {
  return Boolean(engineDefinition(template));
}

function maxToleranceMm(): number {
  const configured = Number(process.env.UNO_RELEASE_MAX_TOLERANCE_MM);
  return Number.isFinite(configured) && configured >= 0 ? configured : 2;
}

function invalidEvidence(part: "request" | "automaticReport" | "physicalProof", error?: z.ZodError): AppError {
  // Field paths only: submitted values are never echoed back.
  const fields = error ? [...new Set(error.issues.map((issue) => [part, ...issue.path].join(".")))].slice(0, 40) : [part];
  return new AppError("release_evidence_invalid", "Os relatórios de liberação estão ausentes ou incompletos.", 422, { fields });
}

/**
 * The protocol form carries approvedBy/approvedAt placeholders. Approval is
 * recorded by the system from the attesting administrator, so they are dropped.
 */
function operatorRecord(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  delete record.approvedBy;
  delete record.approvedAt;
  return record;
}

const sameMm = (left: number, right: number) => Math.abs(left - right) < 0.005;

/**
 * Compares the operator's record with the automatic report and the template.
 * The system only verifies what was submitted; it never fills in a result.
 */
export function evidenceDivergences(input: {
  template: Pick<TemplateRow, "key" | "version" | "engineVersion">;
  widthMm: number;
  heightMm: number;
  report: AutomaticReport;
  reportSha256: string;
  proof: PhysicalProof;
  now: Date;
}): string[] {
  const { template, widthMm, heightMm, report, reportSha256, proof, now } = input;
  const fields: string[] = [];
  const check = (ok: boolean, field: string) => { if (!ok) fields.push(field); };

  check(report.versions.engine === template.engineVersion, "automaticReport.versions.engine");
  check(report.versions.templateKey === template.key, "automaticReport.versions.templateKey");
  check(report.versions.template === template.version, "automaticReport.versions.template");
  check(sameMm(report.widthMm, widthMm), "automaticReport.widthMm");
  check(sameMm(report.heightMm, heightMm), "automaticReport.heightMm");

  check(proof.runId === report.runId, "physicalProof.runId");
  check(proof.inputSha256 === report.inputSha256, "physicalProof.inputSha256");
  check(proof.outputSha256 === report.outputSha256, "physicalProof.outputSha256");
  check(proof.automaticReportSha256 === reportSha256, "physicalProof.automaticReportSha256");
  check(proof.template === template.key, "physicalProof.template");
  check(proof.templateVersion === template.version, "physicalProof.templateVersion");
  check(proof.engineVersion === template.engineVersion, "physicalProof.engineVersion");
  check(sameMm(proof.widthMm, widthMm), "physicalProof.widthMm");
  check(sameMm(proof.heightMm, heightMm), "physicalProof.heightMm");

  const tolerance = proof.acceptedDimensionToleranceMm;
  check(tolerance <= maxToleranceMm(), "physicalProof.acceptedDimensionToleranceMm");
  check(Math.abs(proof.measuredWidthMm - widthMm) <= tolerance + 1e-9, "physicalProof.measuredWidthMm");
  check(Math.abs(proof.measuredHeightMm - heightMm) <= tolerance + 1e-9, "physicalProof.measuredHeightMm");

  // The report must cover every code the engine protects in this layout, and the proof every code of the report.
  const protectedCodes = engineDefinition(template)?.protectedCodes(1, 2) ?? [];
  const sameRoles = (left: string[], right: string[]) => left.length === right.length && left.every((role) => right.includes(role));
  check(
    protectedCodes.length > 0 &&
      sameRoles(protectedCodes.map((code) => code.id), report.syntheticExpectedCodes.map((code) => code.role)) &&
      protectedCodes.every((code) => report.syntheticExpectedCodes.some((expected) => expected.role === code.id && expected.format === code.format)),
    "automaticReport.syntheticExpectedCodes",
  );
  check(sameRoles(report.syntheticExpectedCodes.map((code) => code.role), proof.codes.map((code) => code.role)), "physicalProof.codes");
  for (const expected of report.syntheticExpectedCodes) {
    const read = proof.codes.find((code) => code.role === expected.role);
    check(Boolean(read) && read?.format === expected.format, `physicalProof.codes.${expected.role}.format`);
    check(Boolean(read) && read!.readings.every((reading) => reading === expected.value), `physicalProof.codes.${expected.role}.readings`);
  }

  const testedAt = Date.parse(proof.testedAt);
  check(testedAt >= Date.parse(report.createdAt) && testedAt <= now.getTime(), "physicalProof.testedAt");
  return fields;
}

function publicRelease(row: ReleaseRow): TemplateRelease {
  return {
    id: row.id,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    engineVersion: row.engineVersion,
    widthMm: Number(row.widthMm),
    heightMm: Number(row.heightMm),
    automaticReportSha256: row.automaticReportSha256,
    physicalProofSha256: row.physicalProofSha256,
    evidenceSha256: row.evidenceSha256,
    attestedByUserId: row.attestedByUserId,
    approvedAt: row.approvedAt.toISOString(),
  };
}

export async function listAdminTemplates(identity: AdminIdentity, database: Pick<UnoDatabase, "select"> = getDb()): Promise<AdminTemplateList> {
  await assertPlatformAdmin(identity, database);
  const templateRows = await database.select().from(templates).orderBy(asc(templates.key), asc(templates.version));
  const releaseRows = await database.select().from(templateReleases).orderBy(asc(templateReleases.approvedAt), asc(templateReleases.id));
  return adminTemplateListSchema.parse({
    items: templateRows.map((template) => ({
      id: template.id,
      key: template.key,
      version: template.version,
      engineVersion: template.engineVersion,
      status: template.status,
      recognizedByEngine: recognizedByEngine(template),
      releasedAt: template.releasedAt?.toISOString() ?? null,
      releases: releaseRows.filter((release) => release.templateId === template.id).map(publicRelease),
    })),
  });
}

/**
 * Publishes one template/size combination from complete evidence. The server
 * hashes the bytes it persists; hashes declared by the client are only
 * compared against them. Publication is atomic under the template row lock
 * and idempotent for the same combination and evidence.
 */
export async function publishTemplateRelease(
  identity: AdminIdentity,
  rawTemplateId: string,
  rawInput: unknown,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<PublishedRelease> {
  await assertPlatformAdmin(identity, database);
  const templateNotFound = () => new AppError("not_found", "Modelo não encontrado.", 404);
  const templateId = z.uuid().safeParse(rawTemplateId);
  if (!templateId.success) throw templateNotFound();

  const input = templateReleaseInputSchema.safeParse(rawInput);
  if (!input.success) throw invalidEvidence("request", input.error);
  let reportDocument: unknown;
  try {
    reportDocument = JSON.parse(input.data.automaticReportJson);
  } catch {
    throw invalidEvidence("automaticReport");
  }
  const report = automaticReportSchema.safeParse(reportDocument);
  if (!report.success) throw invalidEvidence("automaticReport", report.error);
  const proof = physicalProofSchema.safeParse(operatorRecord(input.data.physicalProof));
  if (!proof.success) throw invalidEvidence("physicalProof", proof.error);

  const { widthMm, heightMm } = input.data;
  // Persisted evidence: the exact report text and the validated proof record.
  const automaticReport = { encoding: "utf8", source: input.data.automaticReportJson, report: report.data as Record<string, unknown> };
  const automaticReportSha256 = sha256(automaticReport.source);
  const physicalProofBytes = canonicalJson(proof.data);
  const physicalProof = JSON.parse(physicalProofBytes) as Record<string, unknown>;
  const physicalProofSha256 = sha256(physicalProofBytes);
  const width = widthMm.toFixed(2);
  const height = heightMm.toFixed(2);

  return database.transaction(async (transaction) => {
    await assertPlatformAdmin(identity, transaction);
    const templateRows = await transaction.select().from(templates).where(eq(templates.id, templateId.data)).limit(1).for("update");
    const template = templateRows[0];
    if (!template) throw templateNotFound();
    if (!recognizedByEngine(template) || template.status === "RETIRED") {
      throw new AppError("template_not_recognized", "Esta versão do modelo não é reconhecida pela engine atual.", 409);
    }

    const divergences = evidenceDivergences({ template, widthMm, heightMm, report: report.data, reportSha256: automaticReportSha256, proof: proof.data, now });
    if (divergences.length) {
      throw new AppError("release_evidence_divergent", "A prova física diverge do relatório automático ou do modelo.", 422, { fields: divergences });
    }

    const evidenceSha256 = sha256(canonicalJson({
      templateId: template.id,
      templateKey: template.key,
      templateVersion: template.version,
      engineVersion: template.engineVersion,
      widthMm,
      heightMm,
      automaticReportSha256,
      physicalProofSha256,
    }));

    const existing = await transaction.select().from(templateReleases).where(and(
      eq(templateReleases.templateId, template.id),
      eq(templateReleases.widthMm, width),
      eq(templateReleases.heightMm, height),
    )).limit(1);
    if (existing[0]) {
      if (existing[0].evidenceSha256 === evidenceSha256) return publishedReleaseSchema.parse({ created: false, release: publicRelease(existing[0]) });
      throw new AppError("release_conflict", "Esta combinação já foi liberada com outra evidência.", 409);
    }

    const inserted = await transaction.insert(templateReleases).values({
      id: randomUUID(),
      templateId: template.id,
      templateVersion: template.version,
      engineVersion: template.engineVersion,
      widthMm: width,
      heightMm: height,
      automaticReport,
      automaticReportSha256,
      physicalProof,
      physicalProofSha256,
      evidenceSha256,
      attestedByUserId: identity.userId,
      approvedAt: now,
      createdAt: now,
    }).returning();
    const release = inserted[0]!;

    const definition = template.definition && typeof template.definition === "object" ? template.definition : {};
    const previous = Array.isArray(definition.releasedSizes) ? definition.releasedSizes : [];
    const releasedSizes = [
      ...previous.filter((entry) => {
        const item = (entry ?? {}) as Record<string, unknown>;
        return !(item.widthMm === widthMm && item.heightMm === heightMm);
      }),
      { widthMm, heightMm, automaticReportSha256, physicalProofSha256, evidenceSha256, releaseId: release.id, approvedAt: now.toISOString() },
    ];
    await transaction.update(templates).set({
      definition: { ...definition, releasedSizes },
      status: "RELEASED",
      releasedAt: template.releasedAt ?? now,
      updatedAt: now,
    }).where(eq(templates.id, template.id));

    await writeAudit(transaction, {
      organizationId: null,
      actorUserId: identity.userId,
      actorType: "platform_admin",
      action: "template.release_published",
      resourceType: "template_release",
      resourceId: release.id,
      changes: { templateId: template.id, templateVersion: template.version, engineVersion: template.engineVersion, widthMm, heightMm, evidenceSha256 },
    }, now);
    return publishedReleaseSchema.parse({ created: true, release: publicRelease(release) });
  });
}
