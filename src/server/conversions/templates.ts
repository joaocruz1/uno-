import { and, eq } from "drizzle-orm";

import { getDb, templates, type UnoDatabase } from "@/db";
import { ENGINE_VERSION, TEMPLATE_KEY, TEMPLATE_VERSION } from "@/engine/types";
import { allowDraftTemplates } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { OutputSize } from "@/lib/label-size";
import { sizeDimensions } from "@/lib/label-size";

export const INITIAL_TEMPLATE_ID = "00000000-0000-4000-8000-000000000010";
export const INITIAL_TEMPLATE = `${TEMPLATE_KEY}@${TEMPLATE_VERSION}`;

type TemplateRow = typeof templates.$inferSelect;
export type TemplateEligibility = Pick<TemplateRow, "engineVersion" | "status" | "definition" | "releasedAt">;

export async function seedInitialDraftTemplate(database: Pick<UnoDatabase, "insert"> = getDb()): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  await database.insert(templates).values({
    id: INITIAL_TEMPLATE_ID,
    key: TEMPLATE_KEY,
    version: TEMPLATE_VERSION,
    displayName: "Mercado Livre",
    engineVersion: ENGINE_VERSION,
    status: "DRAFT",
    definition: { releasedSizes: [] },
  }).onConflictDoNothing({ target: [templates.key, templates.version] });
}

export function parseTemplateReference(value = INITIAL_TEMPLATE): { key: string; version: string } {
  const match = /^([a-z0-9-]{1,80})@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(value);
  if (!match) throw new AppError("unsupported_template", "O modelo selecionado não está disponível.", 400);
  return { key: match[1], version: match[2] };
}

function exactReleasedSize(template: TemplateEligibility, size: OutputSize): boolean {
  const definition = template.definition as { releasedSizes?: unknown };
  if (!Array.isArray(definition.releasedSizes)) return false;
  const dimensions = sizeDimensions(size);
  return definition.releasedSizes.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const release = entry as Record<string, unknown>;
    return release.widthMm === dimensions.widthMm && release.heightMm === dimensions.heightMm &&
      typeof release.automaticReportSha256 === "string" && /^[0-9a-f]{64}$/.test(release.automaticReportSha256) &&
      typeof release.physicalProofSha256 === "string" && /^[0-9a-f]{64}$/.test(release.physicalProofSha256) &&
      typeof release.approvedAt === "string" && Boolean(Date.parse(release.approvedAt));
  });
}

export function assertTemplateEligible(template: TemplateEligibility, size: OutputSize, draftAllowed = allowDraftTemplates()): void {
  if (template.engineVersion !== ENGINE_VERSION) {
    throw new AppError("unsupported_template", "O modelo selecionado não está disponível.", 400);
  }
  if (template.status === "RELEASED" && template.releasedAt && exactReleasedSize(template, size)) return;
  if (template.status === "DRAFT" && draftAllowed && process.env.NODE_ENV !== "production") return;
  throw new AppError("template_not_released", "Este modelo e formato ainda não estão disponíveis.", 409);
}

export async function findTemplate(
  reference: string | undefined,
  database: Pick<UnoDatabase, "select"> = getDb(),
): Promise<TemplateRow> {
  const { key, version } = parseTemplateReference(reference);
  const rows = await database.select().from(templates)
    .where(and(eq(templates.key, key), eq(templates.version, version))).limit(1);
  const template = rows[0];
  if (!template) throw new AppError("unsupported_template", "O modelo selecionado não está disponível.", 400);
  return template;
}
