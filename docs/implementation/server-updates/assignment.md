# Software updates + connecting from the phone — build brief (2026-10-19)

Decisions: `docs/decisions/server-updates.md` (SWU-01…SWU-15) and `docs/decisions/phone-connect.md` (PC-01…PC-11).
**Read the one your stream builds first**, then §1, §2 and your stream's part of §3. The wire shapes in §2 are what
every stream builds against; contracts 0.98.0 makes them real.

| Stream | Repo | Worktree | Branch (from) | Ids |
|---|---|---|---|---|
| C contracts | whombat-contracts | `~/Code/.wt/contracts-swu` | `swu` (main) | CT-500…CT-529, 0.98.0 |
| H hosts | the hosts service | `~/Code/.wt/hosts-swu` | `swu` (main) | HS-119…HS-140 |
| S server | Whombat | `~/Code/.wt/whombat-swu-server` | `swu-server` (`swu`) | SWU-S01… |
| U updates UI | whombat-app | `~/Code/.wt/app-swu-ui` | `swu-ui` (`swu`) | AP-2860…AP-2899 |
| P phone connect | whombat-app | `~/Code/.wt/app-swu-connect` | `swu-connect` (`swu`) | AP-2900…AP-2959 |

Integration branches (`swu` in Whombat and whombat-app, `~/Code/.wt/whombat-swu`, `~/Code/.wt/app-swu`) are the
lead's. C and H commit straight to their `swu`, which the lead merges into main.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`contracts: …`, `agent: …`, `hub: …`,
  `server: …`, `web: …`, `mobile: …`, `client: …`), every message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into `main` or another stream's
  branch, never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`,
  `~/Code/whombat-hosts`): other sessions work there. The lead merges and vendors.
- **Contracts 0.98.0 arrives on `swu`** (Whombat and app). S and U start before it lands with what doesn't need the new
  types; when the lead says it is vendored, `git merge swu`. Need a contract change? Don't edit vendored tarballs:
  message the lead (SendMessage `main`) with the exact additive change. P needs no contract change unless it finds one.
- **DEV fast** (John's rule): one quick check at the end — `pnpm format` then `TMPDIR=~/.cache/wb-tmp pnpm check`
  (H: `make check` or the repo's documented Go checks), plus `pnpm test:server` once (S). Run single test files while
  you work. No VM gates, no repeated full suites, no CI waits. Own ports (S 4490, U 4492/5199, P 4494/5201) and
  throwaway databases; the shared `docker compose` (Postgres :55432, Mailpit) is never stopped or reset. `/tmp` runs
  out of inodes: `TMPDIR=~/.cache/wb-tmp`. Temporary containers or VMs only through `/usr/local/bin/agent-resource`
  (read `/home/me/Code/dashboard/docs/agent-resources.md` first; `agent-resource run --task … --ttl 2h -- …`), and
  release what you lease.
- **Android emulator:** the AVD `whombat-mobile` is shared; run your own read-only instance on your own port
  (`emulator -avd whombat-mobile -port 5612 -read-only -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`;
  P 5612, U 5614) and `adb -s emulator-<port> emu kill` when done. See `apps/mobile/README.md`.
- **Never touch John's real servers, services or DEV box** from tests or scripts (his Proxmox nodes, his DEV Whombat,
  Home Assistant, UniFi …), never install updates anywhere real, never read his secrets. The lead checks the real ones
  after the merge.
- **Tests** (`docs/decisions/test-speed.md`): unit-test logic (command lines per package manager, output parsing,
  link parsing, form models, words picked by state); fakes in process. A new `*.int.test.ts` needs a reason to need
  Postgres. Check facts (ids, tool names, a key phrase), never long literal text. Wait on events or inject short
  timeouts, never sleep.
- **Copy**: plain, short English a non-developer understands (`docs/decisions/concise-replies.md`), curly quotes
  (’ “ ”), `·`, `…`. The words in the decisions are the words. No ids, paths, commands or stack traces in visible
  words (a package's own name is fine).
- **Tokens only** for UI colours/fonts/radii; match the surrounding code's style and comment density.
- Record your own decisions in your stream's file (H: `hosts/docs/decisions/hosts.md` HS-119…; S: Whombat
  `docs/decisions/server-updates-server.md`; U: whombat-app `docs/decisions/server-updates-app.md`; P: whombat-app
  `docs/decisions/phone-connect.md`; C: the contracts repo's notes as it does them).
- When done: the quick check green, everything committed, a short report to the lead (what you built, what you
  decided, what is left, what the lead must check live). Don't wait for anything after that.

## 2. Wire shapes (software updates)

### Agent and hub (the hosts service)

- **Manage ops on the host** (platform `host`; `Manage` refuses `host` today — these two are the first host-level ops
  outside unRAID): `packages.check` and `packages.install` (`packages []string` optional, each
  `^[A-Za-z0-9][A-Za-z0-9+._:@~-]{0,127}$`, at most 200). Both answer at once with a task `pkg:<16 hex>`; refusals use
  the existing codes: `unsupported` (no package manager, NixOS, unRAID, or an agent too old), `not_allowed` (TrueNAS;
  pacman with named packages; stopping an Install), `busy` (a package task already running, or the package lock still
  held after two minutes), `manage_disabled`.
- **Gate:** the agent's `[remote_control] manage` and the hub's `RCManage`. Hub routes:
  `POST /api/v1/servers/{id}/packages/check` (operator, body `{}`) and `POST /api/v1/servers/{id}/packages/install`
  (admin route, body `{packages?, confirm: true}`).
- **The task:** `GET /servers/{id}/tasks/pkg:…?platform=host&log_start=N` → the existing `TaskStatus` (status, message,
  log pages, `cancellable`: Check yes, Install no), plus `packages {installed int, kept_back []string, warning string}`
  when it ended. `DELETE /servers/{id}/tasks/pkg:…?platform=host` stops a Check. The hub follows it as other tasks and
  publishes `task.finished`; audit `manage.requested`/`manage.finished` as for other manage ops.
- **The server's report** (`GET /servers/{id}` → `system`): `package_task {id, op: check|install, started_at}|null`
  while one runs, `package_last {op, status: ok|failed, finished_at, installed int|null, message}|null` after one
  ended (kept across agent restarts in the agent's state dir). After a task the `updates` collector runs at once, and
  the reboot check with it.
- **How it runs:** a transient systemd unit (`systemd-run`, as `diagnose/exec.go` does, but not `--pipe`/`--wait`:
  the unit must outlive the agent), output appended to a log file the agent pages through, the exit status recorded by
  the unit itself so an agent restarted mid-task finds the result (unit name derived from the task id). Hosts without
  systemd: the agent's own session (the `unraid_tasks.go` pattern). Environment: `DEBIAN_FRONTEND=noninteractive`,
  `NEEDRESTART_MODE=a`, `APT_LISTCHANGES_FRONTEND=none`, `LC_ALL=C`; apt with `-o DPkg::Lock::Timeout=120
  -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -y`. Detect the Proxmox enterprise 401
  (SWU-06). Detect TrueNAS (`/etc/truenas` or `midclt` present) before apt.
- **Inspect updates** (`GET /servers/{id}/inspect/updates`): allowed with the diagnose switch or the console switch, on
  agent and hub (SWU-11).
- **The simulator** (`rackoon-sim`) plays both ops (a short log, the counts going down, a reboot needed after an
  install on one server) so Whombat's and the web's dev setups can show them.

### Contracts 0.98.0 (whombat-contracts)

- `HOST_MANAGE_OPS` gains `packages.check`, `packages.install`; `HostManageRequest.params.packages?: string[]`; platform
  `host` allowed for them. `HostSystem` gains `packageTask {id, op, startedAt}|null` and
  `packageLast {op, status, finishedAt, installed, message}|null` (both optional for older hubs). `HostTask` gains
  `packages? {installed, keptBack, warning}`.
- Runtime feature `hosts.package_updates` (since 0.98.0) in `RUNTIME_FEATURES`.
- `SERVERS_TOOLS`: `server_updates` (read; `server`) — the waiting updates (manager, count, security count, checked
  when, the error, needs a restart and why, the packages: name, now, new, security, source; at most 500), the running
  package task and the last result. `server_update` (write; `server`, `action` `check|install`, `packages` optional,
  `reason`) — description says it installs the server's waiting operating-system updates as a task, never restarts,
  asks a person first unless the server is set not to ask. `SERVERS_SENSITIVE`: `server_update` with `action`
  `^install$` → “Installing updates always asks”. The Servers guide gains one paragraph: check, install, report, offer a
  restart (`server_power`) when it needs one, one node of a cluster at a time.
- Bump `SESSION_API_LEVEL` only if a session operation's shape changes (docs/publishing.md step 1).

### Whombat server

- `api.hosts.manage` passes the two ops through (`manageCall`: the two hub paths; Install sends `confirm: true`), signs
  “Installed updates on {server}” / “Checked {server} for updates” (Done recently), no undo.
- `getTask` with `platform=host` serves the package task (already generic: check it maps `packages`).
- Tools `server_updates` and `server_update` (tools-host.ts or a new tools-updates.ts), the ask words
  (“install 23 updates on PVE-02”, “install nginx and openssl on web-01”), `follow` for an install an agent started
  (SWU-08's message, from the task's `packages` and the server's reboot need), the self-server always-ask (SWU-08), the
  hint's way out (SWU-13), the Asks you first words (SWU-09), the feature advertised when the hosts service is there,
  the skills' text (SWU-09: `packs/homelab/skills/proxmox`, `incus-lxc`). Words map the hub's refusal codes to SWU's
  sentences (`hosts/errors.ts`).

## 3. Streams

**C — contracts.** §2 contracts, with tests as the repo does them; then bump to 0.98.0, tag `contracts-v0.98.0` on
your branch `swu` and `pnpm release` → `dist-release/0.98.0/` (provisional: the lead may ask for a re-release before
main; re-releasing the same version means removing that dist dir). Report the dist path. Then stop.

**H — hosts.** §2 agent and hub: pkgs install/check runner with per-manager command lines (unit-tested), the task
registry for `pkg:` tasks (status, log paging, survive an agent restart, one at a time, the lock wait), the host
manage path, hub routes and the task regex, the report fields, the inspect gate fix, the simulator, docs
(`docs/MANAGE.md`, `docs/CONTRACT.md`, `docs/REST-API.md`). **A real test:** in a disposable Debian 12 system
container or VM leased through `agent-resource`, run the real agent code path (a small test binary or a build-tagged
Go test) for Check and Install against real apt — make an update exist first (install an older version of a small
package from snapshot.debian.org or the release pocket), then confirm it installs, the log pages, the counts drop,
and an agent restart mid-task finds the result. Release the lease. Don't touch any real server.

**S — server.** §2 Whombat server. Start with the tools' and words' logic against the fake hub
(`apps/server/src/hosts/testing/fake*.ts` — teach the fake the two ops and the task), merge `swu` when contracts are
vendored. Int tests only where Postgres matters (the commit/approval path for `server_update`).

**U — updates UI (web + phone).** SWU-10…SWU-14 on the web (`apps/web/src/features/things/tabs/SystemTab.tsx`, the
existing `tasks/TaskDialog.tsx` / `taskTracker.ts`, Look inside → Updates) and the phone (`apps/mobile`: the server
screen's Summary Updates card and a new Updates screen with its route), the words shared in `packages/client`
(`hosts/`), the dev fixtures. The Restart now button reuses the existing server action and its confirm. Visual check
on the web (both themes, 1440×900) and on the emulator (light and dark).

**P — phone connect.** PC-01…PC-11. Order: (1) check how `/connect/` returns are used on the managed web
(`packages/client/src/managed/google.ts`, `apps/web/src/managed/ManagedRoot.tsx`) and decide PC-05's shape; (2) move
the web's pure connect helpers to `packages/client/src/connections/` with their tests, the web importing them (no
visible change on the web — run its tests); (3) the link fix (PC-02) with tests in `navigation/links.test.ts`;
(4) Connect {Name} for the field-based sign-ins (password, token, client credentials, none) with identify, certificate,
the error buttons, More options; (5) Email (IMAP); (6) OAuth and Nextcloud (PC-05) — the App Link path in
`app.config.cjs`; (7) Found on your network; (8) the connection page's changes (PC-09) and the Dropbox app form
(PC-07). Visual check on the emulator (light and dark) against the web's form for the same entry.
