# Workstream: github-gh (GitHub through the host's `gh`, polling)

Implements S-07…S-10 of `self-hosted.md` (plan phase 2, and the code part of phase 6: the GitHub App and
webhooks are removed). `github.md` still describes the mirror's commands, copy, actors, visibility, merges,
PRs, coding runs and deploys; this file records what changed and what was decided. Setup and operation:
`docs/github.md`.

## Layout

```
apps/server/src/github/
  adapter.ts     GitHubAdapter (+ GhAccount, GhPullRequest, GhCheckRun, GhReview, GhWorkflowRun, Conditional,
                 GitHubError / GitHubNotConnectedError / GitHubRateLimitedError)
  gh.ts          GhCliGitHub (fetch + ETags + rate limits) and GhCliAuth (`gh auth token`, cached)
  fake.ts        FakeGitHub: in-memory (optionally bare git repos), ETags on conditional reads, simulate*()
  service.ts     GitHubService: mode, the connection (whoami, cached), connected burrows/repos, credentials,
                 open / merge on GitHub, awaitBranch, the poller and the deploy executor
  poller.ts      GitHubPoller: targets, cursors, phases (pulls, checks + reviews, agents' branches, deploys)
  poll-plan.ts   pure plans: planPulls, checksToMirror, reviewsToMirror, pushCommits, deployRuns
  sync.ts        GitHubSync: a plan's changes → mirror commands, with the actor for each
  mirror.ts      the mirror's commands (unchanged in shape; pushes and reviews recorded once)
  commands.ts    github.connect, github.sync_repos (metadata refresh), add_repo
  routes.ts      github.status, github.connect, github.repos (picker), repos.add, repos.sync
  deploy.ts      DeployExecutor (workflow_dispatch; runs come from the poller)
apps/server/src/scripts/github-smoke.ts   read-only live smoke (`pnpm --filter @whombat/server github:smoke`)
apps/web/src/features/github/             GitHubNotice, useConnectGitHub, useRepoPicker
```

Removed: `real.ts` (the App through Octokit), `webhooks.ts`, `payloads.ts`, `signature.ts`, the setup
callback and the fake install page, `@octokit/auth-app` and `@octokit/core`, `docs/github-app.md`.

## Decisions

- **G-01 Octokit out, `fetch` in; the credential from `gh auth token`.** The adapter keeps the proven REST
  calls (same routes, same mapping) but sends them with `fetch`: one `execFile('gh', ['auth', 'token',
  '--hostname', 'github.com'])` per few minutes rather than one `gh api` process per call (the poller makes
  many calls every 30 s), and direct access to what polling needs — `ETag` / `If-None-Match`, the
  `x-ratelimit-*` and `retry-after` headers, and `Link` pagination. The token is cached 5 minutes and read
  again after a `401` (one retry); a second `401` is "GitHub isn’t connected: GitHub refused gh’s token.
  Run gh auth login on the host." gh gets a minimal environment (`HOME`, `PATH`, `XDG_CONFIG_HOME`,
  `GH_CONFIG_DIR`, `GH_TOKEN`, `GITHUB_TOKEN`, locale; never the server's secrets) and no shell. The binary is
  `WHOMBAT_GH_BIN`, else `gh` on `PATH`, else `~/.local/bin/gh` (systemd units have a short `PATH`). Host,
  API and web URLs are constructor options (github.com only; GHES later is a config change, not a rewrite).
- **G-02 Missing or logged-out gh is a `GitHubNotConnectedError` with a fix.** Messages: "GitHub isn’t
  connected: run gh auth login on the host." (gh exits non-zero or prints nothing) and "…gh isn’t installed
  on the host. Install it, then run gh auth login on the host." (ENOENT); `fix` is `gh auth login`. The API
  answers 409 `{details: {fix}}`; `github.status` carries `error` and `fix`; the web shows the error with
  the command as code (the run page's notice pattern). Missing scopes are a `note` (`repo`: private repos;
  `workflow`: deploys).
