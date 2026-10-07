import { z } from "zod";

const isoDate = z.iso.datetime({ offset: true });

export const WEBHOOK_EVENT_TYPES = ["conversion.completed", "conversion.failed", "batch.completed"] as const;
export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof webhookEventTypeSchema>;

export const WEBHOOK_URL_MAX_LENGTH = 2_048;

export const webhookEventsSchema = z.array(webhookEventTypeSchema).min(1).max(WEBHOOK_EVENT_TYPES.length)
  .refine((events) => new Set(events).size === events.length);

export const webhookEndpointCreateSchema = z.object({
  url: z.string().trim().min(1).max(WEBHOOK_URL_MAX_LENGTH),
  events: webhookEventsSchema,
}).strict();

export const webhookEndpointUpdateSchema = z.object({ active: z.boolean() }).strict();

export const webhookEndpointSchema = z.object({
  id: z.uuid(),
  url: z.string().min(1).max(WEBHOOK_URL_MAX_LENGTH),
  events: z.array(webhookEventTypeSchema).min(1),
  active: z.boolean(),
  disabledAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const webhookEndpointListSchema = z.object({
  items: z.array(webhookEndpointSchema),
  maxActiveEndpoints: z.number().int().positive(),
});

export const webhookEndpointCreatedSchema = webhookEndpointSchema.extend({
  secret: z.string().min(40).max(160),
});

export const webhookDeliveryStatusSchema = z.enum(["pending", "processing", "delivered", "failed", "canceled"]);

export const webhookDeliveryAttemptSchema = z.object({
  attemptNumber: z.number().int().min(1).max(6),
  scheduledAt: isoDate,
  startedAt: isoDate.nullable(),
  finishedAt: isoDate.nullable(),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
});

export const webhookDeliverySchema = z.object({
  id: z.uuid(),
  endpointId: z.uuid(),
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  status: webhookDeliveryStatusSchema,
  attemptCount: z.number().int().min(0).max(6),
  nextAttemptAt: isoDate.nullable(),
  deliveredAt: isoDate.nullable(),
  lastResponseStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  canRetry: z.boolean(),
  createdAt: isoDate,
  attempts: z.array(webhookDeliveryAttemptSchema).max(6),
});

export const webhookDeliveryQuerySchema = z.object({
  endpointId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();

export const webhookDeliveryListSchema = z.object({
  items: z.array(webhookDeliverySchema).max(50),
  nextCursor: z.string().nullable(),
});

const safeErrorSchema = z.object({ code: z.string().min(1).max(64), message: z.string().min(1).max(300) }).strict();

export const webhookEventDataSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("conversion.completed"),
    data: z.object({ conversionId: z.uuid(), status: z.literal("completed") }).strict(),
  }),
  z.object({
    type: z.literal("conversion.failed"),
    data: z.object({ conversionId: z.uuid(), status: z.literal("failed"), error: safeErrorSchema }).strict(),
  }),
  z.object({
    type: z.literal("batch.completed"),
    data: z.object({
      batchId: z.uuid(),
      status: z.enum(["completed", "failed"]),
      counts: z.object({ completed: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).strict(),
    }).strict(),
  }),
]);

export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;
export type WebhookEndpointList = z.infer<typeof webhookEndpointListSchema>;
export type WebhookEndpointCreated = z.infer<typeof webhookEndpointCreatedSchema>;
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;
export type WebhookDeliveryList = z.infer<typeof webhookDeliveryListSchema>;
export type WebhookDeliveryQuery = z.infer<typeof webhookDeliveryQuerySchema>;
export type WebhookEventData = z.infer<typeof webhookEventDataSchema>;
