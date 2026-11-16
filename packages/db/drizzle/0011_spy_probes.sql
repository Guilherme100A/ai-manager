CREATE TABLE "spy_probes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"branch" text DEFAULT 'principal' NOT NULL,
	"status" text DEFAULT 'ativa' NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"max_turns" integer DEFAULT 12 NOT NULL,
	"reply_due_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"listen_until" timestamp with time zone,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ended_reason" text,
	"created_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spy_probes" ADD CONSTRAINT "spy_probes_offer_id_spy_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."spy_offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spy_probes" ADD CONSTRAINT "spy_probes_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spy_probes_active_phone_idx" ON "spy_probes" USING btree ("phone") WHERE "spy_probes"."status" = 'ativa';--> statement-breakpoint
CREATE INDEX "spy_probes_session_idx" ON "spy_probes" USING btree ("session_id","status");