# A run's turn starts at once (HRS-01…HRS-05)

Finding F4 of the 2026-10-07 health review of John's DEV Whombat (wb-k2rt-8pwn-5521), which John asked for directly.
It is built on branch `health-run-start`. Measured on the box (`dispatches`, `runs`):

- On 2026-10-06 at 10:40:25 UTC John asked Banjo in #general for a retry while run #9 was live. His message woke Banjo
  on run #9 as `dsp_EDkEas1sm77n` (trigger mention, mode run; it answered the run, RA-DS62). That turn called
  `start_run` at 10:41:19. This created run #10 and its run turn `dsp_P9yHJ2K7zshs` (`run_control`, created
  10:41:19). The starting turn then kept working until 10:43:46.
- Run #10's turn was claimed at 10:44:07, after 168 s in the queue. A duplicate mention waited 166 s (claimed
  10:43:47) and the follow-up schedule turn waited 239 s (claimed 10:48:20).
- Cause: the claim (`apps/server/src/runtime/service.ts`, under `CLAIM_LOCK`) leased no turn while another turn of
  the same (agent, conversation) was in flight. That included the run turn the in-flight turn's own `start_run` had
  just queued (`runs.dispatch_id` is that turn, `commands/agent-runs.ts`).
- Across all run starts on the box, the run card appeared 15–90 s after the ask (median 24 s). Turns read skills or
  files before `start_run`, although AE-04 asks for the run first. John asked again twice before he saw anything.

