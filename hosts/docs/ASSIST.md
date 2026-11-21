# Assistant: AI investigations with Claude Code or Codex

> **Headless (inside Whombat) the assistant is off**: no routes, no job, no runner process (ONE-13: Whombat has its own). Its read-only checks and commands are REST routes for Whombat's tools: `docs/WHOMBAT.md` "Inspect, diagnose, exec". What follows describes the non-headless hub with its own UI.

Optional. An admin turns the assistant on under **Settings › Assistant**,
installs Claude Code and/or Codex there with one click, and signs in with
their subscription. Rackoon keeps the CLIs up to date. From an alert (or a
host) **Investigate** starts an investigation: the AI gathers evidence on
the hosts through Rackoon's tools, explains what is wrong and, when its
access level allows, fixes it. Every investigation is a conversation: the
admin can reply at any time, stop it, and (access "ask") approve or decline
each change. Investigations can also start on their own for new alerts.

Decided with the owner (2026-10-17): subscriptions (Claude Pro/Max through a
`claude setup-token` token, ChatGPT through Codex's device login); access is
configurable up to **full** (no approvals); enabling the assistant enables
the read-only diagnostics on every host by default; automatic
investigations are a setting (off by default).

## 1. Architecture

```
browser ── REST + SSE ──▶ rackoon-hub ── unix socket (JSON-RPC) ──▶ rackoon-assist (own sandboxed unit)
                            │  tools, approvals, audit                 │  claude -p (stream-json) / codex app-server
                            │                                          │  MCP server "rackoon" ◀── CLI (stdio bridge)
                            └── yamux streams: diagnose / exec / action ──▶ rackoon-agent on each host
```

- **The hub** owns settings, investigations (SQLite), the tools the AI may
  call, approvals and the audit log. Tool calls run in the hub: it checks
  the settings and the host's switches, then asks the host's agent.
- **rackoon-assist** is the same binary (`rackoon-hub assist serve`) in its
  own systemd unit (`packaging/hub/rackoon-assist.socket` and
  `rackoon-assist@.service`): its own dynamic user, its own state directory
  (`/var/lib/rackoon-assist`: CLI binaries, CLI logins, CLI session
  files), no access to the hub's database, CA key or configuration, and
  without `MemoryDenyWriteExecute` (Claude Code's runtime needs a JIT).
  The hub connects to `/run/rackoon-assist.sock` (`--assist-socket`,
  `RACKOON_ASSIST_SOCKET`); systemd starts one runner per connection and the
  hub keeps one connection open. Without `--assist-socket` (development,
  tests) the hub starts `rackoon-hub assist serve` as a child process with
  its state in `<data>/assist`, and Settings says it is not sandboxed.
- **The CLIs** never get a shell on Rackoon's machine or the hosts:
  - Claude Code: `claude -p --input-format stream-json --output-format
    stream-json --verbose --tools "WebSearch,WebFetch" --strict-mcp-config
    --mcp-config <rackoon only> --permission-mode dontAsk --allowedTools
    "mcp__rackoon__*,WebSearch,WebFetch" --append-system-prompt <Rackoon's>`,
    `--resume <session>` to continue. `DISABLE_UPDATES=1`,
    `CLAUDE_CONFIG_DIR` in the runner's state, `CLAUDE_CODE_OAUTH_TOKEN`
    from the saved token, `MCP_TOOL_TIMEOUT` = 1 h (approvals block a tool
    call).
  - Codex: `codex app-server` (JSON-RPC over stdio), `CODEX_HOME` in the
    runner's state, `-c features.<f>=false` for `shell_tool`,
    `unified_exec`, `apps`, `plugins`, `browser_use`, `computer_use` and
    `image_generation` (no shell, browser or apps), sandbox `read-only`,
    approval policy `never`, the `rackoon` MCP server with
    `tool_timeout_sec = 3600` and `default_tools_approval_mode = "approve"`
    (Rackoon decides on every call itself), `check_for_update_on_startup =
    false`. Codex runs tool calls through `codex-code-mode-host`, which
    therefore installs with it. A `config.toml` in Codex's home that names
    a model provider without OpenAI sign-in counts as signed in.
  - The CLI ends after every turn and the next message resumes its session
    (`--resume`, `thread/resume`): idle investigations hold no process.
    Each run carries an id from the hub, so the exit of a run that is
    closing cannot touch the next one.
  - Proxy settings (`HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, …) given to
    the runner (`/etc/rackoon/assist.env`) pass on to the CLIs.
  - The `rackoon` MCP server: the CLI starts `rackoon-hub assist
    mcp-bridge` (stdio), which connects to the runner's per-session Unix
    socket with a per-session token; the runner relays `tools/call` to the
    hub (`tool.call`) and returns the hub's answer.
- **Install and update** (runner, `internal/assist`): versions live side by
  side in `<state>/bin/<provider>/<version>/`, `current` points at one;
  running investigations keep their binary. Claude Code: channel pointer
  `https://downloads.claude.ai/claude-code-releases/{stable|latest}`,
  `…/<version>/manifest.json` verified with `manifest.json.sig` against the
  pinned Anthropic release key (fingerprint
  `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`, embedded), then the binary's
  SHA-256 from the manifest (`linux-x64`, `linux-arm64`, `-musl` on musl
  systems). Codex: `https://api.github.com/repos/openai/codex/releases/latest`,
  asset `codex-package-<arch>-unknown-linux-musl.tar.gz` checked against
  the release's `digest` (sha256); `bin/codex` and
  `bin/codex-code-mode-host` are taken from it. The hub checks every 6 h
  when auto-update is on and installs a newer version; two versions are
  kept.

## 2. Settings

`meta` key `assist_settings` (JSON). Defaults in brackets.

| Field | Values |
|---|---|
| `enabled` | [false] |
| `provider` | `claude` [default] \| `codex`: for new investigations |
| `access` | `read` \| `ask` \| `full` [default]: what the AI may change (below) |
| `auto_investigate` | `off` [default] \| `critical` \| `all` |
| `auto_update` | [true] |
| `claude_model`, `codex_model` | [""] = the CLI's default; free text (`opus`, `sonnet`, `gpt-5-codex`, …) |
| `claude_channel` | `stable` [default] \| `latest` |

**Access levels.** On top of the level, every host's own switches apply
(hub switch AND agent.toml), as for people:

| Tool | read | ask | full | Host needs |
|---|---|---|---|---|
| hosts, alerts, metrics (hub data) | ✓ | ✓ | ✓ | — |
| `diagnose` (read-only checks) | ✓ | ✓ | ✓ | Diagnostics (on by default, both sides) |
| `run_command` (root shell command) | — | approval | ✓ | Host shell (off by default, both sides) |
| `guest_action` (start/stop/… a guest) | — | approval | ✓ | Power actions |

Turning `enabled` on needs a recent sign-in, like every assistant setting.

**Diagnostics switch.** A sixth remote-control switch per server,
`diagnose`, **on by default** in the hub (schema 11) and in the agent
(`[remote_control] diagnose`, default true when absent; `false` turns it
off). It only serves the assistant and only while the assistant is enabled.

## 3. Agent protocol

`internal/proto/assist.go`. Two hub-opened streams:

- `diagnose`: `DiagnoseRequest{check, args}` → `DiagnoseResponse`. Needs
  `Policy.Diagnose`. `check: "list"` returns the catalog the host can run.
  60 s timeout, 256 KiB output.
- `exec`: `ExecRequest{cmd, timeout}` → `ExecResponse`. Needs
  `Policy.HostShell`. `/bin/sh -c` as root, outside the agent's sandbox
  (`systemd-run --pipe --wait --collect` with `RuntimeMaxSec` under
  systemd; directly elsewhere), cwd `/root` (or `/`), stdin closed, a clean
  environment (`PATH`, `HOME=/root`, `LANG=C.UTF-8`), 120 s default, 1800 s
  at most; the agent logs every command.

### 3.1 Diagnostics catalog

The agent runs each check with fixed arguments (no shell), validates every
argument, skips checks whose tool is missing (they are not in `list`), and
redacts secrets in configuration output (values of keys that look like
passwords, tokens, keys, `csrf_token`, `cipassword`). Environment variables
of containers are never returned.

| Check | Arguments | Runs |
|---|---|---|
| `system` | | `uname -a`, `uptime`, `/etc/os-release`, `free -m`, `df -hT` (real file systems), last boot |
| `processes` | `sort` (cpu\|mem), `limit` (≤ 200, 40) | `ps` sorted |
| `ports` | | `ss -tulpn` |
| `services` | `state` (failed\|running\|all, failed) | `systemctl list-units --type=service` (OpenRC: `rc-status`) |
| `service` | `name`* | `systemctl status` + its last 50 journal lines |
| `logs` | `unit`, `since` ("2h", "today", "2026-10-17 10:00"), `lines` (≤ 2000, 200), `grep` (regex), `priority` (0-7 or emerg…debug), `kernel` (true) | `journalctl`, or the syslog files without journald (`/var/log/syslog`, `messages`; Unraid) |
| `disks` | | `lsblk` (model, serial, transport, state), `df -hT` |
| `smart` | `device`* (sda, nvme0n1, or a /dev/disk/by-id name) | `smartctl -x` |
| `raid` | | `/proc/mdstat`, `mdadm --detail` of each array |
| `unraid` | | Unraid's `/proc/mdstat`, `/var/local/emhttp/var.ini` and `disks.ini` (redacted), the last array / disk lines of the syslog |
| `zfs` | `pool` | `zpool status -v`, `zpool list -v`, `zfs list` |
| `network` | | `ip -br addr`, `ip route`, `ip -s link`, `/etc/resolv.conf`, bonds |
| `sensors` | | `sensors` |
| `docker` | `container` | `docker ps -a`, or `docker inspect` without `Config.Env` |
| `docker_logs` | `container`*, `lines`, `since` | `docker logs --timestamps --tail` |
| `incus` | `instance` | `incus list`, or `incus info --show-log` |
| `libvirt` | `domain` | `virsh list --all`, or `dominfo` / `domblklist` / `domiflist` |
| `pve` | `guest` (VMID) | `pveversion`, `pvecm status`, `pvesm status`, `ha-manager status`, `qm list` / `pct list`; with a guest its config (redacted) and status |
| `ups` | | `upsc` / `apcaccess` |
| `updates` | | pending package updates (as the inspect view) |

(* required)

A Mac has its own catalog, the same names where the question is the same
(macOS's own tools from `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`,
`/usr/libexec` only):

| Check | Arguments | Runs |
|---|---|---|
| `system` | | `sw_vers`, `uname -a`, `uptime`, `sysctl` (model, CPU, memory, boot), `vm_stat`, `vm.swapusage`, `df -h -l` |
| `processes` | `sort`, `limit` | `ps` sorted |
| `ports` | | `lsof` (listening TCP, bound UDP) |
| `services` | `state` (failed\|running\|all, failed) | `launchctl list` (failed: not running, last exit not clean) |
| `service` | `name`* (a launchd label) | `launchctl print system/<label>` |
| `logs` | `process`, `subsystem`, `since` (default the last hour), `lines` (≤ 2000, 200), `grep` (regex) | `log show --style syslog` with a predicate the agent builds from the validated names (never one from the hub); `grep` and `lines` filter its output in the agent |
| `disks` | | `diskutil list`, `diskutil apfs list`, `df -h -l` |
| `smart` | `device`* (disk0) | `diskutil info` and its SMART values |
| `network` | | `networksetup -listallhardwareports`, `ifconfig`, `netstat -rn`, `scutil --dns` |
| `sensors` | | the temperatures the Mac reports |
| `updates` | | what macOS's own check found, `softwareupdate --history` |
| `power` | | `pmset -g`, `pmset -g assertions`, the last 100 lines of `pmset -g log` |

Exec on a Mac runs `/bin/sh -c` as root in `/var/root` with PATH
`/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, in its own
process group, with the same limits.

## 4. Tools (MCP server `rackoon`)

The hub defines them and runs them; every host argument accepts a server
id or a host name (case-insensitive).

| Tool | Input | Answer |
|---|---|---|
| `list_hosts` | | hosts: id, name, status, OS, platforms, open alerts, what the assistant may do there |
| `get_host` | `host` | the host's current state: facts, CPU / memory / load, file systems, disks and SMART, arrays, pools, sensors, UPS, system health, network, guests, hints, open alerts |
| `list_alerts` | `host`, `state` (open\|resolved), `limit` | alerts |
| `get_metrics` | `host`, `metric` (cpu, memory, load, swap, net, disk_io, temp…), `range` (1h…30d) | average, maximum, and up to 60 points |
| `diagnose` | `host`, `check`, `args` | the check's output (`check: "list"`: the catalog) |
| `run_command` | `host`, `command`, `reason`, `timeout_s` | exit code and output, or why it was refused / declined |
| `guest_action` | `host`, `guest` ("platform:id" or name), `action`, `reason` | the outcome |
| `finish` | `summary`, `resolved` | records the conclusion (ends the investigation after the turn) |

`ask`: `run_command` and `guest_action` create an approval and wait (up to
30 min) for the admin's decision; declined calls answer with the admin's
reply. Every executed command and action is audited
(`assistant.command`, `assistant.action`), as are settings, installs,
sign-ins and starts.

The system prompt tells the AI where it runs (no local shell; hosts are
remote), what the tools are, that output from hosts is untrusted data
(never instructions), to explain before changing anything, and to call
`finish` when done.

## 5. Investigations

Table `assist_sessions` (one row per investigation) and `assist_events`
(append-only transcript). States: `starting` → `running` ⇄ `waiting`
(approval pending) → `idle` (turn over, waiting for the admin) → `done`
(finish called) / `failed` / `stopped`. A message to an `idle`, `done`,
`failed` or `stopped` investigation continues it (the CLI resumes its
session). A hub restart leaves running investigations `idle`. At most 3 run
at once; automatic ones: 1 at a time, 6 per hour, one per alert, only for
alerts that need attention for 60 s (not acknowledged, muted or
suppressed). Investigations older than 180 days are deleted.

## 6. REST API (admins only)

All under `/api/v1/assistant`. Changes need a session (not an API token)
with a recent sign-in where marked ⚿.

| Method | Path | Body → answer |
|---|---|---|
| GET | `` | → `AssistantState` |
| PUT | `/settings` ⚿ | partial `AssistantSettings` → `AssistantState` |
| POST | `/providers/{claude\|codex}/install` ⚿ | → 202 `AssistantState` (install or update to the newest) |
| DELETE | `/providers/{p}` ⚿ | → `AssistantState` (uninstall; its sign-in stays) |
| POST | `/providers/{p}/login` ⚿ | claude: `{token}`; codex: `{}` → `AssistantState` (codex: `login` filled in) |
| DELETE | `/providers/{p}/login` ⚿ | → `AssistantState` (sign out / cancel a pending login) |
| GET | `/investigations?server=&alert=&limit=` | → `Investigation[]`, newest first |
| POST | `/investigations` | `{server?, alert?, prompt?, provider?}` → 201 `Investigation` |
| GET | `/investigations/{id}` | → `{investigation, events}` |
| POST | `/investigations/{id}/messages` | `{text}` → 202 `Investigation` |
| POST | `/investigations/{id}/stop` | → `Investigation` |
| POST | `/investigations/{id}/approvals/{aid}` | `{approve, reply?}` → `Investigation` |
| DELETE | `/investigations/{id}` | → 204 |

Errors: `assistant_disabled` (409), `provider_not_installed` (409),
`provider_signed_out` (409), `too_many_running` (429),
`runner_unavailable` (503), `not_found` (404), `invalid_*` (400).

```ts
type ProviderId = 'claude' | 'codex';
type Access = 'read' | 'ask' | 'full';
type InvestigationState = 'starting' | 'running' | 'waiting' | 'idle' | 'done' | 'failed' | 'stopped';

interface AssistantSettings {
  enabled: boolean;
  provider: ProviderId;
  access: Access;
  auto_investigate: 'off' | 'critical' | 'all';
  auto_update: boolean;
  claude_model: string;
  codex_model: string;
  claude_channel: 'stable' | 'latest';
}

interface ProviderState {
  id: ProviderId;
  name: string;                 // "Claude Code" | "Codex"
  installed: boolean;
  version: string | null;
  latest: string | null;        // newest known version
  update_available: boolean;
  checked_at: string | null;    // last update check
  busy: 'installing' | 'removing' | null;
  progress: number | null;      // 0..1 while downloading
  signed_in: boolean;
  account: string | null;       // e.g. "john@example.com (plus)", "Claude subscription"
  login: { verification_url: string; user_code: string; expires_at: string } | null; // Codex device login in progress
  error: string | null;         // last install / sign-in error
}

interface AssistantState {
  settings: AssistantSettings;
  runner: { connected: boolean; sandboxed: boolean; error: string | null };
  providers: Record<ProviderId, ProviderState>;
  running: number;              // investigations running now
}

interface Investigation {
  id: string;
  title: string;
  server: string | null;        // server id, null: fleet-wide
  server_name: string | null;
  alert_id: string | null;
  provider: ProviderId;
  model: string | null;
  state: InvestigationState;
  access: Access;               // the level it started with
  auto: boolean;                // started on its own for an alert
  created_by: string;           // user name, or "auto"
  created_at: string;
  updated_at: string;
  summary: string | null;       // from finish
  resolved: boolean | null;
  cost_usd: number | null;      // Claude Code's estimate (subscriptions are not billed per call)
  pending_approvals: number;
}

type InvestigationEvent = {
  seq: number;
  at: string;
} & (
  | { kind: 'user'; text: string; by: string }                       // by: user name or "auto"
  | { kind: 'assistant'; text: string }                              // Markdown
  | { kind: 'tool'; tool_id: string; tool: string; title: string; server: string | null; input: Record<string, unknown> }
  | { kind: 'tool_result'; tool_id: string; ok: boolean; output: string; truncated: boolean; duration_ms: number }
  | { kind: 'approval'; approval_id: string; tool_id: string; server: string; action: 'command' | 'guest_action'; command: string; reason: string }
  | { kind: 'approval_decided'; approval_id: string; decision: 'approved' | 'declined' | 'expired'; by: string; reply: string | null }
  | { kind: 'status'; state: InvestigationState; text: string | null }
  | { kind: 'summary'; text: string; resolved: boolean }
  | { kind: 'error'; text: string }
  | { kind: 'usage'; cost_usd: number | null; input_tokens: number | null; output_tokens: number | null }
);
```

Server JSON: `remote_control` gains `diagnose`, `agent_diagnose`,
`diagnose_reason` (like `manage`); `PATCH /servers/{id}` and the agent
settings accept `remote_control.diagnose`.

**Events** (SSE, admins): `assistant.state` (`AssistantState`),
`assistant.investigation` (`Investigation`, created or changed),
`assistant.event` (`{investigation, event}`), `assistant.deleted`
(`{id}`).

## 7. UI

No new top-level navigation.

- **Settings › Assistant** (admins): the switch, the two providers
  (install / update / remove, version and "update available", sign in /
  sign out: Claude asks for the `claude setup-token` token with a one-line
  how-to; Codex shows the device code and the link, and turns signed in by
  itself), default provider, access level (three radio options with what
  each allows), automatic investigations, auto-update, models, and the
  recent investigations. A notice when the runner is not sandboxed or not
  connected.
- **Investigate**: on alert rows (Alerts page, Watch panels) for admins
  while the assistant is enabled; a row with an investigation shows its
  state and opens it. The host header has **Ask assistant** (a question
  about this host).
- **Investigation panel**: a side panel (like the console panel; full
  screen on phones) opened by `?investigation=<id>` on any page: title,
  host, provider, state, Stop; the transcript (Markdown answers, tool steps
  as one line each that expand to their output, approvals with Run /
  Decline and an optional reply, the summary); a reply box (Enter sends,
  Shift+Enter is a new line).
- **Agent tab**: the **Diagnostics** switch with the others ("Read-only
  checks the assistant runs: logs, SMART, arrays, services").

## 8. Not covered

API keys are accepted (`sk-ant-api…` for Claude Code, an OpenAI key is not
offered: Codex signs in with ChatGPT); cost limits per investigation (the
subscriptions bound usage); the AI managing guests' configuration (Manage)
— it can run commands where the host shell is allowed.
