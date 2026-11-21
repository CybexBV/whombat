ALTER TABLE "automations" ADD COLUMN "mail_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_trigger_items" ADD COLUMN "message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_trigger_items_connection_message_id_idx" ON "mail_trigger_items" USING btree ("connection_id","message_id") WHERE "mail_trigger_items"."message_id" is not null;