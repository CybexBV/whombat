CREATE TABLE "findmy_stops" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"burrow_id" text NOT NULL,
	"person" text NOT NULL,
	"kind" text NOT NULL,
	"place" text,
	"address" text,
	"lat" double precision,
	"lon" double precision,
	"accuracy_m" double precision,
	"code" text,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findmy_timeline_people" (
	"connection_id" text NOT NULL,
	"person" text NOT NULL,
	"burrow_id" text NOT NULL,
	"name" text NOT NULL,
	"kept_since" timestamp with time zone NOT NULL,
	CONSTRAINT "findmy_timeline_people_connection_id_person_pk" PRIMARY KEY("connection_id","person")
);
--> statement-breakpoint
ALTER TABLE "findmy_stops" ADD CONSTRAINT "findmy_stops_connection_id_catalog_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."catalog_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findmy_stops" ADD CONSTRAINT "findmy_stops_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findmy_timeline_people" ADD CONSTRAINT "findmy_timeline_people_connection_id_catalog_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."catalog_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findmy_timeline_people" ADD CONSTRAINT "findmy_timeline_people_burrow_id_burrows_id_fk" FOREIGN KEY ("burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "findmy_stops_person_idx" ON "findmy_stops" USING btree ("connection_id","person","last_at");--> statement-breakpoint
CREATE INDEX "findmy_stops_last_idx" ON "findmy_stops" USING btree ("last_at");--> statement-breakpoint
CREATE INDEX "findmy_timeline_people_burrow_idx" ON "findmy_timeline_people" USING btree ("burrow_id");