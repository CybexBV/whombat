CREATE TABLE "restore_test_servers" (
	"burrow_id" text NOT NULL,
	"server_id" text NOT NULL,
	"on" boolean DEFAULT false NOT NULL,
	"guests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "restore_test_servers_pk" PRIMARY KEY("burrow_id","server_id")
);
--> statement-breakpoint
CREATE TABLE "restore_tests" (
	"id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"server_id" text NOT NULL,
	"guest_id" text NOT NULL,
	"guest_name" text NOT NULL,
	"kind" text NOT NULL,
	"step" text NOT NULL,
	"outcome" text,
	"reason" text,
	"volume" text,
	"backup_at" timestamp with time zone,
	"storage" text,
	"copy_id" integer,
	"copy_name" text,
	"task" text,
	"agent_expected" boolean DEFAULT false NOT NULL,
	"booted" boolean,
	"manual" boolean DEFAULT false NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"step_at" timestamp with time zone NOT NULL,
	"running_at" timestamp with time zone,
	"duration_s" integer,
	"finished_at" timestamp with time zone,
	CONSTRAINT "restore_tests_step" CHECK ("restore_tests"."step" IN ('pick', 'restoring', 'configuring', 'starting', 'booting', 'cleaning', 'done')),
	CONSTRAINT "restore_tests_outcome" CHECK ("restore_tests"."outcome" IS NULL OR "restore_tests"."outcome" IN ('worked', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "catalog_connections" ADD COLUMN "protection" jsonb;--> statement-breakpoint
ALTER TABLE "restore_test_servers" ADD CONSTRAINT "restore_test_servers_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_tests" ADD CONSTRAINT "restore_tests_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "restore_tests_active" ON "restore_tests" USING btree ("burrow_id","server_id") WHERE "restore_tests"."finished_at" IS NULL;--> statement-breakpoint
CREATE INDEX "restore_tests_guest" ON "restore_tests" USING btree ("burrow_id","server_id","guest_id","started_at");