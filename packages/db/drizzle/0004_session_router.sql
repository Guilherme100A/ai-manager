CREATE TABLE "session_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_session_id" uuid NOT NULL,
	"target_session_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"rules" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_links_distinct_sessions" CHECK ("session_links"."source_session_id" <> "session_links"."target_session_id")
);
--> statement-breakpoint
CREATE TABLE "session_route_runs" (
	"link_id" uuid NOT NULL,
	"inbound_id" text NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"message_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_route_runs_link_id_inbound_id_pk" PRIMARY KEY("link_id","inbound_id")
);
--> statement-breakpoint
ALTER TABLE "session_links" ADD CONSTRAINT "session_links_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_links" ADD CONSTRAINT "session_links_target_session_id_sessions_id_fk" FOREIGN KEY ("target_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_route_runs" ADD CONSTRAINT "session_route_runs_link_id_session_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."session_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_route_runs" ADD CONSTRAINT "session_route_runs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_links_source_idx" ON "session_links" USING btree ("source_session_id","enabled");