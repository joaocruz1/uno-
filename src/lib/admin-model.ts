import { z } from "zod";

import { planIdSchema } from "./plans";

const isoDate = z.iso.datetime({ offset: true });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const counter = z.number().int().nonnegative();
const describedText = z.string().trim().min(3).max(300).refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
const millimeters = z.number().positive().max(1_000).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6);

const codeRole = z.string().regex(/^[a-z0-9_]{1,64}$/);
const codeFormat = z.enum(["CODE_128", "QR_CODE"]);

/** At least one code, each role exactly once. Which roles are required comes from the engine's template. */
function uniqueRoles(codes: ReadonlyArray<{ role: string }>): boolean {
  return codes.length > 0 && codes.length <= 16 && new Set(codes.map((code) => code.role)).size === codes.length;
}

/** Structure of `automatic.json` produced by `pnpm proof:print` for an approved run. */
export const automaticReportSchema = z.object({
  runId: z.uuid(),
  createdAt: isoDate,
  fixture: z.literal("synthetic-pdf-v1"),
  variants: z.object({ scanned: z.boolean(), additional: z.boolean() }),
  inputSha256: sha256,
  outputSha256: sha256,
  versions: z.object({ engine: z.string().min(1), templateKey: z.string().min(1), template: z.string().min(1) }),
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  pageCount: z.literal(1),
  validation: z.object({ contentPreserved: z.literal(true), geometryValid: z.literal(true), codesEquivalent: z.literal(true) }),
  validationPolicy: z.object({
    codesDpi: z.array(z.number().int().positive()).refine((values) => values.includes(203) && values.includes(300)),
    pixelContentDpi: z.array(z.number().int().positive()).refine((values) => values.includes(203)),
  }),
  syntheticExpectedCodes: z.array(z.object({ role: codeRole, format: codeFormat, value: z.string().min(1).max(512) })).refine(uniqueRoles),
});

/** Physical proof registered by the operator, following docs/printing-validation.md. */
export const physicalProofSchema = z.object({
  runId: z.uuid(),
  fixture: z.literal("synthetic-pdf-v1"),
  inputSha256: sha256,
  outputSha256: sha256,
  automaticReportSha256: sha256,
  template: z.string().min(1).max(80),
  templateVersion: z.string().min(1).max(40),
  engineVersion: z.string().min(1).max(40),
  widthMm: millimeters,
  heightMm: millimeters,
  dpi: z.union([z.literal(203), z.literal(300)]),
  printer: describedText,
  driver: describedText,
  scalePercent: z.literal(100),
  acceptedDimensionToleranceMm: z.number().nonnegative().max(10),
  measuredWidthMm: millimeters,
  measuredHeightMm: millimeters,
  noClipping: z.literal(true),
  contentPreserved: z.literal(true),
  scanner: describedText,
  codes: z.array(z.object({
    role: codeRole,
    format: codeFormat,
    measuredWidthMm: millimeters,
    measuredHeightMm: millimeters,
    readings: z.tuple([z.string().min(1).max(512), z.string().min(1).max(512), z.string().min(1).max(512)]),
    allThreeMatchExpected: z.literal(true),
  }).strict()).refine(uniqueRoles),
  operator: describedText,
  testedAt: isoDate,
}).strict();

export const templateReleaseInputSchema = z.object({
  widthMm: millimeters.min(50).max(210),
  heightMm: millimeters.min(50).max(300),
  /** Exact text of automatic.json. The server hashes these bytes itself. */
  automaticReportJson: z.string().min(2).max(200_000),
  physicalProof: z.unknown(),
  /** The administrator attests that the physical proof described here was really performed. */
  attestation: z.object({ physicalProofPerformed: z.literal(true) }).strict(),
}).strict();

export const templateReleaseSchema = z.object({
  id: z.uuid(),
  templateId: z.uuid(),
  templateVersion: z.string(),
  engineVersion: z.string(),
  widthMm: z.number(),
  heightMm: z.number(),
  automaticReportSha256: sha256,
  physicalProofSha256: sha256,
  evidenceSha256: sha256,
  attestedByUserId: z.uuid().nullable(),
  approvedAt: isoDate,
});
export const publishedReleaseSchema = z.object({ created: z.boolean(), release: templateReleaseSchema });

