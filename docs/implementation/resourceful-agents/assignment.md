# Resourceful agents (2026-10-03)

John asked, in the main checkout, to make the agents as resourceful as Hermes Agent and to “implement fully”, with
Opus 5.5. The spec is `docs/decisions/resourceful-agents.md` (**RA-01…RA-62**) — read it first, then the decision files
it amends (`agent-computer.md` AC-*, `goal-first.md` GF-*, `bp-memory.md` BP-B*, `skills-library.md` SL-*,
`runs-approvals.md` MD-*, `role-consolidation.md` RO-*). Background: `~/.cache/wb-tmp/research/2026-10-03-resourceful-agents/write-up.md`.
Decide open details yourself, record each in `docs/decisions/resourceful-agents.md` under “Implementation decisions” as
**RA-D<stream><nn>** (C contracts, S server, R runtime, K computer, A app, N appliance, P packs), and move on. Don't ask John.

## Rules for every stream

- **DEV is fast** (IN-132): each repo's quick check only — `TMPDIR=~/.cache/wb-tmp pnpm check`, plus `pnpm test:server`
  **once** when server code changed (re-run only the files that failed). No `harness/validate`, no `release/ship
  validate`, no VM test suites, no waiting on GitHub Actions. Unit-test logic you add (pure functions, reducers, the
  memory ops, schedules, the command helper, the prompt by snapshot).
- **Others are working on this machine.** Use your own worktree (below), throwaway databases and free ports. Never stop or
  reset shared containers, never `docker compose down -v`. Never touch Incus instances, networks or ACLs you didn't
  create: `whombat-dev-box` (the DEV box), `whombat-prod-box` (production!) and `dashboard` are off limits; real-Incus
  tests may create and must remove `wbc-test-*` only. Never deploy anything to production.
- **Commits**: small, imperative, on your branch; every message ends with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never push, rebase shared branches or merge into
  `main` — the lead does (the contracts release is the one exception, below). Commit `pnpm-lock.yaml` with the change
  that caused it.
- **Visuals**: the mocks win; new screens use `@whombat/tokens` only; check light and dark at 1440×900.
- When you finish: your branch committed and clean, `pnpm check` green, and a short report: what you built, the
  RA-D rows you added, anything left undone and why.

| Repo | Worktree / branch | Today | Target |
| --- | --- | --- | --- |
| `~/Code/whombat-contracts` | `~/Code/.wt/contracts-ra` / `resourceful-agents` | 0.43.0 (CT-245), `SESSION_API_LEVEL` 29 | **0.44.0** (CT-246+), level 30, features `agents.memory`, `agents.schedules`, `agents.risk_rows` |
| `~/Code/Whombat` | integration `~/Code/.wt/whombat-ra` / `resourceful-agents`; streams below | migration `0065_vault_task_passes` | `0066_resourceful_agents` |
| `~/Code/whombat-app` | `~/Code/.wt/app-ra` / `resourceful-agents` | 0.32.0 (AP-677) | **0.33.0** (AP-678+) |
| `~/Code/whombat-appliance` | `~/Code/.wt/appliance-ra` / `resourceful-agents` | candidate 0.38.4 (IN-184, NX-136) | candidate **0.39.0** (IN-185+, NX-137+) |

## Streams

