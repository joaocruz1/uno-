ALTER TABLE "subscriptions" ADD COLUMN "refund_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "refunded_at" timestamp with time zone;