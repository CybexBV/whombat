# Working signal: “{name} is thinking” after the agent said something (WG)

John, 2026-10-08, on his DEV box: “@Dusty Check my unraid server, what are the specs?” Dusty answered in the thread
at once with “I’m using the health-report skill for a read-only check of your Unraid host’s hardware, storage and
version.” and then nothing showed that it was working: its turn (`dsp_1Tmq779HZ_4s`) posted that line at 13:51:48,
worked through the Unraid API for half a minute and posted the specs at 13:52:17. The runner set `thinking` false at
the first posting tool and never back, so “Dusty is thinking” (and the action beside it, AP-734) went away with the
preamble. Codex announces a skill before it uses it, so this happened on most skill turns.

| # | Decision | Why |
| --- | --- | --- |
| WG-01 | **A reply turn thinks again when it acts after it posted.** The first posting tool still ends “{name} is thinking” (the server clears it with the message, the client's version guard drops older frames); the turn's next tool call that isn't a posting or handoff tool sets `thinking` again and beats at once, so the line (with what the agent does now) is back within ~0.3 s and stays until the next post or the turn's end (`complete` clears it). It applies to a retry of a turn that posted too: TR-03 holds (it starts without the line), but once it acts it shows. Runs and answers never think, as before. Amends runtime-server.md's “refreshed only for reply-mode turns that have not posted yet”. Runner only: no contracts, server or app change. | A preamble isn't the answer: people saw a finished-looking conversation while the agent still worked. Tying the line to the agent's actions (not to time) keeps it off after a final answer and on a retry that only ends with `NO_REPLY`. |

John, 2026-10-26, on dev.whombat.com (thread “What service failed on The Falcon?”): after “Fix the script please” the
chat went silent for a long time. The box worked normally (`dsp_Ai4Q70R_ma7K`, 36 s, six steps, “thinking” refreshed
every 2 s), but one second into the turn its relay connection dropped (code 1006). A session that goes quiet that way
was only found by the idle heartbeat, after 50 to 70 s without anything arriving, and until then the page showed
neither the thinking line nor the answer.

| # | Decision | Why |
| --- | --- | --- |
| WG-02 | **While the agent's thinking line shows, a quiet connection is checked within seconds.** An active `typing` frame tells the client's session that more frames are owed for `TYPING_TTL_MS` (6 s), so the stall check that guards requests (open-speed.md AP-4401) applies: after 2.5 s of silence a `ping`, and no `pong` 2.5 s later replaces the connection and resubscribes, which brings back the line and anything posted meanwhile. Client only (`packages/client/src/session/secure.ts`), web and phone alike. | The thinking line is refreshed every 2 s while a turn runs, so silence then means a dead path, not an idle one; a healthy connection only pays a ping now and then. |
| WG-03 | **The progress line says what the agent does in words**: `connection_tools` “Looking at a connection”, `connection_call` “Using a connection”, `report_change` “Noting a change”, instead of “Using connection_call”. | The thinking line is how the person sees work going on; tool names say nothing to them. |

