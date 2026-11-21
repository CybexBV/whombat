# Delivering the answer (TC-01…TC-07)

John, 2026-10-28: Dusty acknowledged a disk-space question, investigated for about fourteen minutes, then ended with
only a `MORE:` hint. The runner treated the progress message as the answer and marked the turn done. John asked to
fix it. The investigation is in `~/.cache/wb-tmp/research/2026-10-28-dusty-missing-reply/report.md`.

| # | Decision | Why |
| --- | --- | --- |
| TC-01 | **Deliver a distinct final answer after progress.** A successful posting-tool result counts as delivery; a call alone, a failed result or a blocked outcome does not. The runner posts a substantive final message even after an earlier post, skipping an exact body already delivered in the same request. Post-answer upkeep does not repeat the answer. | Saying “On it” must not swallow the findings. Replaces TO-02's suppression of every final text after any posting tool. |
| TC-02 | **A direct Chat request needs an answer after its work.** For a person's `dm`, `mention` or `expand` reply turn in a DM, an empty, `NO_REPLY` or `MORE:`-only ending is incomplete when nothing was delivered or tools ran after the last delivery. `report_done`, status and run bookkeeping do not count as new investigation. A delivered answer followed only by bookkeeping may end with `NO_REPLY`. Scheduled checks, runs and outsiders' assessments keep their own completion rules. | `report_done` updates the desk; it does not answer a question. A detail hint without an answer cannot stand alone. Replaces CNR-04's literal posting of an orphan hint. |
| TC-03 | **Recover once from the existing findings.** Resume the same available session with an answer-only instruction, no attachments or steering, no fresh-session fallback, and all tools blocked by Hermes's session policy. Allow 45 seconds, honour Stop and shutdown, and sum both attempts' usage. No recursive repair or model fallback in recovery. | The investigation is already done. Finishing its answer must not start another investigation or an unbounded loop. |
| TC-04 | **An incomplete or undelivered Chat answer is a failure.** If recovery is unavailable, times out or still gives no answer, complete with a plain explanation and the existing Try again card. A failed final MCP post also fails a reply turn. Runs and search answers keep their existing completion rules. | A person needs a visible outcome; silently marking the request done loses their question. |
| TC-05 | **Bound investigative commands in the agent's instructions.** Start with existing measurements, narrow expensive disk scans, avoid multi-minute sleeps and repeated whole-disk scans, and use background jobs with `whombat notify` for long work. Tell the person the findings and what remains running. This is command guidance, not a global command deadline. | Serial scans and seven minutes of requested sleeps made this incident take much longer than needed. |

John, 2026-10-29, Dusty's Chat thread on cleaning up The Titan's disk (`msg_mbeI0EC7qHVP` on Home): asked to proceed,
Dusty started two runs and ended its turn with only `NO_REPLY`, as `start_run`'s description says. The turn ran in
Dusty's pod, whose Hermes gateway doesn't allow a bare silence marker on a person's turn: it replaced it with its own
“⚠️ The model returned only a silence marker … Try again or rephrase.” The ACP viewer passed on the streamed
`NO_REPLY` and then that notice, and the runner, which drops only an exact `NO_REPLY`, posted both.

| # | Decision | Why |
| --- | --- | --- |
| TC-06 | **Hermes's notice in place of a bare `NO_REPLY` is never the reply.** The Hermes provider drops the gateway's “returned only a silence marker” chunk (`gateway.errors.unexpected_silence`, matched by its start in Hermes's default language, like “Steer queued”), so the turn's final text is the model's own `NO_REPLY` and the runner's rules decide whether an answer was owed. Hermes stays unpatched; ACP can't say that a turn may be silent. | Whombat decides when silence is right (TC-02, RL-01); the gateway's rule is for chat platforms where a person always expects a reply. |
| TC-07 | **A started run is the answer of a turn without a checkout.** A successful `start_run` in a reply turn without a workspace counts as delivery for TC-02: ending with only `NO_REPLY` is complete, and no recovery asks for a message about the run. A turn with a checkout reports on its run itself, so TC-02 still holds there; a refused or blocked `start_run` delivers nothing. `start_run` stays out of `MCP_POSTING_TOOLS` (RL-01). | The run already shows in the thread as a live line and its own turn answers; TC-03's recovery would otherwise bring back the extra “I’ve started a run” message RL-01 removed. |
