# Workstream: agent-gh (an agent's `gh` through Whombat)

John, 2026-10-03: “When we are authenticated to GitHub via Whombat settings, then Banjo should be able to use this
directly.” Agreed, with one change: Banjo gets a `gh` that Whombat runs for it, not the token. The sign-in token is a
person's whole GitHub account (every repo and org they reach), and with it in the agent's environment the Merge and Push
to main keys would be advisory (`gh api -X PUT …/merge`, `curl`). John: “Agreed, implement this fully.”

Contracts: 0.41.0 (whombat-contracts CT-243): `DispatchContext.gh`, `runner.ghAuthorize`, `ClassifyContext.ghThroughWhombat`,
`pr.comment`'s description. Related: `github-gh.md` (G-13 identity, G-14 git credentials), `managed-providers.md` PV-06
(whose GitHub sign-in an agent uses), `agent-computer.md` AC-40…AC-42 (the guard), `runs-approvals.md` MDS-01…07 (Merge).

## Decisions

- **AGH-01 What.** **Superseded in part by one-person.md OP-S09, OP-S111**: commands still get a working `gh` that acts as the burrow's GitHub connection, through a socket in their wrapper; the token still never reaches them. In a managed turn (task sandbox or the agent's computer) the agent's shell has a working `gh` for the
  burrow's switched-on GitHub repositories. It acts as the same GitHub sign-in the agent's pushes use
  (`GitHubService.agentToken`: managed, the agent's credential owner's own sign-in or the burrow's connection owner's,
  `managedGitToken`; self-hosted, the host's gh). The token never enters the agent's environment, files or output.
- **AGH-02 The path.** **Superseded in part by one-person.md OP-S111, OP-S118**: the stand-in still sends each command to the runner's per-turn gh service, now only over `/run/whombat/gh.sock` in the command's wrapper. `gh` in the sandbox is Whombat's stand-in (`whombat-gh`, plain Node, built-in modules). It reads
  the files and stdin the command names (AGH-08), then sends one JSON request over the runner's per-turn gh service and
  prints the answer. The runner adds the dispatch's lease and asks the server (`runner.ghAuthorize`), which plans the
  command (`github/gh-plan.ts`, pure), decides it (keys, repositories) and answers `run` (the runner runs the real gh) or
  `done` (Whombat answered it itself).
  - Task sandbox: the service is a unix socket in the task's runner directory, bridged by the sandbox's init as
    `127.0.0.1:47103` (`SANDBOX_PORTS.gh`) and bound (the socket file only) at `/home/whombat-task/.whombat/gh/gh.sock`;
    the stand-in is bound read-only at `/home/whombat-task/.whombat/gh/gh`, that folder first on `PATH` (AGH-DR01: `/usr`
    is the host's and read-only, and NixOS has no `/usr/local`). The provider's own sandbox lets it through (AGH-16,
    AGH-17).
  - Computer turn: the command runs on the computer, so the socket is made in the turn's shared temp folder (shared at
    the same path) and computerd writes the stand-in to `/usr/local/bin/gh` before the turn; the command's environment
    names the socket (`WHOMBAT_GH_SOCKET`). The computer's Node (Debian's `nodejs`) runs it.
  - Self-hosted turns get no stand-in (guarded Claude and Codex sandboxes have no route to a runner socket; trusted
    agents have the host's real gh). `DispatchContext.gh` is null there (AGH-12).
- **AGH-03 The runner runs gh, after the server decided.** gh lives with the runner (the sign-in executor's
  `WHOMBAT_GH_PATH`, else `gh` on `PATH`); a box's server speaks GitHub's REST API and has no gh. Same split as pushes
  (G-14): the server decides and hands out the token, the runner uses it in the environment of one process. That process
  runs outside the agent's sandbox with `execFile` (no shell), exactly the server's words, a minimal environment
  (`PATH`, `HOME` and `GH_CONFIG_DIR` in a fresh 0700 directory, `GH_TOKEN`, `GH_HOST=github.com`, `GH_REPO`,
  `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GH_SPINNER_DISABLED=1`, `NO_COLOR=1`, `CLICOLOR=0`, `GH_PAGER=cat`,
  `PAGER=cat`, `LANG=C.UTF-8`), that directory as its working directory (the command's files are written there again and
  the words rewritten to them), stdin only when the command reads `-`. The directory is removed afterwards.
- **AGH-04 Which repository.** `-R`/`--repo` (anywhere in the words, `owner/name` or a github.com URL) names it; else the
  turn's checkout repo; else the only switched-on GitHub repo; else the command is refused with the list (“Say which
  repository with -R: acme/web, acme/api.”). A named repo must be a switched-on GitHub repo of the burrow (case-insensitive
  match, the canonical full name is used); a repo kept on this Whombat (`local/…`, RP-05) is refused (“local/x is kept on
  this Whombat, not on GitHub: use git and open_pull_request.”). The server removes `-R` from the words and passes the repo
  as `GH_REPO`, which every repo command and `gh api`'s `{owner}`/`{repo}` placeholders read. Commands that take no
  repository (help, version) get `GH_REPO` null.
