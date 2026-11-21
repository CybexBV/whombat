# Agent computers (2026-10-02)

John asked to “fully implement” a real computer per agent. The spec is `docs/decisions/agent-computer.md` (**AC-01…AC-52**);
read it first, then the decision files it amends (`managed-sandbox.md` MS-*, `vault.md` VT-*, `runs-approvals.md` MD-*,
`skills-library.md` SL-*). Decide open details yourself, record them in `agent-computer.md` as **AC-Dnn** (next free
number, prefix your stream's letter in the commit message), and move on.

Ship target is **DEV** (fast path, IN-132): each repo's quick checks, merge, push, candidate pins, dev instance
restarted; the DEV box (the real appliance) gets `release/ship all` — computers live only inside appliances (AC-00, AC-23). No `harness/validate`, no
`release/ship validate`, no waiting on GitHub Actions. Production is not part of this task. Use
`TMPDIR=~/.cache/wb-tmp` for every check. Other agents may be running: own throwaway databases and free ports only; never
stop or reset shared containers; never touch Incus instances, networks or ACLs you didn't create (the host runs
`whombat-dev-box`, `whombat-prod-box`, `dashboard` and CI instances).

| Repo | What | Today | Target |
|---|---|---|---|
| `~/Code/whombat-contracts` | `@whombat/core`, `@whombat/protocol` | 0.35.0 (CT-216), `SESSION_API_LEVEL` 25 | **0.36.0** (CT-217+), level 26, feature `agent.computer` |
| `~/Code/Whombat` | server, runner, agent-runtime, new `apps/computerd` | migration `0059_vault_ssh` | migration `0060_agent_computers`, AC-D01+ |
| `~/Code/whombat-app` | web, Android, `@whombat/client` | 0.24.0 (AP-616) | **0.25.0** (AP-617+) |
| `~/Code/whombat-appliance` | harness/dev stack, NixOS, candidates | candidate 0.31.0 (IN-154, NX-128) | candidate **0.32.0** (IN-155+, NX-129+) |

## Streams

1. **Contracts** (first). Everything below as schemas, pure rules and copy, with unit tests; release 0.36.0 the way 0.35.0
   was (tag `contracts-v0.36.0`, `dist-release`), then write `docs/implementation/agent-computer/contracts-0.36.md` here
   listing every new name, and vendor 0.36.0 into Whombat (branch `agent-computer`) and whombat-app (branch
   `agent-computer`).
   - `run_command` approval action (server-only, like `vault_use`), `CommandCategory`, category → key mapping (AC-41),
     `classifyCommand` (AC-40, many tests: positive and negative, quoting, `sudo`/`env`/`bash -c`, ssh option parsing,
     `user@host`, server names and addresses as production targets), normalised command for allowances.
   - `approvals.decide` `scope?: 'once'|'task'|'agent'` (approve of a `run_command` only), `ApprovalView.scopeChoices`
     with the four labels (AC-42), card copy (title, kicker, `content` = the command, target line), `describeAction*`.
   - Command allowances: view type, list/remove ops (agent Access settings).
   - Keys: `commands.destructive`; `branch.main.push` agent-grantable with row `push_main` (“Push to main”) in
     `KEY_TIER_ROWS`; `ROLE_DEFAULT_KEYS` per AC-50; `skills.propose` copy per AC-52.
   - Vault: `VaultKeyView.delivery` (`whombat`|`computer`) + `envName`; give/set-delivery bodies and op; env-name rules
     and default derivation (AC-31); `VaultSshServer.production` and add/update bodies; copy (delivery labels, rotate
     notice AC-34, purpose on the `vault_use` card AC-33); `VAULT_ACCESS_RULES` variant for computer turns; MCP tool
     `request_vault_key {entry, purpose}`.
   - Computers: `AgentComputer` view, states, `computers.get/start/stop/reset` REST + session ops, `HostInfo.computers`
     `{available, reason}`, `DispatchContext.computer` `{productionServers:[{name,host,port}], homeNetworks}`.
   - Runner API: `POST commands/authorize`, `GET commands/authorize/:id` (long poll), `GET dispatches/:id/computer-keys`
     (files, env, needles), `POST dispatches/:id/computer-report` (sweep result).
   - Skills: learned-skill card state + `skills.removeLearned`.
2. **Computer runtime** (Whombat worktree, branch `agent-computer-runtime` from `agent-computer`). `apps/computerd`
   (AC-04…AC-07, AC-10, AC-11, AC-21, AC-32 sweep), the runner side (exec bridge, wrapper, exec service with guard,
   approval wait and ACL opening, turn setup/teardown, git control files AC-22), the server's claim rule (AC-20),
   server ↔ computerd for `computers.*` ops and `HostInfo.computers`. Unit tests with a fake Incus; an integration test
   against real Incus behind `WHOMBAT_TEST_INCUS=1`, cleaning up everything it creates.
3. **Server features** (Whombat worktree, branch `agent-computer-server` from `agent-computer`). Migration 0060
   (`vault_keys.delivery/env_name`, `vault_ssh_servers.production`, `command_allowances`, approval scope), the
   `run_command` approvals (authorize + wait endpoints, card in the turn's thread, scopes, late-yes wake), computer keys
   endpoint + owner/pass rule (AC-30, AC-33), scrubbing of agent posts (AC-32), rotate notice (AC-34), production
   servers + home networks into `DispatchContext.computer`, `request_vault_key`, learned skills active at once (AC-52),
   role defaults wired, `pnpm test:server`.
4. **App** (whombat-app branch `agent-computer`). Vault delivery choice + env name, Production toggle on SSH servers,
   rotate notice; agent settings **Computer** tab (state, size, Start/Stop, Reset with confirm) and status in the profile
   pane; Access: Push to main row, destructive-commands key, allowances list; the `run_command` card (code block, four
   buttons) on web and Android; the learned-skill card with Remove. Light and dark checked. Release 0.25.0.
5. **Prompt** (after 2 and 3 merge): AC-51 and the computer section of the prompt, Vault rules for computer turns.
6. **Appliance NixOS** (in parallel with 2–4): Incus inside the appliance (storage on `/persist`, bridge, nftables
   forward rules, AC-12), the computerd unit (`incus-admin`, socket shared with runner and server), runner/server env
   (`WHOMBAT_COMPUTERS=incus`, `WHOMBAT_COMPUTERD_SOCKET`), a VM test running a container computer inside the appliance;
   candidate 0.32.0 and the DEV box via `release/ship all <id>` (no `--validate`).
7. **Live check on the DEV box** (lead): an agent there builds, installs, uses an SSH key on its computer and asks for a
   production deploy; the dev stack on the host keeps computers off (AC-23).

Only the lead merges into `main` and pushes. Commits end with
`Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