- **G-03 One connection per burrow, the gh account per host.** `github_connections(burrow_id, login,
  github_user_id, connected_by_id, connected_at)`. Connecting (`github.connect`, owners, key
  `burrow.manage`) re-checks gh (`whoami`, bypassing the cache), records the login, links it to the owner in
  `github_identities` (their own actions on GitHub are signed as them), sets onboarding's `githubConnected`
  and signs "Connected GitHub as @login". The status shows the live login (`connection()` is cached a
  minute, errors ten seconds), so a re-login on the host shows at once; the recorded login is the audit
  trail. With the fake, a burrow that has repos counts as connected (the seeded world), as the old fake
  installation did.
- **G-04 Who may connect.** The first burrow on the host to connect claims the gh account; after that only a
  person who owns an already connected burrow may connect another (403 "GitHub on this server is connected
  to another burrow. Ask its owner to connect this one."). Without it, any member could create a burrow and
  reach the owner's repos. An instance-owner concept (phase 4/5) can replace this rule.
- **G-05 Repos: a picker over what gh can reach, not a sync of all of it.** `github.repos?limit=` lists
  `GET /user/repos?affiliation=owner,collaborator,organization_member&sort=pushed` (paginated; `hasMore`)
  marked `added` / `enabled` for the burrow (owners). Repos join the burrow only when picked:
  `repos.add {fullName, enabled = true}` looks the repo up (`GET /repos/{o}/{r}`: 404 is "owner/name on
  GitHub (as @login) not found.") and signs "Added and switched on owner/name" (`repo.added`, new event
  type); switching on/off is `repos.update` as before. `repos.sync` now refreshes the burrow's repos'
  metadata (and triggers a poll) instead of re-reading an installation. `ReposResponse.installUrl` is gone.
- **G-06 Polling (S-08).** One `GitHubPoller` per server process (`services.github.start()` from
  `index.ts`; tests and scripts poll by hand with `pollNow()`), cycles never overlap, `stop()` waits for the
  one in flight. Targets: switched-on repos of connected burrows, plus repos with a deploy in flight. Per
  burrow and repo: (1) open PRs, (2) check runs and reviews of each open PR's head, (3) agents' branches
  without a PR, (4) workflow runs of deploys in flight. Skipped entirely while gh is not logged in (logged
  once per change of problem).
- **G-07 Idempotent by state, plus two records.** Plans are diffs against the burrow's state (a PR's
  head / title / base / reviewers / state, the stored checks), so applying a plan empties it. Pushes and
  reviews are events, so each is recorded in the same transaction as its mirror command:
  `github_branch_heads (burrow, repo, branch) → sha` (mirrorPush is a no-op when the PR's or the branch's
  head already is `after`) and `github_seen (burrow, repo, 'review:<id>')` (mirrorReview is a no-op for a
  review it has). A crash between GitHub and the database re-reads and re-applies safely.
- **G-08 ETags.** Stored per burrow and repo in `github_poll_cursors.etags` (`pulls:<page>`,
  `checks:<sha>`, `reviews:<n>`, `branch:<name>`, `runs`), only after their answer was applied, and pruned
  to the keys used in the last cycle. Open PRs: every page is asked with its ETag; if one changed, the
  pages that answered 304 are read again. A cycle without ETags every 10 minutes catches a burrow that
  diverged (a demo rewind, a manual fix). When more than 20 PRs are due to open in one cycle, the list's
  ETag is not stored, so the rest follow next cycle.
- **G-09 Rate limits.** `x-ratelimit-remaining/reset` are tracked from every answer; below 200 left (a
  reserve for people's merges and agents' PRs) the poller waits until the reset. A 403 "rate limit" or 429
  throws `GitHubRateLimitedError(until)` (`retry-after`, else the reset, else a minute) and the poller backs
  off until then. `WHOMBAT_GITHUB_POLL_MS` (default 30 000; 0 = never on its own).
- **G-10 First sight of a repo.** The cursor's `baseline_at` is when the poller started watching;
  `known_prs` are the open PRs the burrow had then. Open PRs the burrow does not have get a room if they
  were active since `baseline_at − 14 days` (at most 20 per cycle); quiet older ones get it when something
  happens on them. Reviews of `known_prs` submitted before `baseline_at` are history (marked seen, not
  posted): this is what keeps the App-to-gh cutover from re-posting reviews webhooks already mirrored.
  Reviews of PRs the poller opens are all posted (they are news to the burrow).
