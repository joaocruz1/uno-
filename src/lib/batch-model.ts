import { z } from "zod";

import { outputSizeSchema } from "./label-size";

export const batchPublicStatusSchema = z.enum(["queued", "processing", "completed", "failed"]);
export const batchPhaseSchema = z.enum(["queued", "processing", "packaging", "completed", "failed"]);
export const batchCountsSchema = z.object({
  total: z.number().int().positive(),
  queued: z.number().int().nonnegative(),
  processing: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export const batchArchiveSchema = z.object({
  status: z.enum(["pending", "packaging", "ready", "failed"]),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const batchSummarySchema = z.object({
  id: z.uuid(),
  status: batchPublicStatusSchema,
  phase: batchPhaseSchema,
  progress: z.number().int().min(0).max(100),
  counts: batchCountsSchema,
  archive: batchArchiveSchema,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  artifactsExpireAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export const batchDetailSchema = batchSummarySchema;
export const batchItemSchema = z.object({
  id: z.uuid(),
  status: z.enum(["queued", "processing", "completed", "failed"]),
  progress: z.number().int().min(0).max(100),
  originalFileName: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const batchListSchema = z.object({ items: z.array(batchSummarySchema), nextCursor: z.string().nullable() });
export const batchItemsPageSchema = z.object({ items: z.array(batchItemSchema).max(50), nextCursor: z.string().nullable() });

export const batchUploadItemSchema = z.object({
  id: z.uuid(),
  clientItemId: z.string(),
  originalFileName: z.string(),
  contentLength: z.number().int().positive(),
  status: z.enum(["pending", "uploading", "preparing", "ready", "failed"]),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const batchUploadSessionSchema = z.object({
  id: z.uuid(),
  status: z.enum(["open", "accepted", "expired"]),
  template: z.string(),
  size: outputSizeSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  items: z.array(batchUploadItemSchema),
});
export const batchUploadResponseSchema = z.object({
  itemId: z.uuid(),
  uploadUrl: z.url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime({ offset: true }),
});
export const acceptedBatchSchema = z.object({
  id: z.uuid(),
  status: z.literal("queued"),
  progress: z.literal(0),
  itemCount: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type BatchSummary = z.infer<typeof batchSummarySchema>;
export type BatchDetail = z.infer<typeof batchDetailSchema>;
export type BatchItem = z.infer<typeof batchItemSchema>;
export type BatchList = z.infer<typeof batchListSchema>;
export type BatchItemsPage = z.infer<typeof batchItemsPageSchema>;
export type BatchUploadSession = z.infer<typeof batchUploadSessionSchema>;
export type BatchUploadResponse = z.infer<typeof batchUploadResponseSchema>;
export type AcceptedBatch = z.infer<typeof acceptedBatchSchema>;
