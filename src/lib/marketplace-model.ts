import { z } from "zod";

/** Numbering options sent to the lote converter (mirrors labelNumberingSchema on the server). */
export const loteNumberingSchema = z.object({
  letter: z.string().regex(/^[A-Z]{1,3}$/).optional(),
  start: z.number().int().min(1).max(99_999),
  showTotal: z.boolean(),
});

export const acceptedLoteSchema = z.object({
  id: z.string(),
  status: z.literal("queued"),
  progress: z.number(),
  itemCount: z.number().int(),
  createdAt: z.string(),
});

export const loteViewSchema = z.object({
  id: z.string(),
  marketplace: z.string().nullable(),
  status: z.string(),
  phase: z.string(),
  progress: z.number(),
  itemCount: z.number().int(),
  completedCount: z.number().int(),
  failedCount: z.number().int(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  downloadAvailable: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export const loteDownloadSchema = z.object({ url: z.url(), expiresAt: z.string() });

export type AcceptedLote = z.infer<typeof acceptedLoteSchema>;
export type LoteView = z.infer<typeof loteViewSchema>;
export type LoteNumbering = z.infer<typeof loteNumberingSchema>;
