CREATE TABLE "quiet_maintenance_left" (
	"maintenance_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
