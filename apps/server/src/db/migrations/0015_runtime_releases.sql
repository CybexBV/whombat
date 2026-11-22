CREATE TABLE "runtime_releases" (
	"release_id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"schema" text,
	"first_started_at" timestamp with time zone NOT NULL
);
