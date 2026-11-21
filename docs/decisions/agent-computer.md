# Workstream: agent computers (a real computer per agent)

Asked on 2026-10-02 by John, in the main checkout: “Give each agent a real computer and let it do what it's asked. Keep a
person in the loop only for consequential actions, and keep the walls that protect the team.” Research and the
proposal: `~/.cache/wb-tmp/research/2026-10-01-hermes-deploy/` (Hermes Agent: the shell runs as the operator, approvals
only on consequential commands, learned procedures saved as skills). John's answers the same day:

- “When I give an agent access to a password in a vault, then it's okay for the agent to keep that key until I remove
  access or remove the password from the vault. We do not have to be overly protective about these vault passwords
  towards agents. I do want to be protective with these vault passwords towards other users though.”
- Platforms: bare metal first, any hypervisor too (appliance PI-21).
- “Got it, proceed with the full implementation.” The one open question (separate computers per person, or keys mounted
  only in their owner's turns plus an end-of-turn sweep) was left to us: AC-30.

Spikes run before deciding (2026-10-02, all test resources removed afterwards): Claude Code 2.1.287 runs every Bash
command through `CLAUDE_CODE_SHELL` (`<shell> -c <command>`, working directory kept); Codex 0.160 ignores `$SHELL` and
`PATH` and runs `<login shell from /etc/passwd> -lc <command>`; Incus 6.0.4 hot-plugs disk shares into a running
instance and enforces per-NIC ACLs (evaluated drop → reject → allow → default).

## Decisions

### The computer

- **AC-00 Inside the appliance, a container per agent (John, 2026-10-02).** **Superseded by one-person.md OP-04**: the agent has no computer; the one wall between what it runs and Whombat's own data stays, as Hermes's sandbox with a wrapper per command (OP-07). A first draft gave each agent an Incus
  *virtual machine* and tried it on the development host's Incus; John: “the agent should get its own computer INSIDE the
  Whombat appliance”, then asked whether agents need separation at all. Answer recorded: one wall is needed — between
  what agents run and Whombat's own data (database, master key, every person's Vault, signing keys, updates, backups) —
  not mainly between agents. The setup he agreed (“Agreed, fully implement this”) is AC-01…AC-52 below. VMs, and
  computers on any host outside the appliance, are out.
