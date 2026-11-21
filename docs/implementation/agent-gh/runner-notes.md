# agent-gh: the runner side (decisions where `docs/decisions/agent-gh.md` is silent)

The stand-in (`packages/computer/src/whombat-gh.mjs`), the runner's per-turn gh service (`apps/runner/src/gh.ts`), the
task sandbox's bridge and bind (`packages/agent-runtime/src/access/managed/sandbox.ts`, `shim.mjs`), computerd writing
the stand-in into computers (`apps/computerd/src/scripts.ts`, `computers.ts`), the computer guard and environment
(`apps/runner/src/computer.ts`), the wiring of a turn (`apps/runner/src/turn.ts`) and the prompt lines
(`packages/agent-runtime/src/persona/gh.ts`, `merge-deploy.ts`, `apps/runner/src/prompt.ts`).

- **AGH-DR01 Where the stand-in is in the task sandbox.** Its launcher is bound read-only at
  `/home/whombat-task/.whombat/gh/gh` (`SANDBOX_GH_BIN`), and that folder goes first on the payload's `PATH` (before the
  pinned Node). Not `/usr/local/bin/gh` (AGH-02's wording): `/usr` is the host's, bound read-only, so bubblewrap can't
  make a mount point there unless the host already has that file, and NixOS (the appliance) has no `/usr/local` at all.
  The tmpfs home is where the computer shell's launcher is bound already (`COMPUTER_SHELL`). On a computer it is
  `/usr/local/bin/gh` as specified (before `/usr/bin` on the agent's `PATH`, also after Debian's `/etc/profile`).
- **AGH-DR02 What the stand-in reads.** Exactly AGH-08: for `gh pr|issue|release …` the values of `-F`/`--body-file`; for
  `gh api` the value of `--input` and the `@FILE` values of `-F`/`--field key=@FILE` (never `-f`/`--raw-field`). Values
  attached (`--input=f`, `-Ff`, `-F=f`) or as the next word; nothing after `--`; each path once. `files[].path` is the
  word as written (relative to the shell's working directory), so the server can match it. `gh workflow run -F
  key=@file` is not read (not in AGH-08): gh then reports the file missing in the run directory.
- **AGH-DR03 Refused before sending (exit 1, one line).** More than 8 files (“gh: this command reads 9 files; through
  Whombat gh reads at most 8 in one command.”), more than 1 MiB of files and stdin together (“gh: the files and input of
  this command come to more than 1 MiB; …”; sizes checked before reading), a file that can't be read (gh's own form:
  “open body.md: no such file or directory”), more than 200 words or a word over 65,536 characters. stdin is read only
  when the command reads `-` / `@-`.
- **AGH-DR04 The computer turn's socket.** `<turn temp folder>/.whombat-gh/gh.sock`: the folder 0700 and the runner's, the
  socket 0666. The share is idmapped (`shift=true`, AC-DR10), so the computer's `agent` is the runner's uid on that
  mount and may enter the 0700 folder; 0666 keeps `connect` from depending on how the socket inode's owner maps. On the
  host the only way to it is through the runner's private 0700 temp root. The folder is also inside the sandbox's
  writable temp bind (a computer turn's `tmpDir`): that reaches the same service the stand-in reaches, nothing more. A
  computer turn's task sandbox gets no stand-in and no bridge: its shell runs on the computer.
- **AGH-DR05 Socket paths longer than a unix socket allows.** The runner binds through a short folder `/tmp/wbg-*` holding a
  link to the socket's folder (removed at close; like the exec socket's `/tmp/wbc-exec-…`, AC-DR19, but the socket itself stays in the share); the
  stand-in connects from the socket's own folder (`chdir`, relative path) when the path is over 100 bytes.
- **AGH-DR06 Placeholders.** Besides the fixed two (`@whombat-file:N` → the file's path; `…=@@whombat-file:N` →
  `…=@<path>`), the runner also rewrites `--flag=@whombat-file:N` → `--flag=<path>` and an attached short flag
  `-X@whombat-file:N` → `-X<path>` (unambiguous next to `=@@`). An index the request didn't send: exit 1, “gh: Whombat’s
  answer named a file the command didn’t send.” Files are written as `f0`, `f1`, … (0600) in the run directory.
- **AGH-DR07 Running gh.** `spawn` with an argument array and no shell (what `execFile` does; `execFile`'s `maxBuffer`
  would kill gh at the cap, AGH-10 wants the rest cut and gh's own exit), in a process group of its own so the timeout and
  the turn's end stop all of it (SIGTERM, SIGKILL after 2 s). Run directories under `<runner tmp>/gh-runs/` (0700),
  `HOME` = the run directory, `GH_CONFIG_DIR` = `<run dir>/.gh` (0700), `PATH` the runner's. Besides AGH-03's list, the
  runner's proxy and CA variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` in both cases, `SSL_CERT_FILE`, `SSL_CERT_DIR`)
  pass when set: gh can't reach GitHub without them on such a host, and none is a secret. The token is replaced by `***`
  in both streams before they are cut (a token on the edge is never half kept); the cut adds “[Whombat cut gh’s output
  here: it keeps at most 8 MiB.]” (errors: 1 MiB). A timeout adds “gh: it took longer than 300 seconds, so Whombat
  stopped it.” and exits 124; a death by signal is 128 + its number; gh missing is exit 1, “gh: gh couldn’t be started
  where Whombat runs it (ENOENT).”
- **AGH-DR08 Error lines.** From the runner: 409 → “gh: This turn is over.”, 404 → “gh: gh through Whombat isn’t available
  on this Whombat yet.”, any other error → “gh: <the server's message>”, a request cut short by the turn's end → “gh: This
  turn is over.”, an unreadable request → “gh: Whombat couldn’t read this command.” From the stand-in: a socket it can't
  reach → “gh: couldn’t reach Whombat (CODE); this turn may be over.”; the sandbox bridge refused by a sandbox
  (`EPERM`/`EACCES`) → “gh: this shell’s sandbox doesn’t let gh reach Whombat (CODE).”; nothing listening (a computer
  turn without gh) → “gh: gh isn’t available here: Whombat runs gh for you only in a turn that has GitHub (CODE).”; the
  connection closed without an answer → “gh: the connection to Whombat closed before gh answered.” `done` answers are
  printed as the server wrote them.
- **AGH-DR09 Which turns get it on the runner.** A managed live turn (not scripted) whose context has `gh` with at least one
  repo, not a Feedback assessment, search answer or read-only checkout (`ghContextOf`, the server's AGH-12 rule checked
  again), on a runner whose API has `ghAuthorize`. Otherwise the turn is built with `gh` cleared, so its prompt never
  promises a gh. A turn whose service can't start (it can't listen) goes on without it and the runner logs why; its
  prompt was built already, so the agent may find gh missing in that turn.
