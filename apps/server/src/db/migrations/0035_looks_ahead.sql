CREATE TABLE "ahead_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"person_id" text NOT NULL,
	"event_key" text NOT NULL,
	"version" text NOT NULL,
	"summary" text NOT NULL,
	"location" text NOT NULL,
	"calendar" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"event" jsonb NOT NULL,
	"state" text NOT NULL,
	"kind" text,
	"text" text,
	"feedback" text,
	"dispatch_id" text,
	"conversation_id" text NOT NULL,
	"thread_root_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"mail_read_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "looks_ahead_settings" (
	"burrow_id" text PRIMARY KEY NOT NULL,
	"on" boolean DEFAULT true NOT NULL,
	"calendars_off" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calendars_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stopped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ahead_checks" ADD CONSTRAINT "ahead_checks_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ahead_checks" ADD CONSTRAINT "ahead_checks_agent_id_principals_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ahead_checks" ADD CONSTRAINT "ahead_checks_person_id_principals_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ahead_checks" ADD CONSTRAINT "ahead_checks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "looks_ahead_settings" ADD CONSTRAINT "looks_ahead_settings_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ahead_checks_version_idx" ON "ahead_checks" USING btree ("burrow_id","event_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "ahead_checks_one_checking_idx" ON "ahead_checks" USING btree ("burrow_id") WHERE "ahead_checks"."state" = 'checking';--> statement-breakpoint
CREATE INDEX "ahead_checks_event_idx" ON "ahead_checks" USING btree ("burrow_id","event_key");--> statement-breakpoint
CREATE INDEX "ahead_checks_started_idx" ON "ahead_checks" USING btree ("burrow_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ahead_checks_thread_idx" ON "ahead_checks" USING btree ("thread_root_id");--> statement-breakpoint
CREATE INDEX "ahead_checks_dispatch_idx" ON "ahead_checks" USING btree ("dispatch_id");