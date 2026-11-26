ALTER TABLE "ahead_checks" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "ahead_checks" ADD COLUMN "sources" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ahead_checks" ADD COLUMN "promoted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ahead_checks_inbox_idx" ON "ahead_checks" USING btree ("burrow_id","reported_at") WHERE "ahead_checks"."state" = 'told' and "ahead_checks"."promoted_at" is null and "ahead_checks"."settled_at" is null and "ahead_checks"."feedback" is null;