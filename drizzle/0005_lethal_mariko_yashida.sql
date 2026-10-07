CREATE TYPE "public"."batch_archive_status" AS ENUM('PENDING', 'PACKAGING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."batch_upload_item_status" AS ENUM('PENDING', 'UPLOADING', 'PREPARING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."batch_upload_session_status" AS ENUM('OPEN', 'ACCEPTED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "batch_upload_items" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"session_id" text NOT NULL,
	"client_item_id" text NOT NULL,
	"original_file_name" text NOT NULL,
	"content_length" integer NOT NULL,
	"expected_sha256" text,
	"status" "batch_upload_item_status" DEFAULT 'PENDING' NOT NULL,
	"staging_object_key" text,
	"staging_expires_at" timestamp with time zone,
	"ready_object_key" text,
	"ready_sha256" text,
	"error_code" text,
	"error_message" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_upload_items_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "batch_upload_items_content_length_ck" CHECK ("batch_upload_items"."content_length" > 0),
	CONSTRAINT "batch_upload_items_client_id_ck" CHECK (char_length("batch_upload_items"."client_item_id") between 1 and 128 and "batch_upload_items"."client_item_id" !~ '[[:cntrl:]]'),
	CONSTRAINT "batch_upload_items_sha_ck" CHECK ("batch_upload_items"."expected_sha256" is null or "batch_upload_items"."expected_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "batch_upload_items_ready_sha_ck" CHECK ("batch_upload_items"."ready_sha256" is null or "batch_upload_items"."ready_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "batch_upload_items_name_ck" CHECK (char_length("batch_upload_items"."original_file_name") between 1 and 160 and position('/' in "batch_upload_items"."original_file_name") = 0 and position(chr(92) in "batch_upload_items"."original_file_name") = 0 and "batch_upload_items"."original_file_name" !~ '[[:cntrl:]]'),
	CONSTRAINT "batch_upload_items_ready_ck" CHECK ("batch_upload_items"."status" <> 'READY' or ("batch_upload_items"."ready_object_key" is not null and "batch_upload_items"."ready_sha256" is not null and "batch_upload_items"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "batch_upload_sessions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text,
	"status" "batch_upload_session_status" DEFAULT 'OPEN' NOT NULL,
	"template_reference" text NOT NULL,
	"output_preset" text NOT NULL,
	"output_width_mm" numeric(6, 2) NOT NULL,
	"output_height_mm" numeric(6, 2) NOT NULL,
	"accepted_batch_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_upload_sessions_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "batch_upload_sessions_size_ck" CHECK ("batch_upload_sessions"."output_width_mm" between 50 and 210 and "batch_upload_sessions"."output_height_mm" between 50 and 300)
);
--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "upload_session_id" text;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "phase" text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "zip_byte_length" bigint;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "archive_status" "batch_archive_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "archive_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "archive_max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "archive_token" text;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "archive_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "archive_error_code" text;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "archive_error_message" text;--> statement-breakpoint
ALTER TABLE "batch_upload_items" ADD CONSTRAINT "batch_upload_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_upload_items" ADD CONSTRAINT "batch_upload_items_org_session_fk" FOREIGN KEY ("organization_id","session_id") REFERENCES "public"."batch_upload_sessions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_upload_sessions" ADD CONSTRAINT "batch_upload_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_upload_sessions" ADD CONSTRAINT "batch_upload_sessions_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batch_upload_items_session_client_uq" ON "batch_upload_items" USING btree ("session_id","client_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_upload_items_staging_key_uq" ON "batch_upload_items" USING btree ("staging_object_key") WHERE "batch_upload_items"."staging_object_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "batch_upload_items_ready_key_uq" ON "batch_upload_items" USING btree ("ready_object_key") WHERE "batch_upload_items"."ready_object_key" is not null;--> statement-breakpoint
CREATE INDEX "batch_upload_items_org_status_idx" ON "batch_upload_items" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_upload_sessions_accepted_batch_uq" ON "batch_upload_sessions" USING btree ("accepted_batch_id") WHERE "batch_upload_sessions"."accepted_batch_id" is not null;--> statement-breakpoint
CREATE INDEX "batch_upload_sessions_org_status_expires_idx" ON "batch_upload_sessions" USING btree ("organization_id","status","expires_at");--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_org_upload_session_fk" FOREIGN KEY ("organization_id","upload_session_id") REFERENCES "public"."batch_upload_sessions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batches_upload_session_uq" ON "batches" USING btree ("upload_session_id") WHERE "batches"."upload_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "batches_org_idempotency_uq" ON "batches" USING btree ("organization_id","idempotency_key") WHERE "batches"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "batches_archive_lease_idx" ON "batches" USING btree ("archive_lease_expires_at") WHERE "batches"."phase" = 'packaging';--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_phase_ck" CHECK ("batches"."phase" in ('queued','processing','packaging','completed','failed'));--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_idempotency_ck" CHECK (("batches"."idempotency_key" is null and "batches"."request_hash" is null) or ("batches"."idempotency_key" is not null and "batches"."request_hash" is not null and char_length("batches"."idempotency_key") between 16 and 128 and "batches"."request_hash" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_archive_attempts_ck" CHECK ("batches"."archive_attempts" >= 0 and "batches"."archive_max_attempts" > 0 and "batches"."archive_attempts" <= "batches"."archive_max_attempts");--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_archive_claim_ck" CHECK (("batches"."archive_status" = 'PACKAGING' and "batches"."archive_token" is not null and "batches"."archive_lease_expires_at" is not null) or ("batches"."archive_status" <> 'PACKAGING' and "batches"."archive_token" is null and "batches"."archive_lease_expires_at" is null));