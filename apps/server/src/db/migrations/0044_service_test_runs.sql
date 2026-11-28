CREATE TABLE "service_test_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"burrow_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"step" text,
	"reason" text,
	"status" integer,
	"ms" integer NOT NULL,
	"by" text NOT NULL,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_test_runs" ADD CONSTRAINT "service_test_runs_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_test_runs" ADD CONSTRAINT "service_test_runs_connection_id_catalog_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."catalog_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_test_runs_connection_idx" ON "service_test_runs" USING btree ("connection_id","at");