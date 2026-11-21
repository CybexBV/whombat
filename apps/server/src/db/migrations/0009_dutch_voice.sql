ALTER TABLE "voice_typing" ADD COLUMN "dutch_voice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_typing" ADD COLUMN "dutch_voice_agreed_by" text;--> statement-breakpoint
ALTER TABLE "voice_typing" ADD COLUMN "dutch_voice_agreed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voice_typing" ADD COLUMN "dutch_voice_licence_version" text;--> statement-breakpoint
ALTER TABLE "voice_typing" ADD CONSTRAINT "voice_typing_dutch_agreement" CHECK (NOT "voice_typing"."dutch_voice" OR ("voice_typing"."dutch_voice_agreed_by" IS NOT NULL AND "voice_typing"."dutch_voice_agreed_at" IS NOT NULL AND "voice_typing"."dutch_voice_licence_version" IS NOT NULL));