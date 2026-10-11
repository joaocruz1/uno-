CREATE TYPE "public"."batch_kind" AS ENUM('files', 'marketplace');--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "kind" "batch_kind" DEFAULT 'files' NOT NULL;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "marketplace" text;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "numbering" jsonb;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "combined_pdf_object_key" text;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "combined_pdf_byte_length" bigint;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_kind_ck" CHECK (("batches"."kind" = 'files' and "batches"."marketplace" is null) or ("batches"."kind" = 'marketplace' and "batches"."marketplace" is not null));