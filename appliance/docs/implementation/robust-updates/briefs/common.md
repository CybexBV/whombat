# Common brief for every robust-updates agent

You are one specialist in the robust-updates workstream of Whombat (a managed appliance product). The orchestrator owns
the design, merges and every deploy. Read first:

- `~/Code/.wt/whombat-appliance-robust-updates/docs/implementation/robust-updates/assignment.md` — the whole
  assignment (what happened on 2026-09-28, what exists, the workstreams). Your brief names the parts that are yours.
- `~/Code/.wt/whombat-appliance-robust-updates/docs/decisions/updates.md` — the decisions (UP-…) you implement. If you
  must decide something new, decide it, record it in your repository's decision file with your id block, and tell the
  orchestrator in your final report. Do not reopen settled decisions.
- `…/robust-updates/plan.md` — who owns which files, id blocks, ports, the shared-machine rules. Stay in your files;
  if you need a change in someone else's, say so in your report instead of making it.
- Each repository's README / CONTRIBUTING / decision files for its conventions (the Whombat runtime repo has a
  `CLAUDE.md`). Match the surrounding code: naming, comment density, idiom. Decision entries follow the file's format.

Rules:
- Work only in your worktree and branch (your brief says which). Small focused commits, imperative messages, each
  ending with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Do not push, do not
  merge into `main`, do not rebase shared branches.
- `export TMPDIR=~/.cache/wb-tmp` for everything (`/tmp` runs out of inodes).
- Heavy work (any NixOS VM test, ISO build, full `harness validate`, big `nix build`) only under the shared lock:
  `flock ~/.cache/wb-tmp/robust-updates-heavy.lock <command>`.
- Never stop, reset or `down -v` shared services or containers (`whombat-stack-dev`, `whombat-dev`, Postgres :55432,
  Mailpit). Never touch production (Hetzner host, `app.whombat.com`, Incus VM `whombat-prod-box`) or the dev instance's
  services unless your brief says so. Use your port block and throwaway databases.
- Git hosting: the host's active gh account may be a test account, which can't see the private repositories. If you
  must fetch (e.g. Nix fetching a private flake input), use the maintainer account’s token per command:
  `git -c credential.helper= -c credential.helper='!f() { echo username=x-access-token; echo "password=$(gh auth token --user <the maintainer account>)"; }; f' …`
  (for Nix: `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`). Never change the global gh account.
- Tests must pass before you finish (the repository's `check`, plus the tests your brief names). Don't weaken the
  forward-only rule, the safe boundary, the checkpoint rule or TUF to make a test pass.
- Copy is plain, calm English with curly quotes (’ “ ”) where the product uses them; no jargon to owners.
- Final report (your last message): what you built (files, commits), decisions you took (ids), tests run with results,
  what is left or blocked and why, and anything another agent or the orchestrator must do. Keep it factual.