- **AGH-05 What runs (`planGh`).** A table, not a guess; anything not in it is refused with one sentence and exit 1.
  Global: `--hostname`/`GH_HOST` other than github.com refused; `--web`/`-w` refused (“There is no browser here: drop
  --web.”); `gh`, `gh help …`, `gh … --help`, `gh --version`/`gh version` run (no repo). Reads (no key beyond a switched-on
  repo, AGH-06):
  - `pr list|view|diff|checks|status`, `issue list|view|status`, `run list|view` (incl. `--log`, `--log-failed`),
    `workflow list|view`, `release list|view`, `label list`, `cache list`, `repo view` (the repo only), `ruleset
    list|view|check`, `search issues|prs|commits|code` (scoped: `--repo` added when absent, another repo refused),
    `status` refused (it reads every repo of the account).
  - Writes and their keys: `issue create|comment|edit|close|reopen`, `pr comment|edit|close|reopen|ready`, `label
    create|edit` → `pr.comment`; `run rerun` → `pipelines.retry`; `run cancel` → `ci.run`; `workflow run` → `ci.run`, or
    `deploy` when the workflow is the host's deploy workflow (`GITHUB_DEPLOY_WORKFLOW`) or its file/name says deploy,
    release or publish.
  - Whombat's own commands: `pr create` → `open_pr` (title from `-t/--title`, body from `-b/--body`/`-F/--body-file`,
    base from `-B/--base` else the default branch, head from `-H/--head` else the turn's checkout branch; `--fill`,
    `--draft`, reviewers, labels, assignees are not supported and say so); `pr merge` → `merge_pr` (number or the turn's
    branch's open PR; `--merge`, `--squash` or `--rebase` is the method, none a squash, AGH-22); `pr review` → `review_pr`
    (`--approve`, `--request-changes`, `--comment` with `-b`/`-F`). Printed like gh does (the PR's URL; “✓ Merged pull
    request #12”) or the pending/blocked sentence.
  - Refused: `auth`, `config`, `extension`, `alias`, `secret`, `variable`, `ssh-key`, `gpg-key`, `codespace`, `gist`,
    `org`, `project`, `attestation`, `completion`, `browse`, `repo` other than `view` and `create` (clone: “Your checkout is
    already here: use git.”), `pr checkout` (same), `pr lock|unlock|update-branch`, `issue delete|transfer|pin|unpin|lock|
    unlock|develop`, `run delete|download|watch`, `workflow enable|disable`, `release delete|upload|download`, `label
    delete|clone`, `cache delete`, `api graphql`, and every other command.
- **AGH-06 Keys.** Reads need no key beyond the repo being switched on — the same rule as a git fetch (`runtime.
  authorize_git`). Writes go through the commit pipeline as the agent (command `github.gh`, `requiredKey` = the plan's key,
  scope `{repo}`): On runs, Off is a signed Blocked event and exit 126 with the pipeline's sentence, Ask is AGH-09. No new
  key: `pr.comment` covers issues now (its description says so, CT-243; the label stays the mock's). Developer defaults
  are unchanged (an owner switches “Comment on pull requests” on; a refusal names the key so the agent can ask for it).
- **AGH-07 `gh api`.** REST only, and only under the turn's repo: the path (leading `/` dropped, query kept) must be
  `repos/{owner}/{repo}/…` or `repos/<the repo>/…`. Method: `-X/--method`, else POST when any `-f/-F/--field/--raw-field/
  --input` is given, else GET. GET (and HEAD) is a read. Writes allowed only on these paths, with these keys:
  `issues` (POST), `issues/N` (PATCH), `issues/N/comments` (POST), `issues/comments/N` (PATCH), `issues/N/labels`
  (POST/PUT), `pulls/N/comments` (POST), `pulls/comments/N/replies` (POST) → `pr.comment`; `pulls/N/reviews` is refused
  (“Review with gh pr review.”: its event would pick the key); `actions/runs/N/rerun|rerun-failed-jobs` (POST) → `pipelines.retry`;
  `actions/runs/N/cancel` (POST) → `ci.run`; `actions/workflows/W/dispatches` (POST) → `ci.run` or `deploy` (AGH-05).
  `pulls/N/merge` is refused (“Merge with gh pr merge or merge_pull_request.”), as are `contents`, `git/…`, `branches/…`,
  `releases`, `hooks`, `keys`, `collaborators`, `actions/secrets|variables`, DELETE, and every other write. `--paginate`,
  `--jq`, `--template`, `-i`, `-H` (headers other than `Authorization`), `--cache` pass through. `--hostname` refused.
- **AGH-08 Files and stdin.** The stand-in reads what the command names, inside the sandbox, before sending: values of
  `-F`/`--body-file` (pr/issue/release/review commands), `--input` (api), and `@file` values of `-F/--field key=@file`
  (api); `-` means stdin. At most 8 files and 1 MiB together; more is refused before anything is sent. The server reads
  bodies from them for Whombat's own commands; for `run`, the runner writes them into the run directory as `f0`, `f1`, …
  and rewrites those words (`--body-file f0`, `--input f1`, `key=@f2`) — the server returns the words with the same
  placeholders (`@whombat-file:0`), so what runs is exactly what was decided.
- **AGH-09 Ask.** The key asks: one card in the turn's thread (the pipeline's ask: a `custom` approval whose action names
  what it does — “comment on issue #12 in acme/web” — and carries only `ghHash`, the sha256 of the repo and the words; the
  words stay with the deferred command), exit 125 and “I asked {people} on a card in this thread (approval #N). When they
  say yes you are woken: run the same gh command again.” The yes wakes the agent (`custom`'s executor, EA-07). The same
  agent's identical command (same repo, same words, same files) within 24 hours of the yes runs once: the server finds the
  approved request by `ghHash` and signs `github.gh` with its `approvalId`; a second run of it asks again. No waiting inside
  the turn (Claude's Bash tool times out after two minutes; the push model EA-05 already works this way).
- **AGH-10 Running it.** The runner gives gh 5 minutes (`WHOMBAT_GH_TIMEOUT_MS`), keeps at most 8 MiB of stdout and 1 MiB
  of stderr (the rest is cut with a line saying so), replaces the token wherever it appears in either, and relays the exit
  status. The run directory is removed afterwards. One command at a time per turn is not enforced (gh is quick; the
  provider waits for each).
- **AGH-11 The computer's guard.** In a computer turn whose gh goes through Whombat, the guard leaves `gh` alone
  (`ClassifyContext.ghThroughWhombat`, runner and server alike): a `gh pr merge` is decided once, by “Merge into main” in
  Whombat, instead of a `run_command` card and then a `merge_pr` card.
- **AGH-12 When a turn has it (`DispatchContext.gh`).** Managed mode only, GitHub mode `gh` (not `fake`, not `off`), the
  burrow connected, at least one switched-on GitHub repository, and not a Feedback assessment, search answer or read-only
  automation checkout (`workspace.access = read`) turn. `repos` = those repositories (≤ 100, by position), `defaultRepo` =
  the turn's checkout repo when it is one of them, else the only one, else null. Personal agents get it too (reads are
  free; their keys decide writes).
- **AGH-13 Signing.** Writes sign `github.gh` (kind `Code`) before the runner runs them: text “Ran gh issue comment on
  acme/web” (the command words up to the first flag, at most four, never bodies), `where` the repo, payload `{repo, words
  (the subcommand path), keyId, ghHash, approvalId?}`. Reads sign nothing (the run's activity shows the command). GitHub
  shows the signed-in login; bodies Whombat sees get the line “— {Agent} via Whombat” (comments, issues, reviews,
  `pr create` keeps `openedVia`), so a reader on GitHub knows which agent wrote it.
- **AGH-14 The prompt.** A turn with `gh` gets one line in “How you work”: “gh works in your shell for acme/web, acme/api
  (through Whombat, as the burrow's GitHub sign-in): read issues, pull requests, checks and CI logs freely; comments,
  issues, reviews, re-runs and merges go by your keys; gh pr create and gh pr merge open and merge the Whombat way. Not
  here: gh auth, secrets, repo admin, gh api graphql, --web.” The merge rules (`persona/merge-deploy.ts`) say `gh pr merge`
  is the same as `merge_pull_request` where gh goes through Whombat.
- **AGH-15 Errors.** GitHub not connected, the sign-in missing (`managedGitToken`'s sentences), a lost lease (409: “This
  turn is over.”) and a server that doesn't know `runner.ghAuthorize` (404: “gh through Whombat isn't available on this
  Whombat yet.”) are printed by the stand-in with exit 1. gh's own errors pass through unchanged.

- **AGH-16 Claude Code's sandbox in a managed turn with gh.** Claude Code runs every shell command in a bubblewrap of its
  own, without a network and with unix sockets blocked, so the outer bridge isn't there. In a managed turn with gh only,
  its `sandbox.network` gets `allowAllUnixSockets: true` (the domain rules, `strictAllowlist` without the web key and
  `allowLocalBinding: false` stay) and the CLI's environment names the bound socket (`WHOMBAT_GH_SOCKET`; the deny list
  still strips only the MCP token). The managed sandbox stays the boundary: the only unix sockets in the task's view are
  ours and those the task's own processes make (Claude Code's proxy bridges: no new reach); abstract sockets belong to
  the task's network namespace. Measured: the payload's view holds exactly one socket, ours. A live sandboxed Claude
  command reaching it is checked on dev.whombat.com.
- **AGH-17 Codex's sandbox in a managed turn with gh.** Codex's seccomp filter refuses `connect` without a network
  (measured: `EPERM` for loopback TCP and unix sockets; with its network proxy, commands get a namespace of their own).
  In a managed turn with gh only, the permission profile's network is on and Codex's proxy off (`network = { enabled =
  true }`, `features.network_proxy = false`), write and read-only turns alike: commands share the managed sandbox's
  namespace, which has only its loopback bridges, and every host stays the egress service's decision (MSB-06; without the
  web key the provider's endpoints and GitHub only). Commands can reach the MCP bridge but don't hold the token (Codex's
  `shell_environment_policy` excludes it; the app-server isn't visible in their `/proc`). Measured with the new profile:
  both the socket and the loopback port answer, `:workspace` and `:read-only`.
- **AGH-18 No words in the approval.** As built (AGH-DS15): the Ask card stores the command's words nowhere, not even as a
  deferred command (the approvals engine would run a deferred command on the yes). The yes only wakes the agent; its
  identical command, matched by `ghHash`, then runs once (AGH-09).

*Amended 2026-10-04 (resourceful-agents.md RA-DS72…RA-DS74): the stand-in's socket also serves git's GitHub transport
(`git-remote-whombat`): git fetches the switched-on repositories through the runner, which keeps the token; pushes don't
go that way.*

- **AGH-19 `gh repo create` (2026-10-06).** John asked Banjo to create a repository and host a patch in it; `gh repo
  create` was refused, so Banjo wrote a manual guide instead. John: “Go, please fix.” An agent's `gh repo create
  [owner/]name --public|--private|--internal` is now Whombat's own command, like `pr create`: the key decides (AGH-20),
  then the server makes it **as the burrow's GitHub connection** (`GitHubAdapter.createRepo`: `POST /user/repos`, an
  organization's `/orgs/{org}/repos`, or a template's `/generate`), adds it switched on for agents (“Created the public
  repository acme/site on GitHub and switched it on”, signed by the agent) and prints what gh prints (“✓ Created repository
  acme/site on github.com” and its URL). Without an owner it is the connection's own account. Taken: `-d`, `-h/--homepage`,
  `-p/--template` (+ `--include-all-branches`; the template may be any repository the connection reads), `--add-readme`,
  `-g`, `-l`, `--disable-issues`, `--disable-wiki`. Refused with one sentence: no or two visibilities, `-R`, a name GitHub
  wouldn't take, `--source`/`--push`/`--remote` (agents don't push from the shell: a run on the new repository does, G-14),
  `--clone`, `--team`, a template with README/licence/.gitignore/homepage/switches or `--internal`. A name the burrow has is
  “already one of the burrow’s repositories: use it.”; GitHub's own refusal (a taken name, an organization it can't create
  in) is printed as it said. A template's or README's default branch is waited for up to 20 s (as AGR-07), so a run started
  right after finds it. Not done: making a repository from a non-template one (GitHub can't; start a run on the new one and
  bring the commits over with git).
- **AGH-20 Which key.** A private or internal repository is the agent's own work space: “Write code” (`code.write`, on for
  every team agent). A **public** one publishes code to the world: “Deploy” (Ask by default, RA-02), the same row as a
  release workflow. No new key (a contracts change for one command). The card is the gh Ask of AGH-09: “Create the public
  repository acme/site”, the yes lets the identical command make it once; `github.gh` carries `creates: true` and the
  card's attempt is the action itself (no “in owner/name”).
- **AGH-21 `gh release create|edit`.** Publishing a release is a deploy: key “Deploy”, the tag positional required, the
  notes inline (`-n`, signed like a body, AGH-13) or `--generate-notes`. Files are refused (“let the repository’s release
  workflow build and upload them”) and so is `-F/--notes-file`: the stand-in only reads `-F/--body-file` (AGH-08), and a
  built bundle doesn't belong in a turn's 1 MiB. `release upload|delete|download` stay refused. The prompt's gh line names
  both (`gh repo create … (from a template, or with --add-readme, then start a run on it) and gh release create publishes
  a release, by your keys`).

- **AGH-22 An agent says how it merges (2026-10-06).** John told Banjo “I want you to merge it” (John's Morphe Patches
  PR #1); Banjo refused, rightly: Whombat's agent merge only squashed, and that repository's releases need the branch's
  history (a merge commit). `gh pr merge --merge|--squash|--rebase` (one of them; two are refused: “Say one of --merge,
  --squash or --rebase.”) and `merge_pull_request`'s `method` (contracts 0.53.0, CT-290) now choose it; none is still a
  squash. At On the agent's merge uses it; at Ask the `merge_pr` card carries it (`params.method`, its first WHAT HAPPENS
  line ends “with a merge commit” or “, rebased”) and the person's yes merges that way. The merge rules (checks, an
  approving review) are unchanged.

- **AGH-23 Everything gh does, by the agent's keys (2026-10-06).** John, after Banjo asked him to switch on “Allow GitHub
  Actions to create and approve pull requests” by hand: “Allow agents to do this, I want to remove all these
  restrictions so an agent can be really useful.” This replaces AGH-05's refusals and AGH-07's “only under the repo”:
  - **Every gh command** is in the table, and anything else is done with `gh api`, which takes any path on
    api.github.com (the account, organizations, search, anyone's repositories) and GraphQL (a query reads; a mutation
    is decided by what it does). Reads need no key. Unknown flags pass on, except for Whombat's own commands and `gh
    api` (`--verbose` would print the token's header).
  - **Which key.** Changes: Write code (`code.write`, on). Making something public (a repository's visibility, a public
    repository or gist, releases, Pages, deployments): Deploy. Deleting, archiving and transferring (repositories,
    releases, issues, runs, labels, secrets, keys, gists, projects, codespaces, `DELETE` anything but a label, assignee,
    reviewer or reaction): Destructive commands. Lasting access (SSH, GPG and read-write deploy keys, collaborators,
    organization invitations and memberships): Push to main, since such a key can push to main anywhere. A branch's
    commits by other means (`contents`, `git/refs`, `merges`, branch renames, `repo sync`, GraphQL ref and commit
    mutations): that branch's key (`branchWriteKey`, the branch in the key's scope). Comments, issues, labels: Comment
    on pull requests, as before; a review's dismissal: Approve. Merges and reviews stay Whombat's (`gh pr merge|review`,
    the REST and GraphQL ones refused with the pointer), so the burrow's merge rules and cards still hold.
  - **Any repository.** One the burrow doesn't have and the connection can't push to (an upstream's issues, a template,
    a fork's source) is used as it is, reads and writes by the keys, without being added (`github.gh` carries `foreign:
    true`). Account-wide writes name `github.com` and have no repository in their scope. A repository a person switched
    off stays off (AGR-03), and one kept on this Whombat stays git's.
  - **What stays out, and why.** gh's token (`gh auth` but `auth status` without `--show-token`; `-H Authorization|Host`;
    `api --verbose`): the token never leaves Whombat (AGH-03), or the keys would be advice. Code that would run on
    Whombat's side (`gh extension`, `gh alias set`, `gh copilot`). What needs a terminal, a browser or a checkout gh
    here doesn't have (`codespace ssh|code|jupyter|cp|ports`, `browse` without `--no-browser`, `repo clone`, `pr
    checkout`, `repo set-default`, `config set`), and downloads, which would land on Whombat's side. **A path of the
    agent's computer** (`/…`, `~…`, `./…`, `../…`) anywhere but a text flag: gh runs on Whombat's side and would read
    Whombat's file of that name; files reach gh only as `-F/--body-file` (now `release -F` too, inline as `--notes`)
    and `gh api`'s `--input`/`-F key=@file`, which the stand-in sends (AGH-08). So `release upload`, `gist create`
    with files, `ssh-key add key.pub`, `secret set -f` are refused with the `gh api` way to do them; `secret set` and
    `variable set` need `-b` (gh here gets no stdin for them).
  - The prompt's gh line says all this in one sentence.

## Build notes

The server's and the runner's own decisions within these are `docs/implementation/agent-gh/server-notes.md` (AGH-DS01…24:
how gh's words are read, unknown flags, help, URLs naming the repo, `gh api` paths, the checkout branch for `pr`
commands, the signature line, the hash, which yes counts, texts and errors, the test seam) and `runner-notes.md`
(AGH-DR01…14: the stand-in's place and what it reads, limits, the computer's socket, long socket paths, placeholders,
running gh, error lines, which turns get it, the prompt and merge lines, shipping).

## Not built

- Self-hosted guarded turns (AGH-02); GraphQL; `gh run download`/`release download` (files would have to come back into
  the sandbox); waiting for a yes inside the turn; per-command allowances (“Always allow”) for gh writes.
- **AGH-24 “Always allow” on a gh card (2026-11-02).** John, after Dusty asked three times to edit release notes: “add
  the button to those cards”. A gh write's card (a `custom` ask carrying `ghHash`, `isGhWriteAsk`) whose key belongs to
  a risk row (Deploy, Push to main, Destructive commands) offers **Always allow {Agent} to {row}** beside Approve, as
  the typed actions do (resourceful-agents.md RA-06): `approvals.decide` scope `agent` approves and sets the row to On
  for the agent, for people who may change its keys. The agent's next commands under that key run without a card. Other
  `custom` asks keep Approve and Decline: their key is the agent's own choice, not the one that decides the command.
