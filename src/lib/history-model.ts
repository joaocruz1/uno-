import { z } from "zod";

const publicStatusSchema = z.enum(["queued", "processing", "completed", "failed"]);
const sourceSchema = z.enum(["dashboard", "api"]);
const historySizeSchema = z.object({
  preset: z.enum(["100x150", "100x100", "a6", "custom"]),
  widthMm: z.number(),
  heightMm: z.number(),
});

export const historyQuerySchema = z.object({
  q: z.string().max(120).optional(),
  status: publicStatusSchema.optional(),
  source: sourceSchema.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).optional(),
}).strict().refine(
  (value) => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to),
  { message: "from must be before to", path: ["to"] },
);

export const historyItemSchema = z.object({
  id: z.uuid(),
  originalFileName: z.string().nullable(),
  status: publicStatusSchema,
  progress: z.number().int().min(0).max(100),
  template: z.string(),
  size: historySizeSchema,
  source: sourceSchema,
  createdAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  artifactsExpireAt: z.iso.datetime({ offset: true }).nullable(),
  canDownload: z.boolean(),
  canReprocess: z.boolean(),
});

export const historyListSchema = z.object({
  items: z.array(historyItemSchema).max(50),
  nextCursor: z.string().nullable(),
});

export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type HistoryItem = z.infer<typeof historyItemSchema>;
export type HistoryList = z.infer<typeof historyListSchema>;
