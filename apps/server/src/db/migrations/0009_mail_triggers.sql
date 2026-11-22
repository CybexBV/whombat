CREATE TABLE "mail_cursors" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"cursor" jsonb,
	"since" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"succeeded_at" timestamp with time zone,
	"problem_code" text,
	"problem" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_trigger_items" (
	"id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider" text NOT NULL,
	"mailbox" text NOT NULL,
	"external_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"from_header" text NOT NULL,
	"from_address" text NOT NULL,
	"subject" text NOT NULL,
	"snippet" text NOT NULL,
	"body" text NOT NULL,
	"body_truncated" boolean DEFAULT false NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"mirrored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_cursors" ADD CONSTRAINT "mail_cursors_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_cursors" ADD CONSTRAINT "mail_cursors_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_trigger_items" ADD CONSTRAINT "mail_trigger_items_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_trigger_items" ADD CONSTRAINT "mail_trigger_items_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_trigger_items_connection_external_idx" ON "mail_trigger_items" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "mail_trigger_items_burrow_idx" ON "mail_trigger_items" USING btree ("burrow_id","mirrored_at");