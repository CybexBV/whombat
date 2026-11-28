CREATE TABLE "change_baselines" (
	"burrow_id" text NOT NULL,
	"thing_id" text NOT NULL,
	"source" text NOT NULL,
	"state" jsonb NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "change_baselines_burrow_id_thing_id_source_pk" PRIMARY KEY("burrow_id","thing_id","source")
);
--> statement-breakpoint
CREATE TABLE "settings_copies" (
	"id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"made_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"sealed" "bytea" NOT NULL,
	"summary" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings_copy_states" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"tried_at" timestamp with time zone,
	"ok_at" timestamp with time zone,
	"failed_since" timestamp with time zone,
	"problem" text,
	"failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thing_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"thing_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"fact" jsonb NOT NULL,
	"by" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"since" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "change_baselines" ADD CONSTRAINT "change_baselines_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_copies" ADD CONSTRAINT "settings_copies_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_copies" ADD CONSTRAINT "settings_copies_connection_id_catalog_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."catalog_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_copy_states" ADD CONSTRAINT "settings_copy_states_connection_id_catalog_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."catalog_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_copy_states" ADD CONSTRAINT "settings_copy_states_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thing_changes" ADD CONSTRAINT "thing_changes_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settings_copies_connection_idx" ON "settings_copies" USING btree ("connection_id","made_at");--> statement-breakpoint
CREATE INDEX "thing_changes_thing_idx" ON "thing_changes" USING btree ("burrow_id","thing_id","seen_at");--> statement-breakpoint
CREATE INDEX "thing_changes_burrow_idx" ON "thing_changes" USING btree ("burrow_id","seen_at");