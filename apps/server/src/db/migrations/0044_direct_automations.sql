CREATE TABLE "automation_waits" (
	"automation_id" text NOT NULL,
	"key" text NOT NULL,
	"burrow_id" text NOT NULL,
	"version" integer NOT NULL,
	"event_id" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"first_due_at" timestamp with time zone NOT NULL,
	CONSTRAINT "automation_waits_automation_id_key_pk" PRIMARY KEY("automation_id","key")
);
--> statement-breakpoint
ALTER TABLE "automation_waits" ADD CONSTRAINT "automation_waits_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_waits" ADD CONSTRAINT "automation_waits_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_waits" ADD CONSTRAINT "automation_waits_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_waits_due_idx" ON "automation_waits" USING btree ("burrow_id","due_at");