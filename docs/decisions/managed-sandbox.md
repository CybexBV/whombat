# Managed appliance: execution isolation (workstream `managed/sandbox`)

Branch `managed/sandbox` (from `managed/runtime`), 2026-09-25. Implements the runner / agent-runtime side of
the appliance architecture's MA-10 and MA-12, threat model T6 and T7, and assignment §7, §8 (credential owner,
self-updaters) and §14 item 8. Decisions are `MS-nn`; they refine MA / MR decisions and never override them.
Self-hosted mode is unchanged unless a line says otherwise.

Code: `packages/agent-runtime/src/access/managed/` (`sandbox.ts`, `shim.mjs`, `cgroup.ts`, `egress.ts`,
`addresses.ts`, `seccomp.ts`, `outcomes.ts`, `versions.ts`), `packages/agent-runtime/src/workspace/lock.ts` and the
fence in `workspace/index.ts`, `packages/agent-runtime/src/credentials.ts` (credential owners), `apps/runner/src/`
`managed.ts`, `managed-setup.ts`, `generation.ts`, `turn.ts`; server: `apps/server/src/runtime/service.ts`
(`lostLease`, strict in managed mode). Automations: `apps/server/src/automations/engine.ts` (MSB-17).

## Decisions

| # | Decision | Why |
|---|---|---|
| MSB-01 | **Mechanism: bubblewrap, two stages, plus a cgroup per task and a userspace egress service.** Evaluated: (a) `systemd-run` transient units with `DynamicUser`/`PrivateUsers`/`IPAddressDeny`/`RestrictAddressFamilies`/`SystemCallFilter` — needs the system manager (root or a polkit grant) for `DynamicUser` and BPF IP filters, can't express host-name allowlists, and can't be tested unprivileged; (b) nsjail — not packaged here, same kernel features as bubblewrap, its cgroup support needs the same delegation, one more pinned C binary; (c) **bubblewrap** — installed, unprivileged (user namespaces), already what both providers use for their own sandboxes, in nixpkgs, small. Chosen: (c) for namespaces, mounts and seccomp; cgroup v2 delegation for limits and kill; a per-task egress service in the runner for the network. The provider process **and everything it starts** (shells, git, package managers, MCP servers, repository hooks, the provider's own nested sandbox) run inside: the runner starts the provider through `SandboxSession.spawn` (`TurnHost.spawn`, used by the Claude SDK's `spawnClaudeCodeProcess` and Codex's `AppServerProcess`). | One mechanism that works on this host unprivileged (so it is really tested) and on the appliance, where systemd adds delegation and nftables adds a second, kernel-level egress wall (MSB-08). |
| MSB-02 | **Fail closed.** `ManagedSandbox.probe()` builds a real nested sandbox and a task cgroup once; if bubblewrap, unprivileged user namespaces, nesting, a seccomp table for the architecture or task cgroups are missing, the runner logs the reason at start and **every live turn is refused** (`managed:sandbox_unavailable`, the agent says “My sandbox can’t start on this Whombat, and I never work without it. I didn’t do anything.”). A managed runner without a sandbox configured refuses the same way. No fallback, no trusted, no ACP (MR-13's checks stay, one module: `apps/runner/src/managed.ts`). | Assignment §7: “never silently use unsandboxed host execution”. |
| MSB-03 | **Stage 1** (`bwrap --unshare-user --unshare-net --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try --uid 0 --gid 0 --cap-add ALL`, `--die-with-parent --new-session`): the task's own network namespace (loopback only) and a user namespace that maps **only the runner's uid**, so its capabilities count nowhere else. It runs `shim.mjs` on the runner's pinned Node, which binds the loopback bridges (MSB-07) — port 53 needs a capability in the namespace owning the netns, which is why stage 1 is uid 0 there — then starts **stage 2** (`bwrap --unshare-user --unshare-pid --unshare-ipc --unshare-uts --uid 1000 --gid 1000 --cap-drop ALL --seccomp 3`, `no_new_privs`) with the payload. Stage 2 never sees the control directory (sockets, config, seccomp file). Both stages end with `--remount-ro /`: only the listed mounts are writable. Nested user namespaces stay allowed (the providers' own bubblewrap sandboxes run inside and were tested to). | A single stage can't both own the netns (for the resolver on :53) and drop every capability for the payload; bubblewrap refuses to map uids from a capability-less uid 0 (measured). |
| MSB-04 | **Mounts** (`mountArgs`): read-only `/usr`, `/bin`, `/sbin`, `/lib*`, `/nix/store`, `/run/current-system`, an **allowlist of `/etc`** (certificates, loader cache, time zone, `alternatives`, `static`, …) plus generated `passwd`/`group`/`hosts`/`resolv.conf`/`nsswitch.conf`; fresh `/proc` of the task's pid namespace; bubblewrap's minimal `/dev`; size-limited tmpfs `/tmp` (`/var/tmp` → `/tmp`) and home `/home/whombat-task`; read-only: Node's install, the provider command's install (links recreated hop by hop, so `~/.local/bin/codex → …/codex.js` and multi-call binaries work), `WHOMBAT_SANDBOX_RO_PATHS` (toolchains), skills, attachments, a clone's objects; writable: the working directory when the agent may write, what a commit needs (`CommitPaths`), and the credential owner's home; read-only again inside those: `.git` config, hooks, alternates (`CommitPaths.denyWrite`). **Not mounted**: `/run` (Docker/Podman, Postgres, SSH agent, D-Bus, the manager's and helper's sockets), `/var`, `/home` and `/root` beyond the paths above, `/sys`, `/persist`, `/srv`, `/opt`, `/mnt`. Denied paths that sit inside a mounted one (Whombat's home, the runner's state, the credentials root — except the owner's own home — and the guarded confinement's `denyRead`) are covered with an empty read-only tmpfs or `/dev/null`. Payload environment: the provider's, re-pointed (`HOME`, `TMPDIR`, `PATH` filtered to mounted directories with the pinned Node first, proxies), minus `XDG_RUNTIME_DIR`, `DBUS_*`, `SSH_*`, `DISPLAY`. | Allowlist, not blocklist: a new socket or secret on the host is invisible by default. |
| MSB-04b | **Seccomp** (`seccomp.ts`, classic BPF built in TypeScript, x86-64 and arm64): EPERM for the kernel keyring (`add_key`, `request_key`, `keyctl`), `bpf`, `perf_event_open`, `userfaultfd`, `open_by_handle_at`, `name_to_handle_at`, module and kexec loading, `fanotify_init`, clock / swap / reboot / quota / `acct` / `vhangup`; ENOSYS for `io_uring_*` (callers fall back); the whole x32 ABI on x86-64; any other architecture's syscall entry kills the process. Namespaces, `mount` and `ptrace` stay (nested provider sandboxes; ptrace reaches only the task's own processes). | The usual ways out of a namespace sandbox, without breaking git, Node, Python, package managers or the providers (all tested). |
| MSB-05 | **One cgroup per task** in a delegated subtree: `<root>/tasks/g<generation>-<dispatch>` with `memory.max`, `memory.swap.max=0`, `pids.max`, `cpu.weight`; the task joins it before it execs anything (`sh -c 'echo $$ > …/cgroup.procs && exec …'`). Kill = `cgroup.kill` (the whole subtree, forks and `setsid` escapees included), then wait for `populated 0`. Backends: `delegated` (the appliance: the runner's unit has `Delegate=yes`; the runner moves itself to `<root>/supervisor` and enables `memory pids cpu`) and `systemd-user` (development hosts: per generation one transient scope with `Delegate=yes` in a slice of the user manager, held by an anchor process; the scope is the root). `memory.events oom_kill` and `pids.events max` say which limit stopped a task. Defaults: 4 GiB, 1024 pids, weight 100, 1 GiB tmp, 512 MiB home, 256 MiB output, 2 h wall time (`WHOMBAT_SANDBOX_*`). | No pid lists anywhere; one kill that can't miss a process. |
| MSB-05b | **Output and wall time**: the runner counts the provider's stdout + stderr and kills the task at the limit (`output_limit`); a turn stops at its wall time (`wall_time`). **Disk**: tmp and home are size-limited tmpfs (charged to the task's memory); the working directory and workspace repos are **not** quota-limited here — on the appliance that needs a per-task filesystem quota (MSB-16, unrun). | What an unprivileged runner can enforce is enforced; the rest is named. |
| MSB-06 | **Network policy** (`addresses.ts`, `egress.ts`): the task's namespace has only loopback, so every connection goes through the runner's per-task egress service. Destinations: the provider's endpoints (Claude: `*.anthropic.com`, `claude.ai`, `*.claude.com`; Codex: `*.openai.com`, `chatgpt.com`) and GitHub (`github.com`, `*.github.com`, `*.githubusercontent.com`), plus `WHOMBAT_SANDBOX_EGRESS_ALLOW` (e.g. package registries — none by default); with the agent's “Browse the web” key any **public** host. Never: loopback, RFC 1918, link-local, CGNAT, unique-local, multicast, reserved and documentation space, `0.0.0.0/8`, metadata addresses (169.254.169.254, 169.254.170.2, 168.63.129.16, 100.100.100.200, fd00:ec2::254), local and metadata names (`localhost`, `*.local`, `*.internal`, `metadata.google.internal`, single labels) — for IPv4 and IPv6, including IPv4 carried in IPv6 (mapped, compatible, NAT64 `64:ff9b::/96`, 6to4, Teredo refused). Ports 443 and 80. A name is resolved by the proxy; **every** address must be admissible (a name with any private address is refused: no rebinding mix) and the proxy connects to the address it checked, never re-resolving. | Hostname allowlists need a proxy; checking resolved addresses closes DNS rebinding. |
| MSB-06b | **Redirects** are the client's: each hop is a new request through the proxy and is checked on its own, so a redirect from an allowed host to a private or metadata address is refused (tested). A redirect to `127.0.0.1` / `[::1]` is not proxied (`NO_PROXY` keeps loopback for the MCP bridge) and lands on the task's own loopback, where nothing of the host listens (tested: the host service saw no connection). | The proxy never follows redirects itself. |
| MSB-07 | **Controlled DNS and the MCP endpoint.** Inside: `resolv.conf` → `127.0.0.1:53`, a UDP resolver in the shim that asks the runner (`dns.sock`); only allowlisted names resolve, only to public addresses (in allowlist mode the resolver is no exfiltration channel); other servers are unreachable (no route; tested for 8.8.8.8 and 2001:4860:4860::8888). The Whombat MCP endpoint is bridged to `127.0.0.1:47100` inside and forwarded by the runner **only for paths under the MCP path** (the rest of the server answers 403); the proxy is `127.0.0.1:47101` (`HTTP(S)_PROXY`, `ALL_PROXY`, `NODE_USE_ENV_PROXY=1`). | The providers reach MCP at the same URL shape they always had; nothing else of the server is reachable from a task. |
| MSB-08 | **Customer network: explicit grants only** (`WHOMBAT_SANDBOX_GRANTS=10.20.0.0/16:5432;fd12::/48`): private, CGNAT, ULA or link-local blocks with optional ports; loopback, metadata, multicast and reserved space can never be granted; the resolver never answers private addresses (grants open connections to literals). **Appliance, second wall** (for the NixOS module, not implemented here): nftables rules on the runner's cgroup so a bug in the egress service can't reach the LAN either — see “NixOS nftables design” below. | Assignment §7: “optional customer-network access is an explicit scoped grant.” |
| MSB-09 | **Runner generation.** `$WHOMBAT_RUNNER_STATE/generation` (default `$WHOMBAT_HOME/runner`), advanced once per start with write + fsync + rename, under a host-wide lock that also refuses a second runner on the same state. The generation is in the runner id (`rnr_<base>_g<n>`), the task cgroups (`g<n>-<dispatch>`) and the control dirs. **At start, before the first claim, every task cgroup (and generation scope) of another generation is killed and removed** (`killOrphans`; cgroup based). While running, bubblewrap's `--die-with-parent` plus the pid namespace take a crashed runner's tasks down with it (tested with SIGKILL); the start-up sweep catches anything that survived (tested with a planted survivor). | A lease field alone doesn't stop a process; the kernel does. |
| MSB-10 | **Fencing tokens at the server** (the one server change): the lease `{runnerId, attempt}` already fences completion, progress, git credentials, attachments and pack skills (`lostLease`); since the runner id carries the generation, a stale generation's calls are refused. In managed mode a call **without** a runner id or attempt is refused too (`lostLease(…, strict)`); self-hosted keeps accepting them from older runners. No contract change (the generation travels in the runner id). Note: `attempts` is not monotonic (a runner shutdown hands a claim back with `attempts − 1`), which is why the generation — not the attempt — must distinguish runner lives. | Every write point the runner uses carries the token; the server decides. |
| MSB-11 | **Stopping a stale worker from writing.** (1) The task's processes: killed as a whole (`cgroup.kill`) on any stop — at once when the lease is lost, after a 3 s grace for pause / cancel so the provider can close its session; the runner stops a turn that couldn't renew its lease for a lease period (`leaseMs`, default 60 s) even while partitioned from the server. (2) The runner's own writes: a workspace repo records the newest fencing token that prepared it (`whombat.fence` = generation, dispatch, attempt); under the repository lock a manager with an older generation, or an earlier attempt of the same dispatch, may no longer prepare, push or land (`WorkspaceFencedError`). (3) The server refuses its completion, progress and credentials (MSB-10). The sandbox is closed (all processes gone) before the runner lands or releases the workspace. | “Show how the stale worker is stopped from writing”: kill + per-generation workspace ownership + server fence. |
| MSB-12 | **Workspace locks across processes** (`hostLock`): a Linux abstract unix socket bound by the holder (`\0whombat-lock-<sha256>`), released by the kernel when the holder dies — no stale lock files, no takeover races, no pid reuse (the old O_EXCL file lock had a takeover race). A holder file names who holds it. `WorkspaceManager` takes it (key = the repository's common dir) around clone, fetch, worktree add / remove / prune, land and push, on top of the in-process queue; waiters give up after `lockWaitMs` (default 5 min) with `WorkspaceBusyError` → the agent says “Another turn is still working on {repo}, and I waited as long as I may. Ask me again when it’s done.” The direct-mode clone lock (RS-07) uses the same mechanism. Sandboxed tasks have their own network namespace, so they can't touch or squat the locks. | Kernel-held and crash-safe; tested between processes (serialise, time out with the holder, crash release, four concurrent prepares on one repo). |
| MSB-13 | **Superseded by one-person.md OP-09, OP-S85**: a turn's login is the person's one credential home per provider, `<credentials root>/<provider>`; there is no credential owner to name. **Credential owner per run.** A managed turn names `{account, provider, authMode, home}` (`checkCredentialOwner`), logged per turn; the account is the agent's explicit credential owner when the dispatch carries one (`runtime.credentialOwnerAccountId`, coming from the providers workstream), else a personal agent's owner (MR-13 interim). The home `WHOMBAT_CREDENTIALS_ROOT/<account>/<provider>` (0700) is the only login in the task (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), writable (token refresh), and denied to the tools inside the provider's own sandbox. One resolver (the stricter one, replacing `managedCredentialHome`'s body). | Assignment §8: every run identifies its credential owner; no pooled login. |
| MSB-14 | **Superseded in part by one-person.md OP-S85**: `owner_departed` is gone (nobody leaves); the other outcomes are untouched by it. **Distinct outcomes** (`outcomes.ts`, `CompleteBody.error = managed:<outcome>`, the agent's line as the refusal): `owner_departed` (identity marked departed, or a tombstone once removed), `not_signed_in`, `auth_expired` (expired / revoked / invalid login), `quota_exhausted`, `provider_outage` (retryable: an ordinary failure the server retries once), `provider_missing`, `version_drift`, `sandbox_unavailable`, `output_limit`, `memory_limit`, `pids_limit`, `wall_time`, `lease_lost`. Classified from the providers' own messages; an unknown message stays an ordinary failure. None falls back to another identity, the host's login or an API key. | Assignment §8 and §14.9: distinct states, no hidden fallback. |
| MSB-15 | **Provider versions and self-updaters: exposed, not wired** (the providers workstream owns provider auth and version policy): `checkProviderVersion` / `parseProviderVersion` compare `--version` output with `WHOMBAT_PROVIDER_PINS` (`claude=2.1.282,codex=0.157.0`) and give `provider_missing` / `version_drift`; `versionOutput` runs `--version` with an empty home; `noSelfUpdateEnv('claude')` (`DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) and `CODEX_NO_SELF_UPDATE_ARGS` (`check_for_update_on_startup=false`). Whombat's own Codex home already sets `check_for_update_on_startup = false`. Inside the sandbox a self-updater couldn't replace the binary anyway: installs are read-only mounts. | Ownership split set by the orchestrator. |
| MSB-16 | **Appliance configuration** (runner, `WHOMBAT_MODE=managed`): `WHOMBAT_SANDBOX_CGROUP=delegated` (default), `WHOMBAT_SANDBOX_BWRAP=<pinned bwrap>`, `WHOMBAT_RUNNER_STATE`, `WHOMBAT_CREDENTIALS_ROOT=/persist/whombat/credentials`, `WHOMBAT_SANDBOX_RO_PATHS` (the pinned toolchain profile), limits `WHOMBAT_SANDBOX_{MEMORY_MB,PIDS,CPU_WEIGHT,TMP_MB,OUTPUT_MB,WALL_MINUTES}`, `WHOMBAT_SANDBOX_EGRESS_ALLOW`, `WHOMBAT_SANDBOX_GRANTS`. Development hosts: `WHOMBAT_SANDBOX_CGROUP=systemd-user`, `WHOMBAT_SANDBOX_SLICE`. | |
| MSB-18 | **A managed task's environment is an allowlist** (`managedEnvAllowed` / `sandboxEnv`, enforced by the sandbox whatever the provider or runner passes): system and locale variables, the per-dispatch MCP token, the agent's git identity and workspace repo, the runner's own `GIT_CONFIG_*` settings (`credential.helper=`, `gc.auto`, `maintenance.auto` — any other key drops them all), `gh` without a login, the credential owner's home (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) and a few provider switches. **Never**, even when listed (`WHOMBAT_PROVIDER_ENV`, `passEnv`): any name that looks like a secret (`TOKEN`, `SECRET`, `PASSW`, `API_KEY`, `ACCESS_KEY`, `PRIVATE`, `CREDENTIAL`, `AUTH`, `SESSION`, `COOKIE`, …) and whole login families (`ANTHROPIC_*`, `OPENAI_*`, `CODEX_*` but `CODEX_HOME`, `CLAUDE_CODE_USE_*`, `AWS_*`, `GOOGLE_*`, `CLOUDSDK_*`, `AZURE_*`, `VERTEX_*`, `GITHUB_*`, `GH_*` but the three above, `HF_*`, `NPM_*`, `DOCKER_*`, `KUBE*`, `VAULT_*`, `DATABASE_*`, `PG*`, `RUNNER_*`, `WHOMBAT_*` but the MCP token, `SSH_*`, `DBUS_*`, `XDG_RUNTIME_DIR`, `DISPLAY`, `KRB5*`, `GPG_AGENT*`). Credentials come only from the owner's home; how an API-key login is stored there is the providers workstream's. The shim's control file carries only the filtered environment. | A runner-level key must never become a hidden paid fallback or leak to project code (orchestrator's blocking review). Tested: 29 planted runner credentials plus a `GIT_CONFIG_*` header, set in the runner's own environment and in the provider's, reach neither the provider nor its hook, postinstall script or MCP server, nor the control files (`sandbox.test.ts`); the real Codex provider through `runDispatch` sees none (`apps/runner/src/managed-sandbox.test.ts`); the test fails with the allowlist removed (checked). |
| MSB-17 | **Schedules in managed mode** (review of `bp-automations` BP-C18; fixes `15cbce5`, `2d485be` in `apps/server/src/automations/engine.ts`, tests `schedule-clock.int.test.ts`): below. | |
| MSB-19 | **The payload gets pipes of its own; the shim relays them** (2026-09-30). Stage 1's shim used to hand its own stdio to the payload (`inherit`). Node switches the stdio it holds to `O_NONBLOCK` once the payload runs, and an inherited descriptor shares that mode, so Codex's app-server wrote to a non-blocking stdout: the first burst the runner didn't read at once (a screenshot's `item/completed`) failed with `EAGAIN`, its stdout writer gave up for good, the process lived on, and every later notification — `turn/completed` included — was dropped. The dispatch stayed `running` with a live heartbeat (DEV, Pepper's assessment of FB-2P7K-8T73, `dsp_YNDAsd88E4w7`). Now the shim spawns stage 2 with `pipe` and relays stdin, stdout and stderr with backpressure, and exits on `close` after flushing, so the payload's last output isn't lost. Second net in the Codex provider: after `livenessIdleMs` (60 s) without a line from the app-server during a turn it sends `account/read`; no line at all within `livenessTimeoutMs` (30 s) ends the turn with a non-retryable error (“Codex stopped answering Whombat in the middle of the turn, so the turn was ended.”) and kills the process group. A quiet server that answers is only busy. | Measured: with the old shim the real app-server's fd 1 and 2 were `O_NONBLOCK` 300 ms after start, with the new one they stay blocking (`sandbox.test.ts`, real Codex, fails on the old shim). Not retryable: the agent may already have posted, and a retry would repeat the work. |
| MSB-20 | **Codex's shell snapshot is off in guarded turns** (2026-09-30). DEV: Pepper's assessments said “No code was read: read-only file-listing commands returned exit code 2 without output”. Codex 0.159 wraps every `exec_command` as `if . '<CODEX_HOME>/shell_snapshots/<thread>.sh' >/dev/null 2>&1; then :; fi; exec /bin/sh -c '<cmd>'`; the guarded profile can't read `CODEX_HOME` (an assessment's or scratch turn's allowlist doesn't list it, other guarded turns deny `WHOMBAT_HOME`, which holds it), and dash exits 2 when `.` can't open its file, even inside the `if`, before the command starts (38 µs, no output). `codex sandbox`, which the runner's startup probe uses, loads no snapshot, so the probe passed. `codexProfileArgs` now adds `-c features.shell_snapshot = false`. | Allowing `shell_snapshots` for reading would expose other threads' snapshots (proxy settings, `GH_CONFIG_DIR`). Reproduced by hand: exit 2 with the snapshot unreadable, the file list with it off. |

### MSB-17: automation schedules after restarts, downtime, maintenance and clock changes

Behaviour (engine active in one process under an advisory lock):
- **Restart / long downtime**: due schedules are scanned oldest first; for each, the newest `maxCatchUp` fires
  (default 3) up to now are considered; a fire more than 2 min late is *missed*: `skip` drops it (nothing is
  recorded), `run_once` starts one run for the newest missed fire (“missed while Whombat was down”) plus on-time
  fires. **Exactly once across crashes**: run creation and the `next_fire_at` advance commit in one transaction
  under the burrow lock with the automation row locked, and runs are unique on (automation, version,
  `sched:<time>`).
- **Coalescing / overlap**: every candidate fire goes through the overlap policy against active runs of any
  version (including runs from before the restart): `skip` records a skipped run, `queue` keeps one queued,
  `cancel_previous` cancels and starts; at most one new live run per automation per pass.
- **DST**: fires are exact instants (`shift` / `skip` for a missing local time, `once` / `twice` for a repeated
  one), so downtime across a transition is classified correctly; two missed `twice` fires give one catch-up.
  Interval schedules ignore DST.
- **Fixed gaps**: (1) catch-up walked every missed fire in the transaction (≈ 1.4 s per day of downtime for
  `*/5`, 35 s per day for every minute, the wrong fire beyond 10 000) — now the newest fires are found by looking
  back from now; (2) one schedule that throws (an unknown zone after an update) no longer stops the others;
  (3) after the clock was corrected backwards a timer stayed stuck in the future for as long as the clock had
  been ahead — timers now realign (first scan after start, on a detected step back, every 60 s; never before the
  schedule's anchor, so a stale clock at boot fires nothing); (4) `cancel_previous` no longer cancels a run for a
  fire that already has one; (5) approval recovery uses the monotonic clock.
- **Maintenance**: there is no pause; the manager's quiesce stops the process, and on resume every fire older
  than 2 min is *missed* (per policy: dropped, or one catch-up run per automation). **Recommendations (not
  implemented)**: a durable paused flag with defer-or-miss semantics and run deadlines extended by the pause;
  start the engine after `time-sync.target` (`systemd-time-wait-sync`) — a clock running ahead can't be detected
  from inside and fires schedules early; record skipped catch-ups (“Missed 12 runs while Whombat was down”);
  clamp run dates created while the clock was ahead; an engine-lock liveness check that demotes the engine.

## NixOS nftables design (for the appliance module; not implemented in this repository)

The egress service is the policy; nftables is the wall under it, so a bug in the runner's proxy still can't
reach the LAN or metadata. Tasks themselves have no route (own netns). Proposed module knobs
(`services.whombat.runner.egress.*`):

```nix
services.whombat.runner = {
  sandbox.cgroup = "delegated";              # unit gets Delegate=yes (cpu memory pids), Slice=whombat-tasks.slice
  sandbox.bwrap = "${pkgs.bubblewrap}/bin/bwrap";
  sandbox.readOnlyPaths = [ toolchainProfile ];
  egress.serverPort = 4620;                  # the runtime server on loopback (MCP forward)
  egress.grants = [ ];                        # [{ cidr = "10.20.0.0/16"; ports = [ 5432 ]; }] — explicit only
  egress.allowHosts = [ ];                    # extra public hosts (registries)
};
boot.kernel.sysctl."user.max_user_namespaces" = 15000;  # bubblewrap (and the providers' nested sandboxes)
```

```
table inet whombat_runner {
  set denied4 { type ipv4_addr; flags interval; elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10,
    127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3,
    168.63.129.16 } }
  set denied6 { type ipv6_addr; flags interval; elements = { ::/127, ::ffff:0:0/96, 64:ff9b::/96, 64:ff9b:1::/48,
    2001::/32, 2002::/16, fc00::/7, fe80::/10, fec0::/10, ff00::/8 } }
  set granted4 { type ipv4_addr; flags interval; }            # from egress.grants
  set granted6 { type ipv6_addr; flags interval; }
  chain output {
    type filter hook output priority 0; policy accept;
    socket cgroupv2 level 2 != "system.slice/whombat-runner.service" accept   # only the runner's processes
    oif lo tcp dport 4620 accept                                              # the runtime server (MCP)
    oif lo udp dport 53 accept                                                # the host resolver (systemd-resolved stub)
    ip daddr @granted4 accept
    ip6 daddr @granted6 accept
    ip daddr @denied4 counter reject with icmpx admin-prohibited
    ip6 daddr @denied6 counter reject with icmpx admin-prohibited
    meta l4proto { tcp } th dport { 80, 443 } accept
    meta l4proto udp th dport 53 ip daddr @resolvers accept                   # only the configured resolvers
    counter reject with icmpx admin-prohibited
  }
}
```

The runner (not the task) resolves names; DNS from the runner goes only to the appliance's resolver. Everything
else the runner needs is loopback (server) and 443 (providers, GitHub, through the proxy on behalf of tasks).

## Tests (run on this host: Debian 13, kernel 6.12, bubblewrap 0.12.0, systemd user manager, cgroup v2)

- `packages/agent-runtime/src/access/managed/sandbox.test.ts` (real sandbox, 12 tests): a fake provider CLI runs
  `git commit` (a malicious pre-commit hook), `npm install` (a malicious postinstall) and a malicious stdio MCP
  server; each tool tries 30 forbidden accesses (plus its owner’s home as a control) — another identity's credential home, the master key, `/persist/identity`,
  Whombat's home, the host's Claude / Codex / gh / SSH logins, `/root`, fake Docker / manager / helper / Postgres
  sockets, the host's real `/var/run/docker.sock`, the real SSH agent socket, `$SSH_AUTH_SOCK`, the runner's
  `/proc/<pid>/environ` and any runner process in `/proc`, writes to `/usr` and the host tmp, TCP to the host's
  loopback (v4 and v6), 10.0.0.1, 192.168.1.1, 169.254.169.254, fd00::1, 1.1.1.1 directly, DNS to 8.8.8.8 and
  2001:4860:4860::8888 — only the owner's own credential home is reached; the MCP call works and the rest of the
  server answers 403. Network: allowed host through the proxy (plain and CONNECT) works; direct connection fails;
  redirects to private / metadata refused, to loopback never reach the host; not-allowed host, rebinding name,
  private literal, loopback through the proxy (v4, v6) refused; DNS answers only allowed names. Fork bomb stopped at
  `pids.max` and killed whole; memory limit → OOM kill reported; output flood killed; the providers' process-group
  kill takes down the tree including `setsid` children; seccomp (keyctl, bpf, perf_event_open, userfaultfd,
  open_by_handle_at → EPERM, io_uring_setup → ENOSYS) with nested bubblewrap and `unshare -Ur` still working;
  a runner SIGKILLed mid-task leaves nothing running, and a surviving task of an earlier generation is killed by
  the next generation's start; **real `claude --version` (2.1.282) and `codex --version` (codex-cli 0.157.0) run
  inside** (no model calls); no bubblewrap / no cgroups → `SandboxUnavailable` with the reason.
- `addresses.test.ts`, `outcomes.test.ts`, `credentials.test.ts`: classification (IPv4/IPv6/embedded), policy
  decisions, grants; each provider failure state distinct; credential owners (auth mode, departed, not signed in).
- `workspace/contention.test.ts` (separate processes): locks serialise, a waiter times out naming the holder, a
  crashed holder releases, four concurrent prepares on one repository succeed consistently, a busy repository
  refuses clearly; a newer generation fences the old one's push and prepare (and an earlier attempt's).
- `apps/runner/src/managed-turn.test.ts`: the turn runs through the sandbox with the owner's home, the provider's
  egress and the MCP bridge; every outcome (not signed in, departed, expired, quota, outage retryable, missing
  binary, limit, wall time) is its own code; no sandbox / sandbox unavailable → refused and nothing runs; lease
  lost → stopped and killed; the generation advances and is single-runner. `managed-sandbox.test.ts`: the real
  Codex provider (fake app-server) through `runDispatch` inside the real sandbox — only the owner's `CODEX_HOME`,
  no `RUNNER_TOKEN` / master key / SSH agent in its environment.
- `apps/server/src/runtime/fencing.int.test.ts` (managed server, real Postgres): generation 8 took over; every
  write point refuses generation 7 and token-less calls; nothing moved; generation 8 completes. Fails when the
  strict check is removed (checked).
- `apps/server/src/automations/schedule-clock.int.test.ts` (8 tests, MSB-17).

Commands: `TMPDIR=~/.cache/wb-tmp pnpm check` (848 passed, 6 skipped — the opt-in live suites),
`TMPDIR=~/.cache/wb-tmp pnpm test:server` (778 passed, 15 skipped).

## Unrun qualifications (need the NixOS appliance)

1. **Delegated cgroup under the real unit.** On the appliance: `systemctl show whombat-runner -p Delegate`
   (`yes`), start the runner with `WHOMBAT_SANDBOX_CGROUP=delegated`, check the log line “managed · sandbox:
   … delegated cgroup /sys/fs/cgroup/system.slice/whombat-runner.service”, run a turn, and
   `cat /sys/fs/cgroup/system.slice/whombat-runner.service/tasks/g*/memory.max`. Then `systemctl kill -s KILL
   whombat-runner` during a turn and `systemctl start whombat-runner`: the log names the killed orphans and
   `systemd-cgls -u whombat-runner.service` shows only `supervisor`. (Here the same code ran under a user-manager
   delegated scope, not under the system manager.)
2. **nftables wall.** Load the table above; from the runner's uid: `curl -m 3 http://192.168.1.1`,
   `curl -m 3 http://169.254.169.254`, `curl -6 -m 3 http://[fd00::1]` all rejected (counter increments), a
   granted CIDR reachable; from another unit unaffected.
3. **Per-task disk quota** (workspaces): XFS project quotas or a btrfs subvolume + qgroup per workspace, set by
   the runner through the helper (typed op) — not implemented; the tmpfs limits are.
4. **Pinned toolchain profile**: `WHOMBAT_SANDBOX_RO_PATHS` = the Nix profile of the qualified environment; run
   `pnpm install`, `git`, `node`, `python3` inside a task on the appliance image.
5. **Real provider turns in the sandbox** (model calls, subscription logins in per-identity homes, the providers'
   nested sandboxes inside ours, web-key turns through the proxy): opt-in live check, not run here (no model calls
   were made in this workstream).

## Open items

- **Contract**: the credential owner should come from the dispatch context (`runtime.credentialOwnerAccountId`,
  providers workstream); the runner already prefers it when present. A `generation` field on `RunnerLease` would
  make the fence explicit instead of riding in the runner id.
- **Provider policy** (providers workstream): wire `checkProviderVersion` against `WHOMBAT_PROVIDER_PINS` before a
  turn and the self-updater switches; decide how an API-key login is stored in the owner's home (runner-level keys
  are dropped by MSB-18). The providers' own `available()` still checks the host user's login in managed mode.
- **Web-key turns and nested proxies**: Claude's and Codex's own network proxies (inside our sandbox) would have
  to chain to our proxy for a sandboxed shell to browse; not exercised (no live turn with the web key).
- The provider's own home inside the sandbox is a tmpfs (`/home/whombat-task`): caches (`~/.npm`, `~/.cache`) are
  per turn.
- Output limit counts the provider's own stdout/stderr (its JSON stream), not what tools print inside it.
- The server could requeue a restarted runner's older-generation dispatches at once (today: after the lease,
  60 s).
- Self-hosted `RUNNER_ID` set by hand has the non-monotonic `attempts` hole MSB-10 describes (managed avoids it with
  the generation).
