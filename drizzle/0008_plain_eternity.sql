CREATE TYPE "public"."invitation_status" AS ENUM('PENDING', 'ACCEPTED', 'REVOKED');--> statement-breakpoint
ALTER TYPE "public"."delivery_status" ADD VALUE 'CANCELED';--> statement-breakpoint
CREATE TABLE "organization_invitations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" "membership_role" DEFAULT 'MEMBER' NOT NULL,
	"token_hash" text NOT NULL,
	"status" "invitation_status" DEFAULT 'PENDING' NOT NULL,
	"invited_by_user_id" text,
	"accepted_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invitations_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "organization_invitations_role_ck" CHECK ("organization_invitations"."role" in ('ADMIN', 'MEMBER')),
	CONSTRAINT "organization_invitations_email_ck" CHECK ("organization_invitations"."email" = lower("organization_invitations"."email") and char_length("organization_invitations"."email") between 3 and 320),
	CONSTRAINT "organization_invitations_token_hash_ck" CHECK ("organization_invitations"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "template_releases" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" text NOT NULL,
	"engine_version" text NOT NULL,
	"width_mm" numeric(6, 2) NOT NULL,
	"height_mm" numeric(6, 2) NOT NULL,
	"automatic_report" jsonb NOT NULL,
	"automatic_report_sha256" text NOT NULL,
	"physical_proof" jsonb NOT NULL,
	"physical_proof_sha256" text NOT NULL,
	"evidence_sha256" text NOT NULL,
	"attested_by_user_id" text,
	"approved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_releases_size_ck" CHECK ("template_releases"."width_mm" between 50 and 210 and "template_releases"."height_mm" between 50 and 300),
	CONSTRAINT "template_releases_sha_ck" CHECK ("template_releases"."automatic_report_sha256" ~ '^[0-9a-f]{64}$' and "template_releases"."physical_proof_sha256" ~ '^[0-9a-f]{64}$' and "template_releases"."evidence_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "retention_token" text;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "retention_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversions" ADD COLUMN "retention_token" text;--> statement-breakpoint
ALTER TABLE "conversions" ADD COLUMN "retention_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "event_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "body" text NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "claim_token" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_accepted_by_user_id_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_releases" ADD CONSTRAINT "template_releases_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_releases" ADD CONSTRAINT "template_releases_attested_by_user_id_user_id_fk" FOREIGN KEY ("attested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invitations_token_hash_uq" ON "organization_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invitations_pending_email_uq" ON "organization_invitations" USING btree ("organization_id","email") WHERE "organization_invitations"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "organization_invitations_org_created_idx" ON "organization_invitations" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "organization_invitations_invited_by_user_id_idx" ON "organization_invitations" USING btree ("invited_by_user_id");--> statement-breakpoint
CREATE INDEX "organization_invitations_accepted_by_user_id_idx" ON "organization_invitations" USING btree ("accepted_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "template_releases_template_size_uq" ON "template_releases" USING btree ("template_id","width_mm","height_mm");--> statement-breakpoint
CREATE INDEX "template_releases_attested_by_user_id_idx" ON "template_releases" USING btree ("attested_by_user_id");--> statement-breakpoint
CREATE INDEX "batches_retention_idx" ON "batches" USING btree ("artifacts_expire_at") WHERE "batches"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX "conversions_retention_idx" ON "conversions" USING btree ("artifacts_expire_at") WHERE "conversions"."status" <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_one_owner_uq" ON "memberships" USING btree ("organization_id") WHERE "memberships"."role" = 'OWNER';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_org_created_idx" ON "webhook_deliveries" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_lease_idx" ON "webhook_deliveries" USING btree ("lease_expires_at") WHERE "webhook_deliveries"."status" = 'PROCESSING';