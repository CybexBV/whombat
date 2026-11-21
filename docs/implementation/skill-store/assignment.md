# Assignment: skills without packs

Spec: `docs/decisions/archive/skill-store.md` (SST-01…SST-17) in this branch. Background: `docs/decisions/archive/all-skills.md`,
`all-skills-server.md`, `all-skills-agent.md`, `bp-packs.md`, `skills-library.md`, `docs/packs.md`, `docs/skills.md`,
and the Hermes research `docs/implementation/all-skills/research/hermes.md`.

Lead: session whombat-7f (vendors contracts, merges, releases, ships). Integration branches: Whombat `sst`
(`~/Code/.wt/whombat-sst`), contracts `sst` (`~/Code/.wt/contracts-sst`), app `sst` (`~/Code/.wt/app-sst`).

## Streams and worktrees

| Stream | Worktree (branch) | Owns | Numbers |
| --- | --- | --- | --- |
| C contracts 0.113.0 | `~/Code/.wt/contracts-sst` (sst) | every schema change | CT-800…CT-839 |
| S server: the store | `~/Code/.wt/whombat-sst-store` (sst-store) | `apps/server/src/{skills,packs}/`, db schema + migration 0130 + backfill, shipped catalog `packs/` → `skills/`, the runner's skill-files route and building `DispatchContext.skills`, backups, managed staging/import, guides, hire/onboarding role packs, `vault/packs.ts` + the pack part of `vault/withhold.ts`, config, package build, docs | SST-S01…SST-S59 |
| R dispatch: runner and CLIs | `~/Code/.wt/whombat-sst-run` (sst-run) | `apps/runner/`, `packages/agent-runtime/` (persona pack lines → skills, Claude plugin, Codex root), `apps/server/src/mcp/` pack tools (`pk_`, `call_pack_tool`, `PackMcpPool`, `killGroup`'s new home), pack-tool approvals (`approvals/`), the session fingerprint (`memory/sessions.ts`), `scripts/prompt-size` | SST-R01…SST-R39 |
| W app: client and web | `~/Code/.wt/app-sst` (sst) | Settings → Skills on the new shapes, agent settings Skills tab, removal of pack screens, hire/onboarding role packs, Vault and guide words | AP-4100…AP-4149 |
| M app: phone | `~/Code/.wt/app-sst-mobile` (sst-mobile) | SkillsScreen, PacksScreen removal, the chat `/skill` hint, Vault pack words | AP-4150…AP-4199 |

Migration number 0130 is S's. Vault self-serve (session whombat-d0) holds contracts 0.112.0, migration 0129 and app
0.114.0, and is editing `vault/commands.ts`, `ssh*.ts`, `mcp/served.ts`, `mcp/tools.ts`, `computer/secrets.ts`,
`persona/vault.ts`, and in the app `VaultEntryDetail.tsx`, `copy.ts`, `AddToVaultModal.tsx`, `SshServers.tsx` and
mobile `VaultEntryScreen.tsx`. **Leave those files to the end.** The lead tells you when `vs` is on main; then
`git merge main` (Whombat streams: `git merge sst` after the lead merged main into it) and make your changes there.

**Contracts first.** C lands phase 1 (below) and builds a provisional `dist-release/0.113.0`. The lead vendors it into
Whombat `sst` and app `sst` and tells S, R, W and M to `git merge sst`. Until then, build what doesn't need it (S: the
tables, the migration, the store on disk, the catalog move; R: the one-folder materialization and use parsing behind
local types; W/M: reading the current screens and planning removals).

### C phase 1 (what the others wait for)
- A core `skills/` module (pure) that takes over from `packs/` what skills still need: path, size and UTF-8 rules,
  literal-secret detection for skill files, the scan, readiness (`requires`), the listing planner (`library.ts`), skill
  name, origin and status types. It also parses the front-matter `whombat:` line (SST-01) with a `skillMeta`
  read/write pair and unit tests. `packs/` keeps only what old history or old backups need to parse.
- `DispatchContext.skills` (replacing `packs`): the turn's skills (`name`, `description` / listed description,
  `listing`, `versionId`, `category`, `requires`, `prerequisites`, `missing`), the unlisted count and the
  “new since this chat started” names. No instructions, tools or pack pins.
- Runner endpoint `skillFiles` (replacing `packSkills`): request `{versionIds, knownHashes}`; answer per version
  `{name, versionId, files | unchangedHash}`.
- `mcp-skills`: `find_skill` / `read_skill` / `skill_write` without `pack`. Folder `skills/<name>`.
- Skills library API (SST-16): keyed by name; items carry `category`, `group`, `origin`
  (`shipped`/`imported`/`learned`), `changed` and `originalChanged`, plus the compat fields older phones parse.
  Versions use a `skv_` id. Reset, Compare and Undo work per skill. `libraryAdd` copies another person's import.
  `importPreview` / `importCommit` / `hubSearch` stay. Staging archives move from `packs.stage` to `skills.stage`
  (compat alias if an older client stages).
- Backup records for skills (SST-15), with the old pack records still parseable for restore.
- Ids `skl` (skill) and `skv` (skill version); `pkv` stays for history. Features: drop `packs`; add `skills.store`.
- Remove `packEndpoints` (keep whatever SST-16 says an older phone needs), pack views, role-pack endpoints, and the
  Vault's `secret` template from what can be created (the kind stays readable).
Phase 2: words (SST-17), anything the streams ask for, then the final release.

## Rules for every stream
- Read the repo's CLAUDE.md, ARCHITECTURE.md and DECISIONS.md first, and follow its conventions and test rules.
- Commit on your branch: small, imperative messages ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **Never push, never merge into main, never tag or
  release**: the lead does that.
- DEV is fast. Run one quick check per repo when you finish: `pnpm format`, then `pnpm check`; S and R also run
  `pnpm test:server` once (or only the integration files you touched, if the full run is slow). No VM tests, no CI,
  no waiting for future data. Run one repo's full check at a time on this machine.
- `TMPDIR=/home/me/.cache/wb-tmp`, Node 24 (`export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH`).
  Server tests use the shared Postgres :55432 with your own throwaway databases. Never stop or reset shared
  containers.
- Don't touch John's DEV box (`whombat-dev-box`) or the dev stack. The lead migrates and checks them.
- Delete what goes (SST-09) with its tests; don't leave dead code behind feature flags. Keep `@whombat/core` pure.
- Unit-test logic: the backfill's mapping, winner per name, history rebuild, delivery by version, use parsing, compat
  shapes. Check the facts a message carries (names, ids, a short key phrase), not long sentences.
- Visible words are plain and short (concise-replies.md). Record decisions you take under your number range in
  `docs/decisions/archive/skill-store.md` (Whombat), `docs/decisions/contracts.md` (contracts) or the app's
  `docs/decisions/skill-store.md`.
- When you finish, report: your branch tip, what is done, what isn't, and anything another stream must know.
