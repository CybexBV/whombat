# Cards that settle into a line: the server side (QC-01…QC-05)

John, 2026-10-04, about #reports thread `msg_NrGdVFbIh9qR` (website report FB-3B50-6X0Q): 13 of its 25 messages were
cards — 5 runs, 4 “I learned a skill” (one skill twice), a schedule, an approval, an assessment, the report — and none
of them needed him any more. “Only when something is active it should be a card and when it's done the card should be
removed (the post should be updated).” Then: “Build this fully with your recommendations.”

How a card shows (full, a line, inside its run) is the clients' rule, from state the cards already carry: whombat-app
`docs/decisions/card-settle.md` AP-730…AP-735 (`packages/client/src/cardDisplay.ts`). Contracts 0.45.2 (CT-261) add
the two things the clients can't know: the thread a run's card is in, and the run a skill or schedule card came out of.
(CT-261's text names this file's entries `CS-…`; they are `QC-…`, the prefix this workstream was given.) This file is
what the server fills in and the one card it stops posting twice.

## QC-01 `Run.threadRootId` is filled where every Run is made

`loadRuns` (`apps/server/src/read/work.ts`) is the only place a `Run` is built from rows: `run.updated` (both topics,
`publishRun`), the run reads, the run card resolved in messages (`loadMessages` → `loadRunsByIds`), the work lists and
run views all go through it. It looks up the run cards' messages in one batched query and sets `threadRootId` to the
card message's `thread_root_id`; null when the card is top level, when the run has no card (`runs.message_id` null), or
when that message is gone. No column: the card's thread is the message's own fact, and a stored copy could drift.

## QC-02 The run a skill or schedule came out of: the turn's run

`propose_skill` and the `schedule` tool's `create` store `runId` on their card when the turn that calls them works on a
run, and leave it out otherwise. The turn's run is `dispatchRun` (`runtime/dispatch-scope.ts`): the run the dispatch
controls (`dispatches.run_id`, a run turn), else the newest run started in that turn (`runs.dispatch_id`). That is the
rule the activity rows already used (`runOf` in `runtime/activity.ts`, now `dispatchRun`), so a turn's activity, its
skill card and its schedule card name the same run. For `propose_skill` only the agent's own dispatch counts (the MCP
tool passes it; another agent's id gives no run).

Left out rather than `null` outside a run: those cards stay byte for byte what they were before 0.45.2, for older
clients and every existing test. `loadMessages` carries `runId` from the stored card to the resolved one; the
per-recipient frames (`skills/frames.ts`, `schedules/frames.ts`) spread the resolved card, so realtime has it too.

## QC-03 The same skill learned again in the same run and thread reuses its card

**Why there were two.** Banjo's run #2 on FB-3B50-6X0Q, one Codex turn (rollout `01a1064f-b222-…`, copy in
`~/.cache/wb-tmp/banjo-eff/`): at 09:54:02 it called `propose_skill how-whombat-website-feedback-is-tested`
(`skp_dDJMg0kXkyZX`) while its new browser test was still running, writing down that the widget's kind selectors are
radio inputs. At 09:54:19 that test failed (`getByRole('radio', …).check()` timed out: the radios are screen-reader
only, under their visible labels); it fixed the test, saw it pass, and at 09:55:21 called `propose_skill` again with
`supersedes: how-whombat-website-feedback-is-tested` (`skp_M4BgzQvyuD76`, reason “Correcting the verified
interaction”). Both were valid: since AC-52 a proposal is learned at once, the “one pending proposal per name” limit
only covers `proposed` ones, and a name the own pack holds is accepted with `supersedes` — which `learningLines` asks
for (“When the procedure changes, update the skill”). Every learned proposal posted a card of its own, so a correction
of a skill 79 s old became a second “I learned a skill” card. Nothing was broken on the server: it had no notion that
the second card was about the same thing as the first.

**The rule.** Before posting, `propose_skill` looks for the card the agent already posted for a skill of that name:
same agent, conversation and thread, a `skill` card that still points at that name's newest proposal (`card.proposalId`
equal to the proposal whose `message_id` it is), not deleted, and from the same run (`card.runId`) — or, outside a run,
from the same turn (`skill_proposals.dispatch_id`, card without `runId`). Found: the message's card is set to the new
proposal (and run), and `message.updated` is published in the same commit (`moveSkillCard`); the message keeps its
text (“I learned a skill: name.”), place and time, without an edit mark — Whombat changed its own card, the agent
edited nothing. Not found: a new card, as before.

- **The proposals stay as they are**: both rows `learned`, each with its scan and version, both `message_id` the one
  card; `skill.learned` is signed for each, the second with the reused message id. The audit log and Settings keep the
  history; only the chat shows one card, with the newest version. The tool answers `ok` with that message id.
- **Not across runs, threads or turns outside a run.** A later run, another thread or a later conversation turn is
  another moment people read: there a revised skill is news and gets its card (the clients fold it into its run's line,
  AP-732). Within one run the run's line is the place, and two cards for one skill are noise.
- **Not for schedules.** Two schedules are two things that will happen; each keeps its card.

## QC-04 Everything goes through the commit pipeline

The card change is part of `propose_skill`'s own commit (`ctx.tx`, `ctx.publish`), like `markCardRetried` and the guide
cards: no second command, no write outside the pipeline, and a failed proposal changes no card.

## QC-05 Agents aren't told to announce a learned skill

The only such line was the “Learn this” guidance (`SKILL_AUTHORING_LINES`, `packages/agent-runtime/src/persona/
packs.ts`): “then say in one short line that you learned it”. Now: the card says so, don't say it again — answer what
else the person asked, or end with only `NO_REPLY` (which the runner never posts). Nothing else asks for an
announcement: `learningLines`, the reflection's lines, the `propose_skill` and `schedule` tool descriptions (contracts)
and the scheduling lines say when to use the tools, not to report them. Nothing else about how agents learn, revise or
schedule changes.
