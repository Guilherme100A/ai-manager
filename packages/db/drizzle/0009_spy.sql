CREATE TABLE "spy_ads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"input_url" text NOT NULL,
	"parent_id" uuid,
	"ad_archive_id" text,
	"page_id" text,
	"page_name" text,
	"status" text DEFAULT 'na_fila' NOT NULL,
	"phone" text,
	"found_via" text,
	"evidence_url" text,
	"error" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"offer_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spy_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"page_id" text,
	"page_name" text,
	"status" text DEFAULT 'nova' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spy_ads" ADD CONSTRAINT "spy_ads_offer_id_spy_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."spy_offers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spy_ads_archive_idx" ON "spy_ads" USING btree ("ad_archive_id") WHERE "spy_ads"."ad_archive_id" is not null;--> statement-breakpoint
CREATE INDEX "spy_ads_status_idx" ON "spy_ads" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "spy_offers_phone_idx" ON "spy_offers" USING btree ("phone");