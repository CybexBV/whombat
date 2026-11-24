CREATE TABLE "quiet_windows" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"thing_id" text NOT NULL,
	"guest_id" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"note" text,
	"by_id" text,
	"work" text,
	"maintenance_id" text,
	"ended_at" timestamp with time zone,
	"ended_by_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thing_causes" (
	"owner_id" text NOT NULL,
	"thing_id" text NOT NULL,
	"cause_thing" text NOT NULL,
	"cause_name" text NOT NULL,
	"kind" text DEFAULT 'down' NOT NULL,
	"words" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "thing_causes_pk" PRIMARY KEY("owner_id","thing_id")
);
--> statement-breakpoint
CREATE TABLE "way_out_outages" (
	"id" text PRIMARY KEY NOT NULL,
	"step" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "quiet_windows_thing_idx" ON "quiet_windows" USING btree ("owner_id","thing_id");--> statement-breakpoint
CREATE INDEX "quiet_windows_ends_idx" ON "quiet_windows" USING btree ("ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quiet_windows_work_idx" ON "quiet_windows" USING btree ("work");--> statement-breakpoint
CREATE INDEX "thing_causes_cause_idx" ON "thing_causes" USING btree ("owner_id","cause_thing");--> statement-breakpoint
CREATE INDEX "way_out_outages_started_idx" ON "way_out_outages" USING btree ("started_at");