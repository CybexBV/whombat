# Hermes as the engine, steps 1 to 5: the brief and the stream plan

Plan: `docs/decisions/hermes-engine.md` (HE-01…HE-29, settled; new questions HE-30 onwards there). Step 0 (one agent)
is done: `docs/decisions/one-agent.md`, `docs/implementation/one-agent/`. What goes, by repository and file:
`inventory.md` beside this file. The lead (the orchestrating session in `~/Code/Whombat`) merges, checks and ships;
streams write code in worktrees. The hand-off brief this plan answers is at the end, verbatim.

## Numbers (claimed)

- Hermes Agent pinned at **v0.22.5** (`bf0203a794a07aac3ff764972ab9087baa4e4f4e`, 2026-10-23 05:28 UTC, “tested SemVer
  stable”); source `~/.cache/wb-tmp/hermes/src/hermes-v0.22.5`, a Python 3.14 environment with the `acp` and `mcp`
  extras at `~/.cache/wb-tmp/hermes/venv-0.22.5` (`bin/hermes`, `bin/hermes-acp`). A new pin after the trial (HE-28).
- Whombat: decisions HE-30 onwards in `docs/decisions/hermes-engine.md`; server and runner details HE-S01… under
  “Details” in the same file (step 1 HE-S01…S29, step 2 S30…S109, step 3 S110…S159, step 4 S160…S199, step 5 S200…).
- contracts: **0.124.0** (step 2, CT-1150…1199), **0.125.0** (step 3, CT-1200…1249), **1.0.0** (step 4, the clean
  major version, CT-1250…1299).
- whombat-app: **0.126.0** (step 2), **0.127.0** (step 3), **1.0.0** (step 4); AP-5000…AP-5199 (client 5000…5039, web
  5040…5119, phone 5120…5199).
- appliance IN-400 onwards, NX-430 onwards, MG-124 onwards, CG-340 onwards · control CL-134 onwards · relay RL-*
  from its own next free number.

## Repositories, branches, worktrees

Integration branch `hermes` per repository (only the lead merges into it; each step lands from it on `main`):
Whombat `~/Code/.wt/whombat-hermes` · appliance `~/Code/.wt/appliance-hermes` · contracts, app, api, relay, website
`~/Code/.wt/<repo>-hermes` when a step first touches them. Streams: their own worktree and branch off `hermes`,
`git -C <repo> worktree add -b he<step>-<x> ~/Code/.wt/<repo>-he<step>-<x> hermes`.

## Step 1: the trial on the DEV box (HE-28)

The question the trial answers: how much of Hermes works when a CLI runs the loop, driven by Whombat over ACP, inside
the runner's sandbox next to the computer. Three build streams side by side, then the trial itself.

### Interfaces between the streams (fixed here; a stream that must change one tells the lead first)

- **Where Hermes lives.** Development: `WHOMBAT_HERMES_BIN` (default `hermes` on `PATH`; the dev environment above).
  Appliance: a read-only store path the image puts in the runner's environment as `WHOMBAT_HERMES_BIN`
  (`/nix/store` is bound read-only into every task sandbox, so nothing else is needed to reach it).
- **Profiles (HE-16).** `WHOMBAT_HERMES_ROOT` (appliance `/persist/whombat/hermes`, 0700 `whombat-runner`; development
  `$WHOMBAT_HOME/hermes`) holds `profiles/<account id>/` (one `HERMES_HOME` per person) and `profiles/_shared/` for a
  turn for nobody. The runner mounts only the turn's person's profile writable into the task sandbox, and runs at most
  one Hermes process per profile at a time (a lock; Hermes: “never point two agent processes at the same profile”).
