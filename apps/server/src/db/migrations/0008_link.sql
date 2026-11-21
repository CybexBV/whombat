ALTER TABLE "appliance_endpoints" ADD COLUMN "push_token" jsonb;--> statement-breakpoint
ALTER TABLE "appliance_endpoints" ADD COLUMN "push_token_handle" text;--> statement-breakpoint
ALTER TABLE "appliance_state" ADD COLUMN "link_noticed" text;