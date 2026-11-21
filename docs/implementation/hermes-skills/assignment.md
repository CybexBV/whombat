# Hermes's skills only: the stream plan

Decisions: `docs/decisions/hermes-skills.md` (HSK-01…HSK-16, settled; details HSK-S01… added there as built). The lead
(the session in `~/Code/Whombat`) merges, releases and ships; streams write code in their own worktrees.

## Branches and worktrees

| Repo | Integration branch (lead only) | Streams |
| --- | --- | --- |
| Whombat | `hermes-skills`, `~/Code/.wt/whombat-hsk` | P `hsk-p` `~/Code/.wt/whombat-hsk-p`; R `hsk-r` `~/Code/.wt/whombat-hsk-r` |
| whombat-contracts | — (C lands on `main` at release) | C `hsk-c` `~/Code/.wt/contracts-hsk-c` |
| whombat-app | — (W lands on `main` at release) | W `hsk-w` `~/Code/.wt/app-hsk-w` |
| the appliance | — | the lead: the runtime package without `skills/` |

Markers in `~/.cache/wb-tmp/hsk/`: `C-READY` (the provisional contracts 2.0.0 tarballs' directory and commit), `P-READY`.

## Order

1. **C** (contracts 2.0.0) and **P** (the plugin's Hermes steps) in parallel.
2. **R** (runtime) once C and P are ready; **W** (app 2.0.0) once C is ready.
3. The lead: appliance runtime package without `skills/` → contracts 2.0.0 released (tag, byte-identical to the
   provisional) → app 2.0.0 released (tag, APK on DEV) → vendored into Whombat → `pnpm check` + `test:server` →
   `main` → `dev/candidate --minor` → Settings → Skills checked on Home (the list, a hub search, an install).

## Streams

- **C** — `@whombat/core` skills library and Hermes-home skills steps for HSK-02…HSK-10 (built-in, hub, shared and
  learned origins; Hermes's front-matter needs; hub search, preview with scan and policy, install, update; restore and
  compare of a built-in), the import operations, `skills.stage`, the `skill-archive` upload stream, the old hub search,
  Whombat's scanner and `whombat:` metadata removed; `SESSION_PROTOCOL` major 3; every package 2.0.0; CT-1400….
- **P** — `packages/hermes-whombat`: a `hermes` subcommand registered by the plugin that runs Hermes's own skills code
  on the shared directory (sync, diff, reset, hub search/inspect/install/uninstall/check/update over the three allowed
  sources, scan), pytest against Hermes v0.22.5. Its JSON interface written down in HSK-S rows.
- **R** — runner (`apps/runner/src/hermes-home/skills*.ts`), agent-runtime (`hermes/skills.ts`), server
  (`apps/server/src/skills/`), the release bundle and `skills/` removed, the first start on a box that still has
  Whombat's skills, backups, tests, ARCHITECTURE/DECISIONS rows.
- **W** — client skill library, web Settings → Skills tab and Add skills over Hermes's hub, the Agent tab without
  Skills, redirects, the phone, fixtures and tests; app version 2.0.0, not released.

## Rules for every stream

Node 24 (`export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH`), `TMPDIR=~/.cache/wb-tmp`,
`pnpm install --frozen-lockfile` in a new worktree. Search only inside your worktree and the paths your brief names
(never `/` or `$HOME`). DEV is fast: one `pnpm check` per repository at the end (and `pnpm test:server` once when server
code changed), no VM tests, no CI, no pushing, no merging outside your branch. Small imperative commits ending with the
repository's `Co-Authored-By` line. Postgres for tests: your own throwaway databases on :55432, never shared ones.