- **AC-01 One unprivileged system container per agent, inside the appliance.** **Superseded by one-person.md OP-04, OP-13, OP-16**: commands run on the appliance in Hermes's own terminal with the image's tools, no sudo (installs go into the agent's own space), and Docker through rootless Podman. Each agent gets an Incus container
  (Incus runs inside the appliance; `debian/13` from Whombat's own base image, AC-05), unprivileged (user namespace),
  `security.nesting=true` so Docker runs inside, with a persistent root filesystem: its home, installed tools and clones
  stay. The agent has `sudo` in it, so `apt`, `pip`, `npm -g` work. No KVM needed: the same on bare metal, Proxmox, Incus
  or any other hypervisor (PI-21). The wall is the appliance's kernel (namespaces, cgroups, the default Incus seccomp and
  idmap), like today's sandbox but per agent and persistent.
- **AC-02 The provider CLI stays in today's managed sandbox; its shell runs on the computer.** **Superseded by one-person.md OP-07, OP-S105, OP-S107**: Hermes runs commands through its own terminal, each in a bubblewrap wrapper in its pod and asked through the runner's guard; sign-ins still stay out of their reach. Claude Code and Codex
  keep running inside the two-stage bubblewrap sandbox (MSB-01…MSB-20) with the credential owner's login, the MCP bridge
  and the provider egress unchanged — the provider login never enters the computer. Their shell is
  `whombat-computer-shell` (installed under the name `bash`): Claude gets it as `CLAUDE_CODE_SHELL` (flag settings
  `env`), Codex as the login shell of the generated `/etc/passwd`. The wrapper sends `-c`/`-lc <command>`, the working
  directory, the environment the CLI set for the command, stdin and (when it has a terminal) a PTY with its size over a
  new loopback bridge (`127.0.0.1:47102`, `SANDBOX_PORTS.computer`) to the runner's exec service, which runs it on the
  agent's computer as the user `agent`. Output, exit code and signals come back the same way. In computer turns
  Claude's own Bash sandbox is off (`bashSandbox: 'off'`) and Codex runs `danger-full-access` inside our sandbox: the
  computer is the wall for commands, the managed sandbox stays the wall for the CLI. Claude's Bash timeouts are raised
  (`BASH_DEFAULT_TIMEOUT_MS` 30 min, `BASH_MAX_TIMEOUT_MS` 2 h) so an approval wait (AC-41) isn't cut at two minutes.
- **AC-03 The turn's files are shared, at the same paths.** **Superseded in part by one-person.md OP-S109**: the turn's checkout, its git folders and the agent's home are still at their real paths, now bound into each command's wrapper. The paths the sandbox mounts for a turn (working directory,
  commit paths, borrowed clone objects, turn files, skills) are hot-plugged into the container as Incus disk devices at
  the same absolute paths and with the same read/write mode (idmapped, `shift=true`, so the container's `agent` writes
  as the runner's uid), and removed after the turn. The CLI's own file tools (Read, Edit, apply_patch) and the
  computer's shell therefore see the same files. Files elsewhere on the computer (its home, `/etc`) are reached with the
  shell; the prompt says so.
- **AC-04 `computerd` owns Incus; nothing else touches it.** **Superseded by one-person.md OP-S114**: computerd is cut down to whombat-agent-net, the commands' proxy; nothing runs Incus. A separate process (`apps/computerd`) holds the only access
  to the appliance's Incus (the `incus` CLI on its socket) and serves the runner and the server over a unix socket
  (`WHOMBAT_COMPUTERD_SOCKET`, 0660). It manages only instances, ACLs and images it created (name prefix + labels
  `user.whombat.*`), shares only paths under configured roots (workspaces, workdir roots, runner temp), and refuses
  everything else. On the appliance it is its own unit in the `incus-admin` group; the runner and server keep their
  hardening and reach it only through the socket.
- **AC-05 Whombat's own base image.** **Superseded by one-person.md OP-13**: the agent's tools come with the appliance's image; there is no base image. On first use computerd builds `whombat-computer-base/<version>` once: launches
  `images:debian/13/cloud` as a container, provisions it (user `agent` with passwordless sudo, Docker, Chromium, git,
  build tools, Node, Python with venv/pip, openssh-client, rsync, curl, jq, zip; `~/.ssh/config` includes
  `/run/whombat/keys/ssh_config`), publishes it as a local image and deletes the builder. New computers start from it
  in seconds. The image version is part of computerd; a new version is built next to the old one and only new or reset
  computers use it. Follow-up (not now): ship the base image through Whombat's update channel instead of the Incus
  image server.
- **AC-06 Size and lifetime.** **Superseded by one-person.md OP-04, OP-S108**: there is no computer to size, stop or reset; each command gets a cgroup of its own inside the task's. Defaults 2 CPUs, 4 GiB memory, 40 GiB root disk quota
  (`WHOMBAT_COMPUTERS_{CPUS,MEMORY_MB,DISK_GB}`); stopped after 30 idle minutes (`WHOMBAT_COMPUTERS_IDLE_MINUTES`), started
  again by the next turn (about a second). **Reset** rebuilds it from the base image (home and tools gone, confirmed in
  the app); removing the agent removes its computer.
- **AC-07 Names.** **Superseded by one-person.md OP-04.** Instance `wbc-<install>-<agent>`, ACL `wbc-<install>-<agent>`, bridge `wbc<install>` (install = the
  first 8 hex of sha256 of the Whombat home path). Everything lives in Incus's `default` project (6.0 keeps bridge
  networks there, and a per-NIC ACL from another project fails to load).

### The wall at the edge

- **AC-10 Any public address, any port; never this host, other computers or private networks.** **Superseded in part by one-person.md OP-07, OP-S114**: commands reach the same (public addresses on every port but 25, private networks only as allowed, never this host but the agent's own services on 20000–20099) through the commands' proxy, whombat-agent-net, instead of a per-computer ACL. Each computer's NIC
  has its own ACL of **allow rules only** with default reject: TCP to the public IPv4 space on every port except 25,
  UDP and ICMP to the public space, DNS (UDP/TCP 53) to the bridge gateway. The public space is computed as everything
  minus loopback, RFC 1918, CGNAT, link-local, multicast, reserved and documentation ranges, minus every address of the
  host itself, minus `WHOMBAT_COMPUTERS_DENY`, minus production servers (AC-11). Private networks open only through the
  burrow's home-network list (the Vault's, VT-11), as extra allow rules. The bridge has no IPv6. A per-NIC ACL also
  filters traffic between computers on the bridge.
- **AC-11 Production servers are closed until a person says yes.** **Superseded in part by one-person.md OP-07, OP-S114**: production servers stay closed to commands until the person says yes, now in the commands' proxy. An SSH server in the Vault can be marked
  **Production** (`VaultSshServer.production`). Its addresses (resolved when a turn starts) are left out of the public
  space, so nothing on the computer reaches them — whatever the command looks like (`./deploy.sh` included). An approved
  command (AC-40…AC-42) opens the server's address and port for that agent: for the command (once), for the rest of the
  task, or always. This is the gate that holds even if the guard doesn't recognise a command.
- **AC-12 The appliance's own firewall agrees.** **Superseded by one-person.md OP-S114**: the appliance gives whombat-agent-net's uid the rules the computers' bridge had. The appliance's nftables (NX-*) forward the computers' bridge to the
  internet and never into the appliance's own services; the ACL is the per-computer wall inside that.

### Turns

- **AC-20 A computer works for one person at a time.** **Superseded by one-person.md OP-01, OP-S42**: with one person no turn waits for another person's, and the claim rule is gone. With computers on, the server's claim skips a dispatch while
  another in-flight dispatch of the same agent works for a different person (`onBehalfOfAccountId`); the same person's
  turns may run side by side (they hold the same keys). The waiting turn starts when the computer is free.
  *Amended by turn-efficiency.md TE-04:* the claim counts only a turn that began on the computer (`computerBegun`); the
  runner holds the computer per person from a turn's first command there and keeps another person's first command
  waiting (“Waiting for the computer”).
- **AC-21 Before the provider starts**: **Superseded in part by one-person.md OP-S105, OP-S106, OP-S109**: there is nothing to begin, share or sweep; keys exist only in each command's wrapper, and a background job still outlives its command until it is stopped or the pod ends. computerd ensures the computer is running, applies the policy (AC-10, AC-11),
  shares the turn's paths (AC-03) and writes the requester's keys (AC-31). **After the turn** (also on failure and
  cancel, before landing or pushing): the turn's command process groups are ended, keys wiped, the sweep (AC-32) run,
  files the computer's root created in shared paths given back to `agent` and set-uid/set-gid bits removed, shares
  removed. Background processes the agent started on purpose keep running on its computer (it is a real computer); a
  command the CLI killed is ended with its process group.
- **AC-22 Git control files can't be planted.** A shared repository's `config`, `config.worktree`, `info/`, `hooks/` and
  the worktree's `.git` file are snapshotted before the turn and restored byte for byte (new hooks deleted) before the
  runner runs any git of its own; the runner's git keeps `core.hooksPath=/dev/null` and `core.fsmonitor=false`.
- **AC-23 Only on the appliance, only managed mode.** **Superseded by one-person.md OP-S110, OP-S115**: commands run in the same wrappers on the appliance and in development, and an outsiders' turn's commands run in its own task sandbox. Computers need the managed sandbox's generated `/etc/passwd` and
  loopback bridges, and live inside the appliance; the appliance's NixOS module turns them on (`WHOMBAT_COMPUTERS=incus`).
  The dev stack on a development host keeps today's sandbox (computers off); self-hosted guarded/trusted turns are
  unchanged. Development tests may create short-lived `wbc-test-*` containers on a development host's Incus and remove
  them; real computers exist only inside appliances. DEV testing happens on the DEV box. Feedback assessments (read-only, FB-*) and scratch-only system turns
  never use a computer.
- **AC-24 A turn without a checkout is a computer turn when the server gives a computer (lead, 2026-10-02).** **Superseded in part by one-person.md OP-S109**: a turn without a checkout still works in a lasting work folder, now `~/work` in the agent's home. Instead
  of the throwaway scratch folder its working directory is the agent's own persistent work folder
  `<WHOMBAT_WORKSPACES>/.computers/<agentId>/work` (made 0700 by the runner, owned by the runner's uid, under
  computerd's workspaces root), mounted read-write as the sandbox's cwd and shared into the computer read-write at the
  same path like other turn paths, with `/home/agent/work` a link to it. It stays between turns, so clones the agent
  makes there are visible to the CLI's file tools. Everything else the scratch turn had stays (network per keys, …);
  the scratch folder stays for non-computer turns, and Feedback assessments never get a computer. Resolves AC-DP13.

### Vault on the computer (amends VT-04, VT-10, VT-S01 and John's answer 1 of `vault.md`)

- **AC-30 Keys live on the computer only during their owner's turns.** **Superseded by one-person.md OP-S60, OP-S109**: every entry is the person's; a person's turn's keys reach its commands as variables and SSH key files on a tmpfs, and an outsiders' turn gets none. John allows an agent to hold what it was given
  until the key is taken back; the protection is towards other people. Per agent key (`vault_keys`) the owner chooses
  the delivery: **Whombat uses it for {Agent}** (today's brokered tools, the safer choice) or **On {Agent}'s computer**.
  Computer keys are written into the computer's tmpfs `/run/whombat/keys` at the start of a turn **only when the turn
  works for the key's owner** (or carries the owner's pass for it, AC-33), and wiped when the turn ends. Separate
  computers per person were rejected: twice the resources and no continuity of “Banjo's computer”.
- **AC-31 What lands where.** **Superseded in part by one-person.md OP-S109**: SSH keys and values still land this way, on the tmpfs at `/run/whombat/keys` and in the environment of each command of the turn. SSH entry → the private key file and an `ssh_config` with one `Host <server name>` block
  per covered server (HostName, Port, User, IdentityFile, IdentitiesOnly) plus `known_hosts` with the owner-trusted host
  keys (`StrictHostKeyChecking yes`; an untrusted server gets no block). Token, header, basic, query, login and secret
  entries → environment variables in every command of that turn (name chosen by the owner, default from the entry's
  name, e.g. `CLOUDFLARE_API_TOKEN`; basic and login → `<NAME>_USERNAME` and `<NAME>_PASSWORD`). MCP entries can't be
  put on a computer. Since a key is “Allowed” or “Asks” as before, Asks still asks the owner once per turn.
- **AC-32 Copies are swept; other people never see a value.** **Superseded in part by one-person.md OP-S42**: the server still scrubs delivered values from what the agent posts; there is no sweep. After each turn computerd replaces every delivered
  secret value found in files changed during the turn (home and shared paths) with `[removed by Whombat]`, and the owner
  is told which files. Whatever an agent posts (messages, tool evidence, activity) is scrubbed server-side of every
  value delivered to that agent's computer before anyone sees it (VT-42's withhold rule stays for brokered answers).
- **AC-33 Someone else's turn asks the owner.** **Superseded by one-person.md OP-03, OP-S60**: every turn but an outsiders' is the person's own, so there is no other owner to ask. In another person's turn the prompt names the owner's computer keys as
  not present; `request_vault_key` (or a use of a brokered tool) asks the owner with the existing `vault_use` card in
  their DM, now with the agent's stated purpose. Yes → the next turn holds a pass and gets the key; no → declined.
- **AC-34 Taking a key back.** Nothing persists on the computer beyond a turn, but the agent may have kept a copy: when
  a computer key is taken back (or its entry removed), the owner is told to rotate it; for an SSH entry the Vault's
  “Generate a new key” is offered with the servers to update.

### Approvals in the same turn

- **AC-40 The guard reads every command before it runs.** **Superseded in part by one-person.md OP-S107**: the guard still reads every command before it runs, asked by each command's launcher instead of the computer's exec service. All shell commands of a computer turn pass the runner's exec
  service, so one guard covers Claude and Codex. `classifyCommand` (pure, in `@whombat/core`) recognises:
  deploys (`ssh`/`scp`/`rsync`/`sftp` to a production server by name or address, `fly deploy`, `wrangler deploy|publish|
  pages deploy`, `vercel --prod`, `netlify deploy --prod`, `kubectl apply|create|replace|patch|delete|rollout|scale`,
  `helm install|upgrade|rollback|uninstall`, `terraform|tofu apply|destroy`, `pulumi up|destroy`, `docker push`,
  `npm|pnpm|yarn publish`); merges (`gh pr merge`); pushes to the default branch (`git push … main|master|HEAD:main`,
  `--force` to it); destructive commands on other machines (over `ssh`: `rm -rf`, `DROP`, `TRUNCATE`, `docker compose
  down`, `systemctl stop`; `docker -H ssh://…`); messages to the outside world (`sendmail`, `mail`, `swaks`, webhook
  hosts of Slack, Discord, Telegram, Teams). It looks through `sudo`, `env`, pipes, `&&`/`||`/`;`, `$(…)` and one level
  of `bash -c`/`sh -c`. Destructive commands on the agent's own computer are not asked about.
- **AC-41 Keys decide; Ask waits in the same turn.** Category → key: deploy → `deploy` (`deploy.production` when the
  target is a production server), merge → `merge.main`, push to the default branch → `branch.main.push` (now Off · Ask ·
  On for agents too, a third row “Push to main”), destructive → new key `commands.destructive` (“Destructive commands on
  other machines”), outside messages → `messages.external`. On → runs; Off → refused at once (exit 126, a sentence
  naming the key); Ask → a `run_command` approval card in the turn's thread with the exact command, and the command
  waits (up to `WHOMBAT_COMPUTERS_APPROVAL_WAIT_MINUTES`, 15) while the turn stays alive. Yes → it runs and its output
  goes back to the agent in the same turn; no → exit 126 “{Name} said no; the command didn't run.”; no answer in time →
  exit 125, the card stays, and a later yes wakes the agent (`approval_granted`) holding the allowance.
- **AC-42 Allow once, for this task, or always.** The card offers **Allow once**, **Allow for this task**, **Always allow
  for {Agent}** and **Don't allow** (`approvals.decide` gains `scope`). Once = this command, this turn. Task = the same
  command and target for the rest of the run, or of the thread when there is no run. Always = stored per agent
  (`command_allowances`: agent, key, normalised command, target), shown and removable in the agent's Access settings.
- **AC-43 A deploy is just commands.** No deploy workflow is needed any more: an agent with a computer deploys the way a
  person would, with the guard and the production wall above. The GitHub-workflow executor stays as one way an agent can
  deploy (`perform_action deploy`), not a requirement.

### Roles, prompt, skills

- **AC-50 Generous defaults; roles keep their purpose.** New hires (existing agents keep their keys): every role gets
  “Browse the web” and the scratch workspace; Developer also tests, installs (its computer), pushes feature branches and
  opens pull requests, with Merge and Deploy at Ask and Push to main Off; Researcher reads, browses and uses the browser;
  Lead plans and hands off. Keys stay for the consequential things (AC-41) plus spending and outside messages.
- **AC-51 A resourceful prompt.** **Superseded in part by one-person.md OP-S87**: the prompt still says to investigate, check the result and ask only for credentials or decisions; it names no computer, says there is no sudo or apt (install in your own space) and mentions Docker only where the engine is. With a computer the prompt says: you have your own computer (Debian, sudo, Docker,
  Chromium, full internet; production servers open only with a person's yes); investigate first (README, docs, scripts,
  CI, configs, `AGENTS.md`), install what's missing, try alternatives, verify the result, and ask people only for what
  tools can't give — credentials or decisions. The lines that told agents to stop at the first missing capability
  (no network, never ssh yourself, don't look for another way) are rewritten for computer turns; brokered Vault use is
  described only for brokered keys.
- **AC-52 Learned skills are active at once.** After a non-trivial task the agent writes down how it did it with
  `propose_skill` (“how whombat-website deploys”); the scanner still refuses dangerous skills, but a clean one is active
  immediately in the agent's own pack, and the thread gets a “{Agent} learned a skill” card with **Remove**. Supersedes
  SL-06's person approval for an agent's own pack (other packs unchanged).

## Implementation decisions: computer runtime (stream R, branch `agent-computer-runtime`)

Numbered `AC-DR…` so they can't collide with the other streams' `AC-D…`. Code: `apps/computerd`, `packages/computer`,
`apps/runner/src/computer*.ts`, `apps/runner/src/git-control.ts`, `packages/agent-runtime/src/access/managed/` (sandbox,
shim), the providers' computer paths, `apps/server/src/computers/`, the AC-20 rule in `apps/server/src/runtime/service.ts`.

- **AC-DR01 One wire for a command.** **Superseded by one-person.md OP-S107, OP-S116**: `packages/computer` is deleted; a command's launcher talks to the runner over `commands.sock`. `packages/computer` (`@whombat/computer`) holds the frame codec
  (`computer-frames.mjs`, plain JavaScript: the wrapper runs on the sandbox's Node with nothing else), the wrapper
  (`computer-shell.mjs`), the computerd request schemas and client. Wrapper → runner → computerd speak the same thing:
  one JSON request line, one JSON reply line, then frames `[type u8][length u32 BE][payload]` (stdin, stdout, stderr,
  exit `{code, signal}`, signal, resize `{cols, rows}`, eof), payloads ≤ 256 KiB (bigger writes split). The release ships
  `app/computer-shell.mjs` and `app/computer-frames.mjs` (APP_FILES), `app/computerd.mjs` and `bin/whombat-computerd`.
- **AC-DR02 Names.** **Superseded by one-person.md OP-04.** `wbc-<install>-<12 hex of sha256(agent id)>` (instance names are lowercase host names; agent ids
  are case-sensitive); the real id is the label `user.whombat.agent`. `WHOMBAT_COMPUTERS_{PREFIX,INSTALL_ID,BRIDGE}`
  override them (tests use `wbc-test-…`). A builder is `<prefix>-<install>-base`.
- **AC-DR03 computerd's state.** **Superseded by one-person.md OP-S114.** One request per connection on the 0660 socket. Ops: `status`, `list`, `info`, `ensure`
  (`wait: false` answers at once), `stop`, `reset`, `remove`, `begin`/`end` (a turn's session), `setPolicy`, `setOpen`,
  `share`/`unshare`, `writeKeys`/`wipeKeys`, `sweep`, `fixup`, `endGroups`, `exec`. Per agent it keeps in memory the
  sessions (keys, openings, shares), the last policy and the last activity; instance-changing operations of one agent
  are serialized. A restarted computerd forgets sessions: the next `begin` removes shares nobody holds, and at start
  every `whombat open …` rule of its ACLs is dropped. Only instances, ACLs and the bridge with our prefix and labels are
  touched; a same-named object without them is refused.
- **AC-DR04 The container.** **Superseded by one-person.md OP-04.** `security.privileged=false`, `security.nesting=true`, and
  `security.syscalls.intercept.{mknod,setxattr}=true` (Docker's overlay storage in an unprivileged container);
  `limits.cpu`, `limits.memory` (MiB), `root` disk `size=<n>GiB`. `status` = Incus answers and has the LXC driver; there
  is no KVM check. Measured here (Incus 6.0.4, ZFS): a computer from the base image is running in ~2 s; `docker info`
  works as the container's root.
- **AC-DR05 A command on the computer** **Superseded by one-person.md OP-S105, OP-S107**: a command joins the commands' holder and runs in a bubblewrap of its own. (how the spec gets there: AC-DR21). `incus exec <c> -t|-T -- setpriv
  --reuid=<uid> --regid=<gid> --init-groups -- setsid [--ctty] --wait /usr/local/lib/whombat/run <handle>` — `setpriv` for the agent's supplementary groups
  (`docker`, `sudo`; `incus exec --user` sets none), `setsid` because in a container the process `incus exec` starts is
  not a group leader (measured: pgid 0), so the command gets its own session and process group. The launcher writes
  `<pid> <tty>` to `/run/whombat/exec/<handle>`, changes to the working directory (the home when the turn's path isn't on
  the computer), sets the terminal size, sources `/run/whombat/keys/env` and execs `bash` with the wrapper's options,
  `-l`, `-c` and `$0…`. `HOME=/home/agent`, `USER`, `PATH` are the computer's; the client's other variables come with
  the command, minus anything that looks like a secret (MSB-18's names, `WHOMBAT_*`), so `--env` never carries one; Vault
  values reach commands only through the keys' env file, pushed on stdin. Signals: `kill -s SIG -- -<pgid>` in a second
  exec; a command killed by the signal it was sent reports that signal (Incus says 255). Resize: `stty -F <tty>` and
  `SIGWINCH` to the group. Superseded in part by AC-DR21: no `--env`, the launcher is a file.
- **AC-DR06 Which processes a turn's end stops.** **Superseded by one-person.md OP-S106, OP-S108**: a killed command's cgroup is killed whole; a background job lives on in the holder until it is stopped or the pod ends. A command the AI client killed (the wrapper's connection closed before
  the exit) is ended with its whole process group: SIGTERM, then SIGKILL. At the turn's end every command's group is
  hung up like a closed terminal: SIGHUP, and two seconds later SIGKILL to what is still in it and doesn't ignore
  SIGHUP. So `nohup`, `setsid`, daemons, `docker run -d` and services keep running (“on purpose”, AC-21); `cmd &` alone
  doesn't. Tested on real Incus (`nohup sleep` and `setsid sleep` survive, `sleep &` is gone).
- **AC-DR07 Root's files on the host.** **Superseded by one-person.md OP-04, OP-S109**: no sudo and no idmapped shares; commands run as the agent's own user at the real paths. Idmapped shares map the container's root to the host's root, so `sudo` on the
  computer can leave root-owned or set-uid files in shared paths. The fixup (as the container's root, `-xdev`) deletes
  device nodes, drops set-uid / set-gid bits of files and chowns entries owned by uid or gid 0 to the agent; it runs
  before the runner's own git (a push mid-turn, the landing) and at the turn's end. Open issue: between a write and the
  fixup such a file exists on the host (only the runner's user and the computer can reach the workspace).
- **AC-DR08 The sweep.** **Superseded by one-person.md OP-S42.** `python3` in the container as root, needles on stdin: regular files ≤ 10 MiB modified since the
  turn began (5 s slack) under the turn's writable shares and `/home/agent`, symlinks never followed, other mounts not
  entered, `.git/objects` skipped; each needle (≥ 4 characters; shorter ones would match everywhere) replaced with
  `[removed by Whombat]` in place (same inode, owner, mode and mtime). It answers the files and how many values it
  replaced; the runner reports them (`computerReport`) when there were any.
- **AC-DR09 The base image.** **Superseded by one-person.md OP-13**: the tools come with the appliance's image. Built in a builder container from `WHOMBAT_COMPUTERS_IMAGE_SOURCE` by cloud-init
  (`users: []`, one provisioning script: user `agent` with the configured uid/gid, passwordless sudo, groups `sudo` and
  `docker`; `docker.io`, `docker-cli`, `docker-compose`, `chromium`, `git`, `build-essential`, `nodejs`, `npm`,
  `python3{,-venv,-pip}`, `openssh-client`, `rsync`, `curl`, `wget`, `jq`, `zip`, `unzip`; `~/.ssh/config` including
  `/run/whombat/keys/ssh_config`; tmpfiles for `/run/whombat/{exec,keys}`; `users: []` for later boots), checked by a
  marker file, `cloud-init clean --logs --machine-id`, published as `whombat-computer-base/<IMAGE_VERSION>-u<uid>g<gid>`
  (the uid is baked in), the builder deleted. One build at a time; a build that finds the alias published meanwhile
  takes it. `IMAGE_VERSION` is 4 (AC-DR21). Measured: about two minutes here.
- **AC-DR10 Files land with the runner's uid.** **Superseded by one-person.md OP-S109**: commands see the agent's home and the turn's paths at their real paths; nothing is shared into a container. Shares are disk devices with `shift=true` at the same path; the
  container's `agent` has the runner's uid/gid (`WHOMBAT_COMPUTERS_UID/GID`, default computerd's own, ≤ 65535: inside
  the default idmap). Verified on real Incus: a file the agent writes in a share is owned by the runner's uid on the
  host, and a file the host writes is readable on the computer.
- **AC-DR11 The sandbox side.** **Superseded by one-person.md OP-S107**: Hermes's terminal runs every command through `whombat-command`. `COMPUTER_SHELL` = `/home/whombat-task/.whombat/bin/bash`: a per-turn launcher
  (`#!/bin/sh` exec of the sandbox's Node with the wrapper), bound read-only there and at its own path (stage 2 binds
  from stage 1's view); the wrapper's directory read-only; the exec service's socket directory in stage 1 only; the
  task user's login shell in the generated `/etc/passwd` is the launcher (Codex). A temp dir shared at the same path is
  Claude Code's `CLAUDE_CODE_TMPDIR`: after each command Claude Code writes `pwd -P` to a file there and reads it back to
  follow `cd`. Claude gets `CLAUDE_CODE_SHELL`, `CLAUDE_CODE_TMPDIR`, `BASH_DEFAULT_TIMEOUT_MS=1800000`,
  `BASH_MAX_TIMEOUT_MS=7200000` in its flag settings, no shell sandbox, and Bash allowed by `canUseTool`; its file tools
  stay confined. Codex runs `danger-full-access` without the guarded profile, `features.shell_snapshot=false`. A computer
  turn reports access `{guarded, sandbox on, commands sandboxed}` (the computer is the wall for commands).
- **AC-DR12 Git control files.** The snapshot set is the checkout's `CommitPaths.denyWrite` (a whole `.git` dir counts
  for its `config`, `config.worktree`, `info/`, `hooks/`, `commondir`, `gitdir`, `objects/info`), taken before the
  computer is begun. The restore removes anything new, never follows or writes through a link or a hard link (a fresh
  inode), and runs before every push and landing of the turn and at its end; if it fails, nothing is pushed or landed
  and the workspace report says why.
- **AC-DR13 The wall's details.** **Superseded by one-person.md OP-S114**: the commands' proxy applies the home networks, the openings and the rest of the wall. Besides AC-10's rules: DHCP out (UDP 67 to the broadcast address and the gateway) and
  its answer in (UDP from the gateway's 67 to 68 — connection tracking doesn't tie it to the broadcast request; without
  it the container gets no address). Ingress default reject. Home networks (CIDRs, as `DispatchComputerContext` has
  them) allow TCP on every port but 25 and UDP, minus this host and production servers. An opening without a port
  allows every TCP port but 25; openings to this host, the deny list or private space outside the home networks are
  dropped. A new computer reaches only DHCP and DNS until a turn sets its policy; between turns the last policy stays.
- **AC-DR14 What a turn shares.** **Superseded by one-person.md OP-S109.** The sandbox's working directory, commit paths (writable only when the turn may write)
  and readable directories, each with its mode; a readable file only through its directory when that directory is the
  turn's own (`turn-files-<dispatch>…`); never a directory with a denied path inside it (a workdir root holding
  `~/.whombat`, say), never the credential home; a nested path only when it opens writing; at most 24. A path computerd
  refuses (outside its roots) is logged and left out: the CLI's file tools still see it.
- **AC-DR15 A computer that can't be had refuses the turn.** **Superseded by one-person.md OP-04.** When the server gave the turn a computer and it can't be
  begun, the agent says “My computer couldn’t start (…), so I didn’t do anything. Ask me again in a moment.” — no
  silent fallback to the sandbox, whose prompt would be wrong.
- **AC-DR16 Openings and approvals in the exec service.** **Superseded in part by one-person.md OP-S107, OP-S114**: the guard, the openings and their scopes hold, decided by the runner per command and opened in whombat-agent-net. The guard is `classifyCommand` with the turn's production
  servers; only a hit asks the server. `run` straight away (key On, an allowance) opens what the answer names until the
  turn ends; after a person's yes the scope decides: once = until the command exits plus 60 s, task / agent = until the
  turn ends. Hosts are resolved to IPv4 when opened; the wall's production addresses are the server's list plus the
  runner's own resolution at the turn's start. The wait polls `authorizeWait` (≤ 25 s each) for
  `WHOMBAT_COMPUTERS_APPROVAL_WAIT_MINUTES` and stops when the wrapper goes; a failed poll is retried after 2 s.
- **AC-DR17 Server.** **Superseded by one-person.md OP-S42**: `computers.*` and the claim rule are gone; the person stops the agent's services instead (OP-S45). `computers.get` for any member; `computers.start|stop|reset` for the people who manage the agent
  (a personal agent's owner; else burrow owners and its hirer — `canRetireAgent`'s rule, not the keys engine, so no
  approval card), each signed `agent.computer` (Keys, “Started Banjo’s computer”) before computerd acts; Stop and Reset
  answer the contracts' busy sentence (`conflict`) while a turn of the agent is in flight. `toAgentComputer`: `starting`
  shows as `running`, `stopping` as `stopped`, `imageVersion` is the image's number; Start doesn't wait (`creating` with
  what is being done). `HostInfo.computers` is cached 30 s, `COMPUTERS_NOT_HERE` when off. A retired agent's computer is
  removed after the commit. AC-20: a turn for nobody counts as another person (it must not see a person's keys); the
  rule is on only with `WHOMBAT_COMPUTERS=incus`. `RUNTIME_FEATURES` `agent.computer` stays in `NOT_IMPLEMENTED` until
  the server stream's approvals and keys are in (the lead moves it).
- **AC-DR18 Runner configuration.** **Superseded by one-person.md OP-S115**: `WHOMBAT_COMPUTERS` and `WHOMBAT_COMPUTERD_SOCKET` are gone; the runner's wait is `WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES`. `WHOMBAT_COMPUTERS=off|incus` (default off), `WHOMBAT_COMPUTERD_SOCKET` (required
  with `incus`), `WHOMBAT_COMPUTERS_APPROVAL_WAIT_MINUTES` (15). Computer turns need a working managed sandbox; the guard is
  the contracts' `classifyCommand`, the waiting and time-out lines the server's `commandWaitingText` /
  `commandTimedOutText`, exit codes `COMMAND_EXIT_CODES`.
- **AC-DR19 The exec socket.** **Superseded by one-person.md OP-S107**: the launcher asks the runner on the pod's `commands.sock`. `<runner tmp>/computers/<dispatch>/ctl/exec.sock`, or a private `/tmp/wbc-exec-…`
  folder when that path is longer than a unix socket allows.
- **AC-DR20 Idle and busy.** **Superseded by one-person.md OP-04.** Idle time counts from the last begin, end, exec or share (computerd's start counts as one);
  a computer with a session is never stopped; Stop and Reset refuse with `busy` while a session is open; Remove ends
  everything.

- **AC-DR21 Nothing of a command on a command line (lead's review).** **Superseded by one-person.md OP-S105, OP-S107**: there is no computerd or `incus exec`; the launcher hands the command to the runner over `commands.sock`. Commands often carry secrets typed by the agent,
  and Vault values are secrets: neither may show in the appliance's process list (a container's processes are on its
  kernel too). computerd pushes each command's spec — working directory, environment, terminal size, bash's options and
  arguments, the command — as JSON on stdin (`incus file push -`) to `/run/whombat/exec/<handle>.json` (0600 `agent`);
  the host runs only `incus exec <c> -t|-T -- setpriv … -- setsid [--ctty] --wait /usr/local/lib/whombat/run <handle>`
  (no `--env`). The launcher (Python, baked into the base image — `IMAGE_VERSION` 4 — and written again before every
  turn, so older computers get it too) reads and deletes the spec, writes the process group, sets the environment
  (the session's keys last, from `/run/whombat/keys/env.json`) and runs `bash [options] [-l]
  /run/whombat/exec/<handle>.sh …` with the command in that script file (0600, removed with the group at the turn's
  end), so `$0` is the script's path rather than the client's. Logs name a command by its first word and a short hash
  (`curl #3fa9c1d2`); the full command is shown only on the approval card. Tested on real Incus: during a command, a
  planted Vault value, a client variable and a marker in the command appear in no `/proc/*/cmdline` of the host. Left as
  it is: the AI client's own `bash -c <command>` inside the task sandbox (its argv is the client's, as in every turn
  today).

- **AC-DR22 The appliance's gate.** **Superseded by one-person.md OP-S42**: `WHOMBAT_COMPUTERS_STATUS_FILE` is gone. computerd and the server read `WHOMBAT_COMPUTERS_STATUS_FILE` (`{state:
  starting|available|unavailable, reason}`, written by the appliance before Incus starts, NX-129…NX-133). While it says
  `starting` computers are unavailable with “Agent computers are starting…”, while `unavailable` with its reason; with
  `available` or no file, Incus itself decides (reachable, LXC driver). computerd starts and listens even when Incus is
  down, checks again every 30 s, and closes stale openings and stops idle computers only once computers are there. The
  server's `HostInfo.computers` is computerd's answer, or the gate's reason when computerd doesn't answer.
- **AC-DR23 Containers: isolated idmap, no autostart.** **Superseded by one-person.md OP-04.** `security.idmap.isolated=true` (a uid/gid range of its own on
  the host per computer) and `boot.autostart=false` (a turn or a person starts it). Tested on real Incus 6.0.4: shares
  with `shift=true` still land files with the runner's uid, the agent's uid/gid inside stay the configured ones, Docker
  runs. Only CLI forms that 6.0 and 7.0 share are used (`init -s -n -c -d`, `config device add|set|remove`, `network
  acl create|edit` from stdin, `query`, `publish --alias`, `file push -`, `exec -t|-T`).
- **AC-DR24 No disk quota on a `dir` pool.** **Superseded by one-person.md OP-04.** The root disk's `size` is set only on pools whose driver enforces it (zfs,
  btrfs, lvm, lvmcluster, ceph; asked once from `/1.0/storage-pools/<pool>`); on `dir` — the appliance's pool, NX-130 —
  it is left out (Incus would refuse it), so a computer's disk shares the pool and `WHOMBAT_COMPUTERS_DISK_GB` is
  reported, not enforced. Tested on a test `dir` pool on real Incus.
- **AC-DR25 The socket's group.** **Superseded by one-person.md OP-S114**: whombat-agent-net's sockets are 0660. computerd's socket is made by the process with its own group (`whombat-computers` on
  the appliance) and only its mode is set to 0660; tested.

## As built — server

Decided in the server stream (branch `agent-computer-server`, 2026-10-02), numbered `AC-DS…` so they can't collide with
the runtime's `AC-DR…`. Code: `apps/server/src/computer/` (config, context, keys, report, secrets, commands, waiters,
routes), `vault/{commands,rotate,request-key,use,context,store,ssh-commands}.ts`, `commands/approvals.ts`
(`scope`), `commit/pipeline.ts` and `runtime/activity.ts` (scrubbing). Migration `0060_agent_computers`.

### Server: Vault keys, commands, scrubbing (AC-11, AC-30…AC-34, AC-41…AC-43)

- **AC-DS01 Computers on.** **Superseded by one-person.md OP-S42.** `computersOn` reads `WHOMBAT_COMPUTERS` from the config when it declares it (the runtime
  stream's config does) and from the environment otherwise, so both branches merge without touching the same lines.
  `WHOMBAT_COMPUTERS_APPROVAL_WAIT_MINUTES` the same way (15). Every runner endpoint of this stream answers 409
  `COMPUTERS_NOT_HERE` while computers are off.
- **AC-DS02 Tables.** **Superseded in part by one-person.md OP-S49**: the tables hold but `vault_keys.delivery`, which `0006_one_person` drops. `vault_keys.delivery` (`whombat` default) and `env_name`; `vault_ssh_servers.production` and
  `host_key_blob`; `approvals.scope`; `command_allowances` (agent, key, normalised command, target — `''` for none so the
  unique index holds); `command_passes`, one row per `run_command` approval that is both the request (asking dispatch,
  its run or thread, category, key, normalised command, target) and, once allowed, the pass (`scope`, `polled_at`,
  `delivered_at`, `used_at`, `woken_at`). Expand class, readers and writers 0047.
- **AC-DS03 Delivery rules.** **Superseded in part by one-person.md OP-S49, OP-S60**: `delivery` is dropped and every entry is the person's; the variable name rules stay. Giving or changing a key: `delivery` absent keeps the key's (`whombat` for a new key);
  `computer` on an MCP entry is `wrong_kind`; `envName` only for a `computer` key of a valued entry (an SSH key is a file,
  `validation_failed` otherwise), else kept, else `defaultVaultEnvName(entry name)`; `vaultEnvNameProblem` through the
  body schema. Any change signs `vault.key.changed`. The owner only (another person's entry is a 404).
- **AC-DS04 Which keys a turn holds** **Superseded in part by one-person.md OP-S42, OP-S60**: a person's turn gets its keys (`runner.turnKeys` in 3.0); an outsiders' turn or a search answer gets none, and there is no other owner's pass. (`runner.computerKeys`). `computer` keys only: the entry's owner is the turn's
  person and the key is at `can`, or the turn holds the owner's pass (any tier, any owner — an `ask` key in the owner's
  own turn, someone else's key after `request_vault_key`). Search answers and Feedback assessments get nothing; an
  entry without a value is skipped. Unsealed only here. Each delivered entry is one RECENT USE line per dispatch,
  “on {Agent}’s computer for this turn” (signed `vault.used`, neutral). The endpoint answers again on a retry (the
  audit isn't repeated) rather than refusing a second call of the same attempt.
- **AC-DS05 SSH on the computer.** **Superseded in part by one-person.md OP-S109**: the SSH files are the same, on the tmpfs at `/run/whombat/keys` of each command's wrapper. The key at `ssh/<entry key>` (0600); per covered server whose host key the owner
  trusts and no other key was seen since: `Host <name> <host>` (the first entry to claim a name or host keeps it), HostName,
  Port, User, IdentityFile, IdentitiesOnly, StrictHostKeyChecking yes, UserKnownHostsFile; `known_hosts` lines
  `host` / `[host]:port` with the trusted key. The Vault keeps only the pinned fingerprint, so the key itself is read
  from the server the first time a turn needs it, used only when its fingerprint is the pin, and kept in
  `host_key_blob` (bookkeeping, cleared when the server moves or another key is trusted). Two keys choosing the same
  variable: the first by entry name keeps it.
- **AC-DS06 `DispatchContext.computer`.** **Superseded in part by one-person.md OP-S42, OP-S87**: the commands' network facts (production servers, home networks) are still read per turn, as 3.0's `DispatchContext.commands`; there are no computers to be off. Every Production server of the burrow's Vault, whoever's entry and whether
  or not the agent holds a key (CT-220: the wall closes them all), resolved with the Vault's resolver when the context
  is built; only addresses the computer could otherwise reach are listed (public, or inside a home network). Home
  networks: the Vault's list as CIDRs. Null while computers are off, and for search answers, Feedback assessments and
  system agents' turns. The Vault context of a computer turn says per entry `delivery`, `onComputer`, `envNames`; the
  session fingerprint includes a computer key's variable.
- **AC-DS07 The sweep notice.** **Superseded by one-person.md OP-S42.** The report names files, not which value was in which: every owner whose entry was on
  the computer in that turn (from the turn's RECENT USE lines) gets one note in their DM — “{Agent} had “{entries}” on its
  computer for your turn.” + `VAULT_COMPUTER_COPY.swept` + up to 20 files (“and N more”) — and each such entry signs
  `vault.swept` (“Removed copies of a private Vault entry from {Agent}’s computer”, file and value counts, no paths).
  Nothing is said when nothing was found. Follow-up for the contracts: a per-entry sweep result.
- **AC-DS08 Scrubbing, at two doors.** (1) The commit pipeline scrubs the parsed input of every command an agent
  commits — messages, replies, edits, plans, run notes, handoffs, approval texts, `request_vault_key`'s purpose —
  before it is read or stored; (2) `recordActivity` scrubs each report's object and evidence. The values are every form
  (`secretForms`, `sshKeyForms`) of every entry the agent holds a `computer` key to, delivered in this turn or not; values
  shorter than 6 characters aren't looked for (they would garble words and ids). Cached per agent for five minutes and
  forgotten on every Vault change that could change them. `[secret]` (`VAULT_SCRUBBED`) replaces them.
- **AC-DS09 Who may say “Always allow”.** **Superseded by one-person.md OP-S07, OP-S62**: the person says every Allow, Always included, and removes allowances. Whoever may change the agent's keys (`agents.manage`; a personal agent's owner
  only), else `not_allowed`; Allow once and Allow for this task by any approver of the card. Removing an allowance: the
  same people (agents are Blocked).
- **AC-DS10 The card.** **Superseded in part by one-person.md OP-S62**: the card is still the agent's, in the asking turn's thread; the person is its only approver. A `run_command` approval as the agent, in the asking turn's thread (author the agent),
  approvers as for any key's ask (the conversation's people, else the burrow's owners; a personal agent's owner alone), so
  the person whose turn it was can answer. Explainer and card text are the server's; title, question, target and WHAT
  HAPPENS come from the action (the exact command). A card still waiting for the same agent, key, command and target in
  the same conversation answers instead of a second one.
- **AC-DS11 What a pass covers.** `task`: the asking dispatch's run, or (no run) the same conversation and thread.
  `once`: spent by the waiting command (`run` from the long poll), or after a late yes by the agent's next identical
  command in the same conversation within 24 hours. Matching is on the normalised command and the target.
- **AC-DS12 A late yes.** A runner counts as waiting while its long poll is open in this process, or it polled within 35 s
  and the asking turn is still going; then the server gives it 40 s to pick the yes up before waking the agent. Otherwise
  the agent is woken at once (`approval_granted` in the card's thread, `wakeForApproval`, once: `woken_at`).
- **AC-DS13 The long poll.** Woken by the decision (an in-process notifier after the commit), else it reads again every
  second, up to `waitMs`; every look stamps `polled_at`. At delivery the key is checked again: set to Off since the yes,
  the answer is `declined` with the keys engine's sentence. `run` carries `commandAllowedText(scope, person)`.
- **AC-DS14 A no.** While the asking turn goes on, the waiting command gets `declined` (“{Name} said no; the command
  didn’t run.”) and nothing is posted (no second wake); once the turn is over, the ordinary decline reply under the card
  wakes the agent.
- **AC-DS15 Classified again.** The server runs `classifyCommand` with the burrow's production servers (and their
  addresses) and its repos' default branches; when its category is more severe than the runner's, it and its target
  win. A runner can only ever ask about more.
- **AC-DS16 Openings.** For `deploy_production` with a target that is a production server's name, host or address: the
  server's host and its reachable addresses, on its port — at On, under an allowance or a pass, and after a yes. Nothing
  else is opened by the server.
- **AC-DS17 What is signed.** A command at On signs nothing of its own (the turn's activity row shows it); Off signs the
  pipeline's Blocked event; a yes signs `approval.approved` (with the scope) and, when executed, “Allowed {Agent} to
  {runCommandPhrase} once | for this task | from now on” — never that it ran (EA-03); Always allow signs
  `command.allowance_added`, a removal `command.allowance_removed` (Keys).
- **AC-DS18 `request_vault_key`** is `vault.use` with kind `computer`: already on the computer in this turn → `ok`; a
  `whombat` key or an MCP entry → `blocked` (`wrong_kind`); someone else's turn → the owner's `vault_use` card with
  `purpose` and `computer: true` (a waiting one answers instead). Listed only in computer turns of an agent holding at
  least one computer key.
- **AC-DS19 The rotate notice** **Superseded in part by one-person.md OP-S61**: the rotate notice still goes out, to the person's Chat; nobody leaves. (AC-34) is a line in the owner's DM with their personal agent (`tellOwner`):
  `vaultRotateNotice`, and for an SSH key “In Settings → Vault, open “{entry}” and choose Generate a new key.” with its
  servers (`name · user@host:port`); a removed SSH entry's note asks to take its public key off those servers instead.
  Sent on a take-back of a computer key, a switch from computer to Whombat and an entry removed while computer keys
  existed; not when an agent retires (its computer goes with it, AC-06) or the owner leaves.
- **AC-DS20 Push to main with computers** (amends MDS-D07). On the computer a `git push … main` is `push_main`, decided
  by “Push to main” like any category; the runner's own push still asks `authorizeGit` (`branchWriteKey` → the same key),
  so Merge On never implies a push to main. A computer holding a token of its own could push to a remote directly: the
  guard is the gate there (AC-40).

### Server: learned skills and role defaults (AC-50, AC-52; decided in the server stream, 2026-10-02)

- **AC-DS30 Every new `propose_skill` is learned.** An agent only ever proposes for its own pack, so there are no
  “other packs” today: a clean skill is built into the own pack at once (status `learned`, `versionId` set, no decider).
  `skills.decide` stays for proposals still `proposed` from before AC-52 (the 5-pending and one-pending-per-name limits
  keep counting those). A dangerous skill is refused exactly as before (nothing stored, built, posted or signed).
- **AC-DS31 Learning runs as the agent.** `approveIntoOwnPack` is reused with the agent as the actor: the own pack's
  `created_by`, the version's `installed_by` and the attachment's `attached_by` are the agent, and `pack.attached` /
  `pack.pinned` are signed by it. The owner rule (`assertMayConfigure`) is skipped only on the internal own-pack paths
  (`attachOwnPack`, `pinOwnPack` in `packs/commands.ts`, which also insist the pack is the agent's own); `attach_pack`
  and `update_pack_attachment` themselves are unchanged.
- **AC-DS32 What learning says.** The card message is “I learned a skill: {name}.” (the card carries the rest:
  `SKILL · LEARNED`, Remove); `skill.learned` (Keys) “Learned the skill {name} · own-{handle} {version}” (“a skill” for a
  personal agent or a private origin, SL-D43; “· the scan asks for a careful look” for caution), payload ids, status,
  verdict and the pack version, never the body. `skill.proposed` is no longer signed for new skills. Nobody is
  notified (nothing waits for a decision); the card and the Skills tab show it. The own pack's description drops “A
  person approved each one.”, and the “Learn this” prompt says the skill is active at once.
- **AC-DS33 Who removes a learned skill.** People who configure the agent (any person for a team agent, `agents.manage`;
  only its owner for a personal agent — `assertMayConfigure`'s rule) and the person whose turn taught it: the dispatch's
  `on_behalf_of_account_id`, read through `skill_proposals.dispatch_id` (no new column, no migration). Agents are
  Blocked (`agents.manage` is people-only); anyone else gets 403. Why: whoever asked for the work is in the room when
  the card appears and is the one most likely to spot a wrong lesson, also with someone else's personal agent.
- **AC-DS34 What Remove does.** `skills.removeLearned` takes the skill out by name: the own pack's next version without
  it (kept skills hash-checked, an empty version when it was the last), the attachment pinned to it; every `learned`
  proposal of that name becomes `removed` (`decided_by` the remover), its cards are re-published, and `skill.removed`
  is signed (“Removed the skill {name} from {Agent} · own-{handle} {version}”, named as SL-D43 allows). A skill of the
  own pack that came another way (approved before AC-52) can be removed by its configurers too: `proposal: null`. A
  name the own pack doesn't hold is 404.
- **AC-DS35 `canRemove`.** True when the proposal is `learned`, the skill is still in the agent's own pack (a renamed or
  removed one has nothing to remove) and the viewer may remove it (AC-DS33); always false for agents (SL-D46).
- **AC-DS36 Learned skills count as the own pack's source.** `skillNameIsPublic` reads the newest `approved` or
  `learned` proposal of the skill's name (it read approved ones only), so switches of a skill learned in a private
  room stay unnamed in the log.
- **AC-DS37 Onboarding's crew gets the AC-50 keys and every three-state row.** `complete_onboarding` grants
  `ROLE_DEFAULT_KEYS` (channels read scoped as before) plus each of Merge, Deploy and Push to main the defaults don't
  hold, as its umbrella grant at the tier the defaults decide (Off), as `hireGrants` does for a hire. Hires already used
  the 0.36 defaults through `hireGrants`. Personal agents keep `PERSONAL_DEFAULT_GRANTS` (they hold no branch keys);
  the seed and test world stay on `SEED_ROLE_KEYS`; existing agents are not backfilled.
- **AC-DS38 Push to main needed no server change.** `authorizeGit` and `start_run` ask the keys engine for
  `branchWriteKey(defaultBranch)` = `branch.main.push`, now agent-grantable: at can the runner gets push credentials for
  main and a run may start on it; at ask the push is a `push_shared_branch` approval of that commit (`askToPush` is
  key-agnostic); at cannot it stays Blocked (MDS-D07). The grant-key executor gives it at `requestedTier` (ask). The
  persona's “never push to main” line stays true: the agent never pushes itself, Whombat pushes after the turn.

## As built — prompt

Decided in the prompt stream (branch `agent-computer-prompt`, 2026-10-02), numbered `AC-DP…`. Code:
`packages/agent-runtime/src/persona/computer.ts` (new), `persona/{access,vault,merge-deploy,index}.ts`,
`apps/runner/src/prompt.ts`, the computer decision in `apps/runner/src/turn.ts`. Tests: `apps/runner/src/
prompt-computer.test.ts` (with the snapshot of a whole computer-turn prompt), `persona/computer.test.ts`,
`managed-turn.test.ts` § a computer turn.

- **AC-DP01 One rule for “a computer turn”.** **Superseded in part by one-person.md OP-07, OP-S42**: the rule stays as “a person's commands turn”: the server gave the turn `DispatchContext.commands` and it isn't a Feedback assessment. `isComputerTurn(ctx)` (agent-runtime, pure): the server gave the turn a
  computer (`DispatchContext.computer`) and it isn't a Feedback assessment. (First built with “and it isn't a scratch
  turn”; since AC-24 a would-be scratch turn with a computer is a computer turn, and `isScratchTurn` is false for it.)
  Every computer line of both prompt builders asks it; the runner opens a computer exactly when it holds and the runner
  runs computers, is managed and the provider is live (`computerTurn` in `runDispatch`, replacing the earlier
  `!isAssessment && !input.scratch` test — the same turns).
- **AC-DP02 The prompt never describes a computer the turn doesn't have.** **Superseded in part by one-person.md OP-S87**: the prompt still describes commands only when the runner runs them; it names no computer. When the runner won't open one (computers off
  on this runner, not managed, a scripted provider), it builds the turn from the context with `computer: null` —
  before the scratch check — so the folder and the prompt are the sandbox's (a scratch turn where it would be one). The Vault entries' `delivery`/`onComputer`/`envNames` (sent by the server in
  every turn it counts as a computer turn) are ignored outside a computer turn: the brokered tools still serve a
  computer key there, so its block reads as before.
- **AC-DP03 The computer section.** **Superseded by one-person.md OP-S87**: the prompt's command lines say where commands run, what they reach, the image's tools and Docker when it is there; no computer. After the “How you work” list (and the Merge/Deploy and learning lines), before
  `## The Vault`, only in a computer turn — rendered (Banjo, home network 192.168.1.0/24, two production servers, two
  keys on the computer, Mara's not):

  ```
  ## Your computer
  You have your own computer: Debian with sudo (apt, pip, npm), Docker, Chromium, git, ssh and rsync, and the whole internet. Every command your shell runs, runs there.
  - Your working directory and this turn’s files are on it at the same paths. The rest of it (your home /home/agent, /etc) you reach with the shell; your file tools see only the shared paths.
  - Your home stays between turns: clones, installed tools and notes you keep there are still there next time.
  - It reaches any public address and, of private networks, only the burrow’s home networks (192.168.1.0/24); never this Whombat itself.
  - Production servers are closed to your computer until a person says yes to a command: web-1 (web1.example.com), nas-prod. To deploy to one, run the command itself (ssh web-1 '…', rsync -a dist/ web-1:/srv/…), so the person sees exactly that on its card; a script that connects from inside (./deploy.sh) can’t reach it.
  - Deploys, merges, pushes to main, destructive commands on other machines and messages to people outside the burrow are checked against your keys. A command that needs a yes says so and waits while a person answers on its card: let it wait. Exit 125: nobody answered in time; the card stays open and you’re woken when someone allows it, so carry on with what doesn’t depend on it and say in one short line that it waits for a yes. Exit 126: your key is off or a person said no; don’t try another way around it, tell the person what didn’t run.
  - Vault keys on your computer in this turn: “Server Access Key” (SSH: web-1); “Cloudflare API token” ($CLOUDFLARE_API_TOKEN).
  - Not on it in this turn: a private Vault entry of Mara (entry vlt_maranas00001). Ask its owner with request_vault_key when you need it.

  How you work on it:
  (AC-DP07)
  ```

  Without home networks: “It reaches any public address, but no private network and never this Whombat itself.”;
  without production servers the line is left out; without computer keys: “No Vault key is on your computer in this
  turn.” and no “Not on it” line. Exit codes come from `COMMAND_EXIT_CODES`.
- **AC-DP04 Production servers by name; the host only for the requester's own.** **Superseded in part by one-person.md OP-03, OP-S87**: production servers are still named (at most 12) with the deploy run as its own command; there is no other requester to hide hosts from. `DispatchContext.computer` lists every
  production server of the burrow (CT-220). The prompt names each (defused, duplicates once), adds `(host)` only when
  its entry is the requester's own (held or unheld) — VT-S12/VT-D27: in anyone else's turn names alone — and names at
  most 12 (`COMPUTER_PRODUCTION_LISTED_MAX`), “and N more” after. It says to run the deploy command itself because the
  wall (AC-11) blocks a production address for anything the guard didn't recognise and open: `./deploy.sh` that
  connects from inside fails, and the person's card shows the real command.
- **AC-DP05 A waiting command just waits.** Exit 125 isn't “stop at once”: the agent finishes what doesn't depend on
  the command, then says in one line it waits for a yes (it is woken by the yes, AC-DS12). Exit 126 is a person's
  decision or an Off key: no way around it. Whombat MCP tools keep “pending_approval: say so and stop” (unchanged:
  those are stop-and-wake).
- **AC-DP06 Keys on the computer, in two places.** **Superseded by one-person.md OP-S60, OP-S87**: the prompt names no computer and no other person's entries. The computer section lists them in one line (entry label, SSH server
  names whose host key is trusted, or `$VARIABLES`), the ones not on it with their entry id; each Vault block's `How:`
  says it again in context: `on your computer in this turn: ssh, scp and rsync reach its servers by name (ssh web-1)` /
  `on your computer in this turn: $CLOUDFLARE_API_TOKEN` / `not on your computer in this turn: ask Mara with
  request_vault_key (entry vlt_…) and say why`. A brokered key in a computer turn keeps today's `How:` (ssh_exec,
  vault_request, browser_sign_in, an MCP entry's tools): brokered use is described only for brokered keys (AC-51).
- **AC-DP07 How to work on a computer (AC-51)** **Superseded in part by one-person.md OP-13, OP-S87**: the agent installs only in its own space (no sudo or apt) and otherwise says what is missing. — `COMPUTER_WORK_LINES`, under “How you work on it:”:

  ```
  - Investigate first: read the README, docs, scripts, the CI configuration (.github/workflows and the like), the Makefile or package.json, AGENTS.md or CLAUDE.md and any deploy notes before you change or run anything that matters.
  - Install what’s missing (sudo apt-get install -y …, pip install, npm install -g …) instead of stopping.
  - When something fails, read the error, then fix the cause or reach the same result another way: another tool, flag or approach. That is for things that fail, never for a no: a refused command, a blocked tool or a closed production server is a person’s decision.
  - Check the result before you call it done: run it, run the tests, open the deployed URL (curl or the browser) and see that it shows the change.
  - Ask people only for what tools can’t give you: a credential, an access or a decision. Say exactly what you need and why, once.
  - Say only what you did and saw. Never claim a step, a test or a deploy you didn’t run, or one that failed.
  ```

  “Try another way” is bounded in the same line, so the resourcefulness never reads as licence to get around a key, a
  no or the production wall (EA-03 honesty kept in the last line).
- **AC-DP08 Lines rewritten for computer turns** **Superseded by one-person.md OP-S87**: no line names a computer any more. (non-computer turns keep the old wording, where it is still true):

  | Where | Old (still in non-computer turns) | New (computer turns) |
  |---|---|---|
  | runner `networkLine` | “Your own tools have no network: that needs “Browse the web” (keyId web.browse). When a task needs the web, ask for that key the same way and stop.” | (none: the computer reaches the internet whatever the key says, AC-10) |
  | runner `checkoutLine`, writable | “… and commit with git. Never push; the runner pushes what you commit, after your turn and before a pull request opens.” | “… and commit with git. You don’t push it: Whombat pushes what you commit, after your turn and before a pull request opens.” |
  | runner `checkoutLine` (RC-07) | “To propose the change, open the pull request with open_pull_request. Pushing and GitHub need no network access of your own: don’t ask for “Browse the web” for them.” | “To propose the change, open the pull request with open_pull_request.” |
  | runner `checkoutLine`, read-only | “… You can’t change anything in it.” | “… You can’t change anything in it; to build or test it, copy it into your home first.” |
  | Vault intro | “… You use an entry only through Whombat’s tools; Whombat signs the request in and you never see the secret itself.” | “… A key is either used by Whombat for you, through Whombat’s tools, so you never see the secret, or put on your computer during its owner’s turns.” |
  | Vault access rules (`VAULT_ACCESS_RULES`, VT-G01) | “You can’t reach SSH servers or other private services from your sandbox. SSH goes only through an SSH key in the Vault, with ssh_exec, ssh_read_file and ssh_write_file; never try ssh, scp or rsync yourself.” · “When you need access you don’t have, don’t look for another way: tell the person exactly what is still missing in their Vault (the steps below) and stop.” | `VAULT_ACCESS_RULES_COMPUTER` (contracts 0.36.0): “Keys your instructions list as on your computer are there for this turn: SSH works directly by the server’s name (ssh web-1, scp, rsync), and values are in the environment variables named with them. Use them with any tool; never print a value or write it into files, messages or commits.” · “Production servers are closed to your computer: a command that reaches one waits until a person says yes on its card, then runs.” · “Keys of people other than the one this turn is for aren’t on your computer. If you need one, ask its owner with request_vault_key (say what for), stop, and carry on when you’re woken.” |
  | `VAULT_SSH_AGENT_RULES` | all five with any held SSH key | all five only with a brokered SSH key; with SSH keys only on the computer the two about servers (“Never add keys to authorized_keys …”, “When someone names a host …”) |
  | after the SSH setup steps | — | “With step 5 they choose “On Banjo’s computer” to put the key on your computer during their turns, or “Whombat uses it for Banjo”.” (`vaultKeyDeliveryLabels`) |
  | `mergeDeployLines` merge rule (MDS-06) | “Merge only with merge_pull_request: never push to main, and never merge with git merge, git push or gh pr merge.” | “Merge with merge_pull_request. On your computer a git push to main or gh pr merge goes by “Push to main” and “Merge into main”: it runs, waits for a person’s yes or is refused, as those keys say.” (AC-41, AC-DS20) |
  | Deploy at On | “You may deploy when a person asks you to: perform_action with {type: "deploy", params: {environment, service, ref, sha}} (sha null: the latest commit on ref).” | “You may deploy when a person asks you to: deploy from your computer the way the project does it (its scripts, its CLI, ssh or rsync); a deploy to a production server waits for a person’s yes on its card. perform_action with {type: "deploy", …} runs the repository’s deploy workflow when it has one.” (AC-43) |
  | Deploy at Ask | “Deploying asks a person first: perform_action with {type: "deploy", …} posts a card for them to approve and answers pending_approval. Say in one short line that the card is posted and stop.” | “Deploying asks a person first: a deploy command on your computer waits for their yes on its card, in this turn, and runs when they allow it. perform_action with {type: "deploy", …} posts a card and answers pending_approval: say in one short line that the card is posted and stop.” |
  | Deploy at Off | “You don’t hold “Deploy”: when a person asks you to deploy, ask for the key …, say so in one short line and stop.” | “You don’t hold “Deploy”: a deploy command on your computer is refused. When a person asks you to deploy, ask for the key …, say so in one short line and stop.” |

- **AC-DP09 Lines kept, and why.** “If a tool answers pending_approval … say so and stop” and “If a tool answers blocked
  … ask for it … and stop” (Whombat's MCP tools are still stop-and-wake; a missing key is a person's decision, which
  AC-51 keeps asking for). The run line without a checkout (“once the run is started, say in one short line that you
  are on it and end the turn”, RC-01): the run goes on in a run turn with a checkout of its branch — on the computer
  too. Scratch lines (`persona/scratch.ts`: no repository, no credentials, network only with “Browse the web”): a
  scratch turn never has a computer (AC-DP01), so they stay true. Feedback assessments (`feedbackSystemPrompt`,
  `apps/runner/src/feedback.ts`): read-only, untouched (AC-23). `ROLE_GUIDANCE` (Lead “Never edit code or change systems
  yourself”, Security “Defensive only”): the role's purpose, kept by AC-50. `packs.ts` “Your runtime cannot load
  skills …” and “writing skills needs “Propose skills” … ask for that key … and stop”: still true. The “Learn this”
  guidance already says a skill is active at once (AC-DS32), and no other runtime line says skills need approval
  (PACK_PRECEDENCE's “your own approved instructions” are memory instructions, not skills).
- **AC-DP10 The learning loop (AC-52) is in every turn of an agent holding “Propose skills”**, not only computer turns
  (learning how a thing is done isn't computer-specific; the key decides, as `propose_skill`'s listing does), at the end
  of “How you work” after the Merge/Deploy lines:
  “After a task that wasn’t trivial — a deploy, a setup, a tricky fix — write down how you did it with propose_skill,
  as one of your own skills named after the procedure (how-whombat-website-deploys): the steps that worked, the
  commands, the pitfalls and how to check the result; names of keys and servers, never their values. It is active at
  once, and people can remove it. When the procedure changes, update the skill (supersedes).” and “Before such a task,
  read your own skills (own-banjo under Pack skills): one may already say how.” (the own pack is the attached pack named
  `own-…`, SL-D45; without one: “… read your own skills when you have them …”). The example name is a valid
  `SkillName` (lowercase and dashes). The persona builder (`persona/index.ts`, not used live) gets the computer section
  and these lines too.
- **AC-DP11 John's over-cautious line “today”.** `git log --since=2026-10-01` on the prompt and persona, the contracts'
  copy and the agent instructions defaults: the lines added on 2026-10-01 that stop an agent at the first gap are
  VT-G01's `VAULT_ACCESS_RULES` (“… never try ssh, scp or rsync yourself.”, “When you need access you don’t have, don’t
  look for another way: … and stop.”), written into John's own agent-guidance assignment that day
  (`docs/implementation/agent-guidance/assignment.md`, commit c2edebc2) — the line meant. Also from that day: RC-07's
  “Never push …/don’t ask for “Browse the web”” (4915720b) and MDS-06's merge rule (338a0656). All are rewritten for
  computer turns in AC-DP08 and kept where they are still true (the sandbox can't reach SSH). Nothing was added on
  2026-10-02 besides the agent-computer streams' own copy, and no default agent instructions on the server carry such a
  line (memory instructions are written by people).
- **AC-DP12 Follow-ups for the contracts (not released here).** (1) `merge_pull_request`'s description (contracts
  `mcp.ts`, 0.34.0) ends “Never push to main or merge with git or gh yourself.” — in every turn, against AC-41 on a
  computer; suggested: “Prefer this to git or gh: on a computer those go by the same keys.” (2) `VAULT_ACCESS_RULES_
  COMPUTER`'s production line repeats the computer section's; it could go once the section ships. (3) The prompt picks
  the two server rules out of `VAULT_SSH_AGENT_RULES` by their first words (`SSH_SERVER_RULES`, pinned by the snapshot):
  better two constants (`VAULT_SSH_BROKERED_RULES`, `VAULT_SSH_SERVER_RULES`). (4) The delivery sentence after the SSH
  steps (`deliveryStep`) belongs with `vaultSshSetupSteps`. (5) “Owners attached these packs” reads oddly for the own
  pack the agent itself attaches since AC-DS31.
- **AC-DP13 (resolved by AC-24, see AC-DP14) Open for the lead: scratch turns get no computer, and since AC-50 most chat turns are scratch turns.** The
  server gives a computer (and computer fields on Vault entries, and `request_vault_key`) to every non-system,
  non-vaultless turn (`computerTurn`), scratch turns included; the runner skips the computer for any scratch turn
  (AC-23 as the runtime read it, “scratch-only system turns”). With “Run tools in a scratch workspace” in every role's
  defaults (AC-50), a request without a checkout — “deploy the website” in a DM or a channel — is a scratch turn, so it
  runs in the throwaway folder without the computer. The prompt follows the runner (AC-DP02), so it is never wrong, but
  the feature is mostly out of reach in chat. Suggested: in a computer-enabled turn a scratch turn becomes a computer
  turn (the computer's home is the lasting place; the scratch folder can still be shared) — a runtime change, or the
  server leaves `scratch` false when it gives a computer.

- **AC-DP14 The work folder as built (AC-24).** **Superseded by one-person.md OP-S109**: the work folder is `~/work` in the agent's home (`WHOMBAT_AGENT_HOME`), moved from `.computers/<agent>/work`. `isComputerWorkTurn(ctx)` = `isComputerTurn` without a workspace;
  `sandboxFor` is `workspace-write` for it (the sandbox binds the cwd read-write, as for a scratch turn) and
  `isScratchTurn` is false, so no scratch lines and no `input.scratch`. `prepareCwd` returns
  `computerWorkFolder(root, agentId)` = `<WHOMBAT_WORKSPACES>/.computers/<agent id, unsafe characters as _>/work` before
  it looks at the agent's configured working directory (not part of such a turn, so a broken one doesn't refuse it):
  `.computers` and the agent's folder must be private (`privateDir`, refused otherwise); the work folder itself is shared
  with the computer, where `sudo` can change its mode, so its mode is put back to 0700 rather than refused, and a link
  in its place refuses the turn (`work_folder_not_private`, failure kind `workspace`). `release` removes nothing;
  `GIT_CEILING_DIRECTORIES` is its parent; attachments stay in the turn's files folder (shared as before), not copied
  into the work folder. `ComputerTurn.workFolder` marks the share: computerd's `share` op gained `homeLink` (a plain
  name, `^[a-z][a-z0-9_-]{0,31}$`), and after the mount it runs, as the agent (`setpriv` with the configured uid/gid),
  `if [ -L "$2" ] || [ ! -e "$2" ]; then ln -sfn -- "$1" "$2"; fi` with `/home/agent/work` — a folder or file the agent
  made under that name stays; a failure is logged and the turn goes on. No base image bump. Prompt, first line of the
  computer section in such a turn: “Your working directory is your own work folder on your computer, also at ~/work:
  it stays between turns. Clone the repositories you work on there; your file tools see it too.” The run line for a
  turn without a checkout is unchanged (code work on a connected repo still goes through a run). Turns of the same
  agent for the same person may run side by side (AC-20) and share the folder, like a person's two terminals.

## A computer that never makes a turn wait (AC-60…AC-62, 2026-10-05)

John, 2026-10-05: “@Pippa Hi there” in #general took eight minutes to answer. It was Pippa's first turn and the box had
no image 6 yet (RA-DS58 bumped it, Banjo's computer was image 5), so computerd built the base image from
`images:debian/13/cloud` inside her turn (7½ minutes), then created her computer; Codex answered in 13 seconds. He asked
whether agents should run on the appliance itself, as Hermes Agent and OpenClaw do by default. Research
(`~/.cache/wb-tmp/research/sbx/`): both run on the host only because one install is one person's trust boundary; for
groups and teams both isolate per agent (OpenClaw's sandbox `scope: agent`, Hermes's container per profile). A Whombat
holds several people's Vaults and Whombat's own data, and its host is the signed, rolled-back NixOS image, so the
computer per agent stays (AC-00, AC-01). John chose to keep it and make it fast (“implement C fully”):

- **AC-60 The base image is built ahead of time.** **Superseded by one-person.md OP-13.** computerd builds this version's image when computers become
  available (every start, so after every update) and checks again every minute, without waiting for it and without an
  agent (`Computers.prepareImage`). A failed build is tried again after 15 minutes (`IMAGE_RETRY_MS`); a turn that
  needs the image meanwhile builds it itself, as before. Old images stay until a later clean-up.
- **AC-61 A turn sets the computer up for its first command.** **Superseded by one-person.md OP-S105, OP-S107**: nothing is set up per turn; each command joins the pod's holder in a wrapper of its own. `ComputerSession.open` snapshots git's control files,
  reads the production servers' addresses (the guard knows them from the first command) and starts the exec service;
  `begin`, the wall, the shares and the keys come with the first command that reaches the exec service, once per turn.
  A turn that runs no command (most conversation turns) never touches the computer. A computer that can't start
  refuses that command (126, “the computer couldn’t start (…), so this command didn’t run. Try again in a moment.”)
  and the next command tries again, instead of refusing the whole turn. The teardown undoes the computer's part only
  when the turn began there, after waiting for a setup under way.
- **AC-62 A setup that takes a while is an action.** **Superseded by one-person.md OP-04.** When setting the computer up for a command takes more than 2
  seconds (a new computer, a slow start), the runner reports its own activity row (`COMPUTER_SETUP_TOOL`, contracts
  0.46.1 CT-264): the thinking line says “Pippa · Setting up the computer · 12s”, then “Computer ready” or “Couldn’t
  start the computer”. A quick start shows nothing.

## Not now

- Shipping the base image through Whombat's update channel (AC-05; AC-60 builds it ahead of time on the box instead).
- Virtual machines per agent (AC-00), per-person computers, GPU passthrough, inbound ports to a computer (previews keep `browser_preview`).
- Production gates for HTTP-API deploys by address (shared API hosts can't be closed per agent; the guard is the gate
  there, AC-40).
