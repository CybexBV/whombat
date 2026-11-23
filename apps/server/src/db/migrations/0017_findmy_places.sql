CREATE TABLE "findmy_places" (
	"connection_id" text NOT NULL,
	"person" text NOT NULL,
	"burrow_id" text NOT NULL,
	"name" text NOT NULL,
	"place" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "findmy_places_connection_id_person_pk" PRIMARY KEY("connection_id","person")
);
--> statement-breakpoint
ALTER TABLE "findmy_places" ADD CONSTRAINT "findmy_places_connection_id_catalog_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."catalog_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findmy_places" ADD CONSTRAINT "findmy_places_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "findmy_places_burrow_idx" ON "findmy_places" USING btree ("burrow_id");