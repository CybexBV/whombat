# agent-gh — server notes

Decisions the server stream took where `docs/decisions/agent-gh.md` (AGH-01…AGH-15) is silent. Code:
`apps/server/src/github/gh-plan.ts` (planner), `github/agent-gh.ts` (`github.gh`, `runner.ghAuthorize`),
`github/agent-gh-context.ts` (`DispatchContext.gh`), `github/service.ts` (`agentToken`), `computer/routes.ts` (guard).

## Planning (`planGh`)

- **AGH-DS01 Reading the words.** The planner reads gh's words the way pflag does: a value flag takes the next word
  whatever it looks like, `--flag=value` and `-Fvalue` equal two words, short booleans cluster (`-dR acme/web` is `-d`
  and `-R acme/web`). A flag is listed as taking a value only where that is certain, so a word is read as *more* than gh
  reads it, never less. Unknown flags of a read pass as booleans; of a write, `api` or Whombat's own commands they are
  refused (“gh issue comment --x isn’t supported here: leave it out.”).
- **AGH-DS02 Flags before the command.** Only `-R`/`--repo`, `--hostname`, `--help`/`-h` and `--version` may come before
  the command words; anything else is refused (“Put flags after the command: gh issue list --state open.”) — cobra would
  guess at another flag's value there.
- **AGH-DS03 Help.** Help always runs as `gh help <command words>` (the leading lowercase command names, at most three),
  never the agent's words, so a `--help` that gh would read as a value can't run anything. `gh pr` alone is help. Help
  and `--version` get `repo` null and still the agent's token (the contract's `run` needs one).
- **AGH-DS04 URLs name the repo.** A github.com URL among the positional words or non-text flag values names the repo as
  `-R` does (gh follows it); every way of naming must agree (“One repository per command.”). A positional URL to another
  host is refused. Bodies, titles, comments, descriptions and subjects are not looked at.
- **AGH-DS05 `gh api` paths.** A literal `repos/<owner>/<name>/…` names the repo too (switched on, agreeing with `-R`),
  besides `repos/{owner}/{repo}/…`. Refused: full URLs, `%` anywhere in the path, `.`/`..`/empty segments, anything not
  under `repos/<owner>/<name>`. `-H Authorization:` and `-H Host:` are refused. Besides AGH-07's pass-through flags,
  `--silent` and `--slurp` pass; other flags are refused.
- **AGH-DS06 Review comment replies.** Both `pulls/comments/N/replies` (AGH-07) and GitHub's real
  `pulls/N/comments/M/replies` (POST) are `pr.comment`.
- **AGH-DS07 The checkout's branch.** A `pr` command that names no pull request (view, diff, checks, comment, edit,
  close, reopen, ready; merge and review for Whombat's own) gets the turn's checkout branch as its positional word, right
  after the command words, when the checkout is that repo's: gh has no git in its run directory to ask.
- **AGH-DS08 Scope of searches and lists.** `gh search …` gets `--repo <repo>` after the command words. `--owner`, and
  `repo:`/`org:`/`user:`/`owner:` qualifiers in a search query or a list's `--search`, are refused (“gh looks only in
  this repository here: drop repo:, org:, user: and owner: from the query.”).
- **AGH-DS09 `repo view`.** Its positional repo is replaced by the canonical name.
- **AGH-DS10 Workflows.** A numeric workflow id is refused (“Name the workflow by its file: gh workflow list shows
  them.”). When deploy workflows are configured for the repo, a workflow named by its name (not `*.yml`/`*.yaml`) is
  refused the same way, since its file may be the deploy one; a deploy workflow configured by numeric id makes every
  workflow run of that repo `deploy`. `gh workflow run --json` (stdin inputs) and `-F key=@file` are refused (the
  stand-in sends no such files).
- **AGH-DS11 Smuggled placeholders.** A word containing `@whombat-file:` is refused.
- **AGH-DS12 More refused.** Groups `copilot`, `agent-task`, `preview` and the aliases `ext`, `extensions`, `cs`;
  `-e/--editor` and `--web` everywhere; `--delete-last` on comments; `gh pr close -d`; `gh issue create --recover`.

## The signature line (AGH-13)

- **AGH-DS13 Where “— {Agent} via Whombat” goes.** The agent's short name. Inline `-b/--body`, `-c/--comment` (close,
  reopen) and `gh api` `-f/-F body=…` on comment and issue endpoints. A body from `-F <file>` or stdin is turned into
  `--body <text + line>` (api: `-f body=…`) when it fits in one word (`GH_ARG_MAX`); a longer one runs from the file,
  unsigned. Not signed: titles, label descriptions, `--input` JSON, `pr create` (`open_pr` adds `openedVia`), merges, and
  reviews (`review_pr` posts nothing to GitHub; it records the review and posts the body in the branch room as the
  agent). A body already ending with the line isn't signed twice.

## Deciding (`github.gh`)

