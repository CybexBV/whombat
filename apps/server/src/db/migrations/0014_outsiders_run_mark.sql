ALTER TABLE "messages" ADD COLUMN "outsiders_run" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A box that ran a build with the mark in `provenance`: the mark moves to its own column, and `provenance` keeps only
-- the Feedback kinds every release reads.
UPDATE "messages" SET "outsiders_run" = true, "provenance" = NULL WHERE "provenance" = 'outsiders_run';--> statement-breakpoint
-- What outsiders' runs (a tracker customer's report, an incoming email) posted in their thread before the mark: what the
-- run's own steps posted there while it ran (as its automation), and what its own turns posted there while they ran (the
-- agent, in a turn for nobody), with a failed turn's notice. The person's own turns there are theirs and stay unmarked.
UPDATE "messages" AS m SET "outsiders_run" = true
FROM "automation_runs" AS r, "automations" AS a
WHERE r."trigger" ->> 'kind' IN ('tracker', 'mail')
  AND r."thread_root_id" IS NOT NULL
  AND a."id" = r."automation_id"
  AND m."author_id" = a."principal_id"
  AND (m."id" = r."thread_root_id" OR m."thread_root_id" = r."thread_root_id")
  AND m."created_at" >= r."created_at"
  AND (r."finished_at" IS NULL OR m."created_at" <= r."finished_at")
  AND m."outsiders_run" = false;
--> statement-breakpoint
UPDATE "messages" AS m SET "outsiders_run" = true
FROM "automation_runs" AS r, "dispatches" AS d
WHERE r."trigger" ->> 'kind' IN ('tracker', 'mail')
  AND r."thread_root_id" IS NOT NULL
  AND d."trigger" = 'automation'
  AND d."on_behalf_of_account_id" IS NULL
  AND d."thread_root_id" = r."thread_root_id"
  AND d."created_at" >= r."created_at"
  AND (r."finished_at" IS NULL OR d."created_at" <= r."finished_at")
  AND m."author_id" = d."agent_id"
  AND (m."id" = r."thread_root_id" OR m."thread_root_id" = r."thread_root_id")
  AND (
    (m."created_at" >= d."created_at"
      AND m."created_at" <= coalesce(d."finished_at", d."heartbeat_at", d."claimed_at", d."created_at"))
    OR (m."card" ->> 'kind' = 'turn_failed' AND m."card" ->> 'dispatchId' = d."id")
  )
  AND m."outsiders_run" = false;
--> statement-breakpoint
-- What outsiders could steer leaves Search: the marked messages, the approvals asked on a marked card, and the error of
-- a tracker or mail run (it can quote what their agent said).
DELETE FROM "search_documents" WHERE "id" IN (SELECT "id" FROM "messages" WHERE "outsiders_run");--> statement-breakpoint
DELETE FROM "search_documents" WHERE "id" IN (
  SELECT a."id" FROM "approvals" AS a JOIN "messages" AS m ON m."id" = a."message_id" WHERE m."outsiders_run"
);--> statement-breakpoint
UPDATE "search_documents" AS d SET "text" = left(d."text", length(d."text") - length(r."error") - 1)
FROM "automation_runs" AS r
WHERE d."id" = r."id"
  AND r."trigger" ->> 'kind' IN ('tracker', 'mail')
  AND r."error" IS NOT NULL
  AND right(d."text", length(r."error") + 1) = E'\n' || r."error";
