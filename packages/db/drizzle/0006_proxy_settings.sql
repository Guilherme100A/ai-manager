CREATE TABLE "proxy_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"ip_limit_enabled" boolean DEFAULT false NOT NULL,
	"max_sessions_per_ip" smallint DEFAULT 3 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proxy_settings_singleton_check" CHECK ("proxy_settings"."id" = 1),
	CONSTRAINT "proxy_settings_max_check" CHECK ("proxy_settings"."max_sessions_per_ip" >= 1 and "proxy_settings"."max_sessions_per_ip" <= 50)
);
