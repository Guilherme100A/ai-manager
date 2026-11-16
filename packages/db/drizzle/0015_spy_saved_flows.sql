ALTER TABLE "spy_offers" ADD COLUMN IF NOT EXISTS "flow_title" text;--> statement-breakpoint
ALTER TABLE "spy_offers" ADD COLUMN IF NOT EXISTS "flow_script" text;--> statement-breakpoint
ALTER TABLE "spy_offers" ADD COLUMN IF NOT EXISTS "flow_source" text DEFAULT 'captured' NOT NULL;--> statement-breakpoint
ALTER TABLE "spy_offers" ADD COLUMN IF NOT EXISTS "flow_data" jsonb;
