# Merge and Deploy keys with three states (2026-10-01)

John couldn't give Banjo (Developer) “Deploy” or “Merge into main” in Configure. Today:

- `merge.main` has `agentMaxTier: 'never'` (“People only: agents never hold this key”): the engine denies it outright,
  key requests refuse it, Configure shows a locked-off row “people only”.
- `deploy` / `deploy.staging` / `deploy.production` have `agentMaxTier: 'ask'`: Configure and the hire modal show a
  locked-off row “always asks a person” with no switch at all (`liveKeyRows`: “a capped row (Merge, Deploy) off with
  its note”). The only way in is a key request (KR-04 gives it at `ask`). Developers start with `deploy: cannot`.
- Deploys run through `DeployExecutor` only when `GITHUB_DEPLOY_WORKFLOW` is set; otherwise `approvals/unavailable.ts`
  answers “Whombat can’t deploy here: no deploy workflow is set up on this Whombat…”.

**John (2026-10-01):** “I would like to be able to assign both merge and deploy to an agent when I want to. For both I
would like to introduce 3 states: disable / enable / ask (so when ask is selected, it should show a card where the user
has to authorize the deploy or merge).” This **supersedes** the mock's “people only” / “always asks a person” for these
two keys (record it as such; it's John's call). John wants choices made by us: decide open details yourself, record
them, move on.

## Decisions (record as `docs/decisions/runs-approvals.md` § “Merge and Deploy in three states”, MDS-01…, and in the
contracts / app decision logs for what each repo decides)

- **MDS-01 Caps lifted.** `merge.main`, `deploy`, `deploy.staging`, `deploy.production` get `agentMaxTier: 'can'`.
  Catalog descriptions lose “People only…” / “Agents always ask a person first.” (e.g. Merge into main “Merge pull
  requests into the default branch.”; Deploy “Deploy to any environment.”). No other key's cap changes
  (`agents.manage`, `approvals.decide`, `members.invite`, `burrow.manage` stay people only; mail/calendar/files asks
  stay).
- **MDS-02 Two rows, three states.** Configure (web and Android, wherever an agent's keys are edited) and the hire modal
  show **Merge** and **Deploy** as rows with a three-state control instead of a switch: **Off · Ask · On** (`cannot` /
  `ask` / `can`), using the product's existing tier vocabulary and components where a three-state exists (Vault key
  tiers, profile key rows) — match the mock's segmented/tier style. Default for every role stays Off (today's
  `cannot`), except roles whose defaults already hold these keys at `ask` (Operator's deploy keys → the Deploy row
  reads Ask).
  - The **Merge** row is the effective tier for merging any pull request, including into main: it writes the umbrella
    `merge` and the same tier on `merge.main` (or clears narrower grants), so no stale `merge.main: cannot` overrides
    it (engine: the most specific level with a grant decides). The **Deploy** row likewise writes `deploy` and aligns /
    clears `deploy.staging` / `deploy.production`. Read side: a row shows the tier that actually decides a merge into
    main / a production deploy; if the narrower grants differ (e.g. Operator: staging ask, production ask), show the
    most restrictive and say nothing more — keep it simple.
  - Remove the role lock “not for this role” for these two rows (a Lead or Tester can be given them too, defaults Off).
- **MDS-03 Ask = a card.** With Ask, a merge (`merge_pr`) or a deploy (`deploy`) is an approval card the person
  authorises, the existing approvals flow (card in the conversation + Needs you), executing on approve. Verify merge
  approvals actually execute on a managed appliance (GitHub-backed repos via the real executor; repositories created on
  the Whombat — bare origins, `docs/decisions/repositories.md` — must merge too, or answer clearly why not). On means it
  runs without a card. Off means blocked, and the agent may ask for the key (KR flow).
- **MDS-04 Key requests.** `merge.main` is no longer refused as people-only. An approved request for Merge or Deploy
  gives **Ask** (not On): the person switches to On in Configure if they want. Record it (amends KR-04 for these keys).
- **MDS-05 Deploy without a workflow.** The Deploy row can be set regardless; while no deploy workflow is set up, the
  row shows a hint (“No deploy workflow is set up on this Whombat yet.”) and a deploy answers as today
  (`unavailable.ts`). Setting up deploy workflows from the UI is **not** part of this task (note it as open).
- **MDS-06 Agents are told.** The runner/persona prompt's keys section reflects the new tiers (On: may merge/deploy
  when asked to; Ask: say a card was posted and stop; Off: ask for the key). Command-safety rules that stop agents from
  pushing to main in the sandbox are unchanged: merging is only through Whombat's `merge_pr` action, never `git push`
  to main or `gh pr merge`.
- **MDS-07 Audit.** Tier changes are the existing signed Keys events (“Gave Banjo a new key: Merge”, tier changes),
  merges and deploys keep their existing events; nothing new beyond copy.

## Streams and versions

| Repo | Today | Target |
|---|---|---|
| `~/Code/whombat-contracts` | 0.33.0 | **0.34.0** |
| `~/Code/Whombat` (worktree `~/Code/.wt/whombat-merge-deploy`, branch `merge-deploy-keys`) | main 78f67422 | runtime |
| `~/Code/whombat-app` (branch `merge-deploy-keys`) | 0.22.0 | **0.23.0** |
| `~/Code/whombat-appliance` | candidate 0.29.0 | candidate **0.30.0** |

1. **Contracts** (first): catalog caps and copy, engine/`lockedNote`/`hireKeyOptions`/`liveKeyRows`-related core
   helpers (`HireKeyOption` grows a three-state notion for these rows; `hireGrants` / `configureGrants` write the tiers
   per MDS-02), key requests (MDS-04), any copy. Unit tests. Release 0.34.0 like 0.33.0; write
   `docs/implementation/merge-deploy-keys/contracts-0.34.md` in the Whombat worktree; vendor into the Whombat worktree
   and whombat-app (branch `merge-deploy-keys`).
2. **Runtime** (Whombat worktree): engine use, `set keys` command accepting the new tiers, approvals for merge/deploy
   on Ask (MDS-03 verified with integration tests), key requests, prompt (MDS-06), decisions. `pnpm check` +
   `pnpm test:server`.
3. **App** (whombat-app): MDS-02 / MDS-05 on web and Android (Configure + hire modal), light and dark checked on web.
   Release 0.23.0, vendor into the Whombat worktree.
4. **Appliance** (last): candidate 0.30.0, dev instance on it.

DEV fast path (IN-132): quick checks only, no validate/VM gates/CI waits. `TMPDIR=~/.cache/wb-tmp`. Own throwaway
databases and free ports; never stop or reset shared containers. Only the lead merges into `main` and pushes. Commits
end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
