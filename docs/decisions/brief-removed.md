# No morning or evening brief (BRR)

John, 2026-11-06 (main checkout), about the good morning and good evening cards: “Remove this entirely”. The morning
and evening brief (`archive/briefs.md` BRF-01…BRF-09) goes, with everything that only existed for it: its card on web
and phone, its schedules and ticker, the `briefing` turn and its `brief_write` tool, `briefing_set`, the morning
briefing's guide and suggestion, `briefs.set`, and the rule that a scheduled automation's run that goes well waits for
the brief instead of notifying.

| # | Decision | Why |
|---|---|---|
| BRR-01 | **There is no brief.** Nothing posts a morning or evening card, nothing wakes the agent for one, and the agent has no tool to set or write one. `start_guide` offers welcome, email, calendar, files and google_app; suggestions offer email, calendar and files. | John: remove it entirely. |
| BRR-02 | **Every automation run tells as it posts.** A run's messages notify like any other message in the room; a failed run, an approval and a review notify as before. The plan card no longer says how runs are told. An automation definition still accepts `tell` (`brief` or `each_run`) so the ones saved with it keep parsing under the strict schema, and nothing reads it. | Without a brief there is nowhere for a quiet run to be told; a definition that stops parsing would break the automation. |
| BRR-03 | **The `briefs` and `personal_schedules` tables stay, unused**, until a later release drops them in a `contract` migration with its checkpoint (managed-db.md MD-03, MD-06). They stay in the Drizzle schema, untyped, so a generated migration doesn't drop them by surprise. | Dropping a table now would make this release a contract migration needing a checkpoint on every box. |
| BRR-04 | **A brief already in a Chat reads as its own text.** A stored card of a kind this release doesn't make (`brief`) resolves to no card, so the message shows what it said (“Good morning, John. …”). An older `briefing` guide card renders generically like any unknown guide topic; its buttons answer “That isn’t an action on this card.”, and No thanks still closes it. | No migration that deletes the person's messages; nothing breaks on old threads. |
| BRR-05 | **A backup file's `briefing` record is read and skipped.** The record type stays in the backup format so older files still restore. | Old backups keep restoring. |
