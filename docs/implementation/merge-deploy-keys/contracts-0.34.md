# Contracts 0.34.0 / 0.34.1 — what the merge-deploy-keys streams build on

**Vendored now: 0.34.1** (patch, CT-215: `HostInfo.deployWorkflow`, section E): whombat-contracts main `76c3f85`
(merge of `deploy-workflow-hint`: `15f0771` core, `15e3d5a` versions), tag `contracts-v0.34.1`; it replaced 0.34.0 in
both repos (see the end of this section). Everything below about 0.34.0 still holds.

Released 2026-10-01: whombat-contracts main `4e18267` (merge of `merge-deploy-keys`: `fb5d7a9` core, `d7e4afc`
versions), tag `contracts-v0.34.0`, decisions CT-211…CT-214 in `~/Code/whombat-contracts/docs/decisions/contracts.md`.
Not pushed: the lead pushes. Vendored into Whombat `merge-deploy-keys` (`3ba153a0`) and whombat-app
`merge-deploy-keys` (`219cee1`, branched from main `b472cc8`); both pass `pnpm check`. The stubs each left are listed
at the end. Source of truth:
`~/Code/whombat-contracts/packages/core/src/keys/{catalog,engine,grants,configure,requests}.ts`,
`packages/core/src/contracts/{agents,mcp}.ts`, `packages/protocol/src/session/features.ts`.

`SESSION_API_LEVEL` stays **25**. New runtime feature **`keys.merge_deploy`** (`RUNTIME_FEATURES`, since 0.34): a
client shows the three-state rows only on a runtime that advertises it. No Go, JSON Schema or vector change.

## A. Caps (MDS-01, CT-211) — `@whombat/core/keys`

- `KEY_CATALOG['merge.main' | 'deploy' | 'deploy.staging' | 'deploy.production'].agentMaxTier` = `'can'` (was
  `'never'` / `'ask'`). Descriptions: Merge into main “Merge pull requests into the default branch.”, Deploy “Deploy to
  any environment.”, Deploy to staging “Deploy a commit to the staging environment.”, Deploy to production “Deploy a
  commit to production.” Labels unchanged.
- Consequences, no signature change: `agentMaxTier`, `clampTier`, `clampGrants`, `validateGrants` let these keys
  through at `can`; `lockedNote(...)` is null for them; `PEOPLE_ONLY_KEYS` = `branch.main.push`, `agents.manage`,
  `approvals.decide`, `members.invite`, `burrow.manage`; `ALWAYS_ASKS_KEYS` = `mail.send`, `calendar.invite`,
  `files.share`, `files.delete`. `decide()` is unchanged: on these keys `can` → allow (`granted`), `ask` → ask
  (`asks_first`), `cannot` / none → deny (`denied` / `no_key`); `people_only` and `always_asks` no longer occur for them.
- **New key `branch.main.push`** “Push to main” (group `code`, no parent, `agentMaxTier: 'never'`, “Push commits
  straight to the default branch. People only: agents merge through pull requests.”), placed after `merge.main` in
  `KEY_IDS`.
- **`branchWriteKey(branch, defaultBranch = 'main'): KeyId`** — the default branch now gives `'branch.main.push'` (was
  `'merge.main'`), so an agent with Merge On still can't start a run on main, get push credentials for main, or a
  writable sandbox on main. Every caller (`runtime/git.ts`, `commands/agent-runs.ts`, `commands/agent-tools.ts`,
  `automations/workspace.ts`, `github/mirror.ts`, `persona/access.ts`, `mcpRequiredKey('start_run')`) gets it for free;
  their Blocked events now say “KEY IT NEEDED · Push to main”.
- `MCP_TOOLS.merge_pull_request.description` — “Merge a pull request, into main too. Your Merge key decides: held, it
  merges; held at ask, a person approves it on a card first (pending_approval); not held, it is blocked and you can ask
  for the key. Never push to main or merge with git or gh yourself.” `mcpRequiredKey('merge_pull_request')` and
  `actionKey({type: 'merge_pr'})` are unchanged (`merge.main` for base main/master, else `merge`).
