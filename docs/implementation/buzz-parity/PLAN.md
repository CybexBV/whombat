# Buzz-parity implementation plan

Six capabilities inspired by Buzz (github.com/block/buzz), built in Whombat's own architecture:

| id | capability | decisions file |
|---|---|---|
| A | Attachments and agent artifacts | `docs/decisions/bp-attachments.md` |
| B | Durable memory and context continuity | `docs/decisions/bp-memory.md` |
| C | Supervised automations | `docs/decisions/bp-automations.md` |
| D | Capability packs: instructions, skills, approved MCP tools | `docs/decisions/archive/bp-packs.md` |
| E | Generic ACP runtime adapter | `docs/decisions/bp-acp.md` |
| F | Packaged installation, upgrades, backup/restore, diagnostics | `docs/decisions/bp-distribution.md` |

Cross-cutting decisions made by the orchestrator: `docs/decisions/buzz-parity.md` (BP-xx).
Progress ledger: `STATUS.md` (only the orchestrator edits it).

## Refs inspected

- Whombat base: `main` at `73dc18950fc1b4ad05b9b3e4fd93a5643ffd34c2` (the historical comparison used 97db23cc; the
  current main is the base). Integration branch: `buzz-parity` (local only, never pushed by this work).
- Buzz: `block/buzz` at `99c2acf90` (Apache-2.0; the historical comparison used d01e5f82). Patterns are borrowed,
  no code is copied.

## Findings that shape the plan (investigations, 2026-09-24)

- **A**: `api.uploads.create` answers 501; the `attachments` table and `Message.attachments` exist but nothing stores
  bytes, no route serves files, mobile has no attachment code or picker modules; server body limit 1 MiB, JSON-only
  parser; same origin as the session cookie (stored-XSS risk for HTML/SVG); `text` is `min(1)` so attachment-only
  messages fail; guarded agents cannot read `WHOMBAT_HOME`. Claude SDK 0.3.278 accepts base64 image/document
  blocks; codex app-server 0.156.1 accepts `localImage`/`image` input items.
- **B**: every new chat dispatch starts a fresh provider session (session id lives on the dispatch); continuity is a
  20-message window; `job` (280 chars) is the only instruction field; usage is reported but dropped.
- **C**: nothing creates `schedule` dispatches; dispatch enqueue, approval re-evaluation and search indexing are
  in-memory post-commit hooks (lost on crash); no boot-time approval re-evaluation (a crashed `running` execution is
  stuck); no action hash binds an approval to its exact input; the signed `events` table is a durable, ordered
  trigger source; no inbound webhooks; `outboundRequest` is the SSRF-safe fetch.
- **D**: Claude is isolated from host settings (`settingSources: []`, hooks off, `skills: []`); Codex runs with a
  Whombat `CODEX_HOME` but may still read a repo `AGENTS.md`; Claude SDK has `skills`/`plugins`; Codex app-server
  has `skills/extraRoots/set` and `{type:'skill'}` input; Buzz's pack loader is parse-only (never wired).
- **E**: `@agentclientprotocol/sdk` 1.4.0 (`PROTOCOL_VERSION = 1`), `claude-agent-acp` 0.70.0 and `codex-acp` 1.6.2
  are on disk under `~/openclaw/node_modules`; `opencode acp` is on PATH. claude-agent-acp loads user/project
  settings unless overridden.
- **F**: server/runner/CLI run only through tsx (TS source, parameter properties); CLI resolves the checkout
  (`REPO_ROOT`), builds the web app at start (git stamp); embedded Postgres has no `pg_dump`; no `--version`; no
  migration lock (CLI and server both migrate).

## Dependency graph

```
foundation (lead): owned contract files, DispatchContext/TurnInput extension points, provider capabilities
  ├─ A attachments ───────────────┐
  ├─ B memory ────────────────────┤
  ├─ C automations (engine core) ─┼─► C golden-path template (needs A artifacts, B memory, D review pack)
  ├─ D packs ─────────────────────┤
  ├─ E ACP (needs A's TurnAttachment delivery, D's skills path for capability matrix)
  └─ F distribution (packaging early; final smoke on the integrated product; backup covers A/B/C/D state)
reviews: security reviewer + end-to-end reviewer (non-authors) on the integrated branch → fixes → re-review
```

Waves (at most three active workers): **1** A, B, C · **2** D, E, F · **3** independent security review,
end-to-end/golden-path review, fixes.

## Ownership rules

- Contract files: `packages/core/src/contracts/{attachments,memory,packs,automations}.ts` are owned by A, B, D, C.
  `DispatchContext` has `attachments`, `memory`, `packs` fields pointing at them (foundation).
- Persona hooks: `packages/agent-runtime/src/persona/{attachments,memory,packs}.ts` owned by A, B, D.
- Provider contract: `TurnInput.attachments` (A), `TurnInput.skills` (D), `ProviderCapabilities` (lead; A/D/E flip
  their flags in the adapters they own). Claude/Codex adapters: A owns content-block/input-item changes; D adds
  skills delivery in separate functions; E owns `packages/agent-runtime/src/acp/`.
- Registries (`contracts/index.ts` `api`, `routes/index.ts`, `commands/index.ts`, web router, settings tabs, mobile
  navigator, MCP tool lists): one-line additive edits only; the orchestrator resolves conflicts.
- Migrations: workers add Drizzle schema in their own schema file and generate a migration locally to test. On
  merge the orchestrator deletes worker-generated migration files and regenerates one migration per workstream in
  merge order with `drizzle-kit generate --name bp_<ws>`; hand-written SQL (triggers, data fixes) is kept in a
  clearly marked block the orchestrator re-appends.
- Lockfile: workers may add dependencies (listed in the handoff); the orchestrator regenerates `pnpm-lock.yaml` with
  `pnpm install` on merge, never hand-merges it.
- `docs/implementation/buzz-parity/STATUS.md` and `docs/design-handoff/TODO.md`: orchestrator only.

## Isolation per worker

Each worker runs in its own git worktree on its own branch based on a recorded integration commit, uses its own
ports, `WHOMBAT_HOME` and throwaway databases (`useTestDb()`), and never touches shared containers, systemd units,
`~/.whombat`, `~/Services` or the main checkout.

| ws | branch | PORT / WEB_PORT | WHOMBAT_HOME |
|---|---|---|---|
| A | `bp/attachments` | 4511 / 5291 | `~/.cache/wb-tmp/bp-a/home` |
| B | `bp/memory` | 4521 / 5292 | `~/.cache/wb-tmp/bp-b/home` |
| C | `bp/automations` | 4531 / 5293 | `~/.cache/wb-tmp/bp-c/home` |
| D | `bp/packs` | 4541 / 5294 | `~/.cache/wb-tmp/bp-d/home` |
| E | `bp/acp` | 4551 / 5295 | `~/.cache/wb-tmp/bp-e/home` |
| F | `bp/distribution` | 4561 / 5296 (pg 55561) | `~/.cache/wb-tmp/bp-f/home` |

## Acceptance matrix

Each capability is accepted only with: entry point, backend, persistence, permissions, web surface, Android surface,
failure behavior, tests and evidence recorded in `STATUS.md`. The acceptance scenarios are the ones in the
assignment (sections 5–10) plus the integrated golden path (section 12); they are listed per workstream in each
worker brief and checked by the reviewers.
