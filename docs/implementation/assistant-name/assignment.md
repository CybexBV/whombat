# The assistant's own name — build brief (2026-10-17)

Decisions: `docs/decisions/archive/assistant-name.md` (AN-01…AN-09). Read it first, then your stream's section. Contracts
**0.82.0** is done and vendored on both integration branches (Whombat `an`, whombat-app `an`): CT-357…CT-360 in
`whombat-contracts/docs/decisions/contracts.md`.

What 0.82.0 gives you (`@whombat/core`):

- `ASSISTANT_NAMES` (Dusty, Pippa, Banjo, Hazel, Ace), `pickAssistantName(taken, {prefer, seed, skip})`,
  `RESERVED_AGENT_NAMES` (`Whombat`), `isReservedAgentName`, `AGENT_NAME_RESERVED_TEXT`, `AGENT_NAME_FORM_TEXT`.
- `agentFace(agent)` (= `canonicalRole(look ?? role)`), `assistantLookFor(name)` (Dusty → `operator`, a pool name →
  `assistant`), `ASSISTANT_FACES`, `ONLY_ASSISTANT_FACE_TEXT`.
- `agents.update` body takes `look: 'assistant' | 'associate' | 'developer' | 'operator' | 'lead'` (optional).
- Runtime feature `agents.look` (server: in `NOT_IMPLEMENTED` until stream S moves it to `IMPLEMENTED_FEATURES`).