export const adminTemplateSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  version: z.string(),
  engineVersion: z.string(),
  status: z.enum(["DRAFT", "RELEASED", "RETIRED"]),
  recognizedByEngine: z.boolean(),
  releasedAt: isoDate.nullable(),
  releases: z.array(templateReleaseSchema),
});
export const adminTemplateListSchema = z.object({ items: z.array(adminTemplateSchema) });

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(400).optional(),
});
const page = <Item extends z.ZodType>(item: Item) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const adminOverviewSchema = z.object({
  generatedAt: isoDate,
  organizations: counter,
  users: counter,
  subscriptionsByPlan: z.record(z.string(), counter),
  subscriptionsByStatus: z.record(z.string(), counter),
  conversionsByStatus: z.record(z.string(), counter),
  conversionsLast24h: counter,
  failuresLast24h: counter,
  failureCodesLast24h: z.array(z.object({ code: z.string(), count: counter })),
  outboxByStatus: z.record(z.string(), counter),
  webhookDeliveriesByStatus: z.record(z.string(), counter),
  usage: z.object({ activePeriods: counter, reserved: counter, confirmed: counter }),
});

export const adminOrganizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  ownerUserId: z.uuid(),
  memberCount: counter,
  planId: planIdSchema.nullable(),
  subscriptionStatus: z.string().nullable(),
  createdAt: isoDate,
});
export const adminSubscriptionSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  planId: planIdSchema,
  status: z.string(),
  billingLinked: z.boolean(),
  currentPeriodStart: isoDate.nullable(),
  currentPeriodEnd: isoDate.nullable(),
  cancelAtPeriodEnd: z.boolean(),
  reconciliationVersion: counter,
  lastReconciledAt: isoDate.nullable(),
  createdAt: isoDate,
});
export const adminUsageSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  periodStart: isoDate,
  periodEnd: isoDate,
  limit: counter,
  reserved: counter,
  confirmed: counter,
  createdAt: isoDate,
});
export const adminConversionSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  batchId: z.uuid().nullable(),
  status: z.string(),
  source: z.string(),
  templateVersion: z.string(),
  engineVersion: z.string(),
  widthMm: z.number(),
  heightMm: z.number(),
  progress: z.number().int(),
  stage: z.string().nullable(),
  attempts: counter,
  maxAttempts: counter,
  inputPages: z.number().int().nullable(),
  outputPages: z.number().int().nullable(),
  processingTimeMs: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  queuedAt: isoDate,
  processingStartedAt: isoDate.nullable(),
  completedAt: isoDate.nullable(),
  createdAt: isoDate,
});
export const adminJobSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  type: z.string(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  status: z.string(),
  attempts: counter,
  hasError: z.boolean(),
  availableAt: isoDate,
  publishedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const adminOrganizationPageSchema = page(adminOrganizationSchema);
export const adminSubscriptionPageSchema = page(adminSubscriptionSchema);
export const adminUsagePageSchema = page(adminUsageSchema);
export const adminConversionPageSchema = page(adminConversionSchema);
export const adminJobPageSchema = page(adminJobSchema);

export type AutomaticReport = z.infer<typeof automaticReportSchema>;
export type PhysicalProof = z.infer<typeof physicalProofSchema>;
export type TemplateRelease = z.infer<typeof templateReleaseSchema>;
export type PublishedRelease = z.infer<typeof publishedReleaseSchema>;
export type AdminTemplate = z.infer<typeof adminTemplateSchema>;
export type AdminTemplateList = z.infer<typeof adminTemplateListSchema>;
export type AdminOverview = z.infer<typeof adminOverviewSchema>;
export type AdminOrganization = z.infer<typeof adminOrganizationSchema>;
export type AdminSubscription = z.infer<typeof adminSubscriptionSchema>;
export type AdminUsage = z.infer<typeof adminUsageSchema>;
export type AdminConversion = z.infer<typeof adminConversionSchema>;
export type AdminJob = z.infer<typeof adminJobSchema>;
export type AdminPage<Item> = { items: Item[]; nextCursor: string | null };