1. **C — Contracts 0.44.0** (first; the critical path). Schemas, pure rules, copy and tests for:
   - Keys (RA-01…RA-06): the six risk rows (`KEY_TIER_ROWS`/a row table with label, keys, verb for “Always allow
     {Agent} to …”), `ALWAYS_ON_KEYS`, role defaults, `personalAgentMayHold` (+ web.browse, browser.use, tasks.create),
     `hireKeyOptions` (six rows), Configure's rows + “All keys”, a pure `alwaysOnUpgrade` the migration uses, ROLE_GUIDANCE
     without fences (RA-05), approval scope `agent` for risk-row actions with `scopeChoices` and copy.
   - Memory (RA-20…RA-26): profile and note entry types, budgets, `applyMemoryOps` (atomic, budget on the result,
     `memory_full` / `no_match` / `ambiguous_match`), a text scanner (reuse the pack scanner's secret and injection
     rules), the `memory` MCP tool, `DispatchContext.profile` / `.notes`, REST ops for the app (own profile: get, add,
     update, remove, learning switch; an agent's notes: list, update, remove), `propose_skill.source`, own-pack and
     skill-file limits, `search.mine`.
   - Schedules (RA-30): `AgentSchedule`, `when` union, limits, the `schedule` MCP tool, REST list/pause/resume/remove,
     the card in the room, `DispatchContext.schedule`.
   - Triggers `reflect` (RA-24) and `notify` (RA-31) with their `DispatchContext` parts.
   - Computer (RA-41…RA-44): burrow setting `agentsReachLan` (+ setter), `DispatchContext.computer.lan`, the
     `AgentComputer` view's `published` ports and `keepAwakeUntil`, REST `computers.unpublish` and `computers.sleep`.
   - Skills from a link (RA-54): REST preview (fetch + scan result) and add.
   - Copy without “stop” (RA-12) in every tool description and copy constant named there.
   Release 0.44.0 as `docs/publishing.md` says (tag `contracts-v0.44.0`, `pnpm release`), merge into contracts `main` and
   push it with the tag; then write `docs/implementation/resourceful-agents/contracts-0.44.md` in the Whombat integration
   worktree (every new name, one line each) and vendor 0.44.0 into Whombat `resourceful-agents` and whombat-app
   `resourceful-agents` (as 0.43.0 is vendored), each repo's `pnpm check` green (fix compile breaks the bump causes with
   the smallest change, or leave a clear note for the stream that owns the code).
2. **P — Packs** (Whombat worktree `~/Code/.wt/whombat-ra-packs`, branch `ra-packs`; starts now): RA-50…RA-53 — the
   Hermes imports (MIT, from `~/.cache/wb-tmp/hermes-agent/skills` and `optional-skills`; attribution in each pack's
   `SOURCES.md`; tool names and paths rewritten for Whombat; scripts kept where they run on a computer), the new skills,
   the audit of “not available here” lines, the role mapping, within the pack validation and size rules the repo
   enforces (run its pack checks). Content quality matters: real commands, pitfalls and how to check the result.
3. **R — Runtime and prompt** (Whombat worktree `~/Code/.wt/whombat-ra-runtime`, branch `ra-runtime`; starts now, merges
   `resourceful-agents` when contracts 0.44.0 is vendored): RA-10…RA-16 (one live builder, How you work, no stop lines in
   the runtime, repository instructions as data, no `--max-turns`, wall 480, Agent/TodoWrite, skills-first line), and
   once 0.44.0 is in: the prompt parts for RA-20…RA-23 (profile, notes, what goes where), RA-24's reflect turn prompt,
   RA-30's scheduled-turn and RA-31's notify-turn lines, RA-33's brief line, RA-41's LAN line in the computer section.
   Files: `apps/runner/src/prompt.ts`, `packages/agent-runtime/src/persona/**`, `packages/agent-runtime/src/{claude,codex}/**`,
   `apps/runner/src/config.ts`. Not the computer files (stream K).