- **AGH-DS14 The hash.** `ghHash` = sha256 of JSON `[repo (canonical), words, files' base64 in order, stdin]`, where the
  words are as decided: `-R`/`--hostname` taken out, file placeholders in, before the checkout branch and the signature.
  So `-R acme/web` or not, or another file name with the same content, is the same command.
- **AGH-DS15 Ask without a deferred command.** `github.gh` uses `onAsk: 'apply'` and creates its own `custom` approval
  (like `runtime.authorize_git`): `{name: “comment on issue #12 in acme/web”, keyId, data: {ghHash}}`, `command` null, so
  the yes runs `custom`'s executor (wakes the agent) and nothing re-runs. The words are stored nowhere — not even as a
  deferred command (the engine would run it on the yes); they stay with the agent, who runs the same command again.
  A request for the same command still waiting answers instead of a second card.
- **AGH-DS16 Which yes counts.** Approved, decided within 24 hours, the same agent, the same `ghHash`, and an action
  whose key, name and title are exactly what `github.gh` writes for this command — so an agent's own `request_approval`
  carrying the hash under another name covers nothing. Used: a `github.gh` event carries its `approvalId`. Looked up
  inside the burrow's lock. A key that is On runs without using a yes.
- **AGH-DS17 Texts.** The attempt is the action phrase plus “ in <repo>” (“Tried to comment on issue #12 in acme/web.
  Blocked.”, card “Comment on issue #12 in acme/web”). The signed text uses the words that run up to the first flag, at
  most four, each at most 100 characters (“Ran gh issue comment 12 on acme/web”).
- **AGH-DS18 What the stand-in prints.** Refusals, Blocked and pending go to stderr with a newline; Whombat's own
  commands' success to stdout. Blocked prints the pipeline's sentence only. Pending: “in this thread” when the turn has a
  thread, “here” in the conversation itself, “in #general” (the card's conversation) when the card went elsewhere
  (`open_pr`'s ask goes to the first channel, as with `open_pull_request`). Whombat's own commands at Ask: “I asked … on a
  card … (approval #N). When they say yes, Whombat does it: don’t run the command again.” (a merge runs as the person
  who approved; `open_pr` and `review_pr` run again under the yes).
- **AGH-DS19 Whombat's own commands.** `pr create`: base defaults to the repo's default branch; `-H owner:branch` only
  for the repo's owner (“Pull requests from forks aren’t supported here.”); a title is required. `pr merge`: method,
  `-d`, `--body`, `--subject`, `--match-head-commit`, `--author-email` ignored; `--auto`, `--disable-auto`, `--admin`
  refused. A pull request named by branch is the open one with that head in Whombat's table (“No open pull request for
  feat/x in acme/web.”). `pr review`: exactly one of `--approve`, `--request-changes`, `--comment`; a body for the last
  two.
- **AGH-DS20 Order and errors.** A write fetches the token before committing, so a sign-in that can't be used signs
  nothing. Any `ApiError` (the token's sentences, a command's refusal) is `done`, exit 1, its message.
- **AGH-DS21 Limits.** A turn without `gh` gets `done` exit 1 “gh doesn’t go through Whombat in this turn.”; more than
  `GH_INPUT_MAX_BYTES` of decoded files and stdin, exit 1 “gh can read at most 1 MiB of files and stdin together here.”
  The route's body limit is 20 MiB (200 words of 64 KiB plus the files as base64).

## Context and guard

- **AGH-DS22 Test seam.** `useAgentGhForTests(services)` (a per-container flag; throws unless `NODE_ENV=test`) makes
  `agentGhOn` true with the fake GitHub on a self-hosted test server, where `agentToken` is the fake's `gitToken`. In
  production `agentGhOn` is `isManaged(config) && github.mode === 'gh'` only.
- **AGH-DS23 The route's view of the turn.** `ghTurnOf` computes the checkout with `turnWorkspace` exactly as the
  dispatch context does, so the repo list, `defaultRepo` and checkout branch the route plans with are the ones the
  turn's context gave the runner.
- **AGH-DS24 The guard.** `runner.authorizeCommand` computes the dispatch's `gh` context and passes
  `ghThroughWhombat` to `classifyAgain` (the only place the server calls `classifyCommand`).

## For the runner

- `@whombat-file:N` comes back as a whole word (the value of `--body-file`/`-F` or `--input`) or after `=@` in an api
  field (`title=@@whombat-file:1`); the runner writes file N (`body.files[N]`) as `fN` and rewrites those. A body file
  or stdin of a comment or issue usually comes back inline (`--body <text>`), with no placeholder left.
- `-` stays `-` (and `key=@-`); after a body was turned inline, no `-` is left.
- The args may be a few words longer than the request (the checkout branch; `--repo <repo>` for search).
- Help: `['help', …]`, `repo` null; version: `['--version']`, `repo` null.
- Exit codes in `done`: 1 refusals and errors, 125 waiting for a person, 126 blocked, 0 Whombat's own commands.
- A lost lease is a 409 (`liveDispatch`: “This runner no longer holds the dispatch.” or “This dispatch is not
  running.”); the stand-in prints AGH-15's “This turn is over.”
