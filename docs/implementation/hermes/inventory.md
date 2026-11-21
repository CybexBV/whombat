# Hermes steps 2 to 5: what goes, by repository and file

Collected 2026-10-23 (read-only sweeps of `main` after step 0) for `assignment.md`. Three parts: the runtime
(Whombat), contracts and app, and the appliance side (appliance, control, relay, the hosts service, website). Line
counts are rough (`wc -l`, tests included). Each step's streams start from their part here and check it against the
code before deleting.

## Whombat runtime: inventory for the Hermes rebuild (HE-01…HE-29)

Repo `~/Code/Whombat` @ 13138382 (2026-10-23). Read-only. Lines from `wc -l`, tests included unless split as
src/test. "goes" = deleted; "changes" = survives in a reduced or rewritten form; "stays" = untouched by the step.
Paths are relative to the repo; `ar/` = `packages/agent-runtime/src/`, `rn/` = `apps/runner/src/`, `sv/` = `apps/server/src/`.

### Step 2: the engine (HE-01, HE-03…HE-15). About 20.1k lines go (about 11k of them tests)

| path | lines | goes/changes | note |
|---|---|---|---|
| `ar/claude/` index, events, attachments, fast, skills (+ tests, `testing/`) | 5,519 | goes | ClaudeProvider (stream-json, `can_use_tool`, steering, fast mode, skill plugin). Includes scratch/search-confinement tests (472) |
| `ar/claude/cli.ts`, `protocol.ts`, `auth-status.ts` | 497 | stays | `usage/claude.ts`, `models/list.ts` and `providers/login/claude.ts` import them |
| `ar/codex/` index, events, attachments, skills (+ tests, testing) | 3,273 | goes | CodexProvider over `codex app-server` |
| `ar/codex/app-server.ts`, `json-rpc.ts`, `home.ts`, `protocol.ts` | 399 | stays | used by `usage/codex.ts`, `models/list.ts`, `providers/codex-home.ts`, `gateway-home.ts`, `codex-sessions.ts` |
| `ar/acp/config.ts`, `capabilities.ts`, `acp.test.ts` | 853 | goes | `acp-runtimes.json`, capability matrix, trusted-only rule |
| `ar/acp/provider.ts`, `events.ts`, `permissions.ts`, `stream.ts`, `errors.ts`, `testing/fake-agent.mjs` | 1,492 | changes | natural base for the Hermes ACP client (`session/request_permission`, `session/update`, cancel). The fake agent can become the fake Hermes |
| `ar/scripted/` (provider, storyline, assistant, mcp) | 949 | goes | needs a replacement test double first (see open questions) |
| `ar/persona/` access, browser, codex-tools, earlier-runs, memory, profile, reflect, repo, scratch, skill-listing, skills, vault (+ tests, snapshot) | 3,267 | goes | what Hermes owns, or what goes in step 3/4 |
| `ar/persona/` approvals, merge-deploy, gh, cards, plans, work, served-tools, computer, feedback, tracker (+ tests) | 1,990 | changes | rules about Whombat's own tools move into the MCP tool descriptions; `feedback.ts` (518) stays as the assessment task text |
| `ar/persona/` personal, connections, devices, desk, wakes, defuse, attachments, whombat (+ tests) | 635 | stays | HE-11's "who is asking, where, what is connected" |
| `ar/cache.ts` (+ test) | 83 | goes | prompt-cache rules of our providers |
| `ar/contract.ts`, `index.ts`, `attachments.ts`, `failures.ts` | 1,074 | changes | TurnInput/TurnEvent shrink to one provider, attachments via ACP prompt content |
| `ar/models/` | 1,543 | changes | CLIs' model lists, effort; HE-09 sets model and effort on the agent, written into Hermes config |
| `ar/testing/contexts.ts`, `fake-app-server.mjs`, `stub-mcp-server.ts` | 909 | changes | fixtures for the new provider |
| `rn/prompt.ts` | 842 | goes (about 760) | `buildSystemPrompt`, resume plans, prompt hash. Keep `REPLY_STYLE_LINES`, `WRITING_LINES`, `AUTOMATION_REPLY_LINE`, identity, where and now lines (about 80) |
| `rn/prompt-{capabilities,computer,stable,turns}.test.ts`, `prefix-stability`, `approvals-prompt`, `desk-prompt`, `guides` tests | 1,767 | goes | prompt snapshot tests |
| `rn/repo-instructions.ts` (+ test) | 268 | goes | Hermes reads `AGENTS.md`/context files itself |
| `rn/codex-cleanup.test.ts`, `codex-effort.test.ts`, `acp.test.ts` | 329 | goes | |
| `rn/turn/session.ts` | 213 | goes | session choice, fork, prompt hash (HE-18) |
| `rn/registry.ts` | 518 | changes | one Hermes provider; drop `WHOMBAT_AGENTS`, LIVE_PROVIDERS, ACP runtimes |
| `rn/steering.ts` (+ test) | 669 | changes | follow-ups become ACP prompts (or Hermes's `steer`); the server's offer/merge (`sv/runtime/steering.ts` 323) stays |
| `rn/activity.ts` (+ test) | 1,624 | changes | maps Hermes tool-call events plus our hook instead of the CLIs' events |
| `rn/attachments.ts`, `ran.ts`, `gateway.ts`, `feedback.ts`, `config.ts`, `index.ts`, `lib.ts` | 1,207 | changes | gateway moves to Hermes's own loop (HE-08); feedback refuses "trusted/ACP" today |
| `rn/turn/` input, prepare, preflight, attempts, credentials, model, finish, verdict, deps, shape | 1,283 | changes | phases stay, provider branches go |
| `rn/model-effort.test.ts` | 448 | changes | |
| `rn/clients.ts`, `signin*.ts`, `gh.ts`, `git-relay.ts`, `git-control.ts`, `computer*.ts`, `command-repeats.ts`, `turn/sandbox.ts`, `managed-setup.ts`, `generation.ts` | 3,389 | stays | pinned CLIs, sign-in executor, GitHub through Whombat, the computer, the managed sandbox |
| `rn/managed.ts`, `sv/managed/policy.ts` | 423 | changes | "refuse trusted/ACP/unsandboxed" becomes an invariant |
| `sv/runtime/acp.int.test.ts`, `acp-live.int.test.ts` | 599 | goes | |
| `sv/runtime/service.ts` (31 ACP refs), `context.ts`, `readiness.ts`, `sv/commands/agents.ts` (22), `sv/backups/restore/agents.ts` | 3,366 | changes | provider discovery (`host.agents`, ProviderCheck), ACP runtime id on the agent |
| `sv/demo/` director, toffee, routes, int test; `sv/scripts/demo.ts`; `WHOMBAT_DEMO*` in `sv/config.ts`, `sv/index.ts`, `.env.example` | 1,015 | goes | demo storyline (run #1907, Toffee's canvas). `sv/seed/test-world.ts` keeps `run_1907` rows as test data |
| `scripts/prompt-size/` | 1,076 | goes | measures the persona prompt |
| `docs/acp.md` | 108 | goes | |

**Stays:** `ar/providers/**` (8,081: sign-in console, device codes, credential homes, eligibility, drift, bundles),
`sv/managed/providers/**` (5,336), `ar/usage/**` (1,583), `ar/support/**`, `ar/access/managed/**` (4,172),
`sv/computer/**`, `sv/computers/**`, `apps/computerd` (7,076), `packages/computer` (1,636), `sv/github/agent-gh*.ts`,
`gh-plan.ts`, `sv/mcp/**` (fewer tools), `sv/gateway/**` (changes with HE-08).

**HE-13 "the computer always exists": today these run without one:**
- `sv/computer/config.ts` `computersOn()`: `WHOMBAT_COMPUTERS` defaults to `off` (dev stack, self-hosted, every test). `sv/computer/context.ts:109` `computerTurn()`
  also skips system principals, vaultless dispatches, search answers and Feedback assessments (AC-23).
- `rn/turn/shape.ts:49`: a computer turn needs `deps.computers && deps.managed && provider.kind !== 'scripted'`, so `pnpm dev` and all runner tests never get one.
- Without a computer, these paths do the work: `rn/workspace.ts` (668: workdir, owner's clone, worktree/direct, scratch, read-only export),
  `ar/access/index.ts` and `sandbox.ts` (guarded bubblewrap/Codex sandbox), `persona/scratch.ts`, `work.ts` ("with a computer or without").
- Development needs Incus (computerd) or a fake computerd in the dev stack. Unit tests have `rn/computer-fakes.ts` (154) and `sv/computer/testing.ts`.

**Open questions (step 2)**
1. 57 `sv/**/*.int.test.ts` files run the real runner with the scripted provider (`sv/test/runner.ts` `createRegistry('scripted')`).
   A fake Hermes is needed before `scripted/` can go (start from `ar/acp/testing/fake-agent.mjs`).
2. Feedback assessments: read-only and no network today (FB-21, persona `feedback.ts`). How does a Hermes turn on the computer stay read-only?
3. Who reads the model lists (`models/list.ts`) once Hermes owns the model config: Whombat (for Settings) or Hermes?
4. Reflection turns (`reflect` trigger) and search answers: where do they run once Hermes owns sessions and memory?

### Step 3: memory, skills, browser, Vault (HE-16…HE-21). About 30k lines go

| path | lines | goes/changes | note |
|---|---|---|---|
| `sv/memory/` commands, select, sessions, summaries, learning(+rules), reflect, store, service, retention, session-retire, sources, tools, context-copy (+ tests) | 7,172 | goes | instructions/knowledge/checkpoints, context assembly, `agent_sessions`, summaries worker, profiles/notes, reflection |
| `sv/memory/routes.ts` | 367 | changes | `api.memory.*` becomes show/edit/back up Hermes's memory (one profile per person, HE-16) |
| MCP `memory`, `remember`, `recall`, `save_checkpoint`, (`propose_instruction` unlisted) | in `sv/memory/tools.ts` 169 | goes | names live in `@whombat/core` (`MEMORY_MCP_TOOLS`): contracts change first |
| `DispatchContext.memory`/`.profile`/`.notes`/`.skills`/`.browser`/`.vault` built in `sv/runtime/context.ts` (843) | about 250 | changes | contract fields in whombat-contracts |
| `sv/db/schema/memory.ts`: `memory_items`, `memory_checkpoints`, `context_summaries`, `memory_jobs`, `agent_sessions`, `dispatch_memory`, `person_profiles`, `profile_entries`, `agent_notes`, `agent_reflections` | 310 | goes | new baseline (HE-27) |
| `rn/skills.ts` (+ test), `rn/turn/reflect.ts` | 956 | goes | per-turn skill materialization, reflect fork |
| `sv/skills/` store, rows, snapshot, files, uses, outcomes, curator, library, plan, write, write-tool, agent-tools, agent-install, learn, commands, needs-you, audience, read, tools, history, known-findings, dispatch, frames, routes (+ tests) | 7,474 | goes | the skill store, proposals, `find_skill`/`read_skill`/`skill_write`/`skill_result`/`propose_skill` |
| `sv/skills/` shipped, import, import-parse, archive, hub(+routes), links, library-view, library-routes, library-commands (+ tests, `testing/hub`) | 7,484 | changes | ship defaults into Hermes (HE-19); Settings → Skills reads and edits Hermes's skills dir |
| `sv/db/schema/skills.ts`: `skills`, `skill_versions`, `agent_skill_states`, `skill_proposals`, `skill_uses`, `skill_link_previews`, `skill_snapshots`, `skill_imports` | 315 | goes (most) | `$WHOMBAT_HOME/skills/<sha>` store too |
| `sv/managed/skills-stage.ts` | 203 | changes | archive upload over the session |
| `skills/` (19 categories, 120 `SKILL.md`, 414 files) | 59,685 | stays | shipped into Hermes; `whombat:` meta line may need a Hermes mapping |
| `sv/browser/` incl. `host/` (Playwright host, proxy, sessions, snapshot, signin), tools, supervisor, install, fake, test-sign-in (+ tests) | 10,052 | goes | `browser_*` tools, `browser.use` key, `whombat-browser` unit, `browser-host.mjs` in `scripts/package` |
| `sv/browser/previews.ts`, `publish.ts` | 151 | changes | `browser_preview`/`ssh_upload` screenshots into the conversation |
| `sv/feedback/browser.ts` | 87 | changes | the assessor's browser (assessor-browser) |
| `sv/vault/use.ts`, `pool.ts`, `passes.ts`, `request-key.ts`, `ssh-use.ts`, `ssh-turns.ts` | 1,813 | goes | `vault_request`, bridged `vt_*` tools, Ask passes, `request_vault_key`, server-side `ssh_exec`/`read`/`write` (relayed requests) |
| `sv/vault/use.int.test.ts`, `canary.int.test.ts`, about 400 of `ssh.int.test.ts` | about 1,500 | goes | the canary needs a rewrite for computer delivery |
| `sv/db/schema/vault.ts`: `vault_passes`, `vault_pass_requests`, `vault_tools`; `vault_keys.tier` (ask/can) and `delivery='whombat'` | about 120 | goes | `delivery='computer'` + `env_name` stay |
| `sv/vault/context.ts`, `check.ts`, `commands.ts`, `routes.ts` | 1,782 | changes | drop the Ask tier, bridged tools and allowlist; keep entries, on/off per person |
| `sv/vault/store`, `net`, `networks`, `scrub`, `withhold`, `detail`, `save`, `self-serve`, `add-server`, `rotate`, `ssh`, `ssh-keys`, `ssh-commands`, `ssh-check`, `ssh-signin`, `service`; `sv/computer/keys.ts` (304), `secrets.ts` (191) | 5,301 src | stays | "the key is on the computer only during its owner's turns" already exists (AC-30/31: `computer/keys.ts`, `rotate.ts`). `vault/net.ts` is the destination rule for connections, devices and things. `hosts/` uses `vault/ssh*` |
| `sv/mcp/tools.ts` (623), `served.ts` (509), `server.ts` (532) | 1,664 | changes | drop memory, skill, browser and relayed Vault tools; `client-pool.ts` stays (connections use it) |
| `docs/browser.md`, `docs/skills.md` | 216 | goes/changes | |

**Stays (approval paths, HE-17):** `sv/approvals/**` (1,833 src: engine, create, grant-key, push, wake), keys engine (core),
`sv/computer/commands.ts` (588) + `rn/computer-api.ts` (`authorizeCommand`/`authorizeWait`: Ask is a card),
`sv/hosts/asks.ts` (205, "Asks you first"), Merge/Deploy rows, `turn_failed`/Try again, `sv/runtime/stop.ts`.
`ar/acp/permissions.ts` is where Hermes's `session/request_permission` meets this policy.

**Session storage Hermes would own (HE-18):** `agent_sessions` and `sv/memory/sessions.ts` (674: resume rules, fingerprint with a `vault` part,
TE-01…TE-12 fork), `session-retire.ts`, `memory_checkpoints`, `context_summaries` + `memory_jobs`, `dispatch_memory`, `skill_snapshots`
(set frozen per session), `rn/turn/session.ts`, `ProgressBody.session`. Messages stay in Whombat (Chat UI, search, audit).

**Open questions (step 3)**
1. Chat messages are kept twice (Whombat for display, search and audit; Hermes for the model). What does a turn send: only the new message?
   What happens on edits, deletes and "Clear chats"?
2. Skill import (hubs, links, archives: about 3.5k src) on Whombat's side, or Hermes's own `skills` hub plus a Whombat scan (`validateSkill`)?
3. `browser_sign_in` with Vault logins, and the owner's "Test sign-in": no equivalent once Hermes's browser runs on the computer, unless the login is put there.
4. Backup (`.wbk`, `sv/backups/`) must include Hermes's per-person profiles and skills dir. Where do they live on the appliance?

### Step 4: one appliance shape (HE-22, HE-23, HE-27). About 23.4k lines go (incl. `scripts/deploy`)

| path | lines | goes/changes | note |
|---|---|---|---|
| `apps/cli/src/` init, start, service, supervisor, doctor, upgrade(+recovery), install, backup/restore, backup-file, pg, pidfile, process, lock, config-file, home, layout, instance, login-link, admin, browser, diagnostics, vapid, web, app-artifact, skills-python, recovery, … (+ tests) | about 11,500 | goes | the self-hosted `whombat` CLI (13,885 in total) |
| `apps/cli/src/release/` (tar, manifest, signature, keys), `schema.ts` (+ tests), `bin`, `main` (reduced), `log`, `errors` | about 2,400 | stays | `scripts/package` imports `@whombat/cli/release`. The appliance's runtime bundle runs `bin/whombat schema-check` and `migrate` |
| `scripts/package/src/acceptance.ts`, `acceptance-lib.ts`, `smoke.ts`, `launcher.ts`, `widget.ts` | 1,709 | goes | self-hosted release archive, end-to-end install |
| `scripts/package/src/build.ts`, `sign.ts`, `npm.ts`, `notices.ts`, `package.test.ts` | 1,027 | changes | keep `--runtime` (MR-37); drop web/widget, launcher, `--with-claude` |
| `scripts/deploy/` (deploy, install, backup, restore, systemd units, compose) | 630 | goes? | app.whombat.com as a self-hosted server (paused); see Q1 |
| `ar/access/index.ts`, `sandbox.ts`, `access.test.ts`, `scratch-reads.test.ts` | 1,142 | goes | guarded/trusted, bubblewrap/Codex sandbox checks |
| `ar/host.ts` (+ test) | 411 | changes | `WHOMBAT_HOME`, `WHOMBAT_WORKDIR_ROOTS`, `resolveWorkdir` |
| `ar/workspace/clones.ts`, workdir/direct parts of `index.ts` (1,729; 49 `direct` refs), `local-clone.test.ts` | about 700 | goes | the owner's clone and direct mode. The mirror worktree and `local-origin.ts` stay |
| `rn/workspace.ts` (about 350 of 668), `scratch.test.ts`, `run-checkout.test.ts`, `turn/access.ts` | about 1,130 | goes | workdir roots, scratch folders, guarded/trusted access |
| `sv/commands/burrows.ts`/`agents.ts` workdir, checkout, access keys; `burrow-workdir.int.test.ts`, `agent-runtime.int.test.ts`, `access-live.int.test.ts` | about 650 | goes | signed `Keys` events for workdir and access |
| `sv/github/gh.ts` | 1,129 | changes | only the `gh auth token` host credential goes. `ManagedGitHub` (`managed/providers/github-adapter.ts`) wraps `GhCliGitHub` as its REST client |
| `sv/clients/local-installer.ts` (+ test) | 1,782 | goes | self-hosted Claude/Codex installer. `clients/service.ts` keeps the manager path |
| `sv/auth/host.ts`, `host.int.test.ts`, `selfhost.int.test.ts`; `sv/scripts/` bootstrap, login-link, host-lib | 894 | goes | host-shell sign-in, first owner |
| `sv/auth/tailscale.ts` (+ test), `WHOMBAT_AUTH_TAILSCALE`/`TAILSCALE_PORT` in `config.ts`, `app.ts` | 244+ | goes | Tailscale identity on plain HTTP. HE-23 needs Noise over Tailscale instead |
| `sv/auth/service.ts` (magic link and code), `routes/auth.ts`, `auth/request.ts` (cookie, CSRF), `auth/policy.ts`, `auth/admins.ts` | 1,277 | changes | the cookie/bearer client path goes. `auth/service` is imported by about 50 files (helpers stay) |
| `sv/web/static.ts` (+ test), `realtime/ws.ts`, `collab/routes.ts` (/collab ws), `realtime.int`/`ws-logging` tests | 787 | goes | web served by the runtime, `/ws`, `/collab`. `realtime/hub.ts` and `personalize.ts` also feed the session event log |
| `sv/managed/legacy-import.ts` (+ test), `sv/scripts/legacy-import.ts` | 321 | goes | dry-run import from a self-hosted install |
| `sv/production.int.test.ts`, `scripts/smoke-production.ts`, `smoke-lib.ts` | 426 | goes | |
| `WHOMBAT_MODE` / `isManaged()` branches | 89 sites in 44 files | changes | e.g. `config.ts` (20), `managed/providers/service.ts` (14), `db/startup.ts` (9), `mail/digest.ts` (7), `connections/redirect.ts` (OAuth browser callback) |
| `vendor/whombat-contracts/previous/` (protocol 0.20.3 tgz), `@whombat/protocol-previous` in `package.json`/lockfile, `contracts:verify` | small | goes | |
| `sv/managed/skew.int.test.ts`, previous-client helpers in `sv/managed/testing.ts` | about 150 | goes | |
| older-client branches: `mcp/served.ts` (`propose_instruction`, `propose_skill` unlisted), `skills/tools.ts` (77), `library-commands.ts` (ignored `pack`), `desk/ops.ts` (older apps' Unpair), "older clients strip it" (`session/connection.ts`) | about 200 | goes | `Principal.system` closed-enum notes (`trackers/principal.ts`, `hosts/principal.ts`) are data shape, not branches |
| `sv/db/compat.ts` (525), `migrate.ts`, `compat.json`, `backfills.ts` | 1,000+ | stays? | schema rollback classes for appliance updates (MD-01…MD-12), not client compatibility. See Q3 |
| `sv/managed/runtime-features.ts` (334), client floor (`trust.ts`, `client-floor.int.test.ts`) | 419 | stays | API level and features; the client security floor |
| `docs/install.md` 360, `upgrade.md` 112, `backup.md` 144, `troubleshooting.md` 119, `deploy.md` 286, host-gh parts of `github.md` (203) | about 1,120 | goes | ARCHITECTURE "Self-hosted install", "Production: our instance" |

**Client connection paths in the server today:**
- **Relay**: `sv/managed/boot.ts` → `session/relay-client.ts` (398), `endpoint.ts`, `connection.ts` (871), `secure.ts`, `streams.ts`,
  `dispatcher.ts` (1,028), `trust.ts` (1,729). Noise XX over the relay only. This stays.
- **Plain HTTP** (self-hosted, app.whombat.com via Cloudflare Tunnel, whombat-dev :4420): REST `routes/**` with cookie/bearer
  (`auth/request.ts`), `/ws`, `/collab`, `web/static.ts`. This goes as a client path. The REST handlers stay because the dispatcher calls them in-process.
- **Tailscale**: a second plain-HTTP listener with Tailscale identity (`auth/tailscale.ts`, `viaTailscaleListener`). It goes.
- **LAN**: none. `WHOMBAT_LOCAL_NETWORK` governs outbound reach, not clients. `desk/socket.ts` is the box screen's unix socket.
  HE-23 needs a **new** direct Noise listener (Tailscale/LAN) beside the relay. Nothing exists for it yet.

**Open questions (step 4)**
1. What serves app.whombat.com and whombat-dev (both self-hosted-mode servers today) once self-hosted mode goes? Hosted UI only?
2. whombat-app's dev server and e2e/visual tests talk to the runtime over HTTP (`WHOMBAT_SERVE_WEB`, `/api/v1`, `/ws`).
   Do they move to the session protocol, or does a dev-only HTTP path stay?
3. Does `db/compat.ts` (expand/contract/backfill floors) count as "compatibility code" under HE-27, or does it stay for appliance rollbacks?
4. Direct push (`push/apns.ts`, `fcm.ts`, `webpush.ts`, 417) and SMTP mail (`mail/digest.ts` 359) are self-hosted only.
   The community edition has no control: how does it push and send email?
5. `pnpm dev` defaults: `WHOMBAT_MODE=selfhosted`, FakeGitHub, open sign-up. The dev stack needs a managed-mode boot (manager socket, licence, content key) or a dev mode of it.

### Step 0 leftovers: crew names

Pattern `Banjo|Waffle|Pippa|Ace|Skipper|Hazel|Toffee|Neo` (capitalised), `prn_<crew>` and `@<crew>`. Lowercase
`banjo`/`neo`/`skipper`/`hazel` are face ids (OA-S07, `sv/commands/burrows.ts:404`) and stay. Dusty is the default name and stays.

| where | lines | files | note |
|---|---|---|---|
| code, tests/fixtures | 168 | 54 | top: `ar/testing/contexts.ts` 17, `sv/managed/console-burrows.test.ts` 13, `rn/prompt-turns.test.ts` 11, `sv/mcp/rate-limit.test.ts` 8, `ar/workspace/workspace.test.ts` 7, `sv/desk/glance.test.ts` 7, `sv/keys/custody.test.ts` 6, `ar/persona/vault.test.ts` 6 |
| code, non-test | 82 | 47 | `sv/demo/toffee.ts` 13 and `director.ts` 3, `ar/scripted/storyline.ts` 8 and `provider.ts` 1 (all go in step 2). Comment examples: `sv/mcp/tools.ts` 3, `scripts/prompt-size/src/turns.ts` 4, `sv/github/gh-plan.ts` 2, `sv/trackers/reply.ts` 2, `sv/skills/library.ts` 2 ("Learned by Neo"), `sv/guides/commands.ts` 2 ("Ask Hazel"), `sv/domain/{push-preview,messages,live-activity}.ts` 2 each, `sv/commands/{approvals,run-recovery}.ts` 2 each, `sv/collab/{service,commands}.ts` ("Toffee is writing"), 3 skills (`skills/servers/cloudflare-dns-tunnels/SKILL.md`, `homelab/unifi-opnsense/references/opnsense.md`, `productivity/about-this-person/references/entry-examples.md`), plus about 25 one-line comments |
| live docs | 19 | 8 | `docs/automations.md` 7, `docs/github.md` 3, `ARCHITECTURE.md` 2, `DECISIONS.md` 2, `docs/delegation.md` 2 (the whole 62-line file describes handoffs, gone in step 0), `README.md` 1 (`demo:play` row), `docs/feedback.md` 1, `.env.example` 1 |
| history (`docs/decisions`, `docs/implementation`, `docs/design-handoff`) | 561 | 110 | records and the design spec. Keep (CLAUDE.md: don't delete design-handoff) |

**Open question:** does `README.md`'s "Banjo's run → Hazel approves → Neo deploys", plus `demo:play`/`demo:reset`, go with the storyline in step 2?

## Hermes rebuild: inventory of whombat-contracts and whombat-app (2026-10-23)

Read-only. Contracts at 0.123.0 (`SESSION_API_LEVEL` 46), app vendors contracts 0.123.0. Line counts are `wc -l`, without
tests unless a test file is named. `C/` = `whombat-contracts/packages/`, `A/` = `whombat-app/`. Neither repo has a
CLAUDE.md; READMEs read. Context: Whombat `docs/decisions/hermes-engine.md` HE-01…HE-29.

### Step 2: engine (HE-01, HE-04…HE-11)

#### Contracts

| path | lines | goes/changes | note |
|---|---|---|---|
| `C/core/src/domain/acp.ts` (+ `acp.test.ts`) | 103 | goes | `AcpRuntimeDefinition`, `AcpRuntimesFile`, `ACP_FORBIDDEN_ENV`, `AcpTrust`, `AcpNegotiated` (capability handshake) |
| `C/core/src/domain/agent.ts` | 318 | changes | `AgentProvider = claude\|codex\|acp\|scripted` → claude\|codex (+ whatever HE-08 extras need); `AgentModelRuntime.acpRuntime`; `DEFAULT_AGENT_RUNTIME.provider: 'scripted'`. model/effort/fast and `CredentialSource` stay |
| `C/core/src/domain/providers.ts` | 210 | changes | goes: `ProviderCapabilities` (matrix: images, documents, sessionResume, skills, cancel, usage, guardedConfinement), `AgentsMode` (`WHOMBAT_AGENTS` live/scripted), `AcpRuntimeCheck`, `MAX_ACP_RUNTIMES`, `SandboxCheck`, `RunnerStatus.acp/.sandbox`, `acpRuntimeOf`, acp branch of `providerRunnable`. Stays: `ProviderCheck`, `ProviderSetup`, `AgentSetupStatus` (sign-in state) |
| `C/core/src/contracts/runner.ts` | 1550 | changes (largest) | goes: `AgentPersona` (name/handle/doing/keys can-ask-cannot/fingerprint for our prompt builder), `PromptHash`, `resumePromptHash`, `ForkFromSession`, `EarlierRun*`, `SESSION_PROMPT_CHANGED`, `TurnInjection`/`TURN_INJECT_MAX`/`ProgressBody.injected`/`ProgressResponse.inject` (says “Claude Code stream-JSON; Codex's steer call”), and `DispatchContext` parts Hermes owns (`memory`, `skills`, `skillHint`, `notes`, `profile`, `reflect`, `browser`, `window`/`thread` history once Hermes keeps sessions). Stays: `SIGNIN_METHODS`, `ConsoleSignInEvent`, `DeviceSignInDone`, `CredentialMeta`, `signInEndpoints`, `DispatchCredential` (HE-09), `Gh*`/`Authorize*` (HE-14), `Computer*` |
| `C/core/src/text/copy.ts` L327–352 | ~30 | goes | ACP “can’t run guarded”, runtime-not-ready copy, matrix labels |
| `C/core/src/domain/activity.ts` | 507 | changes | `ACTIVITY_NO_TELEMETRY` (“provider doesn’t report its steps”, for scripted/ACP); rows come from the Hermes hook (HE-17) |
| `C/core/src/text/turns.ts` | 108 | maybe | `TURN_MERGED_REASON` (steering) stays only if Hermes steer/follow-up is kept (HE-01, HE-28) |
| `C/core/src/domain/chat-runtime.ts` + `text/chat-runtime.ts` | 155+159 | changes (open) | per-thread provider/model/effort/fast (`ChatThread.runtime`); HE-09 puts model/effort on the agent. `RanOn` stays |
| `C/core/src/backup/records.ts` L266 | 1 | changes | agent record `acpRuntime` |
| `C/protocol/src/session/errors.ts` L301 | 1 | goes | `managed.acp_runtimes` |
| `C/fixtures/src/*` | — | changes | scripted/ACP agent in fixture world |

#### App

| path | lines | goes/changes | note |
|---|---|---|---|
| `A/apps/web/src/features/agent/AiProviderPanel.tsx` (+css 98) | 347 | changes | `CapabilityMatrix`, `AcpRuntimeRow` (“acp-runtimes.json … run whombat doctor”), scripted notice (“WHOMBAT_AGENTS=scripted”). Provider rows/sign-in state stay |
| `A/apps/web/src/features/agent/ProviderPicker.tsx` (+css 43) | 159 | changes | “ACP runtime” option + runtime row + “runs only trusted” text go; Claude Code/Codex picker stays |
| `A/apps/web/src/features/agent/acp.test.tsx` | 176 | goes | |
| `A/apps/web/src/features/agent/settings/ModelTab.tsx` + `model.ts` | 229+60 | changes | `acpRuntime` in draft; model/effort stay |
| `A/apps/web/src/features/ai/AiAccountsTab.tsx`, `aiSummary.ts`, `YourAi.tsx` | 259+172+345 | changes | `ScriptedRow`, ACP rows, “doesn’t start” summary |
| `A/apps/web/src/features/feedback/settingsForm.ts` L413 | 1 | goes | “ACP agents can’t be kept read-only” |
| `A/apps/web/src/app/modelFixtures.ts`, `A/apps/mobile/src/fixtures/assistant.ts` | 269, 1783 | changes | ACP/scripted fixture data |
| `A/apps/mobile/src/data/runsOn.ts` + `screens/RunsOnSection.tsx` | 230+248 | changes | ACP runtimes for owner-admins; model/effort part stays |
| `A/packages/client/src/modelEffort.ts` | 268 | changes | drop acp branches; stays otherwise |
| Per-thread picker: web `features/chats/runtime/*` (548), client `chat/runtime.ts` (505), `react/chatRuntime.ts` (101), mobile `ChatRuntimeSheet.tsx` (595), `ui/chatRuntime.tsx` (214), `data/chatRuntime.ts` (60) | ~2,020 | open | goes or shrinks to provider-only if HE-09 means “agent only” |

**Stays:** sign-in UI — web `features/ai/{ClaudeSignIn 441, SignIn 364, DeviceCode 198, terminal 194, Steps, AiSetup, ClientRow, GitHubSignIn}`, client `signins/*` (~1,010), mobile `managed/AiProviders.tsx`, `ModelEffortSheet.tsx`; contracts `contracts/providers.ts` (250), `domain/signins.ts` (203), `protocol/session/providers.ts` (148), `domain/models.ts` (182), `text/models.ts` (92), `domain/gateway.ts` + `text/gateway.ts` (448; Fusebox for HE-08).

**Rough total:** contracts ~135 lines gone, ~2,900 touched (runner.ts most); app ~180 gone, ~2,600 touched, ~2,000 open.

### Step 3: memory, skills, browser, Vault (HE-16…HE-21)

#### Contracts

| path | lines | goes/changes | note |
|---|---|---|---|
| `C/core/src/domain/memory.ts` | 925 | mostly goes | `MemoryKind` instruction/knowledge, `MemoryScope`, `MemoryItem`, `Checkpoint`, `ContextSummary`, `planContext`, `extractiveSummary`, `CONTEXT_BUDGET_CHARS`, `stablePromptHash`/`sessionPartHashes`/`sessionFingerprint`. Profile/notes (`PROFILE_BUDGET` 2000, `NOTES_BUDGET` 4000, entries) map onto Hermes `USER.md`/`MEMORY.md` and may survive as view/edit shapes |
| `C/core/src/contracts/memory.ts` | 615 | changes | endpoints `memory.list/get/create/decide/revise/remove/checkpoints/context/setLearning` go; `memory.profile`/`notes` (+add/update/remove) → per-person Hermes memory view/edit; tools `remember`, `propose_instruction`, `recall`, `save_checkpoint`, `memory` go |
| `C/core/src/contracts/skills.ts` | 172 | goes | proposals (`skills.proposals/proposal/decide/removeLearned/previewLink/addLink/uses`) |
| `C/core/src/contracts/skills-library.ts` | 501 | changes | library list/view/edit/pin/rest/reset/restore/switch → Hermes skills dir; `importPreview/importCommit/hubSearch` open (Hermes has its own hub/install) |
| `C/core/src/contracts/skills-runner.ts`, `mcp-skills.ts` | 131+298 | goes | `SkillContext`, `read_skill`/`find_skill`/`skill_write` tools |
| `C/core/src/domain/skills.ts` | 432 | changes | proposal limits (`SKILL_PROPOSALS_PENDING_MAX`, 32 KB `SKILL_BODY_MAX_BYTES`), `SkillHint` go; `SKILL_LIMITS` (128 KiB body, 64 files/2 MiB, 256 KB file) re-checked against Hermes |
| `C/core/src/skills/*` | 2,419 | changes | `scan.ts` 1237 (injection/exfiltration scanner: keep for imports?), `library.ts` 258 (`FOREIGN_SKILL_TOOLS` maps Hermes tools → ours: inverts or goes), `files.ts` 363, `meta.ts` 233, `readiness.ts` 61, `secrets.ts` 109, `skill.ts` 158 |
| `C/core/src/packs/*`, `contracts/packs-legacy.ts` | 71 | goes | pre-0.113 names (also step 4) |
| `C/protocol/src/session/skills-stage.ts` | 56 | open | staged archive upload (exists because a CONTROL message caps at 64 KiB, ≈48 KiB base64) |
| `C/core/src/browser/*`, `contracts/mcp-browser.ts` | 432+386 | goes | browser status/destination/limits/names, `browser_*` tools (HE-20); `BrowserContextInfo` in `runner.ts` |
| `C/core/src/contracts/vault.ts` | 730 | changes | `tier` (`asks_owner`), `vault_pass` turn, `delivery`, `setKeyDelivery`; “every pass it holds … ends” |
| `C/core/src/vault/schemas.ts` | 709 | changes | `VAULT_KEY_TIERS` ask/can + labels, `VaultKeyDelivery` whombat/computer (→ computer only), `VaultPackUse`, request/response size caps |
| `C/core/src/vault/request.ts`, `vault/decide.ts` | 424+108 | goes / changes | brokered `vault_request` (headers, scrub, failures); `decideVaultUse` |
| `C/core/src/vault/tools.ts`, `contracts/mcp-vault.ts` | 166+546 | changes | `vault_request`, `request_vault_key`, bridged `vt_*` go; `vault_save`, `vault_add_server`, `ssh_*` open (Whombat tools or keys on the computer) |
| `C/core/src/vault/copy.ts` | 841 | changes | Ask/pass/relay wording |
| `C/core/src/ids.ts` | 2 | goes | `VaultPassId` (`vlp`), `VaultPassRequestId` (`vlq`) |
| `C/core/src/domain/dispatch.ts` | 239 | changes | trigger `vault_pass`; `REFLECT_*`/`ReflectReason` (learning: Hermes's job) |
| `C/core/src/domain/approval.ts`, `approvals/*`, `keys/actions.ts`, `domain/desk.ts` | — | changes | approval kind `vault_use` goes; keys `memory.propose`, `skills.propose` go; `browser.use`, `web.browse` stay as policy |
| `C/core/src/backup/records.ts` | (5,437 dir) | changes | `memory`, `note`, `profile`, `skill*`, `learned_skill` records → Hermes memory files and skills per profile |
| `C/fixtures/src/vaultFetch.ts`, `vault.ts`, `fetch.ts` | 696+335+1289 | changes | tiers/passes, memory, skills fixtures |

#### App

| path | lines | goes/changes | note |
|---|---|---|---|
| `A/apps/web/src/features/memory/*` | 1,654 | mostly goes | `MemoryModal` 409, `MemoryEntries` 212, `MemoryRow` 250, `MemoryEditor` 158, `CheckpointNote` 84, `ContextUsage` 89 go; `AboutYouSection` 206 and `NotesTab` 90 become the Hermes `USER.md`/`MEMORY.md` editors |
| `A/apps/web/src/features/skills/*` | 2,158 (+879 css) | changes | goes: `SkillProposal` 191, `SkillProposalsToggle` 60, `DecisionButtons` 43, `LearnSkill` 351; stays as Hermes-skill view/edit: `SkillsLibraryTab` 269, `SkillDialog` 399, `SkillEditor` 125; open: `AddSkillsDialog` 456, `ScanParts` 47 |
| `A/apps/web/src/features/vault/*` | 3,758 | changes | `AgentAccess` 202 (Asks/Allowed tier), `DeliveryChooser` 128, `approvalScope` 47 (pass scope), `model.ts` 438, `copy.ts`; `LoginSelectors` 81 + `useAgentWithoutBrowser` 11 (our browser); entries, SSH, networks stay |
| `A/apps/web/src/features/agent/browserNote.ts` | 13 | goes | |
| `A/packages/client/src/skillLibrary/*`, `query/skills.ts`, `react/skills.ts`, `session/skillArchive.ts` | 1,780+101+103+121 | changes | `fixtures.ts` 910 inside |
| `A/packages/client/src/agentKeys.ts`, `react/mutations.ts` | 215, 1229 | changes | 26 tier/pass hits; ~35 memory/skills/vault hooks |
| `A/apps/mobile/src/screens/MemoryScreen.tsx`, `agent/NotesPart.tsx`, `data/memory.ts` | 194+215+80 | changes | same split as web |
| `A/apps/mobile/src/screens/{SkillsScreen 408, SkillScreen 253, ProposedSkills 96}`, `data/{skills 298, skillLibrary 132, deviceSkill 140}` | 1,327 | changes | `ProposedSkills` goes |
| `A/apps/mobile/src/screens/{VaultScreen 172, VaultEntryScreen 419, AddToVaultSheet 329}`, `data/vault.ts` 488 | 1,408 | changes | tiers/delivery |

**Stays (approvals, Off / Ask / Allowed):** contracts `domain/approval.ts` 510, `approvals/*` 1,340, `keys/*` ~2,000; web
`features/approvals` 517, `features/cards` (approval cards), `agent/KeyTierRows.tsx` 40, `agent/settings/AccessTab.tsx`
273; mobile `ApprovalScreen.tsx` 363, `data/approval.ts` 212, `ui/keyRows.tsx`. Vault entries, SSH servers, networks,
`vault/ssh.ts` 824, `vault/network.ts` 698.

**What a “Hermes owns, Whombat shows/edits/backs up” UI needs:** (1) memory per person: one view/edit of that person’s
`USER.md` (About you) and the agent’s `MEMORY.md` (notes) in their Hermes profile, char-budget bar (today’s
`memoryUsageText` fits), learning on/off; owners see only their own (HE-16). (2) skills: shared list, view, edit, switch
off, restore defaults, add (zip/link); source = Hermes skills dir, not our DB; “learned by the agent” badge instead of
proposals. (3) sessions: Chat thread ↔ Hermes session id (HE-18); delete/clear thread deletes the session;
conversation search via Hermes `session_search`. (4) backup: profile memory files + skills dir + `state.db` per person in
the `.wbk`. Contracts need new small schemas for these (file text + budget + updatedAt), not the old item model.

**Rough total:** contracts ~5,000 gone, ~5,500 touched; app ~2,000 gone, ~9,000 touched.

### Step 4: appliance only, one client connection, no legacy (HE-22, HE-23, HE-27)

#### How clients connect today

- **Two transports in both clients.** `VITE_WHOMBAT_TRANSPORT`/`EXPO_PUBLIC_WHOMBAT_TRANSPORT` = `http` (default; “legacy
  self-hosted”) or `session` (managed).
- **http (self-hosted server):** web same-origin cookie, Vite proxies `/api` `/ws` (`vite.config.ts` `legacyProxy`); mobile
  types a server URL (`data/config.ts`: “a Tailscale name, a Cloudflare Tunnel hostname”, `http://` for bare IPs/LAN,
  default `https://app.whombat.com`) and gets a bearer token from email-code sign-in. Realtime is its own `/ws` socket,
  canvas collab a Hocuspocus `/collab` socket. Tailscale = `tailscale serve` identity sign-in (`auth.tailscale`). No
  end-to-end encryption beyond TLS. This is what `whombat-dev` (127.0.0.1:4420) serves.
- **session (appliance):** control (`api.whombat.com`) issues an admission ticket → relay WebSocket `wss://…/v1/connect`
  (`whombat-relay.v1`) → Noise XX (`@whombat/secure-channel`) pinned to the appliance PeerId → length-prefixed session
  frames (`createManagedConnector`, `createSecureSession`). Phones use the same with native ChaCha20 (`managed/env.ts`).
  Enrollment/pairing (`managed/pairing.ts`, 8-digit code + fingerprint), claim (4 letters from the box’s own network +
  CPace, coordinated via control), phone QR handoff, push, cloud sign-in (magic link, passkeys) all go through control.
- **There is no direct path today**: no LAN or Tailscale session transport, no discovery. The box’s own screen uses local
  IPC (`control-contracts/local`), not the client session.
- What HE-23 needs: a second `SessionConnector` (a direct `wss://` to the box over LAN or a Tailscale name, same Noise
  XX bytes, same frames; secure-channel already takes any byte stream), admission without a control ticket (the
  appliance already binds endpoints to local accounts), an address source (LAN discovery or a stored Tailscale name) and,
  for the community edition, claim/enrol/sign-in without control. Then the whole http transport goes.

#### Contracts

| path | lines | goes/changes | note |
|---|---|---|---|
| `C/protocol/src/session/features.ts` | 799 | goes | ~98 runtime feature names, `LEGACY_FEATURES`, `RUNTIME_FEATURES`; `WelcomeRuntime.features` |
| `C/protocol/src/session/version.ts` | 122 | changes | `SESSION_API_LEVEL` history, `LEGACY_API_LEVEL` 21, `apiLevelWindow`, `runtimeSkew`, previous-major window → one version check (open: keep client-too-old) |
| `C/protocol/src/session/tolerant.ts` | 220 | open | decoding newer unions; useful only while web/box can skew |
| `C/protocol/src/session/errors.ts` | 369 | changes | `managed.*` self-hosted refusals: `trusted_access`, `sandbox_fallback`, `acp_runtimes`, `api_tokens`, `email_sign_in`, `host_directories`, `host_admin`, `feedback_intake`, `automation_webhooks` |
| `C/core/src/contracts/auth.ts` | 263 | goes (mostly) | HTTP auth: magic link, `auth.options/tailscale/verify/session/logout`, API tokens; `me.*` stays |
| `C/core/src/domain/agent.ts` | ~120 of 318 | goes | `AgentAccess` guarded/trusted, `AgentCheckout`, `TurnSandbox`, `TurnCommands`, `turnAccessLabel`, `workdir`, `AGENT_*_COPY`, `diffAgentRuntime`, `describe*WorkdirChange` |
| `C/core/src/domain/workdir.ts` | 122 | goes | `Workdir`, `parseWorkdirRoots`, `expandHome` |
| `C/core/src/contracts/burrows.ts`, `host.ts`, `github.ts`, `domain/clients.ts` | 326, 66, 136, 51 | changes | `burrows.setWorkdir`; `host.*` self-hosted facts; `via: 'gh'` (host gh); client source `host` |
| `C/core/src/contracts/realtime.ts` | 424 | changes | `WS_PATH` (http realtime); “older clients skip it” notes |
| `C/core/src/contracts/runner.ts` et al. | — | changes | 192 “older runner/server/client / before 0.x” mentions; make optional-for-skew fields required |
| `C/core/src/__fixtures__/recipes-0.70.ts`, `backup/records.ts` pack records, `restore.ts` | — | goes | old-version inputs |
| Clean major (1.0.0) drops | — | — | all of the above, packs, Ask/pass/ACP/scripted, `LEGACY_*`, `previous` support (the previous protocol for skew tests lives in the Whombat runtime, not here). Relay, admission, frame, secure-channel, claim, licence, release, control-contracts and Go bindings stay |

#### App

| path | lines | goes/changes | note |
|---|---|---|---|
| `A/packages/client/src/session/http.ts` | 541 | goes | legacy HTTP transport |
| `A/packages/client/src/realtime/realtime.ts`, `legacy/realtime-legacy.ts`, `web/*` | 523+249+206 | goes | `/ws` socket (keep `backoffDelay`, used by `secure.ts`), `realtimeUrl` |
| `A/packages/client/src/session/runtime.ts`, `tolerant.ts`, `strict.ts` | 113+251+66 | changes/open | `FULL_RUNTIME` vs `LEGACY_RUNTIME`, feature views |
| Feature gates in screens (`useFeature`, `FeatureGate`, `runtime.has`, `featureNeedsUpdate`) | 232 checks in 90 web + 57 mobile + 6 client files | goes | e.g. web `AutomationScreen`, `ConnectionsTab`, `MessageCard`; mobile `ChatView`, `ServerScreen` |
| `A/apps/web/src/app/runtime.tsx` | 64 | changes | `FeatureGate`, `useFeature` |
| `A/apps/web/src/app/auth/*` | 660 (+css) | goes | Login (email, Tailscale), Verify, Name, JoinByInvite |
| `A/apps/web/src/app/services.ts`, `main.tsx`, `vite.config.ts`, `strictCsp.ts` | 249+35+240 | changes | transport switch, `legacyProxy` |
| `A/apps/web/src/app/fixtureFetch.ts` + `*Fixtures.ts` | 787 + ~15,500 | open | fixture mode rides the HTTP client; re-home onto the session fake (`client/session/fake.ts` 1,523, `web/managed/fake/*` 5,368) |
| `A/apps/web/e2e/*`, `scripts/release-dist.ts`, `test:legacy-realtime` | 689+210 | goes | e2e against a legacy server; the legacy web+widget artifact |
| `A/apps/web/src/features/{settings/WorkdirSection 143, agent/AgentWorkspaceSection 115, agent/settings/WorkspaceTab 102}` | 360 | goes | workdir, checkout, trusted/guarded |
| `A/apps/web/src/features/github/{useGitHub 87, GitHubNotice 38}`, `settings/ReposTab.tsx` | 125 + part | changes | “run gh auth login on the host” |
| `A/apps/web/src/features/runs/RunView.tsx`, `ai/AiProviderPanel.tsx` | part | changes | “trusted” label; “whombat doctor” words |
| `A/apps/mobile/src/session/*`, `screens/SignInScreen.tsx`, `data/config.ts`, `App.tsx` | 698+233+64+112 | goes/changes | server mode (`mode: 'server'`, typed URL, email code) |
| `A/apps/mobile/src/screens/agent/WorkspacePart.tsx`, `data/agentSettings.ts` | 200+256 | changes | workdir/access |
| `A/apps/mobile/src/managed/{NeedsNewerApp 30, useNewerApp 83, keptRuntime 38}`, `data/useRuntime.ts` 54 | 205 | open | skew gates; keep a plain “update the app” check? |
| `transport === 'http'` / `useManaged()` / `MANAGED` branches | 86 hits in 59 files | goes | |
| `A/apps/admin/src/screens/{Releases,ReleaseDetail,Fleet}.tsx` | small | changes | show `apiLevel` |

**Stays:** `client/session/{secure 2,206, connector 427, wire, managed-ops 649, console, realtime 247, fake}`,
`client/managed/*` (claim, pairing, passkeys, recovery, push, remote-help, switcher), `@whombat/secure-channel`, relay
and frame codecs, `http/client.ts` typed facade (`createClient({session})`), widget.

**Rough total:** contracts ~1,400 gone, ~1,500 touched; app ~4,500 gone, ~2,000 touched, ~17,000 fixtures to re-home.

### Step 0 leftovers

| path | lines | goes/changes | note |
|---|---|---|---|
| `C/core/src/domain/activity.ts` `WHOMBAT_VERBS` | 4 | goes | `plan_start_step`, `delegate`, `report_back`, `pass_on`: no such tools any more. Keep `ActivityKind 'delegate'` (subagent row) |
| `A/apps/web/src/stories/Agents.stories.tsx` | 47 | goes/rename | “Agents roster, profile pane, hire modal” |
| `A/packages/tokens/{tokens.css L113, src/scale.ts L88}` `--size-modal-hire` | 2 | rename | used by `Modal.module.css .hire`, `Modal.tsx width='hire'`, `things/console/ConsoleDialog.tsx` |
| “hire” in comments | ~20 | reword | `Toggle.tsx`, `Toggle.module.css`, `Toggle.stories.tsx` (story “hire-modal-keys”, its baselines), `Input.tsx`, `Input.stories.tsx` (`hire-name`, “Nugget”), `Memory.module.css`, `MemoryModal.tsx`, `MemoryEditor.tsx`, `AgentTab.module.css`, `ProviderPicker.tsx`(+css), `KeyTierRows.tsx`, `browserNote.ts`, `AgentWorkspaceSection.tsx`, `ReposTab.module.css`, `playwright.config.ts`, `e2e/keyboard.spec.ts`, mobile `ui/keyRows.tsx`, `navigation/RootNavigator.tsx` L575 |
| `A/apps/web/visual/*` | ~2,500 | changes | crew: `approval.spec`/`mockApproval` (Neo, Banjo, Hazel), `audit.spec`/`mockAudit` (`only-banjo`, Banjo), `toasts.spec` (“Nugget joined… after hiring”, Neo), `baselines.spec` (“Meet your first agents”, five roles, crew spend), `onboarding.spec` (six crew), `support/harness.ts` (role words, “To Banjo”) |
| `A/tools/visual/src/{reference.ts, removals.ts}` | 422 | changes | `SCREENS` has `channel`, `roster`; `fiveAgents` reference; `AGENTS_NAV` removal |
| `A/apps/web/visual/__screenshots__` | 277 files | changes | `primitives-toggle--hire-modal-keys*`, `primitives-sidepane--agent-profile*`, onboarding-agents |
| `A/apps/web/e2e-managed/licence.spec.ts` | 219 | reword | “Agents keep working until…”, “agents and automations are paused”, composer “Message #billing-v2” (channels are gone), `limits.agents` |

### Open questions

1. Per-thread Chat runtime (provider/model/effort/fast): does HE-09 (“set on the agent”) remove it, or keep provider per
   thread? ~2,000 app lines hang on it.
2. Hermes skills are per profile; HE-16 wants per-person memory but shared skills. One shared skills dir linked into
   every profile, or the default profile’s skills only?
3. Skill imports: keep our scanner (`skills/scan.ts` 1,237) and zip import, or use Hermes’s hub/install? The “64 KiB
   import cap” isn’t in these repos; the nearest are the 64 KiB session CONTROL message (why `skills.stage` exists) and
   `SKILL_LIMITS` (128 KiB body, 2 MiB files).
4. Vault login entries and SSH tools after our browser and relayed requests go: does Hermes’s browser get the person’s
   login on the computer for their turn (HE-21), and do `ssh_*` stay Whombat tools?
5. Community edition without control: who issues admission, coordinates the claim, does sign-in (passkeys/magic link)
   and push? The session protocol itself doesn’t need control; tickets, claim, QR handoff and push do.
6. Keep any version skew handling (hosted web vs box, Android vs box) after dropping feature flags: a single
   “update the app / update your Whombat” check and `tolerant` decoding, or none?
7. Fixture mode for development and visual tests rides the HTTP client; moving ~16k lines of web fixtures onto the
   session fake is the biggest hidden cost of dropping http.
8. Steering: keep `TurnInjection`/`TURN_MERGED_REASON` in Hermes terms (gateway `steer`) or only queue follow-ups (HE-28
   decides)?

## Hermes engine: inventory of the appliance-side repositories (2026-10-23)

Read-only research for HE-01…HE-29 (`~/Code/Whombat/docs/decisions/hermes-engine.md`). Repositories: the appliance
(`A/`), control (`API/`), the relay (`R/`), the hosts service (`H/`), Whombat_Website (`W/`), and the Hermes source
at `~/.cache/wb-tmp/research/2026-10-23-engine/hermes-src` (`HS/`, MIT). Paths below are relative to `~/Code/<repo>/`.
Nothing was built or changed. The only command that went beyond reading files was an offline `nix eval` of the pinned nixpkgs.

### Key facts

1. **Python 3.14 is available.** The appliance pins `nixos-26.05` at `c508844d` (2026-09-24): `python3` = 3.13.15,
   `python314` = 3.14.7, `python315` = 3.15.0rc2, `uv` 0.11.21, `tailscale` 1.98.10 (offline `nix eval`). Hermes uses
   `nixos-unstable` `0954f7ee` (2026-07-29). It picks `pkgs.python314` from the family in `HS/pm/lock.json`
   (3.14.9+20261021) and fails rather than fall back (`HS/nix/pythonLock.nix`). So
   `inputs.hermes.inputs.nixpkgs.follows = "nixpkgs"` works on our pin. Without `follows`, the overlay
   (`HS/nix/overlays.nix`) aliases Hermes's own build, which would add a second nixpkgs closure to the image.
2. **Where Hermes goes:** a new `A/nix/packages/hermes` (a uv2nix build of the pinned Hermes plus our plugin), referenced
   from the runtime bundle (`A/nix/packages/runtime`). The bundle runs from the runtime profile, so a Hermes bump is a
   runtime-only release that `dev/candidate` can ship. It should not go in the sandbox toolchain (`sandbox.nix`), which
   changes only with a host release. It also should not go on the client channel, which ships upstream's newest tested
   Claude Code and Codex binaries (HE-04: those stay as they are).
3. **How a change ships:** `dev/candidate` ships Whombat main runtime-only
   (`release/ship build <id> --reuse-host <the host John's box runs>`, then `dev/publish-release --rollout wb-r7m4-6nbc-3307`,
   about 4–6 min). Image or module changes need `release/ship build <id> --host` (or `release/ship all <id>`: build, then
   publish-dev; the box reboots). The first Hermes integration changes `runtime.nix`/`sandbox.nix`, so it needs a host
   release; later Hermes bumps can go runtime-only.
4. **The licence check** lives in three places:
   - `A/nix/modules/licence.nix`: pins the keys; a prod build without keys fails evaluation.
   - The manager (`A/manager/internal/licence/`, `A/manager/internal/daemon/licence.go`): daily renewal through control.
   - Control (`API/src/licence/service.ts`): signs licence tokens from the org's entitlement.
   The runtime runs `WHOMBAT_MODE=managed` and refuses to start without keys (MR-55), so a keyless community image also
   needs a licence-free runtime mode.
5. **Tailscale is not in the image.** There is no `services.tailscale` in `A/nix/`, the firewall is
   `allowedTCPPorts = mkForce [ ]` (`network.nix:127-136`), and clients reach a box only through the relay. No LAN path
   exists today. The runtime's self-hosted `tailscale serve` sign-in (`Whombat/apps/server/src/auth/tailscale.ts`) is
   refused in managed mode.
6. **The community edition can't update without control.** The manager installs a release only when control sends a
   signed `update.assignment` (`A/manager/internal/update/offer.go`, `daemon.go:590-706`). Registration, claim tickets
   and the relay also go through control. The AI client channel needs only TUF, so it already works without control.

### Step 1/2: Hermes in the image (HE-10, HE-12)

| path | lines | goes/changes/adds | note |
|---|---|---|---|
| A/flake.nix | 1975 | changes | Inputs today: `nixpkgs` (26.05), `lanzaboote`, private `whombat` and `whombat-hosts` with `flake = false`. Add a `hermes` input pinned to a rev (research `afe3cbd8`) with `inputs.nixpkgs.follows`; uv2nix, pyproject-nix and build-systems come in with it. Add `whombat-hermes` to the overlay (l.52-130) and a `checks.hermes-pin` next to `runtime-pin`/`hosts-pin` (l.1656-1705). |
| A/flake.lock | — | changes | nixpkgs `c508844d`. Hermes brings flake-parts, home-manager (checks only) and npm-lockfile-fix; prune them with `follows`. |
| A/nix/packages/hermes/ | new | adds | Overrides Hermes's `minimal` package. That package already pulls in the TUI and web frontends, pinned Node, ffmpeg, wl-clipboard and xclip (`HS/nix/hermes-agent.nix:113-160`, l.335). Drop those (HE-10: Hermes's own UIs off) and add our plugin (Claude Code mode HE-05, memory and conversation search over MCP HE-07). Self-update, gateway and cron off. |
| HS/nix/{python,pythonLock,hermes-agent,packages,nixosModules}.nix | 181/47/412/103/715 | reference | uv2nix venv with `sourcePreference = "wheel"`. `full` adds 16 dependency groups; we need `minimal`. The NixOS module (`services.hermes-agent`: native unit or OCI container) is not what we need: Whombat writes the configuration and runs Hermes in its sandbox (HE-04, HE-12). |
| A/nix/packages/runtime/default.nix | 239 | changes | The runtime bundle: Node wrappers, `disallowedReferences` = pnpm, python3 (3.13), node-gyp and the pnpm store. `python314` is a different derivation, so it doesn't clash. Reference Hermes (e.g. `bin/hermes` or an env path), add its version to `bundle.json` and passthru, and set `candidate` (now 0.141.0). Drop `@embedded-postgres` (self-hosted, HE-22). |
| A/nix/modules/runtime.nix | 531 | changes | Server and runner run from `/nix/var/nix/profiles/whombat-runtime` (runtime-only updates, no reboot). It sets `WHOMBAT_MODE=managed`, and the runner has its own `WHOMBAT_HOME` (`runnerHome`). Add Hermes's state directory (a profile per person, HE-16) under /persist, and the runner's environment for Hermes. Remove the empty `gh` config for guarded agents (l.198, 513; HE-22). |
| A/nix/modules/sandbox.nix | 300 | changes | Two bwrap stages. `WHOMBAT_SANDBOX_RO_PATHS` = toolchain + clients root (l.240-250). Egress: nftables wall plus proxy, 80/443 only, plus `signInHosts` (l.20-45). Hermes's store closure has to be visible inside the sandbox: add it to the RO paths, or let the runner bind it. The toolchain (`nodejs_22`, `python3`+docx…) may go if skill scripts run on the computer (HE-12). Remove the guarded `gh` config (l.266). |
| A/nix/modules/providers.nix | 126 | stays | Claude Code and Codex come from the signed client channel into `/persist/whombat/clients/<p>/<v>`, run unmodified (nix-ld for Claude), with `DISABLE_AUTOUPDATER`. Hermes's Claude Code mode (HE-05) and Codex mode (HE-06) run these same binaries. |
| A/manager/internal/clients/{clients,state}.go | 874/91 | stays | Installs from the channel and pushes `POST /clients` to the runtime. Hermes doesn't belong here: it is a Nix closure, pinned and tested by us. |
| A/release-tools/clientchannel/{clientchannel,upstream}.go | 354/311 | stays (one part goes) | Fetches Claude from npm and downloads.claude.ai and Codex from GitHub releases. Its plain-path channel for self-hosted servers (`clientchannel.go:54,341`, SUB-26) goes under HE-22, or becomes the community channel. |
| A/nix/modules/browser.nix | 341 | goes or changes (HE-20) | Our headless Chromium browser host (`bin/whombat-browser-host`). Hermes's browser replaces it. Decide where its Chromium runs: the computer, or a unit like this one. |
| A/nix/modules/computers.nix | 1333 | stays (HE-13) | Incus containers per agent, run by computerd (in the runtime bundle). Hermes's `TerminalEnvironmentProvider` talks to computerd, which is runtime code, not image code. |
| A/manifest/candidates/0.141.0.json | — | changes | Components: contracts, relay, api, runtime, app, manager, backup, provisioning, hosts. `tuple.providers` lists scripted, codex and claude placeholders, plus `runtimeHostAbi {1,1}`. Add a `hermes` component or provider, and bump the host ABI if a runtime needs new host support. |
| A/vm-tests/{runtime-live-turn,runtime-real,browser-real,computers-real}.nix | 219/197/?/180 | changes | `runtime-live-turn` runs a fake Claude (`common/live-turn/fake-claude.js`) in both bwrap stages. Rework it for Hermes over ACP driving that fake. The CI VM job (`A/scripts/ci/virtual-machines.sh`, 31) runs 10 of these checks. |

**Harness scenarios and DEV box checks that exercise the engine** (A/harness/; 28 scenarios, 8,683 lines in all). The
default environment is scripted: `WHOMBAT_AGENTS=scripted` (`src/dev/services.ts:1427`) uses the ScriptedProvider inside
the runtime. Hermes needs a scripted equivalent, for example Hermes with a fake model or a fake ACP agent.

| path | lines | what it checks |
|---|---|---|
| scenarios/k-live-agents.scenario.ts | 436 | `WB_MGD_AGENTS=live`: clients installed (K1), Claude PTY sign-in (K2), Codex device code (K3), refusal for a person without a sign-in (K4/K6), a turn on an empty planted Claude home in both sandboxes (K5) |
| scenarios/a-vertical-slice.scenario.ts | 188 | claim, then a task to the one agent, streaming, resume from a cursor, an approval card (HE-17) |
| scenarios/{f-accepted-work,d-durable-commands,g-performance}.scenario.ts | 104/207/234 | a reply arrives once across disconnects and relay restarts; latency |
| scenarios/{s-skills,h4-skills-exports}.scenario.ts | 391/215 | skills learned and switched off, the scan, spend, exports. HE-19 moves skills into Hermes. |
| scenarios/{r-browser,p-vault,m-guides,n-work}.scenario.ts | 468/1086/322/161 | browser (HE-20), Vault keys in turns (HE-21), guides and cards, work |
| src/devbox/{main,session.devbox}.ts | 601/799 | `dev/devbox smoke` and `soak`: sign in, the app over the relay, a message, an agent turn, browser, backup. publish-dev runs it. |
| src/devbox/ra-check.ts (+ra-rules.ts) | 1142/165 | RA-60 on Codex on John's subscription: `learn` (profile memory), `schedule`, `notify`, `port`, `lan`, `ocr`, `correction`, `recovery`. This is the natural HE-28 trial harness. Note that `schedule` and `notify` overlap Hermes cron, which HE-10 turns off. |
| deploy-check (in src/devbox/main.ts) | — | an agent deploys a site to a test server (GF-07). This is HE-28's "website deploy". |

**Ship commands.**
- `dev/candidate` (26 lines; `harness/src/dev/candidate.ts` 1187) does five things:
  1. Builds the next candidate from Whombat `origin/main` and runs `nix build .#whombat-runtime` and the pin checks.
  2. Merges the candidate into appliance main and pushes it.
  3. Runs `release/ship build <id> --reuse-host <the host John's box runs>`, a runtime-only build, while restarting the
     dev stack on `WB_MGD_PINS`.
  4. Runs `dev/publish-release … --rollout wb-r7m4-6nbc-3307` and `whombat-manager check`, then waits for Healthy.
  5. Checks the server.

  It doesn't cover control, relay, manager or host changes. `--hosts <rev>` is the one exception: it forces `--host`
  because the hub is in the DEV image.
- `release/ship build <id> --host` (`release/ship` 29, `release/build` 379, `harness/src/ship/build.ts` 870) builds a host
  release even when only the runtime changed: a new toplevel with modules, manager, helper and toolchain, a PROD build
  and its DEV twin, no ISO. Without the flag, `host-path` decides by itself (UP-X16). Then `publish-dev`, or
  `release/ship all <id>` for build followed by publish-dev with no validation on DEV.
- **The dev stack runs the runtime from a source checkout, not from Nix** (`services.ts:800,1480`). On dev.whombat.com
  Hermes therefore needs a path of its own: `nix build .#whombat-hermes` from the appliance, or a uv install pinned to
  the same rev.

### Step 4: one client connection, appliance only (HE-22, HE-23, HE-27)

| path | lines | goes/changes/adds | note |
|---|---|---|---|
| R/internal/relay/{server,conn,session,queue,preauth,options}.go | 672/432/221/217/105/161 | stays (commercial) | `wss` to `/v1/connect`, subprotocol `whombat-relay.v1`, a `hello` with an EdDSA admission ticket that control signs (MA-05/06). After that only opaque bytes pass. No version-skew code: only hello `v:1`, and "skew" in the code means clock skew. |
| R/internal/{admission/*,wire/*,peer/peer.go}, R/docs/decisions/relay.md | ~950, 263 | stays | Tickets, JWKS, replay cache; RL-01…RL-34 |
| Whombat/apps/server/src/managed/session/{relay-client,endpoint,secure,connection,streams,registry}.ts | 398/76/41/871/285/92 | changes | Inner layer: Noise XX (`whombat-secure-session/1`, PeerId pinned, MA-07/MA-24), then session protocol v1. `secure.ts` works over any ByteStream. `endpoint.ts` is where a second byte source would plug in: a LAN or Tailscale listener next to the relay. |
| Whombat/apps/server/src/managed/{trust,claim,screen-signin,reenroll,ports,boot}.ts | 1729/276/467/372/165/163 | changes | CPace claim (`CPACE-RISTR255-SHA512`), pairing, invites, recovery. Claiming must also work without a relay ticket or control (community). |
| A/nix/modules/network.nix | 270 | changes | Nothing inbound (NX-22); egress allowlist (LN-06). A direct path needs a listener port on the LAN and `tailscale0`, plus outbound UDP/DERP for tailscaled. |
| A/docs/implementation/architecture.md, A/docs/decisions/claim-code.md, A/docs/implementation/reviews/secure-channel-review.md | 348/47/715 | changes | MA-04…MA-08 and CC-01…CC-12. They need a direct-path section and a fresh review. |
| A/harness/scenarios/{1-claim-code,b2-pairing,b-enrollment-negatives,b4-reenroll,c-hostile-relay}.scenario.ts | 285/163/242/155/178 | changes | Add direct-path variants |
| API/src/{tickets/issue,tickets/client,relay/workers,claims/service,claims/lookup,claims/nearby}.ts | 52/44/68/403/98/85 | stays (commercial) | Admission tickets, worker routing, claim leases. "Nearby" matches devices by public IP, not the LAN; there is no mDNS anywhere. |

**Tailscale today.** It is not in the image. Mentions in the appliance are only comments, test fixtures and docs:
`runtime.nix:464`, `vaultwall/internal/networks/networks.go:10`, IN-62/IN-233…236 and `parity-final.md` (Tailscale
sign-in disabled in managed mode). Self-hosted Whombat has `apps/server/src/auth/tailscale.ts` (204) and
`config.ts:344-555`. The hosts service uses `tailscale cert`/`serve` for its standalone hub (`internal/hub/{certs,config,http}.go`)
and parses Unraid's plugin. nixpkgs 26.05 has `tailscale` 1.98.10.

**Install-on-any-Linux (HE-22) and compatibility (HE-27): what goes.**

| path | lines | note |
|---|---|---|
| Whombat/apps/cli, apps/server/src/auth, config.ts (`WHOMBAT_MODE`, `WHOMBAT_WORKDIR_ROOTS`), packages/agent-runtime/src/{access,acp}; docs/decisions/{self-hosted,cli,auth-selfhost,runner-selfhost,mobile-server}.md | ~9.1k (cli) | Self-hosted mode. `mobile-server.md` describes Android connecting directly with an address and token; HE-23 replaces it. |
| A/harness/src/dev/services.ts:1411,1635 | 1921 | `WB_MGD_WORKDIR_ROOTS`, which is passed on as `WHOMBAT_WORKDIR_ROOTS` |
| A/docs/implementation/{parity-final,parity}.md, A/docs/runbooks/cutover.md | 473/21/235 | Comparison and cutover from the self-hosted monolith: archive them |
| H/web/ (~36.6k TS), H/internal/hub/{auth,users,oidc,notify,assist*,static}.go | — | The standalone Rackoon UI with its own users. Whombat runs only `serve --headless`. |
| A/manager/internal/outbox/outbox.go (`OpenCompat`, SR-10) | 462 | Keeps pending reports in the old managers' format too |
| A/manager/internal/controlapi/client.go (`OnLegacy`, `LegacyRetry` 6 h, MG-52/MG-119) | 508 | Sends reports without the contracts-0.22 fields when an old control refuses them |
| A/manager/internal/runtimeapi/runtimeapi.go (`OnLegacyFacts`) | 330 | Handles a runtime from before contracts 0.22 |
| A/helper/pkg/trust/repo.go (`Legacy` nix-export closures) | 565 | Older managers use full closures. Index-only is enough once every manager is from 0.3.0 on. |
| A/harness/src/ship/skew.ts, args/notes/validate.ts, src/lib/client-contracts.ts | 175/265/425/609/53 | Clients checked against runtimes one and two releases back, `--client-floor`, `--skip-skew` |
| A/release/upgrade-gates, A/vm-tests/{update-migration.nix,common/migration-runtimes.nix,upgrade-gates/previous.json} | 290/510/101/7 | Upgrades from N−1 and N−2, schema ranges. Floors restart at the new baseline. Keep the update mechanics. |
| A/docs/release/compatibility.md | 167 | Policy: session protocol N and N−1, old phones, long-offline boxes |
| API/src/rollout/{service,fleet}.ts, API/infra/hetzner/deploy.sh:240-364 | 1402/92/1065 | `MIGRATING_MANAGER_FLOOR`, the API-level window, `LEGACY_API_LEVEL`, `--force-contracts` |
| Whombat `@whombat/protocol-previous` 0.20.3, `managed/{runtime-features,legacy-import}.ts`, `skew.int.test.ts`; `vendor/whombat-app/0.36.0` | 334/260/109 | Runtime-side compatibility code; the import from self-hosted goes too |

### Step 5: editions and licences (HE-24…HE-26)

| path | lines | goes/changes/adds | note |
|---|---|---|---|
| A/nix/modules/options.nix l.8-20 | 174 | changes | `whombat.environment` = `local\|dev\|prod`, the only switch. Add `community`, or a separate `whombat.edition`. |
| A/nix/modules/licence.nix | 71 | changes | `/etc/whombat/licence-keys.json`. Assertions: prod needs keys (l.39), the key set's env must match (l.55), no dev kids in prod (l.59). |
| A/manager/internal/licence/licence.go, daemon/licence.go | 176/328 | stays (unused without keys) | Verifies tokens, keeps a time high-water mark, renews daily through the `licence.renew` device op, pushes `POST /licence` to the runtime |
| A/nix/modules/runtime.nix l.24, 429 | 531 | changes | `WHOMBAT_MODE=managed` is hard-coded; `WHOMBAT_LICENCE_KEYS_FILE` is set when there are keys. A runtime mode without licence and without control is needed (LC-12 covered this only for self-hosted). |
| API/src/licence/service.ts, src/billing/{entitlements,plans,service,stripe}.ts, src/db/migrations/0004_licence.sql | 109/196/62/520/330/18 | stays closed | Signs tokens from the entitlement (`selfInstall`), Stripe |
| A/docs/decisions/licence.md | 107 | changes | LC-01…LC-21: 14-day token, 30 days' grace, then "lapsed". LC-19 (proprietary notices) and LC-15 need revisiting. |
| A/nix/profiles/prod-instance.nix, dev-instance.nix | 51/118 | template | Prod pins its URLs (api, updates, relay), the TUF root, licence keys, client-channel keys and the support CA when present, with self-registration on. Add `community-instance.nix`: own TUF root and client keys, no licence or CA, no `controlUrl` or `relayHost`, Tailscale. |
| A/flake.nix l.189-206, 377-440, 888-914, 1929 | 1975 | changes | `releaseEnvs {dev, prod}`; `nixosConfigurations` (appliance, self-installed-{dev,prod}, installer-*); `installer-iso-{dev,prod}`; licence and trust-document checks. Add the community entries. |
| A/release/build, harness/src/ship/*.ts (6,194 in all) | 379 | changes | `release/build <dev\|prod>`, id families `whombat-…` and `whombat-dev-…`. Needs a community env, id family and publish stage. |
| A/release-tools/cmd/tufrepo/main.go, release-tools/devtuf/*.go | 761/~4,100 | changes | `checkMode` knows only prod with custody online-pilot. A community repository needs a new env, or a delegation inside the prod repository. |
| A/release-tools/fixtures/dev-keys/, manifest/{prod,dev-instance}/{tuf-root,licence-keys,client(s)-channel-keys}.json | — | adds `manifest/community/` | The trust roots the image pins; `manager.nix:250-286` installs them under `/etc/whombat/tuf/` |
| A/manager/internal/{update/offer.go,daemon/daemon.go:590-706,tufclient/*} | 44/915/503 | changes | **The blocker:** updates need a control assignment, signed with assignment keys published in TUF. Community needs a TUF-only "latest release" mode, or a public assignment signer. |
| A/nix/modules/provisioning.nix | 279 | changes | Self-registration with control while `device.json` is missing. A community box has no control to register with. |
| API/infra/hetzner/files/whombat-updates.service; API/infra/hetzner/deploy.sh (`updates` l.382-425, `tuf-*` l.561-622, `release` l.626) | 27/1065 | stays closed | **The update service** is `node static-server.ts /srv/whombat/updates 4739` on the Hetzner host (updates.whombat.com), with timers that run `tufrepo refresh` every 6 h and `clientchannel refresh` daily. Keys live on the host in `/etc/whombat/secrets/tuf`. |
| A/harness/src/dev/static-server.ts (and the tufrepo/clientchannel source) | — | moves? | The code of the "closed" update service lives in the appliance repository, which HE-26 makes AGPL. Carve it out or accept it as open. |
| A/support/ (cmd/whombat-support, internal/{grant,look,fix,sshd,relay,records,api,…}) | ~5,500 | stays (commercial in practice) | Remote help: root SSH over the relay while an owner's grant is active. `A/nix/modules/support.nix` (180) pins `whombat.support.caKeys`; with no CA, remote help is off. Counterparts: `A/manager/internal/broker/support.go` (109), `supportclient` (233), and `API/src/support/{service,ssh-cert,rules}.ts` (186/269/78), which stays closed. The relay has no support-specific code. |
| A/nix/modules/{base.nix:113,118, hosts.nix:191, storage.nix:412, providers.nix:73} | — | review | Gated on the environment: console shell, the Incus agent (NX-143, DEV only), the hosts hub (DEV only, NX-152). Decide each one for community. |

**Licences now, and what HE-26 asks for.**

| repo | now | HE-26 |
|---|---|---|
| the appliance | `LICENSE` (6 lines): "Copyright 2026 John Pals. All rights reserved. Proprietary and confidential. No licence is granted." Package files say `UNLICENSED`. NOTICES.md in `voice/`, `presence/`, `console/ui/`. `release/policy/licenses.json` (374) marks AGPL as `network-copyleft`. `nix/packages/console-ui` l.76 bundles the app's LICENSE.md and THIRD_PARTY_NOTICES.md. | AGPL-3.0 (image) |
| Whombat (runtime) | `LICENSE` with the same proprietary text; `UNLICENSED` | AGPL-3.0 |
| whombat-contracts, whombat-app | `LICENSE.md` (78): PolyForm Strict 1.0.0 with a research permission (SR-02), plus THIRD_PARTY_NOTICES.md (117/787) and TRADEMARKS.md | AGPL-3.0 |
| the hosts service | **no LICENSE**, no `license` field; Go module still named `rackoon`; `nix/packages/hosts/agent-update-key.pub` holds a DEV-only signing key | AGPL-3.0, to be added |
| control | proprietary `LICENSE`, `UNLICENSED` | closed |
| the relay | proprietary `LICENSE`; vendors contracts 0.5.0 (`third_party/README.md`), which become AGPL | closed |
| Whombat_Website | no licence; `terms`, `appliance-terms` and `pricing` pages; nothing about open source or community | outside HE-26. `A/docs/legal/appliance-terms.md` (140) needs rewriting. Never publish. |
| Hermes | MIT, "Copyright (c) 2025 Nous Research" | include its notice in the image |

No first-party file has SPDX headers.

### Launching a VM to install an image (for the community stream)

- `A/vm-tests/install-vm.nix` (603) runs the NixOS test driver: it installs the ISO through the graphical installer onto
  a blank 128 GiB disk on q35 + OVMF (setup mode, no TPM, virtio-scsi, i6300esb). Then it boots, self-provisions
  against **a fake control**, reaches the claim code (OCR), goes through a failed boot assessment and a factory reset.
  `install-machine.nix` (137) is the bare-metal variant. Both are flake checks: build
  `.#checks.x86_64-linux.<name>.driver` and run `bin/nixos-test-driver`, as `A/scripts/ci/virtual-machines.sh` does.
  NX notes (`A/docs/decisions/nixos.md:3764,3850,3882-3884`) record that they ran locally under
  `agent-resource run`, with the driver's sockets in the lease workspace behind a short `/tmp` symlink, all leases
  closed afterwards.
- `A/docs/runbooks/install.md` §5 (l.135-205) shows raw `incus storage volume import … --type=iso`, `incus init --empty --vm`,
  and `raw.qemu` for i6300esb. Per the global rules a throwaway test VM must instead go through
  `agent-resource lease`/`vm-launch` (the `agent-tasks` project). `dev/devbox` (`harness/src/devbox/incus.ts` 312) is
  only for the persistent `whombat-dev-box`.
- An ISO comes from `release/ship iso <id> [--dev|--both]` or `release/build iso <dir>`; both take the heavy lock
  `~/.cache/wb-tmp/robust-updates-heavy.lock`. A community ISO needs `installer-iso-community`.

### Open questions

1. Hermes in the runtime profile, or as a separate profile or host package? The runtime profile gives runtime-only
   bumps, but makes the runtime closure much larger (Python 3.14 venv). The size of `minimal` after stripping the UIs
   is not yet measured.
2. How does Hermes's closure get into the bwrap sandbox: through `WHOMBAT_SANDBOX_RO_PATHS`, or through the runner
   binding the runtime profile? The runner code is in Whombat `packages/agent-runtime`, which this research didn't open.
3. Where does Hermes's browser (HE-20) run: on the computer, or as a unit like `browser.nix`? Its Chromium and egress
   wall depend on the answer.
4. What does the scripted test mode look like with Hermes? A fake model behind Hermes, or a stand-in ACP agent? The
   harness scenarios and the dev stack depend on it.
5. How does the dev stack (runtime from source) get the pinned Hermes: a `nix build` path from the appliance, or uv?
6. Community without control: who signs update assignments, and how do registration, the claim (CPace over the LAN or
   Tailscale) and Tailscale sign-in work? Tailscale's coordination server, or self-hosted Headscale?
7. A direct path means opening inbound ports on `tailscale0` and the LAN, which reverses NX-22 ("nothing inbound").
   Should the LAN listener be on by default (LN-*)?
8. HE-26 keeps the update service closed, but its code (`static-server.ts`, `tufrepo`, `clientchannel`) lives in the
   repository that goes AGPL. Move it to control, or publish it?
9. Should the community edition publish the hosts service's agent updates under its own key?
   `agent-update-key.pub` is DEV-signed only.
10. Hermes's nixpkgs is unstable (2026-07-29) and ours is 26.05. With `follows`, does its uv2nix override set (alibabacloud,
    python-olm, misaki) still build on 26.05's Python 3.14.7? Only a trial build will tell (HE-28).
