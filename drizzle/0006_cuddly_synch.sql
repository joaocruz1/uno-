CREATE TYPE "public"."billing_checkout_status" AS ENUM('CREATING', 'OPEN', 'COMPLETED', 'EXPIRED', 'FAILED');--> statement-breakpoint
CREATE TABLE "billing_checkout_intents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text,
	"plan_id" "plan_id" NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"provider_attempt" integer DEFAULT 1 NOT NULL,
	"stripe_session_id" text,
	"checkout_url" text,
	"status" "billing_checkout_status" DEFAULT 'CREATING' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_checkout_intents_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "billing_checkout_intents_plan_ck" CHECK ("billing_checkout_intents"."plan_id" <> 'FREE'),
	CONSTRAINT "billing_checkout_intents_idempotency_ck" CHECK (char_length("billing_checkout_intents"."idempotency_key") between 16 and 128 and "billing_checkout_intents"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "billing_checkout_intents_provider_attempt_ck" CHECK ("billing_checkout_intents"."provider_attempt" > 0),
	CONSTRAINT "billing_checkout_intents_open_ck" CHECK ("billing_checkout_intents"."status" <> 'OPEN' or ("billing_checkout_intents"."stripe_session_id" is not null and "billing_checkout_intents"."checkout_url" is not null and "billing_checkout_intents"."expires_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "processed_stripe_events" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "processed_stripe_events" ADD COLUMN "stripe_created_at" timestamp with time zone;--> statement-breakpoint
UPDATE "processed_stripe_events" SET "stripe_created_at" = "received_at" WHERE "stripe_created_at" IS NULL;--> statement-breakpoint
ALTER TABLE "processed_stripe_events" ALTER COLUMN "stripe_created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_stripe_events" ADD COLUMN "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_stripe_events" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "reconciliation_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "last_reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ADD CONSTRAINT "billing_checkout_intents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ADD CONSTRAINT "billing_checkout_intents_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_intents_org_idempotency_uq" ON "billing_checkout_intents" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_intents_stripe_session_uq" ON "billing_checkout_intents" USING btree ("stripe_session_id") WHERE "billing_checkout_intents"."stripe_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_intents_org_active_uq" ON "billing_checkout_intents" USING btree ("organization_id") WHERE "billing_checkout_intents"."status" in ('CREATING','OPEN');--> statement-breakpoint
CREATE INDEX "billing_checkout_intents_status_expires_idx" ON "billing_checkout_intents" USING btree ("status","expires_at");--> statement-breakpoint
ALTER TABLE "processed_stripe_events" ADD CONSTRAINT "processed_stripe_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "processed_stripe_events_org_received_idx" ON "processed_stripe_events" USING btree ("organization_id","received_at");--> statement-breakpoint
ALTER TABLE "processed_stripe_events" ADD CONSTRAINT "processed_stripe_events_attempts_ck" CHECK ("processed_stripe_events"."attempts" > 0);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_reconciliation_version_ck" CHECK ("subscriptions"."reconciliation_version" >= 0);
