# Turn retries: a turn cut off after it posted carries on, it doesn't answer again

On dev, a redeploy restarted the runner 18 seconds after Tinker had posted its answer and set its status to
waiting. The runner handed the dispatch back (`runner_shutdown`), the server requeued it, and the retry got the
same prompt (“John is asking you: Can you try again please?”): Tinker showed “Tinker is thinking” for five more
minutes, redid the research and posted a second answer. The same happens after a crash retry or an expired lease.

## Maintainer decisions (2026-09-25)

| # | Decision | Why |
|---|---|---|
| TR-01 | **The server stamps `dispatches.posted_at` the first time a turn posts**, over all its attempts: a successful (`status: 'ok'`) call of a tool in `MCP_POSTING_TOOLS` (`post_message`, `reply_in_thread`, `post_card`, `post_answer`; `@whombat/core`, shared with the runner) with the dispatch's agent token. `Dispatch.postedAt` carries it to the runner. Operational bookkeeping (`transactAccount`), like the rest of the dispatch row. | The server sees every post, including one made just before a `kill -9` or a lost lease, which the runner could never report. The conversation window can't tell it: a mention that arrived while an earlier turn ran and posted looks the same as an answered one. |
| TR-02 | **A retry of a turn that posted carries on.** The prompt replaces “{name} is asking you: …” with: the last turn was cut off after the agent posted the messages above; don't start over or repeat them; if it had finished, end the turn with only `NO_REPLY`, otherwise carry on and post only what is new; plus “N new message(s) for you since your last one” when people wrote since. | The resumed provider session already holds the work; the agent only needs to know it is a continuation. Posting in the first attempt is not taken as “done” (an agent may post “On it.” and keep working), so the retry still runs. |
| TR-03 | **No “{name} is thinking” on such a retry, and `NO_REPLY` is never posted.** `thinking` starts false when `postedAt` is set. The runner still posts a retry's final text when the agent didn't post (a turn that carries on may end with its answer, as `continuity.int.test.ts` does), except a final text of exactly `NO_REPLY`. | The reply people were waiting for is already there; a silent marker keeps “Nothing new to add.” out of the conversation without losing an answer given as final text. |
| TR-04 | **Invalid MCP arguments are explained in the text the agent reads**: `validation_failed: Some arguments are not valid.` followed by one `- field: issue` line per field (`- done.4: Too big: expected string to have <=300 characters`). `structuredContent` keeps `fields`. | Claude Code shows agents the text, not `structuredContent`: Tinker's `save_checkpoint` with a 436-character `done` item failed with no hint and was never retried. |
