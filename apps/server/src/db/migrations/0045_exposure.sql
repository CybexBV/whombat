CREATE TABLE "exposure_openings" (
	"connection_id" text NOT NULL,
	"opening_id" text NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"baseline" boolean DEFAULT false NOT NULL,
	CONSTRAINT "exposure_openings_pk" PRIMARY KEY("connection_id","opening_id")
);
--> statement-breakpoint
ALTER TABLE "exposure_openings" ADD CONSTRAINT "exposure_openings_connection_id_catalog_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."catalog_connections"("id") ON DELETE cascade ON UPDATE no action;