- `HANDOVER_KEYS` gains `'merge.main'`, `'merge'` after `'pr.open'`.
- Unchanged on purpose: `MERGE_NOTE` (“Merging is for people. Agents in this burrow don’t hold a merge key.”),
  `ROLE_DEFAULT_KEYS` (a Developer's `merge.main: cannot` and `deploy: cannot`, an Operator's two deploy keys at ask).

## B. Merge and Deploy rows in three states (MDS-02, CT-212) — `@whombat/core/keys`

- `KEY_TIER_ROWS = ['merge', 'deploy'] as const`; `type KeyTierRow = 'merge' | 'deploy'`;
  `isKeyTierRow(keyId: KeyId): keyId is KeyTierRow`.
- `KEY_TIER_ROW_KEYS: Record<KeyTierRow, readonly KeyId[]>` — what a row writes: `merge: ['merge', 'merge.main']`,
  `deploy: ['deploy', 'deploy.staging', 'deploy.production']`.
- `KEY_TIER_ROW_READS: Record<KeyTierRow, readonly KeyId[]>` — what a row reads: `merge: ['merge.main']`,
  `deploy: ['deploy.staging', 'deploy.production']`.
- `keyTierRowOf(keyId: KeyId): KeyTierRow | null` — `merge.main` → `'merge'`, `deploy.staging` → `'deploy'`.
- `KEY_TIER_CHOICES: readonly Tier[]` = `['cannot', 'ask', 'can']`; `KEY_TIER_LABELS: Record<Tier, string>` =
  `{cannot: 'Off', ask: 'Ask', can: 'On'}` — the control's segments, in order.
- `DEPLOY_NO_WORKFLOW_HINT = 'No deploy workflow is set up on this Whombat yet.'` (MDS-05).
- `KeyRowTiers` — schema `z.object({merge: Tier.optional(), deploy: Tier.optional()})` and type.
- `keyRowTier(grants: readonly Pick<Grant, 'keyId' | 'tier' | 'scope'>[], row: KeyTierRow): Tier` — the row's tier for
  one agent's grants: for each read key, the most specific level of its umbrella chain with a grant (direct before
  bundle, strictest at a level, clamped), scopes ignored, none → `cannot`; the strictest over the read keys. Developer
  → Off/Off, Operator → Off/Ask, Lead → Off/Off; `merge: can` + stale `merge.main: cannot` → Off.
- `withKeyRowTier(grants: readonly GrantInput[], row: KeyTierRow, tier: Tier): GrantInput[]` — sets the umbrella
  (`merge` / `deploy`) to `tier` and aligns every narrower row key already held to `tier`, all without a scope; narrower
  keys not held stay absent; a missing umbrella is appended. Use it wherever a row is written (Configure, the `set
  keys` command if it takes a row, requests).
- `HireKeyOption.defaultTier?: Tier` — set only on the two rows: they render as Off · Ask · On and open at it;
  `defaultOn === (defaultTier === 'can')`; `locked` / `lockedTier` null for every role (no “not for this role”).
- `HIRE_KEY_OPTIONS` — the last two rows are now `{keyId: 'merge', defaultOn: false, locked: null, lockedTier: null,
  defaultTier: 'cannot'}` and the same for `'deploy'` (the `merge.main` row is gone; the Merge row's label is
  `keyLabel('merge')` = “Merge”).
- `hireKeyOptions(role)` — the rows' `defaultTier` is `keyRowTier(roleDefaultGrants(role), row)`: Off for every role
  except the Operator's Deploy (Ask). They stay the last two rows (after the role's extra rows).
- `hireGrants(agentId, selected, channelIds, role?, tiers: KeyRowTiers = {}): Grant[]` — each row is always granted as
  its umbrella key at `tiers[row]`, else `can` if `selected` lists the row, else the role's default, else `cannot`.
  `selected` never grants `merge.main` / `deploy.staging` / `deploy.production`. A hired Developer now holds
  `merge: cannot`, `deploy: cannot` (was `merge.main: cannot`, `deploy: ask`); an Operator `merge: cannot`,
  `deploy: ask`.
