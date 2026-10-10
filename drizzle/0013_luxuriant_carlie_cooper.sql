CREATE TYPE "public"."billing_grant_source" AS ENUM('PIX', 'REFERRAL');--> statement-breakpoint
CREATE TYPE "public"."billing_grant_status" AS ENUM('APPLIED', 'REVOKED');--> statement-breakpoint
CREATE TABLE "billing_grants" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"plan_id" "plan_id" NOT NULL,
	"days" integer NOT NULL,
	"source" "billing_grant_source" NOT NULL,
	"external_ref" text NOT NULL,
	"amount_brl_cents" integer,
	"status" "billing_grant_status" DEFAULT 'APPLIED' NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_grants_days_ck" CHECK ("billing_grants"."days" > 0),
	CONSTRAINT "billing_grants_plan_ck" CHECK ("billing_grants"."plan_id" <> 'FREE'),
	CONSTRAINT "billing_grants_amount_ck" CHECK ("billing_grants"."amount_brl_cents" is null or "billing_grants"."amount_brl_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "prepaid_plan_id" "plan_id";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "prepaid_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_grants" ADD CONSTRAINT "billing_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_grants_external_ref_uq" ON "billing_grants" USING btree ("external_ref");--> statement-breakpoint
CREATE INDEX "billing_grants_org_idx" ON "billing_grants" USING btree ("organization_id","applied_at");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_prepaid_ck" CHECK (("subscriptions"."prepaid_plan_id" is null and "subscriptions"."prepaid_period_end" is null) or ("subscriptions"."prepaid_plan_id" is not null and "subscriptions"."prepaid_plan_id" <> 'FREE' and "subscriptions"."prepaid_period_end" is not null));