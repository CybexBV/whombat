ALTER TABLE "screens" ADD COLUMN "doorbell" text DEFAULT 'big' NOT NULL;--> statement-breakpoint
ALTER TABLE "screens" ADD CONSTRAINT "screens_doorbell" CHECK ("screens"."doorbell" IN ('big', 'off'));