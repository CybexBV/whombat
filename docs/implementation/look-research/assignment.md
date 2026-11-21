# The assistant looks first: the build

Product decisions: `docs/decisions/look-research.md` (LR-01…LR-12); read it first, and the mock's four cards it
describes. Contracts 3.5 are already on branch `looks` (commit “contracts: what the assistant found out about a look
(3.5)”): `LookResearch` (`packages/core/src/domain/look-research.ts`), `DeskLook.research` and `DeskLookFixRequest`
with `DESK_PATHS.lookFix` (`packages/control-contracts/src/local/desk.ts`), `DeskHero.research`/`fix`
(`packages/core/src/domain/desk-glance.ts`), `NeedsYouItem.research` (`domain/home.ts`), `ThingPage.research`
(`domain/thing-page.ts`), `api.looks.fix` (`contracts/home.ts`), the words `DESK_WORDS.looks.looking/lookingSoFar/
fixing/ask` and `DESK_WORDS.calm.ignore` (`domain/desk.ts`). Change a contract only when you must, say so in your
report, and keep `pnpm contracts:gen:check` green.

Every stream works in its own worktree from branch `looks`, commits there with the repository's rules (CLAUDE.md:
small commits, `pnpm format`, `pnpm check` green, Co-Authored-By line), records its own decisions in the section named
below, and ends with a report: what it built, its commits, what it couldn't verify. Don't merge into `main`, don't
push, don't ship: the lead integrates. Use your own `PORT`, `WHOMBAT_HOME` and throwaway databases; never stop shared
containers. No searches of `/` or `$HOME`.

## Stream S: the runtime (`apps/server`, `packages/agent-runtime`, core logic)

Decisions: `LR-S01…LR-S39` in a “Server details” section of `docs/decisions/look-research.md`.

1. **Research rows** (a migration: take the next free number on `main` when you start, and check again before you
   finish; another stream elsewhere may take one): per burrow, the look's key, its line (check, item), its state rank,
   the research's state (`LookResearchState`), title, summary, the offered step (label and the step in the assistant's
   own words, never shown), the thread (conversation, root message), the dispatch, when it started, finished and when
   the look went. Signed changes through the commit pipeline.
