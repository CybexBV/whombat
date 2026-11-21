# Workstream: github (`apps/server/src/github`, runner pushes)

> **Superseded in part (2026-09-24) by `github-gh.md`:** GitHub is reached through the host's `gh`
> (S-07), polled instead of webhooks (S-08); the GitHub App, its install flow and setup callback, the
> webhook receiver (`github_deliveries`) and installation tokens are gone. What this file says about the
> mirror's commands and copy, actors, visibility, merges, pull requests, coding runs and deploys still
> holds, with "webhook" read as "what the poller found".

TODO 10.1, 10.2 and 10.3 (server side), 10.4, real coding runs and the real deploy executor.
ARCHITECTURE.md (“GitHub”), DECISIONS.md, `server-core.md`, `runtime-server.md` and `providers.md` still
apply; this file records what they left open. Setting up the App: `docs/github-app.md`.

## Layout

```
apps/server/src/github/
  adapter.ts     GitHubAdapter interface (+ GhRepo, GhPullRequest …, GitHubError)
  real.ts        RealGitHub: Octokit + @octokit/auth-app (App JWT, cached installation tokens, OAuth)
  fake.ts        FakeGitHub: in-memory (optionally bare git repos on disk), sends signed webhooks
  service.ts     GitHubService: adapter selection, installations, install state, git credentials (GitHost),
                 open / merge on GitHub, awaitBranch
  webhooks.ts    /webhooks/github receiver: signature, idempotency, event → mirror command
  mirror.ts      the mirror's commands (github.sync_pr, github.push, github.checks, github.review,
                 github.connect, github.sync_repos, github.disconnect)
  actors.ts      who signs what GitHub did
  deploy.ts      DeployExecutor (workflow_dispatch → workflow_run)
  visibility.ts  switched-off repos are invisible to agents (+ beforeTool for MCP)
  routes.ts      github.status, the setup callback, repos.sync, the webhook route, the fake install page
  payloads.ts    Zod parsers for the webhook payloads we read
apps/runner/src/workspace.ts   WorkspaceManager checkout + pushIfAhead
```

## Adapter selection

