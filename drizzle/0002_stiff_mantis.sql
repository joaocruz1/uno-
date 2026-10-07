CREATE TYPE "public"."conversion_source" AS ENUM('dashboard', 'api');--> statement-breakpoint
ALTER TABLE "conversions" ADD COLUMN "source" "conversion_source" DEFAULT 'dashboard' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversions" ADD COLUMN "original_file_name" text;--> statement-breakpoint
ALTER TABLE "conversions" ADD COLUMN "input_sha256" text;--> statement-breakpoint
ALTER TABLE "conversions" ADD COLUMN "input_pages" integer;--> statement-breakpoint
ALTER TABLE "conversions" ADD COLUMN "output_pages" integer;--> statement-breakpoint
ALTER TABLE "conversions" ADD COLUMN "processing_time_ms" integer;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD COLUMN "original_file_name" text;--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_input_sha256_ck" CHECK ("conversions"."input_sha256" is null or "conversions"."input_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_input_pages_ck" CHECK ("conversions"."input_pages" is null or "conversions"."input_pages" > 0);--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_output_pages_ck" CHECK ("conversions"."output_pages" is null or "conversions"."output_pages" > 0);--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_processing_time_ck" CHECK ("conversions"."processing_time_ms" is null or "conversions"."processing_time_ms" >= 0);--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_original_file_name_ck" CHECK ("conversions"."original_file_name" is null or (char_length("conversions"."original_file_name") between 1 and 160 and position('/' in "conversions"."original_file_name") = 0 and position(chr(92) in "conversions"."original_file_name") = 0 and "conversions"."original_file_name" !~ '[[:cntrl:]]'));--> statement-breakpoint
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_original_file_name_ck" CHECK ("upload_intents"."original_file_name" is null or (char_length("upload_intents"."original_file_name") between 1 and 160 and position('/' in "upload_intents"."original_file_name") = 0 and position(chr(92) in "upload_intents"."original_file_name") = 0 and "upload_intents"."original_file_name" !~ '[[:cntrl:]]'));