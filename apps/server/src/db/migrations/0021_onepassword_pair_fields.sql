ALTER TABLE "vault_onepassword_links" ADD COLUMN "totp_field_id" text;--> statement-breakpoint
ALTER TABLE "vault_onepassword_links" ADD COLUMN "marker_entry_id" text;--> statement-breakpoint
ALTER TABLE "vault_onepassword_links" ADD COLUMN "refused" jsonb;--> statement-breakpoint
ALTER TABLE "vault_onepassword_state" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;