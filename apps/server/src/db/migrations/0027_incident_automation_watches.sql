CREATE TABLE "incident_triggers" (
	"automation_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"burrow_id" text NOT NULL,
	"version" integer NOT NULL,
	"event_id" text NOT NULL,
	"due_at" timestamp with time zone,
	CONSTRAINT "incident_triggers_automation_id_incident_id_pk" PRIMARY KEY("automation_id","incident_id")
);
--> statement-breakpoint
CREATE TABLE "thing_watches" (
	"id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"thing_id" text NOT NULL,
	"name" text NOT NULL,
	"event" text NOT NULL,
	"status" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"thread_root_id" text,
	"message_id" text,
	"event_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "thing_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incident_triggers" ADD CONSTRAINT "incident_triggers_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_triggers" ADD CONSTRAINT "incident_triggers_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_triggers" ADD CONSTRAINT "incident_triggers_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_triggers" ADD CONSTRAINT "incident_triggers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thing_watches" ADD CONSTRAINT "thing_watches_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thing_watches" ADD CONSTRAINT "thing_watches_agent_id_principals_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thing_watches" ADD CONSTRAINT "thing_watches_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thing_watches" ADD CONSTRAINT "thing_watches_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thing_watches" ADD CONSTRAINT "thing_watches_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_triggers_due_idx" ON "incident_triggers" USING btree ("burrow_id","due_at") WHERE "incident_triggers"."due_at" is not null;--> statement-breakpoint
CREATE INDEX "thing_watches_running_idx" ON "thing_watches" USING btree ("burrow_id","thing_id","event") WHERE "thing_watches"."status" = 'watching';