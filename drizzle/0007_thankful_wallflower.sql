CREATE TYPE "public"."api_request_upload_status" AS ENUM('PREPARING', 'READY', 'COMMITTED', 'ABORTED');--> statement-breakpoint
CREATE TABLE "api_request_uploads" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"api_request_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"object_key" text NOT NULL,
	"multipart_upload_id" text,
	"status" "api_request_upload_status" DEFAULT 'PREPARING' NOT NULL,
	"original_file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"content_length" integer,
	"checksum_sha256" text,
	"cleanup_after" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_request_uploads_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "api_request_uploads_ordinal_ck" CHECK ("api_request_uploads"."ordinal" >= 0),
	CONSTRAINT "api_request_uploads_attempt_ck" CHECK ("api_request_uploads"."attempt" > 0),
	CONSTRAINT "api_request_uploads_content_length_ck" CHECK ("api_request_uploads"."content_length" is null or "api_request_uploads"."content_length" > 0),
	CONSTRAINT "api_request_uploads_sha_ck" CHECK ("api_request_uploads"."checksum_sha256" is null or "api_request_uploads"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_request_uploads_name_ck" CHECK (char_length("api_request_uploads"."original_file_name") between 1 and 160 and position('/' in "api_request_uploads"."original_file_name") = 0 and position(chr(92) in "api_request_uploads"."original_file_name") = 0 and "api_request_uploads"."original_file_name" !~ '[[:cntrl:]]'),
	CONSTRAINT "api_request_uploads_ready_ck" CHECK ("api_request_uploads"."status" in ('PREPARING', 'ABORTED') or ("api_request_uploads"."content_length" is not null and "api_request_uploads"."checksum_sha256" is not null))
);
--> statement-breakpoint
ALTER TABLE "api_requests" ADD COLUMN "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_requests" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "api_key_id" text;--> statement-breakpoint
ALTER TABLE "conversions" ADD COLUMN "api_key_id" text;--> statement-breakpoint
ALTER TABLE "api_requests" ADD CONSTRAINT "api_requests_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "api_request_uploads" ADD CONSTRAINT "api_request_uploads_org_request_fk" FOREIGN KEY ("organization_id","api_request_id") REFERENCES "public"."api_requests"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_request_uploads_request_attempt_ordinal_uq" ON "api_request_uploads" USING btree ("api_request_id","attempt","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "api_request_uploads_object_key_uq" ON "api_request_uploads" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "api_request_uploads_cleanup_idx" ON "api_request_uploads" USING btree ("status","cleanup_after");--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_org_api_key_fk" FOREIGN KEY ("organization_id","api_key_id") REFERENCES "public"."api_keys"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_org_api_key_fk" FOREIGN KEY ("organization_id","api_key_id") REFERENCES "public"."api_keys"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batches_api_key_id_idx" ON "batches" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "conversions_api_key_id_idx" ON "conversions" USING btree ("api_key_id");--> statement-breakpoint
ALTER TABLE "api_requests" ADD CONSTRAINT "api_requests_attempts_ck" CHECK ("api_requests"."attempts" > 0);
