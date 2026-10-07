ALTER TABLE "conversions" ADD COLUMN "current_stage" text;--> statement-breakpoint
ALTER TABLE "conversions" ADD COLUMN "processing_token" text;--> statement-breakpoint
ALTER TABLE "conversions" ADD COLUMN "processing_lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "conversions_processing_lease_idx" ON "conversions" USING btree ("processing_lease_expires_at") WHERE "conversions"."status" = 'processing';--> statement-breakpoint
CREATE UNIQUE INDEX "conversions_upload_intent_uq" ON "conversions" USING btree ("upload_intent_id") WHERE "conversions"."upload_intent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversions_input_object_key_uq" ON "conversions" USING btree ("input_object_key");--> statement-breakpoint
CREATE INDEX "outbox_events_recovery_idx" ON "outbox_events" USING btree ("status","updated_at");--> statement-breakpoint
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_processing_claim_ck" CHECK (("conversions"."status" = 'processing' and "conversions"."processing_token" is not null and "conversions"."processing_lease_expires_at" is not null) or ("conversions"."status" <> 'processing' and "conversions"."processing_token" is null and "conversions"."processing_lease_expires_at" is null));