4. **K — Computer** (Whombat worktree `~/Code/.wt/whombat-ra-computer`, branch `ra-computer`; starts now, merges
   `resourceful-agents` when contracts 0.44.0 is vendored): RA-41 (computerd adds allow rules for the host's own IPv4
   networks — the subnets of its default-route interfaces, minus the host's addresses, refreshed every minute — when the
   policy says `lan: true`), RA-42 (the work folder as a lasting device of the instance), RA-43/RA-44 (Incus proxy devices
   `listen=tcp:0.0.0.0:<host port> connect=tcp:127.0.0.1:<port>` from `WHOMBAT_COMPUTERS_PUBLISH_PORTS`, default
   `20000-20099`, ≤5 per agent; keep-awake as instance config `user.whombat.keep-awake-until` with `boot.autostart`; the idle
   rule), RA-45 (when `WHOMBAT_COMPUTERS_MEMORY_MB` is unset: min(4096, ¼ of the host's memory)), RA-46 (base image 5),
   RA-47 (the `whombat` helper pushed before each turn like the gh stand-in; computerd listens on
   `/run/whombat-computerd/agents/<instance>.sock` per agent, proxied into the computer at `/run/whombat/agent.sock` with
   a `bind=instance` proxy device; `WHOMBAT_TURN=<dispatch id>` in every command's environment; computerd ops `publish`,
   `unpublish`, `keepAwake`, `sleep` and an `events` long poll), and the server side: `apps/server/src/computers/**` —
   the policy's `lan` from the burrow setting, the view's published ports and keep-awake, `computers.unpublish` /
   `computers.sleep`, and the consumer of computerd's events that queues `notify` dispatches (RA-31). Files:
   `apps/computerd/**`, `packages/computer/**`, `apps/runner/src/computer*.ts`, `apps/server/src/computers/**`,
   `apps/server/src/computer/**`.
5. **S — Server** (Whombat worktree `~/Code/.wt/whombat-ra-server`, branch `ra-server`; after contracts 0.44.0 is
   vendored): migration `0066_resourceful_agents` (profiles, notes, schedules, the keys upgrade RA-03, search vectors
   RA-26), the `memory` tool and REST ops, profile/notes into `DispatchContext`, `propose_instruction` unlisted,
   `schedule` tool + ticker + REST + room card, reflection dispatches (RA-24), quota re-queue (RA-32), personal agents'
   `delegate`/`report_back` (RA-33), approvals scope `agent` (RA-06), role defaults on hire, the `agentsReachLan` burrow
   setting and `DispatchContext.computer.lan` (stream K turns it into computerd's policy), skills from a link (RA-54),
   SL-D40 dropped for own packs and the new skill limits (RA-25). `pnpm test:server` once.
6. **A — App** (whombat-app worktree `~/Code/.wt/app-ra`, branch `resourceful-agents`; after contracts 0.44.0 is
   vendored there): hire modal with the six rows; Configure → Access six rows + collapsed **All keys**; **Always allow**
   on risk-row cards (web and Android); **What your agents know about you** (entries, stated/inferred, edit, remove, add,
   the learning switch); the agent page's **Notes** and **Schedules** tabs; the schedule card in rooms with Cancel; the
   Computer panel's published ports (Stop) and keep-awake (Let it sleep); burrow setting **Agents may reach this
   network**; Skills tab **Add from a link** (preview with the scan, Add). Release 0.33.0 the way 0.32.0 was and vendor it
   into Whombat `resourceful-agents`.
7. **N — Appliance** (the appliance's worktree `~/Code/.wt/appliance-ra`, branch `resourceful-agents`; starts now):
   RA-41's forward rule for the computers' bridge to the appliance's own IPv4 networks (an nftables set kept up to date
   by a small root unit when the uplink's address changes), RA-43's inbound rule (tcp 20000–20099 from private sources only, to the proxy devices),
   RA-45's memory setting by RAM (`WHOMBAT_COMPUTERS_MEMORY_MB` = min(4096, total/4)), `WHOMBAT_COMPUTERS_PUBLISH_PORTS=20000-20099`,
   the directory `/run/whombat-computerd/agents` for computerd's per-agent sockets (stream K owns computerd), docs (`install.md`, runbooks). Then, when the lead
   says Whombat `main` has everything: candidate 0.39.0 (pins, flake, dev stack restarted) and `release/ship all
   <id>` to the DEV box (no `--validate`).
8. **Lead** (this session): merges every branch into Whombat `main`, `pnpm check` and `test:server`, pushes, restarts
   the dev instance, runs the live checks of RA-60 on the DEV box, and reports to John.
