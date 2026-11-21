# GitHub

Whombat's GitHub is **your own GitHub sign-in**. There is no GitHub App, no webhook and nothing to register on GitHub:
the server calls GitHub's REST API with your token, and a poller reads your repositories. Development, tests and the
demo run against **FakeGitHub**, an in-memory GitHub that answers the same calls; nothing below is needed for them. How
it is built: `ARCHITECTURE.md`, “GitHub”; decisions: `docs/decisions/github-gh.md`, `polling.md`, `agent-gh.md`,
`agent-repos.md` and `merge-own-account.md`.

## Setting it up

1. Sign in to GitHub: Settings → Connections → GitHub. Whombat runs the unmodified GitHub CLI in your own credential
   home on the box: `gh auth login --web` (GitHub's device flow, a code you enter on github.com) or a pasted personal
   access token. The account needs access to the repositories the agent works on.
2. Signing in connects GitHub at once (“Connected GitHub as @login”, a signed event). Your GitHub login is linked to
   you, so what you do on GitHub is signed as you.
3. There are no repositories to pick: every repository the account owns comes in (not archived ones, at most 300, the
   most recently pushed), and the poller reads the list again every 10 minutes, so one made on GitHub later joins by
   itself; **Sync repos** does it at once. A repository of an organisation or someone else's joins when the agent names
   one the account may push to.

When the sign-in is gone (signed out, the token revoked), every place that needs GitHub says so, and the poller waits
until you sign in again.

## What happens as your account

Everything shows on GitHub as your account; the agent stays the commit author (`dusty@agents.<burrow>.whombat.com`).

| Whombat | GitHub |
|---|---|
| The agent's checkouts (clone, fetch, push its branch) | The runner asks the server for a token per git operation; it reaches git only through that one command's environment. A push needs the agent's branch key: `feat/*` is allowed, `main` is blocked, a shared branch asks you. |
| The agent's `gh` | Whombat's stand-in: each command is planned and decided by the server's keys and run by the runner, and the token never reaches the agent. Comments and issues end with “— Dusty via Whombat”. |
| `open_pull_request` | `POST /repos/{o}/{r}/pulls`; the pull request records the agent. |
| Merging | `PUT /repos/{o}/{r}/pulls/{n}/merge` with the expected head, message “Merged by {you} in Whombat.”; the agent merges only as its Merge key allows. |
| Approved deploys | `POST …/actions/workflows/{file}/dispatches` (see Deploys). |

A push is signed by the agent only when Whombat pushed exactly that commit for it; GitHub doesn't say who made any other
push, so those are signed by GitHub (“Pushed 1 commit by Joris Visser to feat/x.”). Pull requests from forks are named
`owner:branch`.

**GitHub Actions** runners and workflow runs are watched by a connection of their own (Settings → Connections → Add a
connection), with a fine-grained token for its page, widgets and Worth a look only.

## Polling

A Whombat isn't reachable from GitHub, so the server reads each repository on a cadence of its own: every 10 s while
the agent's work is live there (a run, a push, a deploy, its pull request's checks), every 30 s while you are around,
every 3 minutes otherwise, and within a second of a push, a merge, a deploy or a new repository. Each read covers the
open pull requests (each gets a room of its own), their checks and reviews, the agent's branches before their pull
request, deploy runs, and issues of repositories an automation watches. A finished round of checks wakes the agent whose
work it is, once per head commit. Reads are conditional (ETags; a `304` doesn't count against the rate limit), and the
poller keeps a reserve of 200 requests and waits out GitHub's rate limits. Details: `docs/decisions/polling.md`.

## Configuration

```
WHOMBAT_GITHUB=auto                  # auto: gh in production, the fake otherwise; gh | fake | off force one
WHOMBAT_GITHUB_POLL_MS=30000         # a repository is read this often while you are around (0: never on its own)
WHOMBAT_GITHUB_POLL_FAST_MS=10000    # …while the agent's work is live there (0: as above)
WHOMBAT_GITHUB_POLL_IDLE_MS=180000   # …otherwise (0: as above)
GITHUB_DEPLOY_WORKFLOW=              # approved deploys run a workflow (see Deploys)
WHOMBAT_MERGE_RERUN=                 # which failed checks an automation's merge runs once more
```

`WHOMBAT_GITHUB=off` answers `501 not_implemented` where GitHub is needed (git credentials, syncing repositories) and
keeps pull requests and merges inside Whombat.

### Failed checks at a merge

An automation that merges its fix once the checks pass runs failed GitHub Actions jobs once more before it leaves the
pull request to you (`docs/decisions/automation-recipes.md`). `WHOMBAT_MERGE_RERUN` says which, per repository: `once`
(the default) re-runs every failed job; `infrastructure` only when every failed job timed out, lost its runner or failed
in a setup step. One value for every repository, or a comma list of `<owner/repo>=<value>` with `*` for the rest:

```
WHOMBAT_MERGE_RERUN=AcmeHQ/development=infrastructure, *=once
```

A value it can't read stops the server at start.

### Deploys

With `GITHUB_DEPLOY_WORKFLOW` set, an approved `deploy` runs a GitHub Actions workflow. The value is one workflow file
for every repository and environment, or a comma list of `<owner/repo>[:<environment>]=<file>` with `*` for any
repository; the most specific entry wins:

```
GITHUB_DEPLOY_WORKFLOW=whombat/billing:production=deploy-prod.yml, whombat/billing=deploy.yml, *=deploy.yml
```

The workflow must accept `workflow_dispatch` with these inputs (GitHub rejects unknown inputs) and should name its run
after the approval, so the poller can match the run exactly:

```yaml
name: Deploy
run-name: Deploy ${{ inputs.whombat_approval }}
on:
  workflow_dispatch:
    inputs:
      environment: { required: true, type: string }
      ref: { required: true, type: string }
      sha: { required: false, type: string }
      service: { required: false, type: string }
      whombat_approval: { required: true, type: string }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@v4
        with: { ref: "${{ inputs.sha || inputs.ref }}" }
      - run: ./scripts/deploy.sh "${{ inputs.environment }}" "${{ inputs.service }}"
```

The approval shows APPROVED · DEPLOYING while the run is going, then DEPLOYED with the run's URL and duration, or DEPLOY
FAILED with the run's conclusion. Your account must be allowed to run the repository's workflows.

## FakeGitHub (development, tests, demo)

- The default outside production (`WHOMBAT_GITHUB=fake` forces it), signed in as `whombat`. It starts as a mirror of the
  database's repositories and pull requests (the seeded world counts as connected) plus the mock's repositories.
- It answers the poller's reads with ETags like GitHub. Tests change it (`simulatePush`, `simulateCheckRun`,
  `simulateReview`, `simulateOpenPullRequest`, `simulateClose`, …) and run a poll cycle
  (`services.github.poller.pollNow()`); `loggedOut = true` behaves like a GitHub sign-in that is gone.
- `WHOMBAT_FAKE_GITHUB_GIT_ROOT=<dir>` backs its repositories with bare git repositories, so a live agent can clone,
  commit and push; the poller sees the pushes as branch heads moving.
