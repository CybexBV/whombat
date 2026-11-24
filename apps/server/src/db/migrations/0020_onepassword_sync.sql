CREATE TABLE "vault_onepassword_links" (
	"id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"entry_id" text,
	"vault_id" text NOT NULL,
	"item_id" text,
	"state" text NOT NULL,
	"item_version" integer,
	"item_updated_at" text,
	"base" jsonb,
	"name_shortened" boolean DEFAULT false NOT NULL,
	"problem" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_onepassword_state" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"vault_title" text,
	"content_version" integer,
	"checked_at" timestamp with time zone,
	"outcome" text,
	"problem" text,
	"read_only" boolean DEFAULT false NOT NULL,
	"not_in_vault" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"removals" jsonb,
	"limit_hits" integer DEFAULT 0 NOT NULL,
	"next_try_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vault_onepassword_links" ADD CONSTRAINT "vault_onepassword_links_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_onepassword_links" ADD CONSTRAINT "vault_onepassword_links_connection_id_catalog_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."catalog_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_onepassword_links" ADD CONSTRAINT "vault_onepassword_links_entry_id_vault_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."vault_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_onepassword_state" ADD CONSTRAINT "vault_onepassword_state_connection_id_catalog_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."catalog_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_onepassword_state" ADD CONSTRAINT "vault_onepassword_state_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vault_onepassword_links_entry_idx" ON "vault_onepassword_links" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_onepassword_links_item_idx" ON "vault_onepassword_links" USING btree ("connection_id","item_id");--> statement-breakpoint
CREATE INDEX "vault_onepassword_links_connection_idx" ON "vault_onepassword_links" USING btree ("connection_id","state");