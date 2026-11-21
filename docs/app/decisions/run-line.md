# The run line: a run that changes nothing is a line, not a card (AP-668, AP-669, AP-699, AP-700)

John, 2026-10-03, on a #reports thread where Banjo answered “can you confirm this?” with a run card each time: “I like
the idea that when it's doing some work and it will take a while, we see some kind of progress bar, but a card is a
bit overkill.” Agreed with him: a visible “checking…” line with an animation while it works; the card only once the
run changes something; Android the same. The runtime side (the agent no longer announces the run it started) is
Whombat `docs/decisions/run-line.md` RL-01. No contract change: `Run.diff`, `prNumber`, `startedAt`/`finishedAt` and
`summary` already say everything.

| ID | Decision | Why |
|---|---|---|
| AP-668 | **A run without changes shows as the run line** (`runShowsAsLine` in `@whombat/client`: `diff.files === 0` and no `prNumber`). Web (`RunLine`, under the message like a card, at most `--max-card` wide): an 8px dot, the lead in 600 `--ink` and the detail after ` · ` in `--ink2` (14px, one line, ellipsis, the full text as its title), **Watch run** on the right (13.5px 500 `--mut`, underlined on hover). While live: `Checking · {current step}`, the dot in `--status-working` pulsing a `--live-halo` ring (1.6s), and under the text a 3px track (`--sf2`) whose `--progress` fill (at least 8%) carries a `--status-working` sheen sweeping every 1.4s; with `prefers-reduced-motion` the dot keeps the card's static halo and the sheen is gone. A live run that needs a person says `Needs attention · {why}` (lead in `--warn`, waiting dot, no sheen). Ended: `Run #6 · Done in 1m 12s · {summary}` (ok dot), `Run #6 · Failed in … · {summary}` (bad), `Run #6 · Paused · {step}` (waiting), `Run #6 · Taken over · {summary}` (mut), no track. The message's own text (the run's title) stays above it. The run's first changed file or a pull request turns the line into the run card as it was (realtime `run.updated` patches the embedded run, so the switch happens live). Android (`RunLineView` under the bubble, 84% wide): the same text, a 44dp row that opens the run screen, the dot breathing and the sheen sweeping while live, nothing moving with “Remove animations”. | A check of a branch took a 300px card with `+0 −0 · 0 files` and a Branch room button that mean nothing for it, three times the height of the answer. The line keeps what matters — it is working, on what, how far — and the card stays for work that has a diff to show. |

### AP-669 whombat-app 0.30.0

AP-668, no contract change (contracts stay 0.40.0). Checks: `pnpm check` once and the run line's stories (live,
done, needs attention) at 2× in both themes (DEV fast). Android not run on a device. Released like 0.29.1.

## Open run, and Try again on a failed run (AP-699, AP-700)

John, 2026-10-04: a run of Banjo's failed in a #reports thread and showed there as the run line, “Run #1 · Failed in … ·
{summary}” with **Watch run**. Told to press Try again, he couldn't find it: it was only on the run page (AP-596) and,
for failed turns, in Work. No contract change: `runs.retry` and the runtime feature `runs.recovery` are contracts 0.30.0
(CT-197).

| ID | Decision | Why |
|---|---|---|
| AP-699 | **A stopped run's line says Open run; a failed run offers Try again in the conversation.** The line's link says **Watch run** while the run is live (also while it needs a person: it is still running) and **Open run** once nothing moves on it — done, failed, taken over, or paused until someone resumes it on the run page (`runLineControls(run, {retry})` in `@whombat/client`, with the web's copy). A failed line offers **Try again** before the link where the Whombat has `runs.recovery`: a real `<button>`, the app's inline action (`Button variant="link"`: 13.5px like the link, 600, `--brand`, `--ink` on hover, `--mut` while in flight) at the line's line height, with the link's 6px focus ring. The run card (a run with changes) had no way to try again from the conversation either, so a failed card gets the same Try again after Watch run and Branch room (`Button` secondary `md`, the size of the card's secondary buttons; `runControls`, the run page's rule); the card keeps the mock's “Watch run” in every state. Both go through `useRunControl` (`features/runs`), the run page's controls moved into a hook so the request and its handling are the page's: `runs.retry`, the button disabled and `aria-busy` until the answer, “Asked Banjo to try again.”, a refusal's own sentence or the error's in the same toast. The line goes live again from the run's own `run.updated` (published on the burrow topic to the conversation's members), not from the answer. `RunCardContainer` in `MessageCard` renders the line and the card, so a retry in flight survives the line turning into the card. In a narrow column (a thread pane beside a channel, 308px) the lead gives way before the two controls; the line's title is now its whole text, as AP-668 meant (it was the detail only). Amends AP-596's “Where it isn't” for the conversation. **Android**: the line's link says **Watch ›** while live and **Open ›** once the run has stopped (`RunLineModel.link`, from `runLineControls`). No Try again on the phone yet: it has no `runs.retry` call anywhere (its run screen offers Branch room only, AP-596), and its line is one 44dp target that opens the run; Try again comes with the phone's run controls, on the run screen first. | Whoever sees a failed run in the conversation can try it again there, as on its page, and the link no longer promises something to watch on a run that has stopped. |

### AP-700 whombat-app 0.33.2

AP-699, no contract change (contracts stay 0.44.0). Checks: `pnpm check` once; the Cards/Chat cards stories at
1200×800 in both themes (`stories.spec.ts`: the existing baselines unchanged; baselines added for the run line's four
stories, which had none, and the failed card with Try again); the failed line through `<MessageCard>` in the fixture
app's #billing-v2 at 1440×900 and in the 308px thread column, light and dark at 2× (DEV fast). Android not run on a
device. Version bumped like 0.33.1; not tagged.