| ID | Decision | Why |
| --- | --- | --- |
| HRS-01 | **A run's turn isn't held back by the turn that started it.** In the claim's per-(agent, conversation) rule, an in-flight dispatch no longer counts when it is the starting dispatch (`runs.dispatch_id`) of the queued dispatch's run: `… and inflight.state in ('claimed', 'running') and not exists (select 1 from runs as started where started.id = dispatches.run_id and started.dispatch_id = inflight.id)`. Every queued dispatch with that `run_id` qualifies: the run turn RC-01 queues, the run turn of a run approved while its asking turn still runs (the MCP adapter records that turn as `dispatchId`), and a person's answer to the run. A dispatch without a run never does. The claim lock is the same. There is no new index or migration (the `runs` primary key and `runs_dispatch_idx` serve it) and no contract change. | The run's turn is the work the person asked for, and it is what shows them that the work is being done. The starting turn has nothing left to give it (AE-04) and may keep working for minutes (2.5 min on the box), so waiting for it only delays the run. |
| HRS-02 | **Superseded in part by HN-T01…HN-T03 (hermes-native.md)**: the run's own next turn still waits for the one in flight, whatever its thread, and a turn at the conversation's top level still waits for every turn there; another mention or another run's turn in another thread now runs beside them. **Everything else still waits for the one in flight.** While the starting turn or the run's turn is in flight, three kinds of turn still wait: another mention in the conversation, another run's turn and the run's own next turn. Once the starting turn ends, everything goes as before: oldest first, one at a time. A conversation therefore has at most two of an agent's turns in flight: one turn, plus one turn of a run it started. A run's turn that starts a run of its own doesn't open a third, because the new run's turn is still held back by the first turn. Unchanged: (1) The computer rule (AC-20): the run's turn works for its starting turn's person (`continueInCheckout`), so the two share the computer like that person's two terminals. (2) The claim loop's pair set: while the starting turn is in flight, every candidate of that pair that passes the query is exempt from it and held back by nothing else. A pass returns at its first claim, and a run turn that a pass cancels (its run is no longer live) keeps the pair for that pass only, as before. The exemption has nothing to change there. (3) Coalescing: a mention never merges into a run's queued turn, because their modes differ. | The invariant from the Buzz study (one provider turn per agent and conversation) keeps people's questions in order and each conversation's session single-threaded. Only the parent–child case is new, and HRS-03 and HRS-04 make it safe. One consequence: a question asked while the run's turn runs now waits for that turn instead of running ahead of it. The box's duplicate mention was such a re-ask, and a run that shows at once should make those rarer. |
| HRS-03 | **A run's turn never resumes a session that another turn is still running in.** `previousSessionForRun`, which picks the session a run turn resumes, now skips dispatches that are claimed or running. | It also offers the session of the run's starting turn, and that turn reports its session with its beats. Without the skip, a run turn claimed beside it would be handed the session the starting turn is still running in. Where both prompts hash the same (PE-03: a run started on the same branch by a run turn, then approved or answered while that turn runs), two CLI processes would run on one Claude session or Codex thread. The test saw the live session handed over (`sess-parent`). Before HRS-01 the starting turn was never in flight at that moment. Once it has ended, its session is handed on as before, and the runner starts fresh when the prompt differs. |
| HRS-04 | **Only the turn that shows “is thinking” clears it.** For each indicator (conversation, thread, agent), the runtime remembers the turn whose beat last showed it. A beat that isn't thinking, or the end of a turn, clears the indicator only when that turn showed it or no turn did. This is kept in memory, like the indicators themselves. Without beats an indicator still lapses after 6 s (`TYPING_TTL_MS`). | The run's turn is queued in its starting turn's thread (RC-14), so the two turns share one indicator. A run turn's beats never think, and each of them (every 2 s) cleared the indicator of a starting turn that was still thinking; that turn's next beat showed it again. The result was a blinking “Banjo is thinking”. Before HRS-01 there was only ever one turn per indicator, so nothing else changes. |
| HRS-05 | **start_run first, said plainly** (`runLines` in `apps/runner/src/prompt.ts`, for a turn without a checkout). New wording: `- When a request needs code work, your first tool call is start_run, on a feature branch — before you read a skill or a file, search or reply: you have no checkout in this turn, and the run reads what it needs.` Old wording: `- For code work, start a run (start_run) on a feature branch so people can watch, first: you have no checkout in this turn, and the run reads the skills and files it needs.` The rest of the line (NO_REPLY, the live line, carrying on in the run; RL-01, RC-01) is unchanged, and turns with a checkout or on a run keep their own lines. `pnpm prompt:size`, system prompt, before → after: Pippa DM (Codex) 25 697 → 25 735 characters (6 424 → 6 434 ≈tok); Dusty scheduled (Claude) 22 632 → 22 670 (5 658 → 5 668). Unchanged: Banjo's run (8 917 ≈tok), Hazel's personal turn (5 376) and every user turn. Tests: `prompt-turns.test.ts` (the new line, and no such line in a run turn) and the snapshots of `prompt-turns`, `handoffs` and `prompt-capabilities`. `prompt-computer.test.ts` passes unchanged. | The old “…, first:” read as “first: you have no checkout”, and it lost to two lines that every turn also gets: the packs' “Before a task, look at them” (the skills) and How you work's “Find out how it is done here …”. So mention turns read a skill or files before `start_run` (median 24 s to the run card). Naming those steps, and calling it the first tool call, leaves no room; it costs +38 characters. A run turn that starts another run (the box's case) gets no extra line: it has a checkout and may need to look first, and with HRS-01 the new run's turn starts whatever the starting turn does next. |
| HRS-06 | **A run finished by its starting turn stops the run turn it let start.** `finish_run` (with the caller's dispatch from the MCP adapter, like `start_run`) still drops a queued run turn of the run; one already claimed or running beside the starting turn (HRS-01) gets `cancel_reason = cancelled`, which its next beat turns into a cancel (`stopReason`), never the calling turn itself. Found by `approved-write.int.test.ts` (RC-01: a run finished in its starting turn) after HRS-01: the run turn was claimed at once and ran on a finished run. | Without HRS-01 that turn stayed queued and the drop caught it; with it, two turns worked one run, one of them finished. |

## Checking it on the box

After the deploy, read-only, for the first turn of each run started from a turn without its checkout:

```sql
select r.number, p.trigger as starter,
       extract(epoch from r.started_at - m.created_at)::int as ask_to_run_s,     -- HRS-05: was 15–90 s, median 24 s
       extract(epoch from d.claimed_at - d.created_at)::int as run_turn_queue_s, -- HRS-01: seconds, was up to 168 s
       d.claimed_at < coalesce(p.finished_at, 'infinity') as beside_starter      -- true when the starter kept working
from runs r
join dispatches p on p.id = r.dispatch_id
left join messages m on m.id = p.message_id
join lateral (select * from dispatches x where x.run_id = r.id order by x.created_at limit 1) d on true
where r.started_at > '<deployed at>'
order by r.started_at;
```

## Left out

- No run-start line for a run turn or for a turn with a checkout. Those turns work in their checkout, and the line
  would be paid on every call of every run turn. HRS-01 already decides what happens after `start_run`.
- The claim's order is not changed in favour of run turns. Once the starting turn has ended, an older queued mention
  still goes first. That only happens when the run's turn couldn't be claimed beside the starting turn (for example,
  no free runner slot).
- No live check on the box from this branch. The orchestrator ships it (DEV is fast, appliance IN-132).
