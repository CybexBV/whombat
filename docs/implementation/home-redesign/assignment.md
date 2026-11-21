# Home redesign: assignment (2026-10-18)

Spec: `docs/decisions/home-redesign.md` (HR-01…HR-24). Mock: whombat-app
`docs/design-handoff/home-redesign/proposed.html` (order and content; draw with the existing Home cards' tokens).

## Branches and worktrees

| Repo | Integration branch | Worktree |
|---|---|---|
| whombat-contracts | `home` | `~/Code/.wt/contracts-home` |
| Whombat | `home` | `~/Code/.wt/whombat-home` |
| whombat-app | `home` | `~/Code/.wt/app-home` |

Streams branch off their repo's `home` into their own worktree and never commit on `home` themselves (the lead merges),
except stream C, which commits the contracts vendoring on Whombat `home` and app `home`.

| Stream | Repo | Branch / worktree | Owns |
|---|---|---|---|
| C | contracts (+ vendoring) | `home-contracts` / `~/Code/.wt/contracts-home-c` | CT-400…CT-404, release 0.91.0 |
| S | Whombat | `home-done` / `~/Code/.wt/whombat-home-done` | HR-01…HR-08, migration 0111 |
| H | Whombat | `home-overview` / `~/Code/.wt/whombat-home-overview` | HR-21 and HR-23 server side (`chats`, `usedAt`) |
| W | whombat-app | `home-web` / `~/Code/.wt/app-home-web` | `packages/client` + web, AP-2206…AP-2249 |
| M | whombat-app | `home-mobile` / `~/Code/.wt/app-home-mobile` | Android, AP-2250…AP-2299 |

Reserved: contracts 0.91.0, CT-400…CT-409; app 0.88.0; migration 0111; candidate 0.99.0 / IN-287 / rc.117 /
pve-20261018.11.

## Contract shapes (0.91.0)

- CT-400 Home Assistant `request.readPaths`: `POST ^/api/template$`, `POST ^/api/config/core/check_config$`; plus any
  other entry whose guide tells agents to read through a POST.
- CT-401 `ConnectionCallInput.change`: optional string, trimmed, 1–160.
- CT-402 MCP tool `report_change` (every agent): input `title` (1–160), `detail?` (≤300), `thing?` (≤220: a thing id
  like `server:pve-02` or `connection:con_…`, or a connection handle), `undo?` (≤1000, private), `undoes?` (a change
  id); output `ok` with `changeId`, or a refusal.
- CT-403 `HomeChat` `{ conversationId, title (1–160), state: 'working' | 'waiting' | 'recent', at, progress?: { done,
  total }, step? (≤160) }`; `HomeOverview.chats?: HomeChat[]` (≤8, optional for older servers).
- CT-404 `ThingSummary.usedAt?: Timestamp` (the last call that worked).

Until 0.91.0 is on your repo's `home` branch, code against these shapes; the lead messages you when to `git merge home`.

## Rules for every stream

- Read the repo's `CLAUDE.md`/`AGENTS.md`, `ARCHITECTURE.md`, `DECISIONS.md` first. Copy is plain English, curly quotes
  (’ “ ”), `·`; tokens only. Agents and automations talk like people.
- DEV is fast: one quick check per repo at the end (`TMPDIR=~/.cache/wb-tmp pnpm check`; `pnpm test:server` once when
  server code changed). No VM tests, no `harness/validate`, no repeated suites, no waiting on GitHub Actions.
- Never sleep-wait for data or another stream; if blocked, say so to the lead (SendMessage `main`) and do other work.
- Free ports and your own throwaway databases; never stop or reset shared containers.
- Commits small and imperative, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Do
  not push, do not merge into `main` or `home`.
- Record decisions you make in the repo's `docs/decisions/home-redesign.md` (Whombat: HR-3x for S, HR-4x for H; app:
  your AP range).
- Finish with a short report: branch, last commit, what is done, what isn't, which checks ran.
