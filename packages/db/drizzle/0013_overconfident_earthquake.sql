CREATE TABLE "spy_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"probe_id" uuid,
	"message_id" uuid,
	"branch" text,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"file_name" text,
	"bytes" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spy_media" ADD CONSTRAINT "spy_media_offer_id_spy_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."spy_offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spy_media" ADD CONSTRAINT "spy_media_probe_id_spy_probes_id_fk" FOREIGN KEY ("probe_id") REFERENCES "public"."spy_probes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spy_media" ADD CONSTRAINT "spy_media_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spy_media_offer_idx" ON "spy_media" USING btree ("offer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "spy_media_message_idx" ON "spy_media" USING btree ("message_id") WHERE "spy_media"."message_id" is not null;