CREATE TABLE "repo_icons" (
	"burrow_id" text NOT NULL,
	"repo" text NOT NULL,
	"attachment_id" text,
	"path" text,
	"blob_sha" text,
	"checked_at" timestamp with time zone NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	CONSTRAINT "repo_icons_burrow_id_repo_pk" PRIMARY KEY("burrow_id","repo")
);
--> statement-breakpoint
ALTER TABLE "repo_icons" ADD CONSTRAINT "repo_icons_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repo_icons_attachment_idx" ON "repo_icons" USING btree ("attachment_id") WHERE "repo_icons"."attachment_id" is not null;--> statement-breakpoint
CREATE INDEX "automation_runs_thread_idx" ON "automation_runs" USING btree ("thread_root_id") WHERE "automation_runs"."thread_root_id" is not null;