- `WHOMBAT_GITHUB=auto` (default): RealGitHub when `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are set;
  otherwise FakeGitHub outside production, and off in production. `real | fake | off` force a mode;
  `WHOMBAT_FAKE_GITHUB=1` is kept as a shorthand for `fake`. Tests therefore run against the fake.
- `WHOMBAT_GITHUB=real` without the App ID, key or webhook secret fails config validation.
- Off: git credentials and `repos.sync` answer 501; PRs and merges stay inside Whombat (pre-GitHub behaviour).
- FakeGitHub hydrates lazily from the database (repos, PRs, files, diff) into installation 4242
  (`whombat`), so the seeded world “is on GitHub”. In-memory repos accept a PR for a branch nobody pushed
  (as if pushed off-screen); with `WHOMBAT_FAKE_GITHUB_GIT_ROOT` repos are bare git repos, pushes are
  detected by a 150 ms ref poller and delivered as `push` webhooks from the App's bot.

## Connecting (TODO 10.1)

- The install link comes from `GET /burrows/:burrow/github` (`installUrl`, owners only — connecting needs
  “Change burrow settings”) and `repos.list.installUrl`. Its `state` is HMAC-signed (key derived from
  `WHOMBAT_MASTER_KEY`), expires after an hour and carries burrow, person and `returnTo` (same-app paths
  only; default `/onboarding` until onboarding is done, then `/{slug}`).
- The setup callback (`GET /api/v1/github/setup`, outside `api` because it is a browser redirect, exported
  as `githubSetupEndpoint`) requires the signed-in account of the person in `state`, asks the adapter to
  verify the installation (OAuth code → `GET /user/installations`), then commits `github.connect` as that
  person: installation row, repos upserted (**new repos arrive switched off**), the installer's GitHub
  login linked, onboarding `githubConnected`, and a signed “Connected GitHub · whombat”. It redirects to
  `returnTo?github=connected`, or `?github=error&reason=state|not_you|not_your_installation|not_allowed|
  other_burrow|github|github_off`; an install *request* by an org member returns `?github=requested`.
- **Production requires OAuth during installation** (`GITHUB_CLIENT_ID/SECRET`): without it the callback
  cannot tell whether the person may use the `installation_id` in the URL.
- One installation belongs to one burrow; linking it elsewhere is a conflict.
- `installation_repositories` re-reads the installation's repos (removed ones are switched off and
  unlinked); `installation.deleted` / `suspend` switch the burrow's repos off (“Disconnected GitHub ·
  whombat”); `unsuspend` re-reads repos but switches nothing on. `repos.sync` does the same by hand
  (owners).

## Only switched-on repos are visible to agents

Enforced in one place per surface (`github/visibility.ts`): DispatchContext (no workspace for a repo that
is off, neither from a run nor from a branch room; facts list repos that are on), search (branch rooms and
their PR hits of repos that are off are dropped for agent viewers), MCP tools (`beforeTool`: any tool naming
a repo, PR, branch room or a message in one answers `not_found`), git credentials (404). People keep
seeing everything they are members of.

## Webhooks (TODO 10.2 / 10.4)

- `POST /webhooks/github`, own Fastify scope with a raw-buffer JSON parser (the HMAC covers the exact bytes;
  25 MB limit). No or bad `X-Hub-Signature-256` → 401 before anything is parsed or stored.
- Idempotent by `X-GitHub-Delivery`: a `github_deliveries` row is claimed first (`processing`); a
  redelivery of a processed / ignored delivery answers 200 `duplicate`; a `failed` one, or one left
  `processing` for over 5 minutes (the process handling it died), is processed again; one still in flight
  answers 409 `in_progress` (see `security-fixes.md`, runtime-security). Answers: 200 processed, 202
  ignored, 500 failed (GitHub shows it; redeliver by hand).
  Delivery bookkeeping is operational state (`transactAccount`, not signed).
- Deliveries are handled synchronously, per burrow through the commit pipeline, so they serialize with
  everything else in that burrow (the advisory lock).
- Burrows of a delivery: the one the installation is linked to; with the fake also burrows whose repo of
  that name has no installation yet (the seeded world). Only burrows that have the repo.

| event | command | copy |
|---|---|---|
| `pull_request` opened (new) | `github.sync_pr`: branch room (slug = branch, suffixed on clash), members = author, requested reviewers (else the installers / owners), PR row, commits + files from the API | message “Opened PR #N · title.” with the commits card; event “Opened PR #N · title” |
| `pull_request` synchronize / edited / review_requested / reopened / closed | `github.sync_pr` update: title, base, head, diff, files, commits, reviewers join the room | “Merged PR #N into main”, “Closed PR #N”, “Reopened PR #N”, “Asked Joris to review PR #N”; others hidden |
| `push` (branches) | `github.push`: head moves → checks back to queued (stale greens never satisfy approvals), commits upserted | event “Pushed abc123 to feat/x” (not for the default branch: that is a merge); a person's push also posts “Pushed N commits to feat/x.” with the commits card — agents announce their own |
| `check_run` created / completed / rerequested | `github.checks`: one check upserted by name (state, note “12s” / “38/41” / “queued”, tests parsed from “38 of 41” in the output title) | event “Checks passed on PR #482.” / “Checks failed on PR #483 (unit).” once a round finishes (hidden before); a failed round posts “Checks failed on PR #483.” + pill “unit failed” (concise-replies.md CW-01) |
| `check_suite` completed | `github.checks` with no check: recomputes the round, re-evaluates approvals | — |
| `pull_request_review` submitted / edited | `github.review`: reviewer state | changes requested / comments → review card (first comment's file, line, last hunk lines, numbered comments); approved → “Approved.” + pill “Approved · PR #N”; unknown reviewers: “{login} on GitHub: …”; reviews by our own bot are ignored |
| `workflow_run` | DeployExecutor | see Deploys |

Checks for a commit that is an *older* head of the PR are stale and dropped; a commit we have not seen
becomes the new head. Every mirror command re-indexes the PR for search and re-evaluates approvals.

## GitHub-side actors

- The mirror asks no keys (GitHub already decided; the keys engine ran when the runner got its token), but
  an agent's push still records its branch key as KEY USED.
- Pushes with an installation token arrive from the App's bot: the **push grant** recorded when the runner
  got the push token (`github_push_grants`, latest live grant for repo + branch) says which agent, and ON
  BEHALF OF whom (the dispatch's asker).
- Linked logins (`github_identities`: the installer via OAuth for now) are their principal; commit emails
  map agents (`<handle>@agents.<burrow>.whombat.com`, `agentCommitEmail` in core — the runner sets it on
  worktrees) and people (their Whombat email).
- CI is reported by the burrow's CI agent: the first agent whose keys allow “Run CI” (Dusty in the mock).
- PR events from our own bot are signed by the PR's author (the agent that opened it).
- Everything else is signed by a **system principal** “GitHub” (agent-shaped, `principals.system =
  'github'`, no keys, no channels), created on first use: it is in bootstrap principals (names resolve) but
  not on the roster or in the agent count, and never gets dispatches.

## Merges and pull requests (TODO 10.3 server side)

- *Amended 2026-10-01 (runs-approvals.md MDS-03, MDS-D01, MDS-D02): agents merge by their Merge row, Off · Ask · On; a
  yes at Ask merges as the person. Repositories kept on the Whombat merge in their origin (MDS-D05).*
- `merge_pr` keeps its rules (keys: `merge.main` people-only, agents Blocked; `mergeBlock` refuses until
  checks pass and a review approves with no changes requested) and then, for connected repos, merges **on
  GitHub inside the commit**: squash by default, with the expected head sha, title “{title} (#N)” and
  message “Merged by {person} in Whombat.”. A GitHub refusal (head moved, conflicts, branch protection)
  is a 409 and rolls the commit back. The App merges (installation token); the event is signed by the
  person. GitHub's own `closed` webhook then finds the PR merged already and changes nothing.
- `open_pr` (MCP `open_pull_request`) opens the PR on GitHub first for connected repos: the number, head
  and URL are GitHub's. Before the tool runs, the server waits up to 20 s for the branch to exist on GitHub
  (the runner pushes when it sees the tool call). Repos without an installation keep Whombat-only PRs.
- Holding the burrow lock during the GitHub call is accepted: it is one bounded request, and it makes the
  merge / open and our state change atomic.

## Real coding runs

- DispatchContext `workspace`: the run's repo and branch, or — new — the branch of the branch room the
  agent was asked in (reviewers get a checkout to read); `cloneUrl` is the adapter's remote.
- Runner (live providers only; scripted turns keep scratch dirs): `WorkspaceManager.prepare` with the
  dispatch's git credentials (fetch token) and the agent's identity; the token only travels in git's env.
- Agents commit; the runner pushes (`pushIfAhead`, `WorkspaceManager.ahead()`): when the agent calls
  `open_pull_request` (before the MCP call reaches GitHub) and after a successful turn. A push asks for push
  credentials: allowed (feat/* key) → token + push grant; `main` → 403 Blocked (signed); shared branches →
  202, an approval (the push itself is not replayed yet — follow-up).
- `git-credentials`: 501 without GitHub, 409 for dispatches that are not running, 404 for repos that are
  off; tokens are installation tokens scoped to the one repo with `contents: read` or `write`, cached by
  auth-app (the fake caches too).
- Fixed in `WorkspaceManager`: enabling per-worktree config on the bare mirror leaked `core.bare = true`
  into worktrees (“must be run in a work tree” on `git add`); it now lives in the mirror's `config.worktree`.

## Deploys

- `GITHUB_DEPLOY_WORKFLOW` set → `DeployExecutor` becomes the `deploy` executor. It resolves the repo
  (`params.repo`, else the PR's repo, else the only switched-on repo), the workflow (most specific of
  `repo:env`, `repo`, `*:env`, `*`), records a `github_deploys` row, and dispatches the workflow with inputs
  `environment, ref, sha, service, whombat_approval`. It returns `{deferred: true}`: the approval stays
  APPROVED · DEPLOYING.
- Executors may now defer (`Executor` returns `ExecutionOutcome | {deferred: true}`;
  `ApprovalEngine.completeDeferred`). `workflow_run` (event `workflow_dispatch`) matches the open deploy of
  that repo + workflow — by run id, the approval id in the run name (`run-name`), the ref, else the oldest —
  marks it running, and on completion completes the approval: success → DEPLOYED with the run URL and
  `run_started_at → updated_at` as duration; otherwise failed with “the {file} run ended {conclusion}”.
- Unset → simulated executor. The demo keeps its own storyline executor (it wraps whichever is installed).

## Demo

The director no longer writes the push and checks itself when the fake runs: it records Banjo's push grant
(ON BEHALF OF “Hazel’s review on PR #482”), pushes 7be20f7 through FakeGitHub (webhook → signed by Banjo
under “Read and write feat/* branches”) and reports the four check runs (webhooks → signed by Dusty; the
last one logs “Checks passed on 7be20f. 41 of 41 passed.”). The storyline, its audit texts and the demo
test are unchanged; with GitHub real or off it falls back to `record_push` / `record_checks`.

## Schema (`0004_github`)

`github_installations`, `github_deliveries`, `github_identities`, `github_push_grants`, `github_deploys`;
`repos.installation_id`; `principals.system`. Migration numbering may collide with other workstreams'
0004 (e.g. collab): renumber at merge, the migration is self-contained.

## Contract changes (`@whombat/core`, additive)

1. `api.github.status` (`GET /burrows/:burrow/github`) with `GitHubStatusResponse`, `GitHubMode`,
   `GitHubInstallation`; `githubSetupEndpoint` + `GitHubSetupQuery` + `GITHUB_SETUP_RESULT_PARAM`
   (outside `api`).
2. `api.repos.sync` (`POST /burrows/:burrow/repos/sync`).
3. `agentCommitEmail()` / `parseAgentCommitEmail()` (text).
4. `EVENT_TYPES`: `github.connected`, `github.disconnected`, `github.repos_synced`, `pr.updated`,
   `pr.closed`, `pr.reopened`, `pr.review_requested`.
5. `@whombat/client`: `useGitHubStatus`.
6. `@whombat/agent-runtime`: `WorkspaceManager.ahead()`.

## Tests

Server integration (`src/github/*.int.test.ts`, FakeGitHub): webhook signature + idempotency, every event
mapping (PR opened / pushes by a person, an agent via its push grant, an unknown login / checks + pill +
approval re-evaluation / reviews / merged + closed), the install flow (owners only, forged state, someone
else's link, signed out, linking, repo sync, installation events), repo visibility (context, search, MCP,
credentials), git-credentials authorization, merge rules (agents blocked, mergeBlock, GitHub refusal, merge
on GitHub once), deploys (success and failure through `workflow_run`), and a runner coding turn against
bare repos (worktree, commit as the agent, push before the PR and after the turn, PR #483 on GitHub with its
room, commits and files mirrored, pushes signed by the agent). Unit: signatures, check mapping, hunks,
deploy config, key parsing, mode selection, RealGitHub over a fake API (token caching per installation and
per repo scope, merge, OAuth verification).

## Follow-ups

- Web: “Connect GitHub” in onboarding step 2 / a repos settings page on `api.github.status` (the owner's
  `installUrl`) and handling `?github=connected|error|requested` — the web workstreams own those screens.
- Linking people's GitHub logins beyond the installer (a “Connect your GitHub account” OAuth flow).
- Merging truly as the person (user-to-server token) instead of the App with a “Merged by” message.
- Replaying an approved push to a shared branch; a deploy that never gets its `workflow_run` stays
  DEPLOYING (add a timeout); `github_deliveries` / expired push grants cleanup.
- Agents' reviews (`review_pull_request`) are not posted to GitHub yet.
- Async webhook processing if deliveries approach GitHub's 10 s timeout.
