CREATE TABLE "account_uptime_points" (
	"connection_id" text,
	"github_burrow_id" text,
	"at" timestamp with time zone NOT NULL,
	"up" double precision NOT NULL,
	"samples" integer,
	CONSTRAINT "account_uptime_slot" UNIQUE NULLS NOT DISTINCT("connection_id","github_burrow_id","at"),
	CONSTRAINT "account_uptime_owner" CHECK (num_nonnulls("account_uptime_points"."connection_id", "account_uptime_points"."github_burrow_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "account_uptime_points" ADD CONSTRAINT "account_uptime_points_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_uptime_points" ADD CONSTRAINT "account_uptime_points_github_burrow_id_burrows_id_fk" FOREIGN KEY ("github_burrow_id") REFERENCES "public"."burrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_uptime_at_idx" ON "account_uptime_points" USING btree ("at");--> statement-breakpoint
CREATE INDEX "account_uptime_github_at_idx" ON "account_uptime_points" USING btree ("github_burrow_id","at");