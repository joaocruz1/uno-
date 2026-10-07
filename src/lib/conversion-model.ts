import { z } from "zod";
import { outputSizeSchema } from "./label-size";

const signedArtifactSchema = z.object({
  url: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
  expiresAt: z.iso.datetime({ offset: true }),
});

export const conversionViewSchema = z.object({
  requestId: z.string().optional(),
  id: z.uuid(),
  status: z.enum(["queued", "processing", "completed", "failed"]),
  progress: z.number().int().min(0).max(100),
  stage: z.string().optional(),
  template: z.string(),
  engineVersion: z.string(),
  size: z.object({ preset: z.enum(["100x150", "100x100", "a6", "custom"]), widthMm: z.number(), heightMm: z.number() }),
  originalFileName: z.string().nullable().optional(),
  createdAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  artifactsExpireAt: z.iso.datetime({ offset: true }).nullable().optional(),
  processingTimeMs: z.number().nonnegative().nullable().optional(),
  download: signedArtifactSchema.optional(),
  original: signedArtifactSchema.optional(),
  error: z.object({ code: z.string(), message: z.string(), suggestedSize: outputSizeSchema.optional() }).optional(),
  events: z.array(z.object({ stage: z.string(), progress: z.number().int().min(0).max(100), createdAt: z.iso.datetime({ offset: true }) })).default([]),
});

export const acceptedConversionSchema = z.object({ id: z.uuid(), status: z.literal("queued"), progress: z.literal(0), createdAt: z.iso.datetime({ offset: true }) });
export type ConversionView = z.infer<typeof conversionViewSchema>;
