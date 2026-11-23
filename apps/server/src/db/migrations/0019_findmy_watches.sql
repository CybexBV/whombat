CREATE TABLE "findmy_watches" (
	"id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"connection_id" text,
	"person" text NOT NULL,
	"name" text NOT NULL,
	"change" text NOT NULL,
	"place" text NOT NULL,
	"from_place" text,
	"from_address" text,
	"lat" double precision,
	"lon" double precision,
	"accuracy_m" double precision,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"thread_root_id" text,
	"message_id" text,
	"status" text NOT NULL,
	"to" text,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "findmy_watches" ADD CONSTRAINT "findmy_watches_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findmy_watches" ADD CONSTRAINT "findmy_watches_connection_id_catalog_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."catalog_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findmy_watches" ADD CONSTRAINT "findmy_watches_agent_id_principals_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findmy_watches" ADD CONSTRAINT "findmy_watches_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findmy_watches" ADD CONSTRAINT "findmy_watches_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "findmy_watches_connection_idx" ON "findmy_watches" USING btree ("connection_id","status");--> statement-breakpoint
CREATE INDEX "findmy_watches_burrow_idx" ON "findmy_watches" USING btree ("burrow_id","status");