import { z } from "zod";

import { outputSizeSchema } from "./label-size";
import { planIdSchema } from "./plans";

const isoDate = z.iso.datetime({ offset: true });
const signedDownloadSchema = z.object({ url: z.url(), expiresAt: isoDate });
const safeErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  suggestedSize: outputSizeSchema.optional(),
});

export const apiKeyNameSchema = z.string().trim().min(1).max(80)
  .refine((value) => !/[\x00-\x1f\x7f]/u.test(value));

export const apiKeySummarySchema = z.object({
  id: z.uuid(),
  name: apiKeyNameSchema,
  prefix: z.string().min(8).max(24),
  lastUsedAt: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
  revokedAt: isoDate.nullable(),
  createdAt: isoDate,
});

export const apiKeyListSchema = z.object({ items: z.array(apiKeySummarySchema) });
export const apiKeyCreatedSchema = apiKeySummarySchema.extend({ key: z.string().min(40).max(160) });

export const publicConversionSchema = z.object({
  id: z.uuid(),
  status: z.enum(["queued", "processing", "completed", "failed"]),
  progress: z.number().int().min(0).max(100),
  stage: z.string().optional(),
  template: z.string(),
  templateVersion: z.string(),
  engineVersion: z.string(),
  size: z.object({
    preset: z.enum(["100x150", "100x100", "a6", "custom"]),
    widthMm: z.number(),
    heightMm: z.number(),
  }),
  createdAt: isoDate,
  updatedAt: isoDate,
  completedAt: isoDate.nullable().optional(),
  download: signedDownloadSchema.optional(),
  error: safeErrorSchema.optional(),
});

export const publicBatchItemSchema = z.object({
  id: z.uuid(),
  status: z.enum(["queued", "processing", "completed", "failed"]),
  progress: z.number().int().min(0).max(100),
  originalFileName: z.string().nullable(),
  createdAt: isoDate,
  completedAt: isoDate.nullable(),
  error: safeErrorSchema.omit({ suggestedSize: true }).optional(),
});

export const publicBatchSchema = z.object({
  id: z.uuid(),
  status: z.enum(["queued", "processing", "completed", "failed"]),
  phase: z.enum(["queued", "processing", "packaging", "completed", "failed"]),
  progress: z.number().int().min(0).max(100),
  counts: z.object({
    total: z.number().int().positive(),
    queued: z.number().int().nonnegative(),
    processing: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  items: z.array(publicBatchItemSchema),
  createdAt: isoDate,
  updatedAt: isoDate,
  completedAt: isoDate.nullable().optional(),
  download: signedDownloadSchema.optional(),
  error: safeErrorSchema.omit({ suggestedSize: true }).optional(),
});

export const publicUsageSchema = z.object({
  planId: planIdSchema,
  periodStart: isoDate,
  periodEnd: isoDate,
  limit: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});

export type ApiKeySummary = z.infer<typeof apiKeySummarySchema>;
export type ApiKeyList = z.infer<typeof apiKeyListSchema>;
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>;
export type PublicConversion = z.infer<typeof publicConversionSchema>;
export type PublicBatch = z.infer<typeof publicBatchSchema>;
export type PublicUsage = z.infer<typeof publicUsageSchema>;
