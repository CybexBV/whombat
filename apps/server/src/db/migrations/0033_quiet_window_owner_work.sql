DROP INDEX "quiet_windows_work_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "quiet_windows_work_idx" ON "quiet_windows" USING btree ("owner_id","work");