- **AGH-DR10 The prompt line** is AGH-14's sentence with at most 20 repositories named and “and N more” after them (100
  names would crowd “How you work”). Both prompt builders use `ghLines`; the runner's after the checkout lines.
- **AGH-DR11 The merge rules with gh.** Sandbox turn: “- Merge with merge_pull_request or gh pr merge, which through
  Whombat is the same merge and goes by “Merge into main”. Never push to main, and never merge with git merge or git
  push.” Computer turn: the same first sentence, then “On your computer a git push to main goes by “Push to main” and
  “Merge into main”: …” as before. Without gh both stay as they were.
- **AGH-DR12 The computer's stand-in stays between turns.** computerd writes it before every turn whether or not that turn
  has gh (it doesn't know); a turn without gh sets no `WHOMBAT_GH_SOCKET`, so the stand-in tries `127.0.0.1:47103` on the
  computer, finds nothing and says gh isn't available (AGH-DR08). It shadows a gh the agent installs itself
  (`/usr/bin/gh`): GitHub goes through Whombat.
- **AGH-DR13 Shipping.** `whombat-gh.mjs` is one file with built-in modules only (nothing newer than Node 20), in the
  release's `app/` (APP_FILES) next to the bundles; the runner binds its folder into sandboxes, computerd reads it once
  from next to its own bundle (`GH_STANDIN_PATH`) and pushes it into computers.
- **AGH-DR14 The stand-in's order.** `$WHOMBAT_GH_SOCKET` first, then the bridge when the socket can't be connected to
  at all (AGH-16, AGH-17: a provider whose environment policy drops the variable still finds the bridge); when neither
  answers, the first one's error is the line.

## The providers' own sandboxes (decided by the orchestrator, 2026-10-03)

Found while building: in a managed turn without a computer the agent's commands run inside the provider's own shell
sandbox, which has a network namespace of its own, so the outer sandbox's loopback bridge (`127.0.0.1:47103`, AGH-02)
isn't there. Measured with the installed `codex sandbox` (codex-cli 0.160.0) and today's settings (`network = { enabled
= false }`, `:workspace` and `:read-only`): a TCP connect to a loopback port and a unix socket connect both fail with
`EPERM`; with the web key's settings (`domains = { "*" = "allow" }`, `features.network_proxy = true`) the unix socket
fails with `EPERM` and TCP with `ECONNREFUSED` (a namespace of its own). Claude Code 2.1.283 runs commands with a
network namespace of its own and a seccomp filter against unix sockets (its binary: “[Sandbox Linux] Skipping seccomp
filter - allowAllUnixSockets is enabled”).

Reasoning for both decisions: in a managed turn the outer `ManagedSandbox` is the real boundary. The task's network
namespace has only the loopback bridges, every connection out goes through the egress service's policy (MSB-06), and
stage 2 sees only what the runner binds. So the provider's inner sandbox may let the stand-in through without widening
what the task can reach. Turns without gh are unchanged.

- **AGH-16 Claude Code, a managed turn with gh only.** The flag settings' `sandbox.network` gets `allowAllUnixSockets:
  true`; everything else stays (without the web key `allowedDomains: []` and `strictAllowlist`, `allowLocalBinding:
  false`, the filesystem rules, the MCP token on the `credentials.envVars` deny list). The gh service's socket **file**
  (never its directory) is bound into stage 2 at `/home/whombat-task/.whombat/gh/gh.sock` (`SANDBOX_GH_SOCKET`), next
  to the stand-in, and the managed sandbox sets `WHOMBAT_GH_SOCKET` to it in the payload's environment — the CLI's
  environment, set after the env allowlist so no filter drops it; the deny list names only `WHOMBAT_MCP_TOKEN`, so
  sandboxed commands inherit it. The stand-in tries that socket first and, if it can't connect at all, the bridge.
  What unix sockets the payload sees: measured in the real sandbox (a walk of everything but the read-only `/usr`,
  `/nix`, `/proc`, `/sys`, `/dev`): the gh socket only — the host's (`/run`, Docker, Postgres, the manager) are never
  mounted, and denied paths are covered. In a live turn there are also the ones the task's own processes make (Claude
  Code's sandbox proxy bridges in the task's `/tmp`): no new reach, the commands already go through those proxies.
  Abstract sockets are per network namespace: the task's holds only what the task makes. Claude Code then serves no
  “device tools” (its own message for a sandbox that allows unix sockets); Whombat uses none. Unverified without a live
  model: that Claude Code's sandboxed command reaches the socket with this setting (Claude Code has no way to run a
  sandboxed command without a turn).
- **AGH-17 Codex, a managed turn with gh only.** The guarded profile's network is on and Codex's network proxy off
  (`permissions.whombat = { …, network = { enabled = true } }`, `features.network_proxy = false`), for write and
  read-only turns alike and whatever the web key (Codex's proxy would put commands in a namespace of their own again).
  The managed turn uses the permission profile, not the legacy `sandbox_workspace_write.network_access`; the profile's
  `network.enabled` is its equivalent and exists for `:read-only` too. Commands then share the managed sandbox's
  namespace: the stand-in reaches the bound socket (`WHOMBAT_GH_SOCKET`, inherited: Codex's default environment policy
  passes it, ours excludes only the MCP token) or the `127.0.0.1:47103` bridge. Hosts are still the egress service's
  decision (no web key: the provider's endpoints and GitHub only), through `HTTPS_PROXY`; with the web key, any public
  host by MSB-06 instead of Codex's proxy, which refused the same local addresses. Measured with `codex sandbox` and this
  profile (`:workspace` and `:read-only`): a unix socket and a loopback TCP port both answer.
  The MCP bridge port (`127.0.0.1:47100`) becomes reachable from commands, which don't hold the token (Codex's
  `shell_environment_policy` excludes it). `/proc`: in the same measurement the command's pid namespace held only
  `codex-linux-sandbox` (pid 1) and the command; the app-server, which holds the token, isn't there. Pid 1's
  `/proc/1/environ` is readable — in the measurement it carried the environment given to `codex sandbox`; in a live turn
  it is the environment Codex starts the command with (unverified live whether that is the filtered one). Were the
  token readable, the agent would only call its own MCP endpoint as itself, under its own keys: acceptable.