- `HireBody.keyTiers?: KeyRowTiers` (`agents.hire`) — the rows as the person set them.
- `configureKeyTiers(grants, options = HIRE_KEY_OPTIONS): KeyRowTiers` — `keyRowTier` for each row `options` shows.
- `ConfigureEdit.baseTiers?: KeyRowTiers`, `ConfigureEdit.tiers?: KeyRowTiers` — the rows as opened and as now.
- `configureGrants(held, edit, options)` (changed) — a row whose `tiers` value differs from `baseTiers` is written with
  `withKeyRowTier`; without `tiers`, a row's `keys` switch change is read as On (`can`) / Off (`cannot`). A save at the
  opened tiers changes nothing (null).
- `configureKeyState(grants, options)` (changed) — a row's switch is `keyRowTier(...) === 'can'` (for a client still
  drawing switches); the param type widened to `Pick<Grant, 'keyId' | 'tier' | 'scope'>[]`.
- `ROLE_LOCKED_NOTE` stays exported; no fixed row carries it now.

## C. Key requests (MDS-04, CT-213) — `@whombat/core/keys`

- `keyRequestProblem(agent, grants, keyId)` — no longer refuses `merge.main`; `branch.main.push` and the burrow keys
  still “… is for people. Agents never hold this key.” A row key held at ask: “Tinker already holds “Deploy to
  staging” and asks a person each time. A person can switch it to On in Configure.”; held at can: “Tinker already holds
  “…”.”
- `requestedTier(keyId)` — `'ask'` for `merge`, `merge.main`, `deploy`, `deploy.staging`, `deploy.production`; else as
  before. The card copy follows (“…, still asking a person each time”).
