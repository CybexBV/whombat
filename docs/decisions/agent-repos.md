# GitHub repositories for agents by default (AR)

John, 2026-10-05, in #general on his DEV box: Banjo needed a GitHub repository for a task and said it was blocked —
“this should not happen. It should simply connect to the repo, without any issues.” The cause: agents could only use
repositories a person had added in Settings → Connections → GitHub. `gh -R`, `start_run`, `open_pull_request` and a
private repository's `git clone` all stopped with “isn’t switched on for agents … a person adds it”, and with no
repository added yet the turn had no gh at all. This follows John's 2026-10-04 rule (resourceful-agents.md RA-DS51:
one GitHub connection covers every agent, nobody is “assigned”) through to the repositories themselves.

| ID | Decision |
|---|---|
| AGR-01 | Once the burrow is connected to GitHub, an agent that names a GitHub repository the burrow doesn't have yet gets it **added and switched on** for agents. The repository is looked up on GitHub as the connection, the command `github.add_repo_for_agent` is signed by the agent (event `repo.added`, “Added and switched on owner/name”), and the agent's work goes on. Where it happens: `gh` through Whombat (a plan that names an unknown repository is planned again with it), the git fetch credential (`runner.gitCredentials`, fetch only), and the MCP tools `start_run` and `open_pull_request` (`beforeTool`, which also passes on GitHub's own spelling of the name). `apps/server/src/github/agent-repos.ts`. |
| AGR-02 | A connected burrow's turns get `DispatchContext.gh` even with no switched-on repository yet (`repos: []`). The runner keeps gh and the git transport for such a turn, and asks the server for a fetch credential for any github.com repository, not only the listed ones. No contract change: `GhDispatchContext.repos` was already allowed to be empty. |
| AGR-03 | *Superseded by AGR-11.* A repository a **person switched off stays off**: only one the burrow doesn't have is added. An agent never switches a repository on. Refusals keep one wording for “not reachable” and “switched off” (TODO 10.1). |
| AGR-04 | Only the team's own repositories are added: one the connection can **push to** (`permissions.push` from GitHub's repo API, `GhRepo.canPush`), or a **private** one it can read. Anyone's public repository (cloned or looked at for reference) isn't added, so it isn't polled and doesn't show up in the burrow; git still clones it directly without a sign-in, and gh says so. When GitHub doesn't say (`canPush` absent, the fake), the repository is added. |
| AGR-07 | **A run on someone else's public repository runs on the team's own copy.** John's next try, same evening: Banjo's `start_run` on `MorpheApp/morphe-patches-template` (a public template John's account can't push to) still stopped, because AGR-04 left it out and a run has to push its branch. `start_run` now makes a copy as the connection: “Use this template” (a **private** repository, default branch only) when GitHub marks the source as a template, else a fork (default branch only). The copy is named `<connection login>/<same name>` and is added for agents with “Made owner/name from source and switched it on”. The run uses it, and `beforeTool` passes the copy's name on. A copy already there by that name and pushable is reused, so nothing is made twice. Making the copy may take 30 s, and its default branch is waited for up to 20 s after. Only `start_run` makes copies; gh, git and `open_pull_request` keep AGR-04. New adapter method `copyRepo` (`POST …/generate` or `…/forks`). |
| AGR-05 | The prompt's gh line says gh works for the switched-on repositories “or any other repository the burrow’s GitHub sign-in works on (name it with -R owner/name; nobody has to add it first)”. With none switched on yet, it names only that. |
| AGR-06 | The lookup on GitHub may take 10 s (`LOOKUP_MS`). A sign-in that doesn't answer, or any GitHub error other than 404, is logged and treated as not found: the agent's command gets its usual refusal instead of hanging. |

Not changed: writes still go by the agent's keys (pushes, pull requests, merges, gh writes; AGH-06, G-14). A burrow
nobody connected still says so (RA-DS50). The developer-craft `github` skill's “gh isn’t available here” guidance is
still right for an unconnected burrow and wasn't bumped.

## Every repository the account owns (AGR-08…AGR-13)

