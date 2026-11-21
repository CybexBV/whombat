# All skills — build brief (2026-10-18)

Decisions: `docs/decisions/archive/all-skills.md` (SK-01…SK-18) — read it first, then §1, §2 and your stream's part of §3.
Background: `docs/implementation/all-skills/plan.md` and `research/{openclaw,hermes}.md` next to this file (read the
parts about your area: index format and budget, `skills_search`/`skills_read`, Workshop, Hermes `skill_manage`,
background review, curator, hub sources). Mockup John saw: whombat-app
`docs/design-handoff/all-skills/settings-skills.html` (layout, order and words; the app's tokens and component sizes win
on details; figures are made up).

Integration branches `skills`: contracts `~/Code/.wt/contracts-skills`, Whombat `~/Code/.wt/whombat-skills`, app
`~/Code/.wt/app-skills`. Reserved: contracts **0.92.0** (CT-410…CT-439), whombat-app **0.90.0** (AP-2300…AP-2399),
Whombat migrations **0113–0115**, appliance candidate **0.101.0 / IN-291 / rc.121**, host builds pve-20261018.15+.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`contracts: …`, `server: …`, `runner: …`,
  `client: …`, `web: …`, `mobile: …`), every message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into `main` or `skills`, never touch
  the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`, `~/Code/whombat-appliance`) or
  other sessions' worktrees. The lead merges (and tells you when to `git merge skills`).
- **DEV fast** (John's rule): one quick check at the end — `TMPDIR=~/.cache/wb-tmp pnpm check` in your repo, plus
  `pnpm test:server` once for Whombat streams. No VM tests, no repeated full suites, no CI waits, no sleeping to wait for
  data. Run single test files while you work. Own ports (L: `PORT=4491`, A: `PORT=4492`, W: `PORT=4493 WEB_PORT=5199`)
  and throwaway databases; never stop or reset shared containers (`docker compose` is shared — never `down -v`). `/tmp`
  runs out of inodes: `TMPDIR=~/.cache/wb-tmp`.
- **Tests check facts, not sentences** (CLAUDE.md, `docs/decisions/test-speed.md`): names, ids, statuses, a short key
  phrase — no long literal text. Wait on events or inject short timeouts, never sleep. A new integration test file needs
  a reason to need Postgres.
- **Never call John's real services, his DEV box or the internet from tests.** Hub adapters are tested with recorded
  JSON. The lead does the live checks and John's import after the merge.
- **Copy**: plain, short English a non-developer understands (concise-replies.md): curly quotes (’ “ ”), `·`, `…`. No
  ids, paths, hashes or stack traces in visible words. Instructions meant for the agent go to the agent, never into the
  chat.
- **Tokens only** for UI colours; match the surrounding code's style and comment density.
- Contract change needed after 0.92.0 is vendored? Don't edit vendored tarballs: message the lead (SendMessage `main`)
  with the exact additive change; prefer solving it on your side.
- Record your own decisions in your stream's file (L: Whombat `docs/decisions/archive/all-skills-server.md`, SK-S01…; A:
  `docs/decisions/archive/all-skills-agent.md`, SK-A01…; W: whombat-app `docs/decisions/all-skills.md` AP-2300…AP-2359; M: the
  same file AP-2360…AP-2399; C: contracts `docs/decisions/contracts.md` CT-410…).
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is left,
  what the lead must check live).

## 2. The wire shapes (contracts 0.92.0 — stream C makes them; everyone codes against these names)

Additive only; old servers and clients keep working (defaults).

- **CT-410 `PackSkillRef.needs`**: `{ connections: string[] ≤ 8, servers: string[] ≤ 8 }`, default empty, where
  connections are connection catalog ids and servers are server platform kinds — reuse the enums/patterns that already
  exist in core for catalog ids and host platforms. Validation rejects unknown shapes, not unknown ids (a newer catalog
  may know more).
- **CT-411 `SkillSource`** `'shipped' | 'imported' | 'own'` and `SKILL_SOURCE_PRECEDENCE` (own > imported > shipped);
  `skillWinner()` pure helper picking one skill per name (SK-03).
- **CT-412 Listing** `SkillListing` `'full' | 'short' | 'unlisted'`; `SKILL_LISTING_FULL_MAX = 160`,
  `SKILL_LISTING_SHORT_MAX = 60`, `SKILL_LISTING_BUDGET_DEFAULT = 10_000`; pure `planSkillListing(items, budget)` where
  `items` are `{ key, name, description, rank }` (lower rank = more important) → per key `{ listing, description }`
  (full while it fits, then short, then unlisted; each line costs name + description + a fixed overhead constant);
  `cutSkillDescription(text, max)` at a word boundary with `…`. Unit-tested in contracts.
- **CT-413 `PackContext.skills[]`** gains `listing` (default `'full'`), `listedDescription` (optional, the cut text),
  `source` (default `'shipped'`), `group` (default `''`), `pinned` (default false). **`PackContext.skillsNew`**
  `{ pack, name, description }[]` (default `[]`, SK-07) and **`PackContext.skillsUnlisted`** number (default 0).
- **CT-414 MCP tools** in `SKILL_MCP_TOOLS`:
  - `find_skill` — input `{ query (1–200), online (default false), limit (1–10, default 5) }`; output ok
    `{ matches: { pack, name, description, source, status: 'listed'|'unlisted'|'resting', folder }[], online?: { hub,
    name, description, url, trust: 'trusted'|'community' }[] }` where `folder` is `<pack>/skills/<name>`. No key,
    read-only.
  - `read_skill` — input `{ name, pack?, file? }`; output ok `{ pack, name, version, folder, text, files: { path, bytes
    }[] }` or `not_found { suggestions: string[] }`. No key, read-only.
  - `skill_write` — input discriminated on `action`: `create { name, description, body, files?, why, source? }`,
    `patch { name, pack?, old, new, why }`, `rewrite { name, pack?, description?, body, why }`, `add_file { name, pack?,
    path, content, why }`, `remove_file { name, pack?, path, why }`, `rest { name, why }`, `install { url, why }`. Output:
    ok `{ pack, name, version, replaces?: { pack }, messageId? }`, `invalid { problems }`, `refused { reason, findings }`,
    `not_found { suggestions }`, `waiting { messageId }` (a community install waits for the person). Key
    `skills.propose`. Limits reuse `domain/skills.ts` (body 32 KB, 16 files, folders references/templates/scripts).
  - `propose_skill` stays; its description points at `skill_write`.
- **CT-415 Library** (`contracts/skills-library.ts`, burrow-scoped like the packs endpoints; every call names the
  assistant `agentId`, the caller must be allowed to configure it):
  - `SkillStatus` `'ready'|'needs_setup'|'hidden'|'off'|'resting'|'replaced'`.
  - `SkillLibraryItem` `{ key ('<pack>:<name>'), pack, packTitle, group, source, name, description, status, missing:
    string[] (words), uses, lastUsedAt|null, changedAt|null, changedBy: 'agent'|'person'|null, pinned, listing|null,
    replaces: { pack, packTitle }|null, replacedBy: { pack, packTitle }|null, originalChanged: boolean, addedBy: { id,
    name }|null, canEdit }`.
  - `GET skills/library?agentId` → `{ agentId, agentName, items, budget: { chars, used } }` (items include “Added by
    others” imports with `status: 'off'` and `addedBy`).
  - `GET skills/library/skill?agentId&pack&name` → `{ item, text, files: { path, bytes }[], versions: { versionId,
    version, at, by: { kind: 'agent'|'person', name }, summary }[], original: { pack, packTitle, text }|null }`;
    `GET …/skill/file?agentId&pack&name&path` → `{ path, text }`.
  - `POST skills/library/edit { agentId, pack, name, description?, body }` → `{ item }` (SK-10 when not its own);
    `pin { agentId, pack, name, pinned }`, `rest { agentId, pack, name, resting }`, `reset { agentId, name }` (removes
    the higher copy), `restore { agentId, pack, name, versionId }`, `switch { agentId, pack, name, on }`,
    `add { agentId, pack }` (attach someone else's import) — each → `{ item }` (or `OkResponse` where no item remains).
  - Import: `POST skills/import/preview` (multipart `file` .zip/.tar.gz/.tgz ≤ 25 MB, or JSON `{ url }`) →
    `{ importId, source: 'whombat'|'hermes'|'openclaw'|'claude'|'agentskills'|'github'|'skills.sh'|'clawhub'|'link',
    items: { name, description, group, verdict: 'clean'|'caution'|'dangerous', findings, secrets: string[], translated:
    number, clash: 'new'|'replaces_shipped'|'replaces_import'|'same_as'|'exists_own', selectable, selected }[],
    expiresAt }`; `POST skills/import/commit { agentId, importId, names }` → `{ added, packs: string[] }`.
  - Hub: `GET skills/hub/search?q` → `{ results: { hub: 'skills.sh'|'clawhub'|'hermes'|'anthropic', name, description,
    url, trust, installs? }[] }` (install = import preview with `{ url }`).
- **CT-416 `DispatchContext.reflect.reason`** `'quiet' | 'long_turn'` (default `'quiet'`),
  `REFLECT_LONG_TURN_TOOL_CALLS = 12`; `REFLECT_DISPATCH_TOOLS` gains `skill_write`, `read_skill`, `find_skill`.
- **CT-417 Constants** `SKILL_REST_AFTER_DAYS = 60`, `SKILL_SNAPSHOT_HOURS = 24`, `SKILL_IMPORT_MAX_SKILLS = 300`,
  `SKILL_IMPORT_MAX_BYTES = 25 MiB`; foreign tool-name table `FOREIGN_SKILL_TOOLS` (Hermes, OpenClaw, Claude Code →
  Whombat words) and `translateForeignSkill(text)` pure (rewrites call-like mentions only, counts them).
- **CT-418 Runtime feature** `skills.library`; key `skills.propose` label “Learns skills”.

## 3. Streams

### C — contracts (branch `skills` itself, worktree `~/Code/.wt/contracts-skills`)

Build §2 in `packages/core` (read `packs/manifest.ts`, `contracts/packs.ts`, `contracts/skills.ts`,
`contracts/mcp-skills.ts`, `domain/skills.ts`, `domain/dispatch.ts`, the reflect bits, the runtime features list, the
keys catalog), with unit tests for `planSkillListing`, `cutSkillDescription`, `skillWinner`, `translateForeignSkill`
and the new schemas' defaults. Version 0.92.0 everywhere it's recorded; decisions CT-410…; build the release
(`docs/publishing.md`, the `dist-release/0.92.0` tarballs + SHA256SUMS as for 0.91.0) and **vendor it on the `skills`
branches of Whombat (`~/Code/.wt/whombat-skills`) and whombat-app (`~/Code/.wt/app-skills`)** exactly as 0.91.0 was
vendored (package.json `file:` paths, `contracts:verify`, lockfile via `pnpm install`), each repo's `pnpm check` green
(type errors from the new required fields are yours to fix with defaults). Commit in all three worktrees. Do not tag or
merge; the lead does. Tell the lead (SendMessage `main`) as soon as both vendorings are committed.

### L — server library (Whombat, branch `skills-lib` from `skills`, worktree `~/Code/.wt/whombat-skills-lib`)

Read first: `apps/server/src/packs/read.ts` (`appliedPacks`, `packContextFor`, `enabledSkills`, `skillsOffOf`),
`packs/assistant.ts` (`assistantGivenPacks`), `packs/whole-burrow.ts`, `packs/bundled.ts`, `packs/store.ts`,
`packs/commands.ts`, `packs/routes.ts`, `packs/readiness.ts`, `skills/own-pack.ts`, `skills/links.ts`,
`skills/uses.ts`, `skills/read.ts`, `skills/routes.ts`, `skills/shadow.int.test.ts`, `index.ts` boot steps, the
connections catalog and hosts fleet reads (to know connected catalog ids and server platforms), `packs/` at the repo
root (shipped packs, `whombat-pack.json`), `docs/decisions/skills-library.md`, `bp-packs.md`, `less-is-more.md`
(LM-P…).

**First, a skeleton within ~1 hour** (commit, then SendMessage `main` “skeleton ready <sha>”): migration **0113**
(`skill_states (agent_id, pack_name, skill_name, pinned, rested_at, updated_at)`, `skill_snapshots (agent_id,
conversation_id, keys jsonb, hash, created_at)`, `skill_imports` (staged previews with expiry), `pack_versions.source`
value `import` + an `origin` jsonb (kind, url, trust, imported_by); take 0114/0115 only if needed and tell the lead) and
`apps/server/src/skills/library.ts` exporting the functions stream A calls: `availableSkills(services, agent)` (one
winner per name with status, listing, folder, source, group, pinned, uses), `resolveSkill(services, agent, name,
pack?)`, `readSkillText(services, agent, ref, file?)`, `writeSkill(services, agent, change, by)` (create / patch /
rewrite / add_file / remove_file on the own pack; copies another source's skill into the own pack first, SK-10; returns
version and `replaces`), `restSkill`, `wakeSkill` (a use wakes a resting skill), `recordSkillUse`. Stubs are fine at
first; real bodies follow.

Then build:
1. **SK-01 attach everything** (assistant shell only): boot step installs every shipped pack in the burrow and attaches
   it to every assistant (agent target, enabled), idempotent, and again when a release ships a new pack; replaces
   `assistantGivenPacks`'s narrow rule; the old “More packs” notion goes. New assistants get the same at creation.
2. **SK-04 needs**: add `needs` to the ~40 shipped skills tied to a service (Homelab, Operator craft, Game servers,
   Assistant productivity's Notion/Airtable/Obsidian/Google…) — bump those packs' versions the way shipped packs are
   upgraded today (`bundled_skill_upgrades`); compute availability from the burrow's connections (catalog ids) and
   servers (platform kinds); `missing` words (“Needs UniFi Protect”, “Hidden · no TrueNAS server”, “Needs the browser
   key”).
3. **SK-03 winners** and **SK-05 ranking + listing** inside `packContextFor`: one skill per name; rank pinned → used in
   30 days → own/imported → tied to a connected thing → the rest by name; `planSkillListing` with
   `WHOMBAT_SKILL_LISTING_BUDGET` (config, default from core); fill the new `PackContext` fields; hidden and resting
   skills are left out of `skills` (resting ones stay findable through `availableSkills`).
4. **SK-07 snapshots**: per (assistant, conversation) the first dispatch records keys+versions; later dispatches within
   `SKILL_SNAPSHOT_HOURS` reuse that set (newer versions of the same skills are *not* swapped in) and list additions or
   changes in `skillsNew`; a compaction/new CLI session (find how the runner signals a fresh session) or expiry
   rebuilds.
5. **REST (CT-415)** library, skill, file, edit, pin, rest, reset, restore, switch, add; permission: whoever may
   configure that assistant (its person; owners for team agents). `canEdit` per item.
6. **SK-14 import**: zip/tar/folder and links (extend `skills/links.ts` to whole GitHub repos/folders, skills.sh,
   ClawHub — find their download/raw URLs; fetch with the existing safe fetcher, size limits); detect the layout
   (Whombat manifest, Hermes categories + `DESCRIPTION.md`, OpenClaw/Claude/agentskills folders); parse foreign front
   matter (name, description, `metadata.openclaw.requires`, Hermes `platforms`/`requires_toolsets`/`metadata.hermes`)
   and map to `needs` where known; rebuild front matter (BP-D20); `translateForeignSkill`; credential-looking values →
   `<from the Vault: NAME>` (use core's secret detection, list names); `scanPack`; one generated pack per group
   (`hermes-smart-home`, title “From Hermes · smart-home”; names must not clash with shipped names or `own-`); clash
   classification vs the assistant's available skills; preview staged with expiry, commit installs + attaches to the
   importer's assistant (SK-02). Keep file limits (skip oversized files with a note in the preview).
7. **SK-13 curator**: daily job rests own/imported skills unused for `SKILL_REST_AFTER_DAYS` and not pinned; a use wakes
   them.
8. Docs: rewrite `docs/skills.md` for the library model (short, user-facing); `docs/packs.md` where it says packs are
   attached by hand.
9. Tests: unit tests for ranking/winners/needs/import parsing (fixtures: a small Hermes tree, an OpenClaw skill, a Claude
   skill, a zip with a secret and a dangerous script), one int test for the library + edit + reset round trip, one for
   import preview/commit, one for snapshots. Then `pnpm check` and `pnpm test:server` once.

### A — agent side (Whombat, branch `skills-agent` from `skills`, worktree `~/Code/.wt/whombat-skills-agent`)

Read first: `apps/runner/src/skills.ts` (`materializeSkills`, `sanitizedSkillMarkdown`, the content hash AE-07),
`packages/agent-runtime/src/claude/skills.ts`, `codex/skills.ts`, `codex/index.ts` (extra roots, disabling by path),
`persona/packs.ts` (`packLines`, PE-06, RA-16), `persona/computer.ts` (`learningLines`), `apps/runner/src/prompt.ts`,
`apps/server/src/skills/tools.ts`, `commands.ts`, `uses.ts`, `outcomes.ts`, `apps/server/src/mcp/server.ts` +
`tools.ts` (`REFLECT_DISPATCH_TOOLS`), `apps/server/src/memory/reflect.ts` (RA-24), `docs/decisions/prompt-efficiency.md`,
`agent-efficiency.md`, `resourceful-agents.md` (RA-16, RA-24), `agent-computer.md` (AC-52).

Until L's skeleton is merged into `skills` (the lead tells you), work on the parts that don't need it (runner, persona,
hub adapters, reflect trigger); then `git merge skills` and wire the tools to `skills/library.ts`.

Build:
1. **Runner (SK-05)**: materialize every skill in `PackContext.skills` (listed and unlisted); write `listedDescription`
   into front matter; Claude's `skills` filter and `--allowedTools Skill(…)` list only full/short skills; Codex: unlisted
   skills disabled by path (as repo skills are); keep the content-hash folder; the prompt gets one line with the skills
   folder so `find_skill`'s `folder` can be opened; usage: count Claude `Read` of a pack's `SKILL.md` like Codex reads.
2. **Persona (SK-06, SK-07, SK-08)**: rewrite the pack-skills lines for the library model (short; one rule each): look
   first, read when even partly relevant; `find_skill` for anything not listed; `read_skill` works everywhere; after a
   task, fix the skill you used with `skill_write patch` (or create one for a new procedure); procedures in skills, facts
   in memory; `skillsNew` named once. `learningLines` points at `skill_write`. Measure the prompt before/after for an
   assistant with all shipped packs (record the numbers in SK-A…).
3. **MCP tools (CT-414)**: `find_skill` (local search over `availableSkills`: name, description, start of the body;
   simple scoring, no embeddings; `online` → hub search), `read_skill` (counts a use, wakes a resting skill),
   `skill_write` (every action via `writeSkill`; scan; “I learned a skill” card only on `create`/`install`, as today's
   AC-52 card; patches post nothing; `install`: trusted hub → import commit to the agent's own person's assistant + “I
   added …” card with Undo; community → a card for the person with **Add** / **Not now**, answer `waiting`);
   `propose_skill` keeps working by mapping to create/rewrite.
4. **Hub search (SK-12)**: adapters for skills.sh, ClawHub, Hermes official optional skills (the NousResearch/hermes-agent
   `optional-skills` tree), Anthropic's skills repo — find their real search/list endpoints (research reports name
   them), timeouts, 10-minute cache, trust per source; `GET skills/hub/search` route (CT-415) and the `online` part of
   `find_skill`. Recorded JSON in tests.
5. **SK-11 review after long turns**: when a dispatch ends with ≥ `REFLECT_LONG_TURN_TOOL_CALLS` tool calls and no
   `skill_write`/`propose_skill`, enqueue a `reflect` dispatch with reason `long_turn` (not after automation, schedule,
   feedback, briefing, reflect, undo_requested, expand), at most one per conversation per hour; its prompt: at most one
   skill change, prefer patching a skill read in that task, never name a skill after one incident, nothing posted.
6. Tests: unit tests for listing in the materialized files and CLI flags, persona lines (facts: tool names present),
   find scoring, the long-turn trigger rules, hub adapters with recorded JSON; one int test for `skill_write patch` on a
   shipped skill → own version + `replaces`. Then `pnpm check` and `pnpm test:server` once.

### W — web (whombat-app, branch `skills-web` from `skills`, worktree `~/Code/.wt/app-skills-web`; owns `packages/client` and `apps/web`)

Read first: `apps/web/src/features/settings/SettingsScreen.tsx` (the assistant-shell filter of the Skills tab, ~:156),
`app/routing/search.ts` (`settingsRedirect`), the assistant sidebar (`assistantSidebarModel.ts`, `AssistantSidebar.tsx`,
`BurrowShell.tsx` count), `features/packs/*` (`SkillsScreen.tsx`, `PacksTab.tsx`, `LearnSkill.tsx`, `assistantCatalog.ts`,
`skillsCopy.ts`), `features/agents/settings/SkillsTab.tsx` (link import), the Markdown renderer used for messages, the
PR file view diff, `packages/client` (endpoints, hooks, fixtures), `docs/decisions/less-is-more.md`,
`skills-settings.md`, `home-simplify.md`.

Build (assistant shell; the crew shell keeps `PacksTab` as it is):
1. Client: endpoints + hooks for CT-415, fixtures with a realistic library (shipped groups, From Hermes, Learned by Dusty,
   hidden/needs setup/resting/replaced items, versions).
2. **SK-16**: sidebar row gone (and its count); Settings shows Skills in the assistant shell; `/skills` → `/settings?tab=skills`
   (keep `?tab=packs` redirect); links elsewhere that pointed at `/skills` updated.
3. **SK-17** the tab per the mockup: header with count, help line, search (name and description, instant), Learn a
   skill (today's LearnSkill), Add skills (dialog: Upload a .zip or folder (`webkitdirectory` zipped client-side or sent
   as files — choose and record), Paste a link, Find (hub search results with source and trust, Add); then the preview
   list with verdict, clash words, secrets note, checkboxes; Add selected), chips with counts, grouped rows, folds;
   the skill panel beside the list (stacked below under ~860 px): rendered body, files (click opens text), needs/uses/
   changes lines, history with Undo per version, Edit (Markdown textarea with preview toggle; Save / Cancel; saving a
   skill it didn't write says it becomes “Dusty’s version”), Compare with original (diff view reused from PR files),
   Pin, Reset to original, the switch. Empty/error/loading states per less-is-more. Keyboard and focus rings.
4. Visual check at 1440×900 both themes against the mockup (`pnpm visual` or Playwright on your dev server with
   fixtures); fix differences.
5. Tests for the client model (grouping, counts, chips filter), redirects. Then `pnpm check`.

### M — Android (whombat-app, branch `skills-mobile` from `skills`, worktree `~/Code/.wt/app-skills-mobile`; owns `apps/mobile`)

Start after W has the client hooks (the lead tells you to merge `skills`); until then read `apps/mobile/src/screens/
PacksScreen.tsx`, `AgentScreen.tsx` (SKILLS section), the Settings screen and navigation, `docs/decisions/android-*`.
Build **SK-18**: Settings → Skills (search, chips, grouped rows with status words and switches, folds), a read-only skill
screen (rendered body, needs/uses lines, Pin, Reset to original); the old SKILLS section in the assistant's screen links
here; 44 px targets, labels. Verify with the fixtures APK on the emulator under `agent-resource run` (see
`~/.cache/wb-tmp/mockups/home-simplify/emu.sh` and memory notes in the app's decisions); screenshots both themes.
Then `pnpm check`.

## 4. Ship (lead)

Merge C → tag contracts-v0.92.0 after streams merge; L skeleton → `skills`; streams → `skills`; Whombat `pnpm check` +
`test:server`; app release 0.90.0 (+APK) vendored into Whombat; main + push in all repos; whombat-dev restart; appliance
candidate 0.101.0 runtime-only on top of 0.100.2 to the dev stack and John's box; live checks (index size in a real turn,
a turn that opens an unlisted skill via `find_skill`, a patch + Undo, the tab on dev.whombat.com); then SK-15 import of
John's Hermes skills on his box through the import endpoint.
