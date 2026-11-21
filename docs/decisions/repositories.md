# Workstream: repositories (repositories created on the Whombat)

Asked on 2026-09-30 by John, in the main checkout: rename Burrow settings → “Software Dev” to “Repositories”, add the
ability to create a new repository on the device (a name such as `Whombat_Website`, active right away, with the name
and email of the owner), and make signing in to GitHub from the web friendly. Contracts 0.27.0 (CT-192); the web side
is whombat-app `docs/decisions/repositories.md` (AP-540…).

## Decisions

- **RP-01 A local repo is a repo row with `source = 'local'`.** Migration 0055_local_repos (expand): `repos.source`
  (`github` default), `origin_path`, `created_at`. The full name is `local/<name>` so every client that reads
  `owner/name` still parses it; a GitHub repo of the same name part is refused both ways (a new local repo whose name
  a repo of the burrow already has, and `repos.add` of a GitHub repo onto a local row), so agents can always tell them
  apart and their checkouts (`<workdir>/<name>`, RS-04) don't collide.
- **RP-02 Whombat keeps it as a bare origin under the workspaces root.** `<WHOMBAT_WORKSPACES>/.origins/<burrow
  id>/<name>.git`, `--shared=group`, directories 2770. Not in a working directory: a managed box has none people reach
  (`WHOMBAT_WORKDIR_ROOTS` is unset there, managed-runtime.md G-09), and the workspaces root is the one place both the
  server (which creates it) and the runner (which fetches and pushes) write, through the `whombat-workspaces` group and
  the root's setgid bit (appliance `persist.nix`). The workspace cleanup never enters `.origins`. It is made in a
  temporary name and renamed into place; when the record is refused (a key, a race on the name) the route removes it.
- **RP-03 Who, and as whom.** Owners (key `burrow.manage`); on a self-hosted Whombat an owner who is also its admin,
  because it writes to the host (like the default working directory, AH-01). The first commit (`README.md`, “Create
  <name>”, on `main`) and the origin's own `user.name` / `user.email` are the creating person's name and email.
  Agents keep committing as themselves (their name and `agentCommitEmail`), as everywhere else: who made a commit
  stays visible. `repos.list` (and `repos.sync`) carry `create {allowed, reason, author}` so the dialog says who it
  commits as before anything happens. Signed event `repo.created` (System) “Created Whombat_Website on this Whombat”.
- **RP-04 Agents use it like a GitHub repo.** The dispatch context's `cloneUrl` for a local repo is its origin path;
  the runner's git-credentials route runs the same keys decision (a push to `main` still asks a person, EA-05) and
  answers `token: ''` with the origin as `remoteUrl`, also on a Whombat without a git host. The workspace manager
  treats an absolute path as a local remote: it adds `protocol.file.allow=always` and `safe.directory=<origin>` (the
  server's user owns it, the runner's reads and writes it). A self-hosted agent with a working directory gets its own
  clone of it there (RS-04 matches `origin` to the path).
- *Amended 2026-10-01 (runs-approvals.md MDS-D05, MDS-D06): local repos have Whombat pull requests, merged in the origin.*
- **RP-05 No GitHub behind it.** The poller, `repos.sync` and the fake's seed skip local repos; `open_pr` refuses one
  with what to do instead (“tell the person who asked that <branch> is ready”); the agents' facts say which repos are
  kept on this Whombat and that there are no pull requests there.
- **RP-06 No level bump, feature `repos.create`.** All contract additions are optional (CT-192); the runtime advertises
  `repos.create` and clients offer “New repository” only then.

## Tests

- agent-runtime `workspace/local-origin.test.ts`: the origin (bare, `main`, the owner's commit and config, shared,
  2770, no hooks), refusing a name in use without leftovers, the local remote config, and a workspace that checks it
  out, commits and pushes without a token while cleanup keeps it.
- server `github/local-repos.int.test.ts`: create (201, row, origin, author, event, list), names in use (also in other
  letters and a GitHub repo's), bad names, members, credentials without a token, the agents' facts, the poller.

## Follow-ups

- Deleting or renaming a local repo, and publishing one to GitHub (`gh repo create` as the owner, then it becomes a
  `github` repo) are not built.
- ~~Local pull requests (a branch room and a merge on the Whombat) are not built; agents push branches and say so.~~
  Built 2026-10-01: runs-approvals.md MDS-D05.