John, 2026-10-30, in the main checkout: “I want a GitHub connection to give access to all repos owned by the account, so
can you please remove individual repo selection?” Settings → GitHub had a switch per repository and an “Add from
GitHub” picker (the account's repositories, more on demand, one by `owner/name`); nothing reached the agent until
someone picked it.

| ID | Decision |
|---|---|
| AGR-08 | **Every repository the connected GitHub account owns is the burrow's**, for the agent: GitHub's `GET /user/repos?affiliation=owner` (`listRepos(…, {owned: true})`), not its collaborations or organisations' (those still join when the agent names one, AGR-01, AGR-04). They come in when GitHub is connected (the Connect route and signing in, RA-DS52), on **Sync repos**, and by the poller (AGR-09): command `github.owned_repos` (`github/owned-repos.ts`), signed by the person who connected or pressed Sync, else by GitHub, with **one** event for all that joined (`github.repos_synced`, “Added 12 repositories from GitHub”), not one per repository. A failure while connecting is logged and the connection stands; the poller tries again. |
| AGR-09 | **The poller reads the account's repositories every 10 minutes** per connected burrow (`OWNED_SYNC_MS`, in its scheduled tick only, so tests' `pollNow` doesn't), so one made on GitHub joins by itself. Ones the burrow has get GitHub's language, default branch and last push, written only when they changed. |
| AGR-10 | **Archived repositories stay out**, and at most 300 come in (`OWNED_REPOS_MAX`, the most recently pushed); any other is reached by naming it (AGR-01). A repository the account no longer owns (deleted, transferred) stays as it is: its pull requests and rooms are history. A repository created on the Whombat by the same name is left alone. |
| AGR-11 | **No per-repository switch.** Migration `0021_repos_all_on` (data only, an `expand`) switches on every repository a person switched off. No contract shape changed, so there is no contracts release: `repos.update` stays for older apps, switching on works and switching off is a 409 (“Repositories can’t be switched off any more…”); `repos.add` and `github.repos` stay for older apps' picker, and `repos.add` always switches on. The `repos.enabled` column and the rules for a repository that is off stay where they are (always on now). Refusals no longer tell anyone to switch a repository on or add it in Settings. Supersedes AGR-03. |
| AGR-12 | **Settings → GitHub lists the repositories with nothing to pick**: no switches, no “Add from GitHub”, no `owner/name` box. The card says “Connected. {Name} works in every repository @login owns, as @login.”; Sync repos stays and brings in new ones. The phone's GitHub page counts them (“@login · 12 repositories”) and says every repository the account owns comes with the connection. The agent's Access tab and the New repository dialog say the same without “switched on”. |
| AGR-13 | **The agent's facts name at most 20 repositories**, the most recently pushed, and count the rest (“Repositories you work in: … and 84 more.”); gh's list (`DispatchContext.gh.repos`, at most 100) is in the same order, so its first 20 named in the prompt are the ones in use. |

## A repository renamed on GitHub (AGR-14…AGR-17)

John, 2026-11-16, after one of his team's repositories was renamed on GitHub: “Fix the new repo name.” His two report
automations still named the old one. They kept working only because GitHub sends an old name on to the new one (a
redirect that ends the day anyone makes a repository by the old name), and their T3 Code turns had to guess which project
“the project of” the old name was. The box's own repository row kept the old name too: only owned repositories are
listed again (AGR-08), and that sync matched by name, so a renamed owned repository would have come in a second time.

| ID | Decision |
|---|---|
| AGR-14 | **A repository renamed or moved on GitHub is renamed on the Whombat.** GitHub keeps its id, so it is the same repository: `github.repo_renamed` (signed by GitHub, event `repo.renamed`, “GitHub renamed a/b to a/c”) renames the row and, in the same commit, what the box keeps by its name — the poll cursor, branch heads, issues, push tokens, deploys, repository rules and setups, nightly runs, deployments, check-server work, a tracker's followed fixes —, keys limited to it (`grants.scope.repos`) and a connection's settings that name it (GitHub Actions' list). Messages, runs, approvals and the log are history and keep the name they were written with; GitHub's redirect still reaches their links. |
| AGR-15 | **The poller notices it**: each read of a repository asks GitHub for the repository itself (`repoInfo`), conditional on that answer's own ETag, kept through refreshes, so it is a 304 GitHub doesn't count while nothing about the repository changed. A different name (any case aside) is renamed at once and the repository is read by its new name from the next cycle. The owned sync (AGR-09) matches GitHub's id before the name, so an owned repository renamed on GitHub is renamed, not added again. |
| AGR-16 | **Automations take the new name by themselves**, like new wording (automation-recipes.md AR-59): every automation whose live version or draft names the old one gets a new version with the new name wherever the definition names it as a whole name (a recipe's repository, the pull-request steps, the words of its prompts, its triggers), committed as the automation itself (`automation.repo_renamed`) and still published by whoever published it. A recipe made for the old name comes out equal to one made today for the new name, so it keeps taking later wording updates. |
| AGR-17 | **A name already taken stays as it was.** When the burrow already has another repository by the new name (one created on the box, or a second row from before AGR-15), when GitHub's id says it is another repository, or for a repository created on the box, nothing is renamed and the server logs why; the old name keeps working through GitHub's redirect until a person sorts it out. |

