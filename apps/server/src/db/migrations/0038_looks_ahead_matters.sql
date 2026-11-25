CREATE TABLE "ahead_matters" (
	"id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"person_id" text NOT NULL,
	"origin" text NOT NULL,
	"title" text NOT NULL,
	"who" text DEFAULT '' NOT NULL,
	"waiting_on" text NOT NULL,
	"due_at" timestamp with time zone,
	"note" text,
	"match" jsonb NOT NULL,
	"state" text NOT NULL,
	"closed_reason" text,
	"conversation_id" text,
	"thread_root_id" text,
	"followed_up" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_news_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ahead_checks" ADD COLUMN "matter_id" text;--> statement-breakpoint
ALTER TABLE "ahead_matters" ADD CONSTRAINT "ahead_matters_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ahead_matters" ADD CONSTRAINT "ahead_matters_person_id_principals_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ahead_matters" ADD CONSTRAINT "ahead_matters_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ahead_matters_state_idx" ON "ahead_matters" USING btree ("burrow_id","state");--> statement-breakpoint
ALTER TABLE "ahead_checks" ADD CONSTRAINT "ahead_checks_matter_id_ahead_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."ahead_matters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ahead_checks_matter_idx" ON "ahead_checks" USING btree ("burrow_id","matter_id");