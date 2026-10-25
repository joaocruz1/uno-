CREATE TABLE "coupons" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"code" text NOT NULL,
	"stripe_coupon_id" text NOT NULL,
	"stripe_promotion_code_id" text NOT NULL,
	"discount_type" text NOT NULL,
	"percent_off" integer,
	"amount_off_brl_cents" integer,
	"duration" text NOT NULL,
	"duration_in_months" integer,
	"plan_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_redemptions" integer,
	"expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_code_ck" CHECK ("coupons"."code" ~ '^[A-Z0-9_-]{3,40}$'),
	CONSTRAINT "coupons_discount_ck" CHECK (("coupons"."discount_type" = 'PERCENT' and "coupons"."percent_off" between 1 and 100 and "coupons"."amount_off_brl_cents" is null) or ("coupons"."discount_type" = 'AMOUNT' and "coupons"."amount_off_brl_cents" > 0 and "coupons"."percent_off" is null)),
	CONSTRAINT "coupons_duration_ck" CHECK (("coupons"."duration" in ('once', 'forever') and "coupons"."duration_in_months" is null) or ("coupons"."duration" = 'repeating' and "coupons"."duration_in_months" between 1 and 36)),
	CONSTRAINT "coupons_max_redemptions_ck" CHECK ("coupons"."max_redemptions" is null or "coupons"."max_redemptions" > 0)
);
--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ADD COLUMN "promotion_code" text;--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ADD COLUMN "applied_discount" text;--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ADD COLUMN "coupon_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "applied_coupon_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "applied_coupon_code" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "applied_promotion_code_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_code_uq" ON "coupons" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_stripe_promotion_code_uq" ON "coupons" USING btree ("stripe_promotion_code_id");--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ADD CONSTRAINT "billing_checkout_intents_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_applied_coupon_id_coupons_id_fk" FOREIGN KEY ("applied_coupon_id") REFERENCES "public"."coupons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_checkout_intents_coupon_idx" ON "billing_checkout_intents" USING btree ("coupon_id");--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ADD CONSTRAINT "billing_checkout_intents_discount_ck" CHECK ("billing_checkout_intents"."applied_discount" is null or "billing_checkout_intents"."applied_discount" in ('COUPON', 'FIRST_MONTH', 'NONE'));