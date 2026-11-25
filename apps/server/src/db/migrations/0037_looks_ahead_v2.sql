ALTER TABLE "ahead_checks" ADD COLUMN "source" text DEFAULT 'calendar' NOT NULL;--> statement-breakpoint
ALTER TABLE "ahead_checks" ADD COLUMN "stage" text DEFAULT 'eve' NOT NULL;--> statement-breakpoint
ALTER TABLE "ahead_checks" ADD COLUMN "extra_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ahead_checks" ADD COLUMN "action_label" text;--> statement-breakpoint
ALTER TABLE "ahead_checks" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "ahead_checks" ADD COLUMN "feedback_note" text;--> statement-breakpoint
ALTER TABLE "looks_ahead_settings" ADD COLUMN "mail_on" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "looks_ahead_settings" ADD COLUMN "rules" jsonb DEFAULT '[]'::jsonb NOT NULL;