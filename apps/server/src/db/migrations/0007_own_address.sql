CREATE TABLE "box_passkey_users" (
	"account_id" text PRIMARY KEY NOT NULL,
	"user_handle" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_passkey_users_user_handle_unique" UNIQUE("user_handle")
);
--> statement-breakpoint
CREATE TABLE "own_address_certs" (
	"serial" text PRIMARY KEY NOT NULL,
	"spki_sha256" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "own_address_foreign" (
	"spki_sha256" text PRIMARY KEY NOT NULL,
	"names" jsonb NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "appliance_passkeys" ADD COLUMN "rp_id" text;--> statement-breakpoint
ALTER TABLE "appliance_passkeys" ADD COLUMN "user_handle" text;--> statement-breakpoint
ALTER TABLE "appliance_state" ADD COLUMN "shared_route_off" boolean;--> statement-breakpoint
ALTER TABLE "appliance_state" ADD COLUMN "own_address_reach" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "appliance_state" ADD COLUMN "account_linked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appliance_state" ADD COLUMN "account_linked_email" text;--> statement-breakpoint
ALTER TABLE "appliance_state" ADD COLUMN "kit_declared_ids" jsonb;--> statement-breakpoint
ALTER TABLE "appliance_state" ADD COLUMN "kit_declared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "box_passkey_users" ADD CONSTRAINT "box_passkey_users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A box that ran before this release started with the shared-passkey route: never inside A3 (own-address.md).
UPDATE "appliance_state" SET "shared_route_off" = false;