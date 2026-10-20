DROP INDEX "spy_probes_active_phone_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "spy_probes_active_branch_idx" ON "spy_probes" USING btree ("phone","branch") WHERE "spy_probes"."status" = 'ativa';--> statement-breakpoint
CREATE UNIQUE INDEX "spy_probes_active_session_idx" ON "spy_probes" USING btree ("phone","session_id") WHERE "spy_probes"."status" = 'ativa';