- **Configuration (HE-04, HE-10).** The runner writes `$HERMES_HOME/config.yaml` before every turn (Whombat owns it,
  nobody else edits it): the turn's runtime (`claude_code` from our plugin, or Hermes's own `codex_app_server`), the
  model and effort, the CLI paths (`model.codex_bin`; the plugin's own key for `claude`), the Whombat plugin enabled,
  and everything HE-10 turns off (self-update, messaging platforms, cron, dashboards and UIs, cloud features, Hermes's
  own OAuth providers and `auth.adopt_external_logins`).
- **Sign-ins (HE-09, SUB-04).** The turn's credential home (`TurnHost.credentialHome`) reaches the CLI through Hermes's
  environment: `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex. Hermes itself never holds a model login.
- **The computer (HE-12, AC-02).** The CLIs' shells go to the computer as today (the task's `SHELL` is the computer
  wrapper, `COMPUTER_SHELL`/`WRAPPER_PATH` in `@whombat/computer`); Hermes's own terminal and file tools go there through
  the plugin's `TerminalEnvironmentProvider`, which runs commands through the same wrapper.
- **Whombat's MCP tools.** Hermes's ACP takes only stdio MCP servers from the client, so the runner passes a small
  stdio↔HTTP bridge (`node <bridge> <server>/mcp`, the agent token in its environment) in `session/new`,
  `session/load` and `session/resume`; the plugin hands every MCP server Hermes has to the CLI (`--mcp-config` for
  Claude Code; Hermes's own migration for Codex).
- **Whombat's words in the prompt (HE-11).** What is stable for a person (the agent's name, the talk-like-people rules,
  `concise-replies.md`) goes into a system-prompt section the plugin registers, read from `$HERMES_HOME/whombat.md`
  (written by the runner); what changes per turn (who is asking, where, what is connected, the trigger) goes in front
  of the ACP prompt text.
- **One Chat thread is one Hermes session (HE-18).** The runner stores the Hermes session id where it stores a
  provider session today and resumes it (`session/resume`, else `session/load`).

### Streams

| Stream | Repo, worktree, branch | Owns |
|---|---|---|
| P plugin | Whombat `~/Code/.wt/whombat-he1-p`, `he1-p` | `packages/hermes-whombat/` (new, Python 3.14, package `whombat_hermes`, tests with pytest against the pinned Hermes): the **Claude Code mode** (HE-05) modelled on Hermes's Codex mode (`agent/codex_runtime.py`, `agent/transports/codex_app_server*.py`, `codex_event_projector.py`, `hermes_cli/codex_runtime_switch.py`): the unmodified `claude` in stream-JSON mode runs the whole turn on the asker's sign-in, Hermes's prompt as its system prompt, every Hermes MCP server plus Hermes's tool callback plus a live-agent MCP server for **memory and session search** (HE-07) on `--mcp-config`, Claude's events projected into Hermes's messages so memory and skill review keep working, permission questions through Hermes's approvals (so they reach ACP `session/request_permission`), interrupt, a follow-up into the running turn, the Claude session resumed per Hermes session. Hermes's **auxiliary model calls** (titles, compression, the memory and skill review fork) never go to a provider API on a subscription: they run through the same CLI or are off, and the trial records which. The `TerminalEnvironmentProvider` to the computer, a `pre_tool_call` hook skeleton (HE-17: sees every tool call, fails closed), the `whombat.md` prompt section. A seam Hermes lacks (it has none for a whole-turn runtime besides Codex's) is a small patch file in `packages/hermes-whombat/patches/` applied to the pinned source, written to be offered upstream (not offered: John's call). |
| R runtime | Whombat `~/Code/.wt/whombat-he1-r`, `he1-r` | `packages/agent-runtime/src/hermes/` (new): `HermesProvider` on the existing ACP client code (`src/acp/`): `hermes acp` per turn with the person's `HERMES_HOME`, the config and `whombat.md` writer, the MCP bridge, sessions, ACP updates → turn events and activity, `session/request_permission` → Whombat's tool policy (as the CLIs' permission questions are answered today), Stop as `session/cancel`, follow-ups into the running prompt, usage. Runner wiring (`apps/runner/src/registry.ts`, `turn/**`, `managed*.ts`): for the trial only, the turns of the people listed in `WHOMBAT_HERMES_ACCOUNTS` (account ids) run on Hermes with their agent's provider (claude → `claude_code`, codex → `codex_app_server`); everyone else as today. The profile mount and lock in the managed sandbox. Development: `pnpm hermes:install` (a uv environment at the pin, our plugin installed editable) and `WHOMBAT_HERMES_BIN`. Tests with a fake Hermes (extend `src/acp/testing/fake-agent.mjs`). |
| N image | appliance `~/Code/.wt/appliance-he1-n`, `he1-n` | Hermes in the image (HE-10): a flake input pinned to v0.22.5, its own uv2nix package with only what the ACP gateway, MCP and our plugin need (no desktop, TUI, web UI, messaging, voice), Python 3.14, our plugin and patches from the runtime input (`packages/hermes-whombat`), `WHOMBAT_HERMES_BIN` and `WHOMBAT_HERMES_ROOT` for the runner, the profile root under `/persist` (backups come in step 3), egress for what Hermes itself needs (nothing beyond the CLIs' hosts with these settings: check). Closure size measured. Builds the DEV image (`nix build`) and a NixOS VM check if one exists for the runner. |
| T trial | the lead (or one stream it starts) | After P, R and N are on `main` and a DEV host release carries them: John's DEV box, his Chat on Hermes (`WHOMBAT_HERMES_ACCOUNTS` set on the box by hand for the trial), real tasks (a website deploy to a test target, never the Whombat website; a Home Assistant check), Claude and ChatGPT. Measured against today's engine on the same tasks: memory, skill learning, approvals, Stop, follow-ups, speed (first token, turn time, Hermes start). ACP against the TUI gateway (`tui_gateway`: submit, steer, interrupt) on the development host. Findings as HE-30 onwards, a new pin, John's short result. |

## Step 2: Hermes becomes the engine (HE-01, HE-03…HE-15; lead decisions HE-30…HE-36)

Every turn goes Whombat → Hermes → CLI (or Hermes's own loop for the extras). Starts when step 1 is live on DEV; the
trial's tasks on John's box finish beside it (HE-30). Inventory: `inventory.md` “Step 2” parts.

**Shape, fixed here.**
- **One provider**: `HermesProvider` runs every live turn; `WHOMBAT_HERMES_ACCOUNTS`, `WHOMBAT_AGENTS`, the Claude, Codex,
  generic ACP and scripted providers go. What the usage probes, model lists and sign-in need of the CLI wrappers
  (`claude/cli.ts`, `protocol.ts`, `auth-status.ts`, `codex/app-server.ts`, `json-rpc.ts`, `home.ts`, `protocol.ts`) stays.
- **Model sources (HE-32)**: `claude` and `codex` on the turn's person's own sign-in run in Claude Code mode and Codex
  mode; the same agent on an organisation key, or switched onto the AI gateway, runs on Hermes's own loop (Hermes's
  Anthropic or OpenAI-compatible provider: the key in Hermes's environment, or the gateway through the sandbox's
  forwarder `127.0.0.1:47104` with the agent token, the relay putting the gateway's key in); `local`: an
  OpenAI-compatible model on the owner's network (base URL and model, set by owners), Hermes's own loop. Never a
  subscription on Hermes's own loop.
- **The Chat runtime picker stays** (HE-31): a thread's provider, model, effort and fast replies override the agent's
  in that thread's Hermes config.
- **Scripted (HE-33)**: one scripted ACP agent stands in for Hermes through `WHOMBAT_HERMES_BIN` — the demo storyline and
  canned replies, the Whombat MCP calls through the bridge it gets in `session/new` — for the demo, the server's
  integration tests (57 files run the runner today) and the runner's tests; unit tests of the provider use the fake.
- **The prompt (HE-11, HE-34)**: `SOUL.md` (who the agent is), `whombat.md` (the talk-like-people rules and what is
  stable for the person), the per-turn preface (who is asking, where, what is connected, the trigger). Rules about
  Whombat's own tools move into those tools' MCP descriptions. The persona builder, prompt hashes, earlier-run
  summaries and prompt-size tooling go.
- **The computer always exists (HE-13, HE-35)**: appliances on Incus as today; development and the dev stack on
  computerd's `local` backend (the agent's home a directory on the host, each command in bubblewrap with the turn's
  network rules); tests on the fake. The no-computer paths (guarded workspace on the host, `persona/scratch`, “with a
  computer or without”) go.
- **Feedback assessments (HE-36)**: read-only on Hermes — Claude Code mode with read tools only (Read, Grep, Glob) and
  Hermes's own terminal and file tools off, Codex mode in its read-only sandbox, no network, only the feedback MCP tools.

| Stream | Repo, worktree, branch | Owns |
|---|---|---|
| C contracts | contracts `~/Code/.wt/contracts-he2-c`, `he2-c` | 0.124.0 (CT-1150…): `AgentProvider` `claude \| codex \| local` and the local model's definition and session ops; ACP runtime types, the capability matrix, `AgentsMode`, `scripted`, `AgentPersona`, prompt hashes, `ForkFromSession`, `EarlierRun*`, `SESSION_PROMPT_CHANGED`, `ACTIVITY_NO_TELEMETRY`, the dead `delegate`/`pass_on`/`report_back` activity labels go; Hermes's version and readiness in the runner's status; copy. Provisional `dist-release/0.124.0` for the lead to vendor. |
| E engine | Whombat `~/Code/.wt/whombat-he2-e`, `he2-e` | `packages/agent-runtime` providers and contract, `apps/runner` registry, turn phases, activity, attachments, steering, sessions, gateway and org keys onto Hermes's own loop (with stream X's config pieces), the server's runtime service and provider discovery (`host.agents`, `runtime/service.ts`, `readiness.ts`, `commands/agents.ts`, backups' agent record), ACP's server tests deleted. |
| S scripted | Whombat `~/Code/.wt/whombat-he2-s`, `he2-s` | the scripted ACP agent (from `scripted/` and `acp/testing/fake-agent.mjs`), `apps/server/src/test/runner.ts` and the 57 integration tests on it, the demo (`sv/demo/**`) on it, crew names in comments, examples and the storyline (step 0's ~250 lines). |
| P prompt | Whombat `~/Code/.wt/whombat-he2-p`, `he2-p` | `apps/runner/src/prompt.ts` → HE-11 only, `persona/**` trimmed, tool rules into `apps/server/src/mcp/**` descriptions, `repo-instructions.ts`, prompt tests, `scripts/prompt-size`, `SOUL.md`/`whombat.md`/preface writers (with E). |
| X extras and computer | Whombat `~/Code/.wt/whombat-he2-x`, `he2-x` | HE-08 on Hermes's own loop: the org key, the gateway and the local model in Hermes's config (the plugin side in `packages/hermes-whombat` too: the `TerminalEnvironmentProvider` is how that loop reaches the computer); the local model's server commands and checks; HE-13: computerd's `local` backend, computers on in development and the dev stack, the no-computer paths deleted, feedback read-only (HE-36); the plugin passes the CLI only an allowlisted environment (no `ANTHROPIC_*` from Hermes's own). Codex pinned for development and tests (`login.test.ts`). |
| W app | whombat-app `~/Code/.wt/app-he2-w`, `he2-w` | after C's dist: the ACP runtime rows and picker, capability matrix and scripted notices go (web, client, Android); “A model on your network” in Settings → AI and the Chat picker; step 0 leftovers (“hire” in stories and styles, the crew in visual references, `e2e-managed/licence.spec.ts`). 0.126.0, visual check in both themes. |
| N2 appliance | appliance `~/Code/.wt/appliance-he2-n`, `he2-n` | the dev stack with Hermes (`WHOMBAT_HERMES_BIN`, the profile root) and computers (`local` backend), harness scenarios and devbox checks on Hermes, a new Hermes pin from the trial, the pre-existing `runtime-live-turn` VM test fixed. |

## Step 3: Whombat stops doing what Hermes does (HE-16…HE-21; lead decisions HE-38…HE-45)

Starts once step 2 is live on DEV. Inventory: `inventory.md` “Step 3” parts.

**Shape, fixed here.**
- **The Hermes homes are the runner's (HE-38).** The server never touches `WHOMBAT_HERMES_ROOT`; it reads and changes
  memory, skills and sessions through the runner's internal API (like the sign-in executor): read and write a person's
  memory files, list and edit skills, delete a session, export and import a home for backups.
- **Memory (HE-39):** each person's Hermes profile holds `MEMORY.md` (what the agent learned working with them) and
  `USER.md` (about them); each person sees and edits only their own (OA-10). The agent's notes that owners write for
  everyone (Settings → Agent → Notes) go into `whombat.md` for every profile. Our memory system (items, checkpoints,
  summaries, profiles, notes tables, reflection, the memory MCP tools, `DispatchContext.memory/profile/notes`) goes.
- **Sessions (HE-40):** one Chat thread is one Hermes session (HE-18); a resumed session gets only the messages since
  its last turn, a new one the window; deleting a thread or clearing chats deletes its sessions; Whombat keeps the
  messages for display, search and the audit log.
- **Skills (HE-41):** the shipped defaults and what owners add live in one shared directory every profile reads
  (`skills.external_dirs`), read-only during turns; what the agent learns or changes lands in the person's own profile;
  owners may share a learned skill with everyone. Settings → Skills shows both (“For everyone”, “Learned with you”).
  Our store, proposals and skill MCP tools go; imports (zip, link) stay as a way to add to the shared directory, with
  the scanner; Hermes's own skill hub stays off.
- **Browser (HE-42):** Hermes's browser tools drive a Chromium on the agent's computer over CDP (bridged into the task
  sandbox like the exec service), so browsing obeys the computer's wall (HE-15); a person's Vault logins reach
  Hermes's credential vault only in their own turns. Our browser host, sessions and `browser_*` tools go; previews and
  the deploy screenshot stay.
- **Vault (HE-43):** entries stay Whombat's and private per person; an entry switched on for the agent is put on the
  computer only during its owner's turns (AC-30/31) and removed after. The Ask level, passes, relayed requests
  (`vault_request`, `vt_*`, `request_vault_key`, the server's `ssh_*` relay) go.
- **Approvals (HE-44):** the plugin's `pre_tool_call` hook gets the turn's policy from Whombat (`whombat-policy.json`,
  from the agent's keys: Off blocks, Ask asks, Allowed runs); Ask becomes Hermes's approval → ACP
  `session/request_permission` → a card in the person's thread, the turn waiting for the answer. Servers and
  connections stay Whombat tools with “Asks you first”. Step 0's loose ends here: the decline notice naming the
  requester twice, and a late “Allow for this task” covering the woken turn.
- **Schema (HE-45):** tables that go stay in the schema, unused, until one contract migration at the end of step 4
  (with a backup checkpoint on the DEV box), so no step needs a checkpoint before then.

| Stream | Repo, worktree, branch | Owns |
|---|---|---|
| C3 contracts | contracts `~/Code/.wt/contracts-he3-c`, `he3-c` | 0.125.0 (CT-1200…): Hermes memory view/edit (file text, budget, updated), skills from Hermes (shared and learned, share, switch off, restore), sessions; memory items/checkpoints/summaries/profile entries, proposals, `browser_*`, Vault tiers/passes/requests, `vault_use` approvals, `memory.propose`/`skills.propose` keys, `REFLECT_*` and their copy go; backup records for Hermes homes. |
| M memory and sessions | Whombat `~/Code/.wt/whombat-he3-m`, `he3-m` | the runner's Hermes-home service (memory, sessions, export/import); `sv/memory/**` deleted but the routes for the new view/edit; `whombat.md` with owners' notes; only new messages to a resumed session; thread delete and Clear chats delete sessions; backups (`.wbk`) with every Hermes home, restore proven. |
| K skills | Whombat `~/Code/.wt/whombat-he3-k`, `he3-k` | the shared skills directory, the shipped defaults synced into it, Settings → Skills on Hermes's files through M's service, imports into it with the scanner, share-with-everyone; the store, proposals, uses, curator, skill MCP tools and `rn/skills.ts` deleted; the 64 KiB import cap. |
| B browser | Whombat `~/Code/.wt/whombat-he3-b`, `he3-b` | Hermes's browser on the computer's Chromium over a CDP bridge, Vault logins into Hermes's credential vault in their owner's turns, the feedback assessor's look at a website; `sv/browser/**` (host, sessions, tools, supervisor) deleted; plugin side in `packages/hermes-whombat`. |
| V Vault and approvals | Whombat `~/Code/.wt/whombat-he3-v`, `he3-v` | the Vault without Ask, passes and relays; keys on the computer only in their owner's turns; the hook's policy from the agent's keys, Ask as a card through `session/request_permission`; the two approvals loose ends; the **two-person privacy tests** (OA-10) across memory, skills, sessions, Vault and connections on the scripted Hermes. |
| W3 app | whombat-app `~/Code/.wt/app-he3-w`, `he3-w` | 0.127.0: memory per person (About you, what the agent remembers), Settings → Skills on Hermes (two groups, share), Vault without Ask tier and delivery chooser, the browser bits; web and Android, both themes. |
| N3 appliance | appliance `~/Code/.wt/appliance-he3-n`, `he3-n` | the Hermes homes in the box's backups and restore, the computer image's Chromium for CDP, the old browser unit gone, harness scenarios. |

## Step 4: one product shape (HE-22, HE-23, HE-27; lead decisions HE-48…HE-56)

Starts once step 3 is live on DEV. Inventory: `inventory.md` “Step 4” parts.

**Shape, fixed here.**
- **One runtime mode (HE-48):** the appliance's. `WHOMBAT_MODE=selfhosted`, the `whombat` CLI install (init, start,
  service, upgrade, install, doctor…; `schema-check`, `migrate` and the release library stay), the self-hosted release
  archive, trusted and guarded access, host `gh`, workdir roots and the owner's clone, the HTTP client paths (cookie and
  bearer sign-in, magic links for clients, `/ws`, `/collab`, the runtime serving the web app for HTTP clients), the
  Tailscale identity listener, the self-hosted Claude/Codex installer and the legacy import go.
- **Development (HE-49):** `pnpm dev` runs that one mode with development stand-ins: no licence (the same no-licence
  switch the community edition gets in step 5), an identity made at first start, the manager's sockets stood in, a
  development-only way to enrol a browser on this machine, FakeGitHub, the scripted Hermes by default, computerd's local
  backend. The appliance's dev stack stays the full environment (relay, control, manager).
- **One encrypted connection (HE-50):** web and Android speak the same Noise session three ways: through the relay
  (as today), or **directly** to the box over the local network or Tailscale — a direct listener on the box with the
  same Noise XX and frames, admission by the box itself (an enrolled device's key; no control ticket). Clients learn
  the box's direct addresses from it and try direct first, the relay after. A browser reaches the box directly from a
  page the box serves itself: over HTTPS on its Tailscale name (`tailscale cert`), over plain HTTP on the local network
  (everything inside still end-to-end encrypted; what needs a secure context says it isn't available there). Android
  connects directly to both. The HTTP transport goes from both clients.
- **Tailscale in the image (HE-51)**, off until an owner signs it in from Settings → This Whombat (Tailscale's own login
  link); the firewall opens the direct port on the local network and `tailscale0` only (reverses NX-22's “nothing
  inbound” for that one port).
- **No compatibility code (HE-52):** contracts **1.0.0** without runtime feature flags, `LEGACY_*`, API-level windows and
  the previous protocol — a client and a box speak one major version, else the client says “update the app”;
  older-phone gates, skew tests and release skew checks, the manager's legacy report formats and closures, control's
  API-level window and manager floors go. Schema rollback classes (`db/compat.ts`, MD-*) stay: they keep box updates
  safe, they're not client compatibility.
- **The schema clean-up (HE-53):** one contract migration drops every table steps 2–3 left unused and the
  `prompt_hash` columns; the DEV box gets a backup destination for its checkpoint first.
- **What stays outside (HE-54):** production (app.whombat.com runs the old self-hosted mode and is John's to update) and
  the standalone `whombat-dev` (:4420, HE-47) are left as they are; John is told.
- **Docs (HE-55):** CLAUDE.md, ARCHITECTURE.md and every README describe the one way; the self-hosted docs go.
- **Push and mail (HE-56):** the box's own Web Push and SMTP code stays for the community edition (step 5).

| Stream | Repo, worktree, branch | Owns |
|---|---|---|
| C4 contracts | contracts `~/Code/.wt/contracts-he4-c`, `he4-c` | **1.0.0** (CT-1250…): features/legacy/API-level windows/previous gone, one version check; self-hosted auth, workdir, access, sandbox, `host.*`, host-`gh` shapes gone; direct-connection shapes (the box's direct addresses, local admission, the direct listener's hello) in protocol and secure-channel; Tailscale status and sign-in for This Whombat. |
| R1 one mode | Whombat `~/Code/.wt/whombat-he4-r1`, `he4-r1` | HE-48, HE-49, HE-53, HE-55: self-hosted mode and its code deleted, `pnpm dev` on the one mode with stand-ins, skew/legacy code, the clean-up migration, CLAUDE.md, ARCHITECTURE.md, READMEs. |
| R2 direct | Whombat `~/Code/.wt/whombat-he4-r2`, `he4-r2` | HE-50/51 in the runtime: the direct listener and local admission, the box serving the web app for direct browsers (LAN HTTP, Tailscale HTTPS), the direct addresses to clients, the Tailscale status and sign-in ops, development enrolment. |
| W4 app | whombat-app `~/Code/.wt/app-he4-w`, `he4-w` | **1.0.0**: the HTTP transport, auth screens and feature gates gone; the direct connector (web and Android) with direct-first, relay fallback; the web build the box serves; Tailscale in Settings → This Whombat; fixtures on the session fake; e2e/visual on it. |
| N4 appliance | appliance `~/Code/.wt/appliance-he4-n`, `he4-n` | Tailscale in the image, the firewall's direct port, the runtime's web build on the box, the manager's/helper's/release tools' compatibility code, harness scenarios with direct-path variants. |
| A4 control | control `~/Code/.wt/api-he4-a`, `he4-a` | control's API-level window, `LEGACY_API_LEVEL`, manager floors and contract forcing gone; anything control must say about direct addresses. |

## Step 5: editions and licences (HE-24…HE-26; lead decisions HE-57…HE-64)

Starts once step 4 is live on DEV. Inventory: `inventory.md`, the appliance part's “Step 5”.

**Shape, fixed here.**
- **Two editions of one image (HE-58):** `whombat.edition = commercial | community`. Community: no licence check (the
  runtime's no-licence switch from HE-49), no control (no registration, admission tickets, relay or remote help), Tailscale
  on and offered at setup, its own signed update channel: a TUF repository of its own and the manager taking the newest
  release from it without a control assignment. Commercial: unchanged (relay, control, managed rollouts, remote help,
  the box).
- **Claim, sign-in and joining without control (HE-59, HE-60):** on a community box the four-letter claim runs over the
  direct connection from the box's own page (local network or Tailscale), the first owner is made there, people join with
  an invite link or QR the box makes, devices enrol locally over the direct connection; passkeys only on the HTTPS
  Tailscale page.
- **Push and mail without control (HE-61):** Web Push from the box itself where the page is secure; no Android push (no
  Firebase key — the app checks when it opens); email through the owner's own SMTP server, optional.
- **Licences (HE-63):** AGPL-3.0 for the runtime (Whombat), contracts, apps, the appliance image and the servers agent
  (the hosts service): `LICENSE`, `package.json`/Go module licence fields, a NOTICE with third-party notices (Hermes's MIT
  notice in the image's); closed: control, the relay and the update service, whose code
  (`static-server.ts`, `tufrepo`, `clientchannel`) moves from the appliance to control; drafts in each open repo's
  `docs/legal/`: a contributor agreement and a note on the name “Whombat”. Nothing is published: repositories stay
  private, no public mirror, no public channel.
- **Done (HE-64):** the community ISO builds, installs in a VM through `agent-resource`, is claimed over its direct page
  and reached over Tailscale — a Headscale coordination server in an `agent-resource` container (the community edition
  lets an owner name their own login server), so John's tailnet isn't touched.

| Stream | Repo, worktree, branch | Owns |
|---|---|---|
| C5 contracts | contracts `~/Code/.wt/contracts-he5-c`, `he5-c` | 1.1.0: the edition in what clients read, local claim/invite/enrol over the direct connection, Tailscale's own login server, the signed `tailscale.*` event (step 4's note), SMTP settings, Web Push without control. |
| R5 runtime | Whombat `~/Code/.wt/whombat-he5-r`, `he5-r` | the community edition's runtime: no licence outside development only in community, claim/first owner/invites/enrolment without control, Web Push and SMTP from the box, Tailscale's login server, the signed event. |
| W5 app | whombat-app `~/Code/.wt/app-he5-w`, `he5-w` | 1.1.0: the community setup on the box's page (claim, owner, Tailscale), invites by link/QR, no relay or control paths in community, the login-server field. |
| E5 community image | appliance `~/Code/.wt/appliance-he5-e`, `he5-e` | `whombat.edition`, `community-instance.nix`, the manager's TUF-only update mode, community TUF root and client-channel keys (test keys only, never published), the community installer ISO, the VM install test through `agent-resource` with Headscale. |
| L5 licences | every repo, `~/Code/.wt/<repo>-he5-l`, `he5-l` | HE-63 across Whombat, contracts, app, appliance, the hosts service (open) and control, relay (closed); the update service's code moved to control's repository; drafts of the contributor agreement and the name note. |

## Rules for every stream

- Node 24 and TMPDIR: `export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH`,
  `export TMPDIR=/home/me/.cache/wb-tmp`. Postgres :55432 with your own throwaway databases only; never stop or reset
  shared containers.
- Search only inside your worktrees, the repositories named in your brief and `~/.cache/wb-tmp/hermes/src`; never
  `find`/`grep` over `/` or `$HOME`.
- Temporary Docker containers or VMs only through `agent-resource` (`/home/me/Code/dashboard/docs/agent-resources.md`);
  release every lease before you report.
- No production (app.whombat.com, `~/Services/whombat`, `scripts/deploy/deploy.sh`, `release/ship promote-prod`), no
  publishing, no DEV box or dev stack changes: the lead ships.
- Never send a subscription through Hermes's own Anthropic OAuth or `auth.adopt_external_logins`; the unmodified `claude`
  and `codex` binaries run every subscription turn (SUB-01, SUB-04, HE-05). On this machine the host's own `claude` and
  `codex` logins may be used for development tests of the CLI path, never copied anywhere.
- Delete, don't deprecate: the product is unreleased (HE-27). Tests check facts (ids, names, codes), not long text
  (`docs/decisions/test-speed.md`). Words people see follow `concise-replies.md`.
- Commits small, imperative (`runtime: add the Hermes provider`), ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never push, never merge into `main` or
  `hermes`; when the lead says “merge hermes”, `git merge hermes` into your branch.

## Finishing a stream

`pnpm format`, then the repository's check (Whombat `TMPDIR=~/.cache/wb-tmp pnpm check`, plus `pnpm test:server` when the
server changed, against your own throwaway database; the plugin's pytest; appliance per its README and `nix build` of
what you changed), all green; commit; report to the lead in at most 300 words: commits, what's done, what's left,
decisions you added (HE-3x, HE-Sxx), anything another stream must know.

## Lead: merge and ship (not for streams)

Per step: streams → `hermes` per repository → contracts released (tag, `dist-release`) and vendored → app released
(tag, APK on DEV downloads) and vendored → Whombat `hermes` → `main` (pushed; `~/Code/Whombat` fast-forwarded) →
`dev/candidate` for a runtime-only change, `release/ship all <id>` when the image, manager or host changed (Hermes in
the image is such a change) → a real thread on DEV read → John told in percentages.

---

## The hand-off brief (verbatim)

# Hand-off: Whombat on Hermes Agent, steps 1 to 5

You take over the Whombat engine rebuild from the session that planned it and built step 0. Your job: implement
steps 1 to 5 of `docs/decisions/hermes-engine.md` (HE-01…HE-29) fully. Land each step on `main` in every repository it
touches and put it on DEV (dev.whombat.com and John's DEV box) before you start the next. John said “implement steps 1
to 5 fully”, so work through them without waiting for him, except at the stop points below. You orchestrate from the
main checkout `~/Code/Whombat`; helper agents write the code in worktrees.

## Read first

- `~/Code/Whombat/CLAUDE.md` (rules, commands, shipping, the DEV box, remote help), and the CLAUDE.md of every other
  repository you change.
- `docs/decisions/hermes-engine.md`: the plan. It is settled; don't reopen it. New questions get HE-30 onwards there.
- `docs/decisions/one-agent.md` (OA-01…OA-24 and the OA-S server details): step 0, done. OA-10 (privacy with one shared
  agent) and OA-11 (sign-ins) carry into everything you build.
- `docs/decisions/provider-subscriptions.md` (SUB-01, SUB-04, SUB-57), `agent-computer.md` (AC-02 above all),
  `concise-replies.md`, `vault.md`, `vault-self-serve.md`, `skill-store.md`, `browser.md`, `self-hosted.md`,
  `ai-gateway.md`, `model-effort.md`.
- `docs/implementation/one-agent/assignment.md` and `inventory.md`: how step 0 was split into streams and inventoried.
  Do the same here.
- The research, with sources: `~/.cache/wb-tmp/research/2026-10-23-engine/engines.md`. Hermes's source is beside it in
  `hermes-src/` (commit afe3cbd8, 2026-10-23).
- The appliance runbooks `~/Code/whombat-appliance/docs/runbooks/shipping.md` and `dev-instance.md`.
- The memory file `whombat-engine-hermes.md`, the state log of this work. Keep it current.

## Where things stand (2026-10-23)

- Step 0 (one agent) is on `main` everywhere and live on DEV:
  - contracts 0.123.0 (tag `contracts-v0.123.0`);
  - whombat-app 0.125.0 (tag `app-v0.125.0`);
  - appliance candidate 0.141.0, on host release `whombat-dev-20261023.1`.
- The database has one migration baseline, `0000_baseline`. Later steps migrate normally.
- Fresh installs:
  - the DEV box `wb-r7m4-6nbc-3307` (“Cybex BV”, agent Neo);
  - the dev stack `whombat-stack-dev`;
  - the standalone `whombat-dev` (:4420).
- John's Z13 “Home” (`wb-h7mq-2xvd-4410`) is on 0.141.0 with an empty database and waits for him to claim it.
- The engine today: Whombat's runner runs the Claude Code CLI (stream-JSON) and the Codex app-server in its managed
  sandbox. Their shells run on the agent's computer, an Incus container inside the appliance (AC-02).
- John still has to:
  - sign in on dev.whombat.com and join the DEV box;
  - sign in to Claude or ChatGPT there;
  - upload the 16 skills waiting in `~/Downloads/whombat-hermes-skills-16-to-accept.zip`;
  - claim Home.
- The trial's real tasks need his Claude sign-in on the DEV box. Check whether it is there. If it isn't, ask him once,
  in one short message at the start, and build in the meantime.

## Hermes facts that shape the design (check each against the pinned source)

- **ACP.** `hermes acp` is a viewer of a per-profile gateway daemon that it starts itself.
  - It takes client stdio MCP servers in `session/new`.
  - It sends `session/request_permission` for dangerous commands, edits and clarify questions.
  - It answers cancel with `stopReason: cancelled`.
  - It uses ACP's unstable methods (resume, fork, list).
  - It ignores ACP's client terminal and file methods, so commands and files run where Hermes runs.
  - Its TUI gateway (JSON-RPC: submit, steer, interrupt) is the alternative HE-01 asks the trial to compare.
- **Codex mode exists** (`model.openai_runtime: codex_app_server`, `hermes_cli/codex_runtime_switch.py`). It runs
  `codex app-server`, and Codex's own shell and patch tool replace Hermes's loop. Memory, `delegate_task`,
  `session_search` and todo are missing in that mode.
- **There is no Claude Code mode.** You build it as a Hermes plugin, modelled on the Codex mode (HE-05).
- **Subscriptions.** The unmodified `claude` and `codex` binaries run each turn on the asking person's own sign-in,
  exactly as today's onboarding sets it up (HE-04, HE-09, SUB-04). Never let a subscription go through:
  - Hermes's own Anthropic OAuth: it bills only Max extra usage, and Pro can't use it;
  - `auth.adopt_external_logins`: two programs sharing one login break its rotating refresh token.
- **Hooks.** `pre_tool_call` sees every tool call and fails closed. Container terminal backends skip dangerous-command
  approvals (`skip_container_guards`), so Whombat's hook is the gate (HE-17).
- **Profiles.** Each profile is a home with its own memory, sessions (`state.db`) and skills. Never run two processes on
  one profile. One gateway can serve several (`gateway.multiplex_profiles`). Use one profile per person, with shared
  skills (HE-16).
- **Where commands run.**
  - Hermes's own terminal and file tools go through `TerminalEnvironmentProvider`. Use it for Hermes's own loop (the
    HE-08 extras).
  - The CLIs' own shells keep going to the computer through today's path (AC-02, `apps/runner/src/computer.ts`).
- **Pinning.** Hermes needs Python 3.14 and ships several releases a week with breaking changes. Pin it and build it
  into the image yourself (HE-10).

## The steps and what “done” means

### 1. Trial on the DEV box (HE-28)

- **Set-up:** Hermes is pinned and runs in the box's sandbox next to the computer, with a first Claude Code mode plugin
  and the Codex mode. Whombat drives it over ACP for one person's Chat.
- **Real tasks:**
  - a website deploy to a test target, never the Whombat website, which is not published;
  - a Home Assistant check.

  If the DEV box lacks a connection a task needs, ask John to add it and run the rest meanwhile.
- **Measure** against today's engine: memory, skill learning, approvals, Stop, follow-ups and speed. Also compare ACP
  with the TUI gateway.
- **Done:** John gets a short plain-English result, the findings are recorded as decisions, and Hermes has a new pin.
  Then carry on.

### 2. Hermes becomes the engine (HE-01, HE-03…HE-15)

- **Flow:** every turn goes Whombat → Hermes → CLI.
- **What goes:**
  - Whombat's own Claude, Codex, generic-ACP and scripted adapters. The scripted demo becomes a scripted ACP agent, and
    unit tests use a fake Hermes.
  - Our persona builder. The prompt adds only HE-11's items.
- **What stays:** onboarding sign-in, exactly as it is, and GitHub through Whombat.
- **Tools:**
  - Our plugin gives the CLI memory and conversation search.
  - Hermes gives it skills, the web and Whombat's tools over MCP.
  - API keys, Fusebox and local models run on Hermes's own loop.
- **The computer always exists,** in development too.
- **Done:**
  - live on DEV, with one real turn on Claude and one on ChatGPT, each on John's own sign-in;
  - Stop and follow-ups work;
  - the old adapters are deleted.

### 3. Whombat stops doing what Hermes does (HE-16…HE-21)

- **Hermes owns sessions, memory and skills.** One Chat thread is one Hermes session.
  - Whombat shows, edits and backs them up, and ships the default skills into Hermes.
  - Our memory system, skill store and browser go.
- **The Vault stays Whombat's, private per person.** A key goes onto the computer only during its owner's turns. The
  Ask level, passes and relayed requests go.
- **Approvals:** Off / Ask / Allowed through the hook, with Ask as a card. Servers and connections stay Whombat tools
  with “Asks you first”.
- **Done:**
  - live on DEV;
  - the privacy rule (OA-10) proven by tests with two people;
  - backups include the Hermes homes, and restoring them works.

### 4. One product shape (HE-22, HE-23, HE-27)

- **The install-on-any-Linux mode goes:** the `whombat` CLI install, trusted and guarded agents, host `gh` and
  workdir roots.
- **Development** still runs with a computer. CLAUDE.md, ARCHITECTURE.md and the READMEs describe the new way.
- **One connection:** web and Android use one encrypted connection, through the relay or directly over Tailscale or the
  local network.
- **Compatibility code goes:** protocol-skew support, older-phone compatibility and the rest. The contracts get a clean
  major version.
- **The standalone `whombat-dev` (:4420)** is a self-hosted install. Leave it on its last working version, tell John,
  and stop it only when he says.
- **Done:** live on DEV, with web and Android connecting all three ways.

### 5. Editions and licences (HE-24…HE-26)

- **Community image:** the same image without a licence check, with Tailscale built in and its own signed update
  channel.
- **Commercial edition:** keeps the relay, managed rollouts, remote help and the box.
- **Licences:**
  - AGPL-3.0 licence files and notices on the open parts;
  - control, the relay and the update service stay closed;
  - a contributor agreement and a note protecting the name, both as drafts.
- **Done:** the community image builds, installs in a VM through `agent-resource`, and is reached over Tailscale.
  Nothing is published.

## Stop and ask John only for

- **His calls:**
  - anything on production (app.whombat.com, `~/Services/whombat`, `scripts/deploy/deploy.sh`,
    `release/ship promote-prod`);
  - publishing the website;
  - making a repository or update channel public;
  - offering the Claude Code mode to the Hermes project.
- **A trial result that breaks a settled rule:**
  - a subscription can't run through the CLI under Hermes within SUB-01 and SUB-04;
  - Hermes can't do the job, so HE-02 would need reopening.
- **Data:** wiping or resetting data on the DEV org or on Home beyond what step 0 had approved.

Everything else: decide, record it with the reason in `docs/decisions/hermes-engine.md` (or the matching workstream
file), and mention it in your report.

## How to work

- **First commit:** this brief and your stream plan as `docs/implementation/hermes/assignment.md`, plus `inventory.md`
  listing what goes, by repository and file.
- **Helper agents** work in `~/Code/.wt` worktrees, one area each. Brief each one with the goal, the files and these
  rules:
  - no searches across `/` or `$HOME`;
  - temporary Docker containers or VMs only through `agent-resource`;
  - no production;
  - the commit trailer from CLAUDE.md.

  John allows more than 3 at once; use judgement. You merge, check and ship.
- **Contracts first,** released as tagged tarballs and vendored, as in step 0. App releases get the APK on DEV
  downloads.
- **UI:** the mocks win. Check web and Android visually in both themes.
- **Checks:** run CLAUDE.md's quick checks in each repository you change (`pnpm format`, `pnpm check`, and
  `pnpm test:server` when the server changed), one repository at a time. Don't run the long validation or wait for CI
  nobody asked for.
- **Shipping:**
  - `dev/candidate` for runtime-only changes;
  - `release/ship build <id> --host` when the image, manager or host changes. Putting Hermes in the image is such a
    change.

  Run long commands in the background, and don't sit in sleep loops.
- **What the agent says:** everything it posts in a conversation talks like people (concise-replies.md). Read the
  result in a real thread.
- **Progress to John:** in percentages, short and plain, whenever a stream lands and at least about once an hour. After
  each step, tell him what changed, where to try it and what he must do.

## Also: step 0's loose ends

They are listed in `~/.cache/wb-tmp/one-agent/followups.md`. Clear them along the way:

- **Shows in the app:**
  - the approvals decline notice names the requester twice;
  - the 64 KiB skill-import cap;
  - a late “Allow for this task” yes doesn't cover the woken turn.
- **Tests:**
  - the visual-suite references still show the crew;
  - `apps/web/e2e-managed/licence.spec.ts` expects the old wording;
  - `packages/agent-runtime/src/providers/login.test.ts` fails because the host's Codex is 0.164.0. Fix it when you pin
    Codex in step 2.
- **Leftovers in code:**
  - “hire” in comments, story files and style names (whombat-app `Agents.stories.tsx`, `--size-modal-hire`);
  - the dead `delegate`, `pass_on` and `report_back` activity labels in the contracts;
  - crew names in about 190 lines of comments and the demo storyline. Clean those up with the scripted provider in
    step 2.
- **Test databases:** drop the `whombat_test_*` databases on :55432 that are idle and older than a few hours, and only
  those.

## When you're done

All five steps are on `main` and on DEV, the decisions are recorded, the memory file is updated, and no temporary
resources are left (`agent-resource check`). Tell John, in a short plain report, what changed, where to try it, what he
must do and what's still open.
