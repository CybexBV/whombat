ALTER TABLE "prompts" ADD COLUMN "merge" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "t3_watches" ADD COLUMN "merge" jsonb;