- **G-11 Closed / merged / reopened.** An open PR that left the list is read (`GET …/pulls/{n}`): merged →
  signed by `merged_by`, closed → by `closed_by` (`GET …/issues/{n}`), else GitHub; a closed (not merged)
  PR back in the list → "Reopened PR #N" by GitHub. A PR opened and closed between two polls is never seen.
  Review requests and edits are signed by GitHub (the pulls API does not say who).
- **G-12 Agents' branches.** Branches with a live push grant and no open PR are read with
  `GET …/branches/{name}` (ETag). A moved head is a push (`compare` for its commits). First sight is a push
  only when the head commit is an agent's (agent commit email), else just recorded. A branch that does not
  exist yet is a 404 each cycle until the grant expires (an hour).
- **G-13 Identity (S-09).** Everything on GitHub is the gh account. Pushes: the latest live push grant for
  the branch when the pushed head commit is that agent's (the runner commits as the agent), else the
  commit's author (email, then linked login), else GitHub — a stranger's commit on an agent's branch is not
  the agent's. PRs by the gh account that the burrow does not have are the grant's agent, else the agent
  whose commit is the head, else the person the login is linked to. PRs Whombat opens end their body with
  "Opened by Banjo via Whombat" (`openedVia`) and the PR row's `author_id` is the agent. Merges through
  Whombat are already merged in the database when the poller sees them close.
