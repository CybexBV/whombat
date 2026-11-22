ALTER TABLE "messages" ADD COLUMN "outsiders_run" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A box that ran a build with the mark in `provenance`: the mark moves to its own column, and `provenance` keeps only
-- the Feedback kinds every release reads.
UPDATE "messages" SET "outsiders_run" = true, "provenance" = NULL WHERE "provenance" = 'outsiders_run';--> statement-breakpoint
-- Messages outsiders' runs (a tracker customer's report, an incoming email) posted before the mark: what no person
-- wrote in such a run's thread while the run went on.
UPDATE "messages" AS m SET "outsiders_run" = true
FROM "automation_runs" AS r, "principals" AS p
WHERE r."trigger" ->> 'kind' IN ('tracker', 'mail')
  AND r."thread_root_id" IS NOT NULL
  AND (m."id" = r."thread_root_id" OR m."thread_root_id" = r."thread_root_id")
  AND m."created_at" >= r."created_at"
  AND (r."finished_at" IS NULL OR m."created_at" <= r."finished_at")
  AND p."id" = m."author_id"
  AND p."kind" <> 'person'
  AND m."outsiders_run" = false;
