ALTER TABLE "catalog_connections" ADD COLUMN "hub_check_id" text;--> statement-breakpoint
ALTER TABLE "catalog_connections" ADD COLUMN "hub_check_changed_at" timestamp with time zone;