- **G-14 Git credentials.** Same runner contract; the token is the gh account's (`gho_…`), not repo-scoped,
  valid in our terms for an hour (the push grant's lifetime). The keys engine runs first as before
  (`runtime.authorize_git`: fetch needs a switched-on repo, `feat/*` pushes need the branch key, `main` is
  Blocked, shared branches ask). Remote: `https://github.com/<owner>/<repo>.git`.
- **G-15 Deploys.** `workflow_dispatch` as the gh account; the poller reads `GET …/actions/runs?event=
  workflow_dispatch` (ETag) while a deploy of that burrow and repo is in flight. A run only matches a deploy
  when it was created after the dispatch (a minute of skew) — the webhook path never saw older runs, a
  poller does. `github_deploys.installation_id` is gone.
- **G-16 Modes.** `WHOMBAT_GITHUB = auto | gh | fake | off` (+ `real`, read as `gh` so our instance's
  `production.env` keeps starting). `auto`: gh in production, the fake in development and tests.
  `WHOMBAT_FAKE_GITHUB=1` still means fake. App settings still in the environment are ignored and listed at
  startup (`obsoleteGitHubSettings`); `GITHUB_*` secrets are no longer `_FILE` keys.
- **G-17 The fake.** Logged in as `whombat`; ETags are a hash of each answer; `reads` records 200 / 304 per
  conditional read; `loggedOut` makes every call fail like a logged-out gh; `simulatePush`,
  `simulateCheckRun`, `simulateReview`, `simulateOpenPullRequest`, `simulateRequestReviewers`,
  `simulateClose`, `simulateReopen` change it, and nothing is delivered — the poller reads it. The demo
  director simulates Banjo's push and checks and then polls once (`pollNow`), so the storyline is
  unchanged. `dispatched` lists workflow dispatches (was `workflowRuns`).

## Migration `0007_gh_connection`

Creates `github_connections`, `github_poll_cursors`, `github_branch_heads`, `github_seen`; copies every live
(`deleted_at is null`) App installation to a connection (one per burrow, `login` null, connected by the
installer, at the installation's time); drops `github_installations`, `github_deliveries`,
`repos.installation_id` and `github_deploys.installation_id`. Tested on a database at 0006 with an
installation like app.whombat.com's (`migration.int.test.ts`). Numbering may collide with other
workstreams' 0007: renumber at merge (the migration is self-contained; regenerate the snapshot after).

## Contracts (`@whombat/core`)

1. `GitHubMode` = `gh | fake | off`; `GitHubStatusResponse` = `{mode, connected, login, error, fix, note,
   canConnect, polledAt}` (`login` for members of a connected burrow too — for "Trusted · acts as @login");
   `GitHubRepoChoice`, `GitHubReposResponse`, `GitHubLogin`.
2. `api.github.connect` (POST `/burrows/:burrow/github/connect`), `api.github.repos` (GET
   `/burrows/:burrow/github/repos?limit=`), `api.repos.add` (POST `/burrows/:burrow/repos`), `RepoFullName`.
3. Removed: `GitHubInstallation`, `GitHubSetupQuery`, `githubSetupEndpoint`, `GITHUB_SETUP_RESULT_PARAM`,
   `ReposResponse.installUrl`, `github.status`'s `returnTo` query.
4. `EVENT_TYPES['repo.added']`; `githubConnectedAs(login)` ("Connected as @login"); removed
   `githubErrorToast`, `githubRequestedToast`. `@whombat/client`: `useGitHubRepos`.
5. `GitCredentialsResponse.token` is documented as the gh token.

## Web

Onboarding step 2 and Settings → GitHub (not in the mock, B-05): "Connect GitHub" (secondary) calls
`github.connect`; gh's problem shows in the run page's notice pattern (`GitHubNotice`: the fix command as a
code span where the message names it); once connected, "Connected as @login" (onboarding: a quiet line
above the card; settings: the row title). The repo list is the burrow's repos, then the repos gh can reach
that it does not have (switched off; switching one on adds it), "Show more repos" (10 more at a time), and
an `owner/name` field with "Add" (step 4's invite form). `?github=` and its toasts are gone
(`?burrow=&step=` resume stays). The onboarding reference comparison is unchanged (fixture mode serves no
GitHub status); the settings / onboarding baselines were retaken.

## Tests

Unit (`github.test.ts`): check mapping, deploy config, modes, GhCliAuth over a fake `execFile` (no shell,
clean env, cache, `~/.local/bin`, missing / logged out), GhCliGitHub over a fake transport (scopes, ETag →
304, multi-page re-read, 401 → fresh token → not connected, primary and secondary rate limits, merge,
branch 404), the plans (every change kind, empty once applied, the cap, checks, reviews and history,
push commits, deploy runs), the fake's ETags. Integration (FakeGitHub): `poller.int.test.ts` (the old
webhook scenarios on the poll path, plus: a PR the gh account opened for an agent, review history, review
requests / close / reopen, agents' branches, all-304 second poll, a restarted poller, gh logged out, low
rate limit), `connect.int.test.ts` (status, connect, logged out, picker, add, sync, members, the host
rule), `rules`, `coding` (PR body "Opened by Banjo via Whombat"), `deploy`, `migration`, `endpoints`. The
live read-only smoke was run against this repository on GitHub (whoami, repos, PRs, checks, a 304 at no cost).

## Follow-ups

- Commit statuses (`GET …/commits/{sha}/status`: Vercel and older CIs) are not polled; only check runs.
- Checks that disappear from a new head stay `queued` (as with webhooks).
- A per-instance allowlist or an instance owner could replace G-04.
- Pushes to people's branches without a PR are not mirrored (webhooks logged them).
- Disconnecting a burrow (switch its repos off, drop the connection) has no endpoint yet.
- `github_push_grants`, `github_seen` and `github_branch_heads` are never cleaned up.

## Poller fixes (workstream github-poller-fixes)

Fixes from the self-hosting code review. These decisions replace the parts of G-01, G-08, G-10, G-12, G-13
and G-15 they name; everything else above stands. Migration `0010_gh_poller_fixes`.

- **GP-01 A push is an agent's only when Whombat pushed that commit for it.** The runner asks for push
  credentials with the commit it is about to push (`runner.gitCredentials` body `sha`, a full sha); the
  push grant records it (`github_push_grants.sha`). A push the poller reads (a PR's head moving, or an
  agent's branch moving or seen for the first time) is signed by the agent, ON BEHALF OF the grant's
  asker, under its branch key, only when a live grant for that repo and branch has exactly the new head.
  Every other push is signed by GitHub's system principal: GitHub does not say who pushed, and a commit's
  author (email, name, the login GitHub maps the email to) is free text anyone can write. There is no
  verified mapping from a push to a person, so people's pushes are GitHub's too; the room's commits card
  says whose commits they are, as git says: "Pushed 1 commit by Joris Visser to feat/x." ("… by Joris
  Visser and Mara Okafor …", "… by Joris Visser and 2 others …"), and the event keeps them in
  `payload.authors`. Commit emails still label each commit on the PR's commit list (display only).
  GitHub's signer never records a branch key as used. Replaces G-12's "first sight is a push when the
  head commit is an agent's" and G-13's push rule.
- **GP-02 PRs by the gh account.** A PR the gh account opened that the burrow does not have is the agent's
  when its head is a commit Whombat pushed for that agent (GP-01), else the person the gh login is linked
  to. The head commit's author no longer decides it (G-13).
- **GP-03 Forks.** `GhPullRequest.fork` is the head repo when it is not the base repo (`unknown` once the
  fork was deleted). A fork's PR is keyed on GitHub's `owner:ref` label (`prBranch`): its row's branch and
  its room are `stranger:feat/x`, so it never shares a branch, a push grant or a room with the repo's own
  branches (git refs cannot contain `:`). A PR's head move is mirrored onto that PR by number, never by
  branch name; a fork's push is never an agent's. Fork PRs mirrored before this get their label on the
  next list read (one `pr.updated`).
- **GP-04 PRs only Whombat has.** `pull_requests.local_only` marks PRs `open_pr` opened while the repo was
  not connected (migration: the rows still on open_pr's placeholder head; at run time: the poller's
  `GET …/pulls/{n}` answering 404). The poller leaves them out of its plan (not vanished, not known) and out
  of checks and reviews; GitHub's PR with the same number is not mirrored (logged; renumbering is a
  follow-up), and merging a local-only PR never merges GitHub's PR of that number.
- **GP-05 One bad PR does not stop a repo.** An error reading one open PR's checks or reviews (other than
  rate limits and gh logged out) is reported (`PollReport.errors`, the cursor's `error`) with that PR's
  ETags kept; the other PRs, agents' branches and deploys are still read. The cycle without ETags counts as
  done even when part of it failed. The fake answers 422 for commits it does not have and 404 for PRs it
  does not have, like GitHub.
- **GP-06 PRs Whombat opened get their commits.** `open_pr` records no commits or files. A known open PR
  with no commits in the burrow is read once more (`GET …/commits`, `…/files`) when the list is read, and
  updated with them (its diff from the files); nothing when GitHub has none yet.
- **GP-07 Review requests nobody can take.** The plan only counts requested reviewers whose login is linked
  to a principal (the only ones that can become reviewers), and a PR update that changes nothing signs
  nothing (no `pr.updated`), so a request for an unlinked login no longer signs an event on every read.
- **GP-08 Deploy runs.** A run already recorded on a deploy is that deploy's, finished or not. A run whose
  title names an approval (`apr_…`) only matches that approval, and none when this burrow never dispatched
  it (another burrow's or another instance's deploy of the same repo). The minute of skew (G-15) stays.
- **GP-09 gh and the keyring.** gh also gets `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` (not secrets):
  `gh auth login` keeps its token in the desktop keyring whenever there is one, and gh reaches it over the
  session bus. A host without a keyring session (a system service, a headless box) needs a token gh keeps
  in its own config: `gh auth login --insecure-storage`, or `GH_TOKEN` for the server.
- **GP-10 Every page.** A PR's commits (GitHub lists at most 250) and files (up to 500) are read over every
  page. Reviews are read over every page with one ETag each (`reviews:<n>:<page>`); only changed pages come
  back (an unchanged page holds reviews already mirrored), and the page after a full one is asked too,
  because new reviews land there.
- **GP-11 History for every PR the burrow had.** A cursor's `known_prs` are all the burrow's PRs of that
  repo when the poller starts watching, closed ones too (migration: existing cursors gain their PRs that
  are not open), so reviews submitted before the baseline stay history when an old PR is reopened (G-10).
- **GP-12 Checks per PR.** The checks ETag is `checks:<n>:<sha>`: two open PRs on one head each get their
  own first read.

Follow-ups: renumbering (or linking) a local-only PR when its repo is connected; an agent dispatched in a
fork PR's room gets `stranger:feat/x` as its workspace branch, which git refuses (agents cannot push to
forks anyway); expired push grants are still never cleaned up.