- `grantsWithRequestedKey(agentId, grants, keyId)` — for a row key: the whole row at ask (`withKeyRowTier`), unless a
  row key is already held at can (then only that key's own grant goes to ask, as before). Other agents' grants are left
  out, as before. So a Developer asking for Merge into main ends with `merge.main: ask` + `merge: ask` (row reads Ask).

## D. Protocol

- `RUNTIME_FEATURES` gains `'keys.merge_deploy'` (`SINCE_0_34`); `LEGACY_FEATURES` doesn't have it.

## E. `HostInfo.deployWorkflow` (0.34.1, MDS-05, CT-215) — `@whombat/core/contracts`

- `HostInfo.deployWorkflow?: boolean` (`host.info`, `GET /burrows/:burrow/host`) — `true` when a deploy workflow is set
  up on this Whombat (`DeployExecutor` configured, `GITHUB_DEPLOY_WORKFLOW` today), `false` when a deploy answers
  “Whombat can’t deploy here…” (`approvals/unavailable.ts`). Absent (older servers): unknown → no hint. Optional, no
  feature name, `SESSION_API_LEVEL` unchanged. `FIXTURE_HOST` (fixtures) leaves it out.

## What each stream still has to do

**Runtime** (Whombat worktree):

- The vendoring commit put `'keys.merge_deploy'` in `NOT_IMPLEMENTED` (`apps/server/src/managed/runtime-features.ts`);
  move it to `IMPLEMENTED_FEATURES` once the stream lands.
- `hire_agent` (`apps/server/src/commands/agents.ts`): pass `input.keyTiers` as `hireGrants`' fifth argument (without
  it the rows take the role's default).
- `set keys` (agent-facing or CLI command, MD's “set keys command accepting the new tiers”): accept `can` for
  `merge.main` / deploy keys (the clamp no longer lowers them); if it edits “Merge” / “Deploy” as rows, write them with
  `withKeyRowTier`.
- `host.info` (MDS-05, 0.34.1): set `deployWorkflow` — the same condition `approvals/unavailable.ts` uses to answer
  “Whombat can’t deploy here” (false there, true when a deploy workflow is configured).
- Approvals on Ask (MDS-03): `merge_pull_request` / `merge_pr` and `deploy` with `ask` must create the approval card and
  execute on approve (prs.ts already asks `merge.main`/`merge`); verify merges really execute on a managed appliance,
  GitHub-backed and bare-origin (`repos.create`) repositories. Deploy without a workflow keeps `approvals/unavailable.ts`.
- Persona/prompt (MDS-06): the keys section for Merge/Deploy On (may merge/deploy when asked), Ask (say a card was
  posted, stop), Off (ask for the key). Command safety unchanged; pushing to main is now blocked by `branch.main.push`.
- Integration tests that assert the old caps — run against the vendored 0.34.0 (only these seven files): 9 failures
  in 7 files, all expected: `github/rules.int.test.ts:200`, `runtime/runner.int.test.ts:559` and
  `mcp/mcp.int.test.ts:295` (push / run on main → `keyNeeded.id` is now `branch.main.push`);
  `commit/keys.int.test.ts:206` (a hired Developer: `merge: 'cannot'`, `deploy: 'cannot'`, no `merge.main`);
  `approvals/key-requests.int.test.ts:115` (`merge.main` may now be asked for; given at ask with `merge` aligned);
  `packs/packs.int.test.ts:354` (`lockedNote` of `merge.main` is null); `commands/roles.int.test.ts:103` (the
  Merge/Deploy rows are no longer locked, so `locked` is empty and each hire has two more grants, `merge` and `deploy`
  at Off: assert `defaultTier` instead of `lockedTier`; its two later tests fail only because the first didn't fill
  `hired`). “merge into main is people only” (`rules.int.test.ts`) still passes — Banjo's role holds
  `merge.main: cannot` — but its title is stale. The seed/test-world Blocked event at `seed/test-world.ts:720` is
  history and may stay. The rest of `pnpm test:server` was not run.
- Record MDS-01…MDS-07 in `docs/decisions/runs-approvals.md` § “Merge and Deploy in three states”.

**App** (whombat-app `merge-deploy-keys`):

- Hire modal and Configure (web; Android wherever an agent's keys are edited): rows with `defaultTier !== undefined`
  (`isKeyTierRow(option.keyId)`) render as an Off · Ask · On segmented control (`KEY_TIER_CHOICES`,
  `KEY_TIER_LABELS`) instead of a switch, only when the runtime has `keys.merge_deploy` (else keep today's locked
  rows, or hide them). Hire sends `keyTiers`; Configure opens with `configureKeyTiers(grants, options)` and saves with
  `configureGrants(held, {…, baseTiers, tiers}, options)`.
- `liveKeyRows` (`apps/web/src/features/agents/liveKeys.ts`) treats any `locked` row as capped; the rows are no longer
  locked, so after vendoring they show as plain “Merge” / “Deploy” switches (the transitional switch path works: on =
  `can`, off = `cannot`, via `selected` / `keys`). The vendoring commit made `withProposeSkills` (`configureKeys.ts`)
  place “Propose skills” before the first `defaultTier` row too (else it went last, after Deploy), and moved four tests
  off the old locked rows (`liveKeys.test.ts`, `agents.test.tsx` hire flow, `skills.test.tsx` ×2: “Merge” switch,
  unlocked, Off) — rewrite them for the segmented control.
- The Deploy row's hint `DEPLOY_NO_WORKFLOW_HINT` when `useHostInfo` answers `deployWorkflow === false` (MDS-05,
  0.34.1); `true` or absent (older server) → no hint. The row stays settable either way.
- The vendoring commit added `'keys.merge_deploy': 'Merge and Deploy for agents'` to `FEATURE_NAMES`
  (`packages/client/src/managed/updates.ts`; “Update your Whombat to use Merge and Deploy for agents.”).
- `MERGE_NOTE` under the people's Merge into main button is no longer always true; show it only when no agent in the
  room holds Merge, or drop it (app decision).
- Release 0.23.0 and vendor it into the Whombat worktree.
