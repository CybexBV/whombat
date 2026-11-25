CREATE TABLE "team_report_copies" (
	"burrow_id" text NOT NULL,
	"report_id" text NOT NULL,
	"number" bigint NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" bigint NOT NULL,
	"read_revision" bigint DEFAULT 0 NOT NULL,
	"report" jsonb,
	"created_by_id" text,
	"copied_at" timestamp with time zone NOT NULL,
	CONSTRAINT "team_report_copies_pk" PRIMARY KEY("burrow_id","report_id")
);
--> statement-breakpoint
CREATE TABLE "team_report_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"person_id" text NOT NULL,
	"agent_id" text,
	"conversation_id" text,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"expected" text NOT NULL,
	"approval_id" text,
	"state" text DEFAULT 'waiting' NOT NULL,
	"report_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "team_report_copies" ADD CONSTRAINT "team_report_copies_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_report_copies" ADD CONSTRAINT "team_report_copies_created_by_id_principals_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_report_drafts" ADD CONSTRAINT "team_report_drafts_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_report_drafts" ADD CONSTRAINT "team_report_drafts_person_id_principals_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_report_drafts" ADD CONSTRAINT "team_report_drafts_agent_id_principals_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_report_copies_burrow_idx" ON "team_report_copies" USING btree ("burrow_id","created_at");--> statement-breakpoint
CREATE INDEX "team_report_drafts_burrow_idx" ON "team_report_drafts" USING btree ("burrow_id","created_at");