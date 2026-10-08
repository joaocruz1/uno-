ALTER TABLE "billing_checkout_intents" DROP CONSTRAINT "billing_checkout_intents_plan_ck";--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ALTER COLUMN "plan_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ADD COLUMN "addon" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "api_addon_subscription_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "api_addon_status" "subscription_status";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "api_addon_current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_checkout_intents" ADD CONSTRAINT "billing_checkout_intents_plan_ck" CHECK (("billing_checkout_intents"."plan_id" is not null and "billing_checkout_intents"."plan_id" <> 'FREE' and "billing_checkout_intents"."addon" is null) or ("billing_checkout_intents"."plan_id" is null and "billing_checkout_intents"."addon" = 'API'));