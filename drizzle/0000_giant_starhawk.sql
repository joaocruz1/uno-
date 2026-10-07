CREATE TYPE "public"."batch_status" AS ENUM('queued', 'processing', 'completed', 'failed', 'deleting', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."conversion_status" AS ENUM('queued', 'processing', 'completed', 'failed', 'deleting', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('OWNER', 'ADMIN', 'MEMBER');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."page_kind" AS ENUM('digital', 'scanned');--> statement-breakpoint
CREATE TYPE "public"."page_role" AS ENUM('logistics', 'danfe');--> statement-breakpoint
CREATE TYPE "public"."plan_id" AS ENUM('FREE', 'STARTER', 'PRO', 'BUSINESS');--> statement-breakpoint
CREATE TYPE "public"."platform_role" AS ENUM('USER', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('PENDING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."stripe_event_status" AS ENUM('PROCESSING', 'PROCESSED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'UNPAID', 'PAUSED');--> statement-breakpoint
CREATE TYPE "public"."template_status" AS ENUM('DRAFT', 'RELEASED', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."usage_reservation_status" AS ENUM('RESERVED', 'CONFIRMED', 'RELEASED');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_org_id_uq" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "api_requests" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"api_key_id" text,
	"request_id" text NOT NULL,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"idempotency_key" text,
	"request_hash" text,
	"status" "request_status" DEFAULT 'PENDING' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"resource_type" text,
	"resource_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text,
	"actor_user_id" text,
	"actor_type" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text,
	"status" "batch_status" DEFAULT 'queued' NOT NULL,
	"item_count" integer NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"zip_object_key" text,
	"artifacts_expire_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "batches_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "batches_item_count_ck" CHECK ("batches"."item_count" > 0),
	CONSTRAINT "batches_counts_ck" CHECK ("batches"."completed_count" >= 0 and "batches"."failed_count" >= 0 and "batches"."completed_count" + "batches"."failed_count" <= "batches"."item_count"),
	CONSTRAINT "batches_progress_ck" CHECK ("batches"."progress" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "conversion_pages" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"conversion_id" text NOT NULL,
	"page_number" integer NOT NULL,
	"role" "page_role" NOT NULL,
	"kind" "page_kind" NOT NULL,
	"rotation_degrees" integer DEFAULT 0 NOT NULL,
	"width_points" numeric(10, 3) NOT NULL,
	"height_points" numeric(10, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversion_pages_page_number_ck" CHECK ("conversion_pages"."page_number" in (1, 2)),
	CONSTRAINT "conversion_pages_rotation_ck" CHECK ("conversion_pages"."rotation_degrees" in (0, 90, 180, 270)),
	CONSTRAINT "conversion_pages_dimensions_ck" CHECK ("conversion_pages"."width_points" > 0 and "conversion_pages"."height_points" > 0)
);
--> statement-breakpoint
CREATE TABLE "conversions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text,
	"batch_id" text,
	"upload_intent_id" text,
	"template_id" text NOT NULL,
	"template_version" text NOT NULL,
	"engine_version" text NOT NULL,
	"status" "conversion_status" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"output_preset" text NOT NULL,
	"output_width_mm" numeric(6, 2) NOT NULL,
	"output_height_mm" numeric(6, 2) NOT NULL,
	"input_object_key" text NOT NULL,
	"output_object_key" text,
	"source_byte_length" integer NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"error_code" text,
	"error_message" text,
	"suggested_size" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"artifacts_expire_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversions_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "conversions_progress_ck" CHECK ("conversions"."progress" between 0 and 100),
	CONSTRAINT "conversions_attempts_ck" CHECK ("conversions"."attempts" >= 0 and "conversions"."max_attempts" > 0 and "conversions"."attempts" <= "conversions"."max_attempts"),
	CONSTRAINT "conversions_source_byte_length_ck" CHECK ("conversions"."source_byte_length" > 0),
	CONSTRAINT "conversions_output_size_ck" CHECK ("conversions"."output_width_mm" between 50 and 210 and "conversions"."output_height_mm" between 50 and 300)
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "membership_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"deduplication_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "outbox_events_attempts_ck" CHECK ("outbox_events"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "processed_stripe_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"stripe_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" "stripe_event_status" DEFAULT 'PROCESSING' NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "processing_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"conversion_id" text NOT NULL,
	"stage" text NOT NULL,
	"progress" integer NOT NULL,
	"attempt" integer NOT NULL,
	"duration_ms" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_events_progress_ck" CHECK ("processing_events"."progress" between 0 and 100),
	CONSTRAINT "processing_events_attempt_ck" CHECK ("processing_events"."attempt" > 0),
	CONSTRAINT "processing_events_duration_ck" CHECK ("processing_events"."duration_ms" is null or "processing_events"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"plan_id" "plan_id" DEFAULT 'FREE' NOT NULL,
	"status" "subscription_status" DEFAULT 'ACTIVE' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_price_id" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"key" text NOT NULL,
	"version" text NOT NULL,
	"display_name" text NOT NULL,
	"engine_version" text NOT NULL,
	"status" "template_status" DEFAULT 'DRAFT' NOT NULL,
	"definition" jsonb NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_intents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text,
	"object_key" text NOT NULL,
	"content_type" text DEFAULT 'application/pdf' NOT NULL,
	"content_length" integer NOT NULL,
	"checksum_sha256" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_intents_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "upload_intents_content_length_ck" CHECK ("upload_intents"."content_length" > 0)
);
--> statement-breakpoint
CREATE TABLE "usage_periods" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"limit" integer NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"confirmed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_periods_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "usage_periods_dates_ck" CHECK ("usage_periods"."period_end" > "usage_periods"."period_start"),
	CONSTRAINT "usage_periods_limit_ck" CHECK ("usage_periods"."limit" >= 0),
	CONSTRAINT "usage_periods_counters_ck" CHECK ("usage_periods"."reserved" >= 0 and "usage_periods"."confirmed" >= 0 and "usage_periods"."reserved" + "usage_periods"."confirmed" <= "usage_periods"."limit")
);
--> statement-breakpoint
CREATE TABLE "usage_reservations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"usage_period_id" text NOT NULL,
	"conversion_id" text NOT NULL,
	"units" integer DEFAULT 1 NOT NULL,
	"status" "usage_reservation_status" DEFAULT 'RESERVED' NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_reservations_units_ck" CHECK ("usage_reservations"."units" > 0)
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"platform_role" "platform_role" DEFAULT 'USER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"outbox_event_id" text NOT NULL,
	"status" "delivery_status" DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"last_response_status" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "webhook_deliveries_attempt_count_ck" CHECK ("webhook_deliveries"."attempt_count" between 0 and 6)
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery_attempts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"response_status" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_attempts_number_ck" CHECK ("webhook_delivery_attempts"."attempt_number" between 1 and 6)
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"url" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_auth_tag" text NOT NULL,
	"encryption_key_version" text NOT NULL,
	"subscribed_events" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "webhook_endpoints_events_ck" CHECK (cardinality("webhook_endpoints"."subscribed_events") > 0)
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_requests" ADD CONSTRAINT "api_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_requests" ADD CONSTRAINT "api_requests_org_api_key_fk" FOREIGN KEY ("organization_id","api_key_id") REFERENCES "public"."api_keys"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_pages" ADD CONSTRAINT "conversion_pages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_pages" ADD CONSTRAINT "conversion_pages_org_conversion_fk" FOREIGN KEY ("organization_id","conversion_id") REFERENCES "public"."conversions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_org_batch_fk" FOREIGN KEY ("organization_id","batch_id") REFERENCES "public"."batches"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_org_upload_intent_fk" FOREIGN KEY ("organization_id","upload_intent_id") REFERENCES "public"."upload_intents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_events" ADD CONSTRAINT "processing_events_org_conversion_fk" FOREIGN KEY ("organization_id","conversion_id") REFERENCES "public"."conversions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_periods" ADD CONSTRAINT "usage_periods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_org_period_fk" FOREIGN KEY ("organization_id","usage_period_id") REFERENCES "public"."usage_periods"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_org_conversion_fk" FOREIGN KEY ("organization_id","conversion_id") REFERENCES "public"."conversions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_endpoint_fk" FOREIGN KEY ("organization_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_outbox_fk" FOREIGN KEY ("organization_id","outbox_event_id") REFERENCES "public"."outbox_events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_attempts_org_delivery_fk" FOREIGN KEY ("organization_id","delivery_id") REFERENCES "public"."webhook_deliveries"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_uq" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_org_active_idx" ON "api_keys" USING btree ("organization_id","created_at") WHERE "api_keys"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "api_keys_created_by_user_id_idx" ON "api_keys" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_requests_request_id_uq" ON "api_requests" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_requests_org_route_idempotency_uq" ON "api_requests" USING btree ("organization_id","route","idempotency_key") WHERE "api_requests"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "api_requests_org_created_idx" ON "api_requests" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_user_id_idx" ON "audit_logs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "batches_org_status_created_idx" ON "batches" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "batches_created_by_user_id_idx" ON "batches" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_pages_org_id_uq" ON "conversion_pages" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_pages_conversion_page_uq" ON "conversion_pages" USING btree ("conversion_id","page_number");--> statement-breakpoint
CREATE INDEX "conversion_pages_org_conversion_idx" ON "conversion_pages" USING btree ("organization_id","conversion_id");--> statement-breakpoint
CREATE INDEX "conversions_org_status_created_idx" ON "conversions" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "conversions_org_batch_id_idx" ON "conversions" USING btree ("organization_id","batch_id");--> statement-breakpoint
CREATE INDEX "conversions_template_id_idx" ON "conversions" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "conversions_created_by_user_id_idx" ON "conversions" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memberships_org_role_idx" ON "memberships" USING btree ("organization_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_uq" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "organizations_owner_user_id_idx" ON "organizations" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_deduplication_key_uq" ON "outbox_events" USING btree ("deduplication_key");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("available_at","created_at") WHERE "outbox_events"."status" in ('PENDING', 'FAILED');--> statement-breakpoint
CREATE UNIQUE INDEX "processed_stripe_events_event_id_uq" ON "processed_stripe_events" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX "processed_stripe_events_status_received_idx" ON "processed_stripe_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "processing_events_org_conversion_created_idx" ON "processing_events" USING btree ("organization_id","conversion_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_uq" ON "session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_organization_id_uq" ON "subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_stripe_customer_id_uq" ON "subscriptions" USING btree ("stripe_customer_id") WHERE "subscriptions"."stripe_customer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_uq" ON "subscriptions" USING btree ("stripe_subscription_id") WHERE "subscriptions"."stripe_subscription_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "templates_key_version_uq" ON "templates" USING btree ("key","version");--> statement-breakpoint
CREATE INDEX "templates_status_key_idx" ON "templates" USING btree ("status","key");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_intents_object_key_uq" ON "upload_intents" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "upload_intents_org_expires_idx" ON "upload_intents" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE INDEX "upload_intents_created_by_user_id_idx" ON "upload_intents" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_periods_org_period_uq" ON "usage_periods" USING btree ("organization_id","period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_reservations_org_id_uq" ON "usage_reservations" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_reservations_conversion_uq" ON "usage_reservations" USING btree ("conversion_id");--> statement-breakpoint
CREATE INDEX "usage_reservations_org_period_status_idx" ON "usage_reservations" USING btree ("organization_id","usage_period_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_uq" ON "user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_event_uq" ON "webhook_deliveries" USING btree ("endpoint_id","outbox_event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at","created_at") WHERE "webhook_deliveries"."status" in ('PENDING', 'FAILED');--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_delivery_attempts_delivery_number_uq" ON "webhook_delivery_attempts" USING btree ("delivery_id","attempt_number");--> statement-breakpoint
CREATE INDEX "webhook_delivery_attempts_org_delivery_idx" ON "webhook_delivery_attempts" USING btree ("organization_id","delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_org_active_idx" ON "webhook_endpoints" USING btree ("organization_id","active");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_created_by_user_id_idx" ON "webhook_endpoints" USING btree ("created_by_user_id");