2. **The watcher** (LR-01…LR-03): a job (the home jobs' pattern, about every minute) that reads the looks as the desk
   does (`deskLooks` over `things()` and the fleet; the line behind each from `thingNotice`/`cardNotice`) for the burrow's
   person, and starts research for a look seen on two passes in a row with no research for this episode; ends rows whose
   look went; skips quieted looks; 12 a day, one at a time, in the desk's order. Publish `home.changed` when a research
   changes so the desk, Home and pages refresh.
3. **The research turn** (LR-04, LR-05): the assistant posts one plain line as a new top-level message in the person's
   Chat (job-notify's pattern, `runtime/job-notify.ts`; no push, no chime: find how a quiet post is made, or add it),
   then `wakeQuietly` with a new trigger `look` (core `DispatchTrigger`), `own: true`, `messageId`. The turn's context
   carries the look (name, kind, state, reason, since, its line, the connection or server it is, its access level) and
   the prompt (`packages/agent-runtime/src/persona/wakes.ts`, `prompt.ts`) says what to do: find out, read first; small,
   safe, undoable steps itself only when it may manage and nothing asks (LR-06); end with `look_report`; then one short
   message like a colleague (CLAUDE.md “Agents and automations talk like people”). Measure the preface: keep it short.
4. **`look_report`** (a tool served only in `look` and `look_fix` turns, as `report_assessment` is with `assesses`;
   contract in core `contracts/mcp.ts`, strict input): `title` (≤ 80), `summary` (≤ 240, one line), `fixed` (bool),
   `fix?: {label ≤ 32, step ≤ 300}` (not with `fixed`). It records on the row of the turn's look, refuses in any other
   turn, and a `fixed` report goes to Done today (`report_done`'s path).
5. **The fix** (LR-08): `looks.fix` (session op and route, `api.looks.fix`) and the desk socket's `look/fix`
   (`desk/socket.ts`, `DeskService`, unlocked only, as the paired person, as `lookQuiet`): only for a row in `found`
   with a step; posts the person's words in the look's thread (`dispatch: false`), wakes with trigger `look_fix`, `own:
   true`, carrying the step; state `fixing`. 403 when the person may not manage the thing, 404 when there is no step.
6. **The screens' fields**: `DeskLook.research` (glance), the calm hero (`desk-calm.ts` `heroOf`: the research's title
   and summary as title and detail (cut to 200 for older consoles), `research` and `fix` on the hero, “I’m looking into
   it.”/“So far: …” while looking), `NeedsYouItem.research` for the items about a server, connection or device,
   `ThingPage.research` on a connection's or device's page. Also Settings → Screen's preview (`desk.preview`): its
   `wrong` scenario should show a found look with a step, so the apps can see the buttons.
7. **Tests**: unit tests for the watcher's decisions and the hero; an integration test (real Postgres) for watcher →
   research turn queued → `look_report` → rows and fields → `looks.fix` → `look_fix` turn queued; the scripted Hermes
   (`hermes/testing`) where a turn must run. Check facts, not sentences (TS-07). Update the widest-glance test
   (`DESK_STATE_MAX_BYTES`) with five researched looks.

## Stream W: the web (`apps/web`, `packages/client`)

Decisions: `AP-5900…AP-5919` in `docs/app/decisions/look-research-web.md`.

- Shared client logic in `packages/client` (pure, tested), so the phone uses the same: which words and buttons a
  researched look, Needs you item and thing page show (LR-09); the step's button calls `looks.fix` (a hook in
  `packages/client/src/react/`); *Ask {assistant}* opens the research's thread in Chat.
- Home's Needs you (`features/home/NeedsYouCard.tsx`, `useHomeActions.ts`, `features/inbox/NeedsYouRow.tsx`): with
  `research`, its title and summary, the step first, Ignore, Ask; “I’m looking into it.” while looking; green when fixed.
- A thing's page (`features/things/dashboard/`): `ThingPage.research` as a card at the top of the Summary.
- Settings → Screen's preview (`features/desk/DeskPreviewScreen.tsx`): the hero mirrors the console's (step, Ignore for
  a look, Open), from `DeskHero.research`/`fix`.
- The fixture world (`apps/web/src/app/*Fixtures.ts`, `packages/fixtures`): a researched look in each state.
- Verify visually (`pnpm visual` fixture mode, both themes, 1440×900) against the mock's cards; tokens only.

## Stream M: the phone (`apps/mobile`)

Decisions: `AP-5920…AP-5939` in `docs/app/decisions/look-research-mobile.md`. Start after W's first commit with the
shared client logic (merge W's branch when the lead says so); until then build the screens against the contract.

- Home's Needs you row and sheet (`screens/home/NeedsYouCard.tsx`, `screens/NeedsYouSheet.tsx`, `data/home.ts`), the
  thing page (`data/thingPage.ts`, `screens/thing/Panels.tsx`), Settings → Screen's preview
  (`settings/DeskPreviewScreen.tsx`): as the web, 44 px touch targets, the shared client logic.
- Typecheck and unit tests; screenshots from the fixture mode if the harness allows.

## Stream P: the desk screen (appliance repo, `~/Code/whombat-appliance`, `console/`)

Decisions: `CG-370…CG-379` in the appliance's `console-gui.md`. Work in a worktree of the appliance repo from its
`main`, branch `looks`.

- Contracts: until the lead releases 3.5, vendor the TS files from Whombat's branch `looks` by hand for development
  (`console/ui/scripts/vendor-contracts.sh` takes a tag: copy the same files from the worktree), and use the Go
  module from the worktree's `contracts/go` through a temporary `replace`; the lead re-vendors from the release tag.
- Go: `internal/desk` clean rules for `research` (`clean.go` `cleanLooks`, maxes in `wire.go`), the hero's new fields
  (`cleanCalm`), a `LookFix` client method (`lookquiet.go`'s pattern) and `/api/desk/look/fix` in `consoleapi.go` with
  its body limit; tests as `lookquiet_test.go`.
- UI: `ui/src/lib/desk.ts` (`DeskLook`, `parseLook`), `ui/src/lib/calm.ts` (`CalmHero`, `parseCalm`),
  `ui/src/desk/Calm.tsx` `Hero` (step first, *Ignore* where *Not now* was, Open), `ui/src/desk/Sheet.tsx` `LookCard`
  (research words, step, Ask {assistant} → Talk as `fixLook` does, Ignore, Not now, Open, Close), `lib/needsYou.ts`
  `lookActions`, `Desk.tsx` wiring (a `fixStep` posting `/api/desk/look/fix`, the PIN first when locked as Approve),
  `deskCopy.ts` words, the demo (`demo/demo.tsx`, `demo/calmFixtures.ts`: looking, found with a step, found without,
  fixing, fixed), and its shots (`node scripts/shots.ts`) for the lead to look at.
