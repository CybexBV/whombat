# The run line: a quick run isn't announced (RL-01, RL-02)

John, 2026-10-03, on a #reports thread: asked “can you confirm this?”, Banjo posted the run's message with a full run
card and then “I’ve started run #6 to check the updated repository …”, three blocks before any answer. Agreed with
him: a run that changes nothing shows as a line with a live animation (whombat-app `docs/decisions/run-line.md`
AP-668, app 0.30.0: `runShowsAsLine`, `RunLine`, Android's `RunLineView`); the full card appears once the run changes
a file or opens a pull request.

- **RL-01 A turn without a checkout doesn't announce the run it starts.** `start_run` in a mention, handoff or DM turn
  goes on in a run turn with a checkout (run-checkout.md RC-01); the prompt used to tell the agent to “say in one short
  line that you are on it”, which became the extra message. It now tells it to end the turn with only `NO_REPLY` (the
  runner posts nothing for it, as for a retry with nothing new), because the run already shows in the thread as a
  live line; only something the person needs before the run ends is still said. The answer comes from the run turn,
  after `finish_run`. `start_run` is not made a posting tool (`MCP_POSTING_TOOLS`): in a run turn that starts its own
  run, the final text is the answer and must still be posted.
- **RL-02 Questions still start a run when the agent needs a checkout to answer.** John chose to keep the visible
  “checking…” line over answering a code question without a run (a read-only checkout in a mention turn): the run is
  what shows that the agent is working, and on what. Unchanged: no new tool, no new turn kind.