Already on whombat-app `an` (both app streams have it): `agentAvatarRole` draws `agentFace` (so every avatar on web and
Android follows `look`), `agentRoleMoved` ignores a face look, and `@whombat/client` `suggestAssistantName(principals,
assistant, offered)` / `assistantTakenNames` for “Suggest a name”.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`server: …`, `web: …`, `mobile: …`), every message
  ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into `main`, never
  touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`): other sessions use
  them. The lead merges. Don't change contracts; if you find a gap, work around it in your repo and report it.
- **DEV fast** (John's rule): one quick check per repo at the end: `TMPDIR=~/.cache/wb-tmp pnpm check`, and for the
  server the integration tests of what you touched plus `pnpm test:server` once at the end. No VM tests, no repeated
  full suites, no CI waits. Use your own ports and throwaway databases; never stop or reset shared containers
  (`docker compose` is shared, never `down -v`). `/tmp` runs out of inodes: `TMPDIR=~/.cache/wb-tmp`.
- **Copy**: plain, short English a non-developer understands, curly quotes (’ “ ”), `·`, `…`. Never a pronoun for an
  agent or a person where a name works (“Dusty took over”, not “he”). Agents' chat words follow CLAUDE.md “Agents and
  automations talk like people”.
- **“Whombat” the product stays** (AN-01): This Whombat, “Sent by your Whombat”, push titles, the logo, emails, “Working
  in Whombat”, the app name. Only words that mean *the assistant* change to its name. When you can't know the name
  (nothing loaded yet), say “your assistant”, never “Whombat”.
- **Decisions you make** go in your stream's decisions file: Whombat `docs/decisions/archive/assistant-name-server.md` (AN-S01…),
  whombat-app `docs/decisions/assistant-name-web.md` (AP-1503…AP-1532) and `assistant-name-mobile.md`
  (AP-1533…AP-1562).
- **Report** at the end: what you built (by AN decision), files outside your ownership you touched, contract gaps, what
  the lead must do at merge, how you verified it.

## 2. Shared copy (all streams use these words)

| Where | Words |
|---|---|
| Sidebar / new-chat button | `Ask Dusty` |
| Ask box placeholder | `Ask Dusty to check, change or set up anything…` (Home), `Ask Dusty…` (short boxes) |
| Reply box | `Reply to Dusty…` |
| A server's ask pane | `Ask about pve-02` · `Dusty sees this server’s sensors, guests and history` |
| Settings → Profile card title | `Your assistant` |
| Its fields | `Name` (field) · `Save` · `Suggest a name` · `Face` (the five faces, each labelled `Dusty’s face`, `Pippa’s face`, … after the character) · `More settings` (link to the model, effort and keys page) |
| Hint under the name | `One word with a capital first letter. Dusty answers you in every chat and looks after your servers and connections.` |
| Saved | `Your assistant is now called Rex.` / `Rex has a new face.` |
| Refusals (server) | `AGENT_NAME_FORM_TEXT`, `AGENT_NAME_RESERVED_TEXT`, `agentNameTakenText` (“There’s already a Pippa in this burrow.”), `ONLY_ASSISTANT_FACE_TEXT` |
| Keys events | `Renamed Whombat to Dusty`, `Changed Dusty’s face`, `Retired Banjo · Dusty took over 6 connections and 1 automation` |

## 3. Stream S — server (Whombat, branch `an-server`, worktree `~/Code/.wt/whombat-an-server`)

Owns `apps/server`, `apps/runner`, `packages/agent-runtime`. Decisions AN-S01…, file
`docs/decisions/archive/assistant-name-server.md`. The crew shell (`WHOMBAT_SHELL=crew`, the test default) keeps its
behaviour except where noted; assistant-shell suites set `env: { WHOMBAT_SHELL: 'assistant' }`.

1. **Naming (AN-02, AN-03).** `domain/personal-agents.ts`: in the assistant shell a new assistant gets
   `pickAssistantName(taken.names, { seed: person.id, prefer: elsewhere })` (assistants count again; `othersNames` and
   `assistantNameFor` go) and `agent_look = assistantLookFor(name)` (extend `createAgent` with `look`).
   `home/shell.ts` `WHOMBAT_ASSISTANT_NAME` goes; `NO_HIRING_TEXT` becomes “Everyone here has their own assistant, so
   there’s nobody to hire.”. `commands/agents.ts` `update_agent`: the reserved check (`isReservedAgentName` →
   `AGENT_NAME_RESERVED_TEXT`, both shells), `AGENT_NAME_FORM_TEXT` for the pattern, `assertAgentNameFree` without the
   assistant exception (drop `options.assistant`), an empty name (unreachable through the contract) is
   `pickAssistantName`'s. **`look`** (AN-04): assistants only (`ONLY_ASSISTANT_FACE_TEXT` on `look` otherwise), stored
   in `agent_look`, text `Changed Dusty’s face`, in the event payload; a rename never touches it. Check `toAgent` sends
   `look`. Move `agents.look` to `IMPLEMENTED_FEATURES`.
2. **Retire the crew with a hand-over (AN-06)** — assistant shell only, a boot job (`index.ts`, next to
   `settleRetiredAgents`), per burrow while it has an active team agent (`kind = 'agent'`, `system` null, `owner_id`
   null, `retired_at` null, `removed_at` null), each agent in its own pipeline commit signed by the burrow's first
   owner (`signerFor`'s fallback in `domain/retired-settle.ts`), idempotent, logged. Reuse `retireAgent`
   (`domain/offboarding.ts`) with a hand-over option rather than a copy. Hand-over, each counted in the
   `agent.retired` payload (`handedOverTo`, counts) and its text (§2):
   - **Connections it looks after** (`catalog_connections.looked_after_by`, `connections/caretaker.ts`
     `handOverConnections`): to the active assistant of `connected_by_id`, else the first owner's assistant.
   - **Automations** whose current version has a `dispatch_agent` step naming it (`automation_versions.definition`), and
     `automations.draft_agent_id`: a new published version (`publishVersion`, as `automation.publish` does: recipe
     agents join the channel `addRecipeAgents`, missing keys `addMissingRecipeGrants`) naming the assistant of the
     version's `published_by_id` (else `created_by_id`, else the first owner); enabled state unchanged. An automation
     only ever asks its publisher's assistant (`automations/authority.ts` `dispatchableAgent`, ONE-DW11), so the step's
     person and the assistant's owner must match. Check `trackers/reply.ts` and `trackers/fixes.ts` sign as the new step
     agent and that `customerSignature` reads well for an assistant.
   - **Vault keys** (`takeAgentsVaultAccess`): granted to the entry owner's assistant where `vaultKeyHolderProblem`
     (`vault/store.ts`) allows it, else taken as now.
   - **Active schedules** (`agent_schedules`, status not ended): moved to the assistant of `for_account_id`'s person, in
     that person's default chat (`personalDmId`, thread null), else ended as now.
   - **Packs** attached only to it that aren't a shipped role pack: attached to the first owner's assistant before
     `detachAgentsPacks`.
   - **Feedback integrations** assessed by it (`feedback/*`, `agentProblem` in `feedback/rules.ts`): the integration's
     creator's assistant, else the first owner's; `agentProblem` accepts a person's own assistant in the assistant
     shell (it joins the destination channel as the assessor needs).
   - **The CI reporter** (`github/actors.ts` `ciReporter`): in the assistant shell, the first owner's assistant when no
     active team agent qualifies.
   Everything else retiring does stays (requests withdrawn, handoffs stopped, runs and dispatches cancelled, computer
   removed, conversations left but its DMs).
3. **Rename the “Whombat” assistants (AN-07)** — the next boot step, after (2): active assistants whose name is
   `Whombat` (case-insensitive) get `pickAssistantName` (visited owner first, then by position; `prefer` the account's
   assistant name elsewhere) and `assistantLookFor`, through a pipeline command signed by the assistant's owner, the
   same writes as `update_agent` (DM titles and search `where`s via `renameAgentDms`, `agent.updated`, `Renamed Whombat
   to Dusty`). An assistant with a chosen name keeps it; if that name is one of the five characters' and it has no
   `look`, it gets that face. Idempotent.
4. **Prompt (AN-09).** `packages/agent-runtime/src/persona/whombat.ts` and `apps/runner/src/prompt.ts` (~164–170, ~367):
   “## Being Dusty” and “You are Dusty, John’s assistant in Whombat” (the agent's name; Whombat stays the product, keep
   “## Working in Whombat”). Assistant shell: no teammates section (`runtime/context.ts` ~347–357 →
   `runtime/teammates.ts`), no `pass_on` (`mcp/served.ts` ~414), and routing (`domain/messages.ts` ~285–322) never
   offers a retired agent.
5. **Server words that mean the assistant** use its name (the acting assistant, or the person's): `chats/commands.ts`
   (42, 47, 225), `home/widgets.ts` (230, 233), `home/overview.ts` (169, 176, 216, 527), `home/changes.ts` (53),
   `hosts/undo.ts` (229, 235, 237, 357, 395, 417), `devices/undo.ts` (149, 153), `devices/tools.ts` (30),
   `hosts/tools.ts` (98); grep for more (`'Whombat` / `Whombat ` in strings). Keep the product ones (`push-preview.ts`,
   `mail/template.ts` “Sent by your Whombat”, `hosts/service.ts` ~30, “## Working in Whombat”).
6. **Reads.** Retired agents keep coming back where history needs them; make sure Needs you (`home/overview.ts`
   ~79–135) and connections' `lookedAfterBy` never show a retired agent, and that search answers don't offer one.
7. **Tests**: integration tests for (1) naming and `look`, the reserved name, uniqueness among assistants; (2) a
   burrow with Dusty/Pippa/Banjo in the assistant shell: after boot all retired, connections/automation/Vault
   key/schedule/feedback handed over, then the owner's “Whombat” is Dusty with face `operator`; idempotent second
   boot; (3) the prompt. Update the tests that expected “Whombat” as the assistant's name.

## 4. Stream W — web (whombat-app, branch `an-web`, worktree `~/Code/.wt/app-an-web`)

Owns `apps/web`, `packages/*` (except what stream M adds under `apps/mobile`), `docs/design-handoff/one-whombat/`.
Decisions AP-1503…AP-1532 in `docs/decisions/assistant-name-web.md`. The assistant's name: `personalAgentOf(bootstrap
.principals, me.id)` (as `features/settings/ProfileTab.tsx` does); add one small hook (e.g. `useMyAssistant`) in
`packages/client/src/react` if it helps both apps, in a new file.

1. **Mock first** (the mocks win): `docs/design-handoff/one-whombat/index.html` says “Whombat” for the assistant with
   the logo as its face (lines ~260, 421, 424, 447, 470, 495, 513, 552). Change those to Dusty with Dusty's drawing
   (`whombat-app/packages/avatars/svg/operator-*.svg`), keep the product's logo where it means the product, and add a
   screen for Settings → Profile → Your assistant (§2 copy: the face bust, Name + Save, Suggest a name, the five
   faces, the hint, More settings). Re-shoot the PNGs it ships (`convo.png`, `home.png`, `home-light.png`,
   `server.png`, `phones.png`, and a new `assistant.png`) the way the folder's previous ones were made
   (`node ~/.cache/wb-tmp/mockups/shoot.cjs <dir>` if it still works, else Playwright).
2. **Names in the shell**: `AssistantSidebar.tsx` (~92 “Ask Whombat”), `AskBox.tsx` (~87, 93, 138),
   `packages/client/src/home/ask.ts` (~10 `ASK_PLACEHOLDER` → a function of the name), `things/AskPane.tsx` (~28–30,
   57, 176), `ChatScreen.tsx` (~199), `DoneScreen.tsx` (~37, 57), `SkillsScreen.tsx` (~21); grep the shell for more.
   Product words stay.
3. **Your assistant (AN-05)**: `features/settings/ProfileTab.tsx` (~267–287, now “Assistant · Hazel · Open”) becomes
   the card: face (bust), Name field + Save (`useSetAgentModel` → `agents.update {name}`), Suggest a name
   (`suggestAssistantName`, fills the field, a different name each press, saves nothing), the five faces as a radio
   group (only with runtime feature `agents.look`; `agents.update {look}`), the hint, More settings → the agent's own
   page. Errors from the server appear under the field. In the assistant shell `features/agents/settings/ProfileTab.tsx`
   (~113–160) shows no “Reset to Hazel” (Suggest a name instead).
4. **The crew out of sight (AN-08)**: leave retired agents out, and in the assistant shell team agents too, of ⌘K
   (`SearchScreen.tsx` ~104–111, 214–217 “Ask Pippa”; `searchFilters.ts` ~106–119), the @ list (`ConversationRoom.tsx`
   ~544, `Composer.tsx` ~231, `messaging/model.ts` ~138–150), the Skills grid (`InstalledPacks.tsx` ~176–190), Vault
   holders (`vault/model.ts` ~271–277), Spend (`SpendTab.tsx` ~84–101, 223–245: past spend of a retired agent stays,
   labelled “Banjo · retired”), approvals (`ApprovalModal.tsx` ~86, 158, `MessageCard.tsx` ~947). Pickers offer the
   person's own assistant: caretaker (`lookedAfter.ts` ~59, `ConnectionPage.tsx` ~287), automations
   (`automationModel.ts` ~59–61). Assistant shell routes (`router.tsx` ~678–733, `AgentsScreen.tsx`): `/agents` goes to
   Settings → Profile; an agent's page shows only that agent (no roster column, no “Hire an agent”); a retired agent's
   page still opens read-only from history.
5. **Fixtures**: `apps/web/src/app/oneFixtures.ts` (~141–152) and `hostsFixtures.ts` (~156–167): the assistant is Dusty
   with `look: 'operator'`; the fake world's `agents.update` applies `look`; e2e and unit tests that said “Whombat”.
6. **Visual check**: fake world (`VITE_WHOMBAT_TRANSPORT=session VITE_WHOMBAT_FAKE=1 VITE_FIXTURE_HOSTS=1` vite in
   `apps/web`, signed in with `e2e-managed/support.ts` `signIn` + `claimAndSaveKit`), 1440×900, both themes, against
   your updated mock: Home, a chat, a server's ask pane, Settings → Profile.

## 5. Stream M — Android (whombat-app, branch `an-mobile`, worktree `~/Code/.wt/app-an-mobile`)

Owns `apps/mobile`. Don't edit `packages/*` (stream W's); `suggestAssistantName`, `agentFace` and the avatar change are
already there. Decisions AP-1533…AP-1562 in `docs/decisions/assistant-name-mobile.md`.

1. **Names**: `data/chats.ts` (~11, 14, 16, 21, 77, 79, 81, 96–97), `HomeScreen.tsx` (~37–38), `NewChatSheet.tsx`
   (~61), `ThingsScreen.tsx` (~28); grep for more (“Whombat” meaning the assistant). Product words stay.
2. **Your assistant (AN-05)** in the phone's Settings/Profile: the same card as the web (§2 copy), 44 px targets, face
   picker only with `agents.look`, `useSetAgentModel` → `agents.update`.
3. **The crew out of sight (AN-08)**: the Agent, AgentSettings and HireAgent screens (`RootNavigator.tsx` ~433, 615,
   622) aren't reachable for team agents in the assistant shell (the own assistant's settings stay reachable from
   More settings); mentions (`data/mentions.ts` ~64–72), connections' caretaker (`data/connections.ts` ~635–645, offers
   the own assistant), Vault entry holders (`VaultEntryScreen.tsx` ~299–360), Spend (`data/spend.ts` ~186: retired
   labelled).
4. **Fixtures**: `fixtures/assistant.ts` (~65–75): Dusty, `look: 'operator'`; `agents.update` applies `look`.
5. **Check**: `pnpm check`, then the emulator (`export ANDROID_HOME=$HOME/Android/Sdk`) with the demo world:
   Home, a chat, Settings → Your assistant (rename, Suggest a name, faces), screenshots in your report.
