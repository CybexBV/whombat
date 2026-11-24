CREATE TABLE "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"thing_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"nature" text NOT NULL,
	"words" text NOT NULL,
	"check_id" text,
	"subject" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"cause_thing" text,
	"cause_name" text,
	"pushed_at" timestamp with time zone,
	"push_group" text,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_open_idx" ON "incidents" USING btree ("burrow_id","thing_id") WHERE "incidents"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "incidents_thing_idx" ON "incidents" USING btree ("burrow_id","thing_id","started_at");--> statement-breakpoint
CREATE INDEX "incidents_burrow_idx" ON "incidents" USING btree ("burrow_id","started_at");