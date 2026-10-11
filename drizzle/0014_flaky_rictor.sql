CREATE TYPE "public"."pix_charge_status" AS ENUM('PENDING', 'APPROVED', 'EXPIRED', 'FAILED');--> statement-breakpoint
CREATE TABLE "pix_charges" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text,
	"plan_id" "plan_id" NOT NULL,
	"days" integer NOT NULL,
	"amount_brl_cents" integer NOT NULL,
	"provider" text DEFAULT 'mercadopago' NOT NULL,
	"provider_charge_id" text,
	"status" "pix_charge_status" DEFAULT 'PENDING' NOT NULL,
	"qr_code" text,
	"qr_code_base64" text,
	"grant_external_ref" text,
	"expires_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pix_charges_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "pix_charges_days_ck" CHECK ("pix_charges"."days" > 0),
	CONSTRAINT "pix_charges_plan_ck" CHECK ("pix_charges"."plan_id" <> 'FREE'),
	CONSTRAINT "pix_charges_amount_ck" CHECK ("pix_charges"."amount_brl_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "pix_charges" ADD CONSTRAINT "pix_charges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pix_charges" ADD CONSTRAINT "pix_charges_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pix_charges_provider_charge_uq" ON "pix_charges" USING btree ("provider_charge_id") WHERE "pix_charges"."provider_charge_id" is not null;--> statement-breakpoint
CREATE INDEX "pix_charges_org_created_idx" ON "pix_charges" USING btree ("organization_id","created_at");