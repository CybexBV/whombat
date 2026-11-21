# Contracts 0.37.0 — what the five-roles streams build on

Released 2026-10-02: whombat-contracts main `43f1116` (merge of `five-roles`), tag `contracts-v0.37.0`, pushed;
decisions CT-228…CT-233 in `~/Code/whombat-contracts/docs/decisions/contracts.md` (CT-232 lists where names differ from
the assignment). Vendored into Whombat `role-consolidation` (`dc8df07e`); **not** vendored into whombat-app (the app
stream does that). Source of truth: `packages/core/src/domain/roles.ts`, `domain/principal.ts`, `keys/grants.ts`,
`packs/{roles,manifest}.ts`, `contracts/{agents,burrows,packs,runner}.ts`, `packages/protocol/src/session/*`,
`packages/fixtures/src/{principals,onboarding,fetch}.ts`. Spec: `docs/decisions/archive/role-consolidation.md` (RO-*), details
settled while building: RO-DC01…RO-DC10.

## Roles (`@whombat/core/domain`, CT-228)
- `AGENT_ROLES` — 19 now: the 18 of 0.36 plus `associate` (appended at the end).
- `CANONICAL_ROLES` / `CanonicalRole` — `assistant`, `associate`, `developer`, `operator`, `lead`.
- `HIREABLE_ROLES` / `HireableRole` / `isHireableRole` — **changed**: `associate`, `developer`, `operator`, `lead`.
- `LEGACY_ROLES` / `LegacyRole` / `isLegacyRole(role)` — the 14 retired roles (RO-02 says thirteen, lists fourteen).
- `LEGACY_HIREABLE_ROLES` / `LegacyHireableRole` — the 17 of 0.36 in their old order: the picker on runtimes without
  `agents.focus` (RO-22).
- `TEAM_ROLES` / `TeamRole` — every role but `assistant`: what `HireBody.role` and onboarding accept (legacy roles from
  older clients are served; store `canonicalRole` + `legacyFocus`).
- `canonicalRole(role)` → `CanonicalRole`; `legacyFocus(role)` → `AgentFocus | null` (RO-20 mapping).
- `ROLE_LABELS`, `ROLE_NOUNS`, `ROLE_JOBS`, `ROLE_DUTIES`, `ROLE_DEFAULT_NAMES`, `ROLE_DM_SUGGESTIONS` — **changed**:
  written for the five roles (RO-03…RO-06, verbatim); each legacy entry is its canonical role's.
- `ROLE_GUIDANCE` — **changed**: Associate, Developer, Operator per RO-09, Lead unchanged, no assistant entry; legacy
  entries = canonical role's (Tester/Security/Product guidance moved into `FOCUS_GUIDANCE`).
- `roleGuidance(role)` — `ROLE_GUIDANCE[role] ?? []`.
- `roleNounForLabel(label)` — still knows the legacy labels (“Product” → “a product agent”).
- `CAPABILITY_ROLES` — deprecated, now `readonly AgentRole[]`; nothing in core uses it.
- `ONBOARDING_ROLES` — new: `associate`, `developer`, `operator` (RO-24). `ONBOARDING_DEFAULT_ROLES` — **changed**:
  `['associate']`.
- `isTeamAgent(agent)` — not retired, not system, no `ownerId`, not `assistant`. `LEAD_TEAM_MIN` = 3.
- `hireableRolesFor({teamAgents, hasLead})` → `HireableRole[]`: Lead only with ≥ 3 team agents or an existing Lead
  (RO-08).

## Focus (`@whombat/core/domain`, CT-228)
- `AGENT_FOCUSES` / `AgentFocus` — `research`, `writing`, `analysis`, `finance`, `legal`, `sales`, `marketing`, `design`,
  `support`, `product`, `testing`, `security`, `review`, `planning`, `servers`, `homelab`, `game_servers`.
- `FOCUS_LABELS` — `Servers & deploys` for `servers`, otherwise the capitalised word (“Game servers”).
- `ROLE_FOCUSES: Record<CanonicalRole, AgentFocus[]>`; `focusesFor(role)` (legacy role → its canonical role's);
  `isFocusFor(role, focus)`.
- `agentFocusOf(agent)` — the stored focus when it belongs to the role, else a legacy role's own, else null. Use it
  everywhere instead of reading `agent.focus` directly.
- `agentLook(agent)` — `agent.look ?? agent.role` (the avatar to draw, RO-07).
- `roleWithFocusLabel(role, focus)` — “Associate · Legal focus”, or the role label alone.
- `agentRoleFocusLabel(agent)` — `roleWithFocusLabel(agent.role, agentFocusOf(agent))`; a stored `legal` from an old box
  reads “Associate · Legal focus”.
- `FOCUS_GUIDANCE: Record<AgentFocus, string>` — one sentence each (Legal, Homelab, Game servers verbatim from RO-12).
- `focusPromptLines(focus)` → `['Your focus: Legal.', FOCUS_GUIDANCE.legal]` or `[]` — render after the job line (RO-12),
  next to `roleGuidance(role)`.

## Agents and bodies (CT-228)
- `Agent.focus?: AgentFocus | null` and `Agent.look?: AgentRole | null` — optional, no default; old payloads parse.
- `HireBody.role` — **changed** to `TeamRole`. `HireBody.focus?: AgentFocus | null` (refined: must be in
  `focusesFor(role)`, else a validation error on `focus`). `HireBody.job?: string` (trimmed, ≤ 280; blank/absent → the
  server stores the role's `ROLE_JOBS`, or keeps `''` and lets `agentJobText` fall back — server's call).
- `AGENT_JOB_MAX` = 280.
- `agents.update` body `focus?: AgentFocus | null` (null clears). Not refined (the role isn't in the body): the server
  checks `isFocusFor(agent.role, focus)`.
- `CompleteOnboardingBody.roles`, `.packs[].role`, `onboarding.update` `selectedRoles` — **changed** to `TeamRole`.
- `AgentPersona.focus?` (DispatchContext.agent) and `Teammate.focus?` — nullable optional.

## Keys (`@whombat/core/keys`, CT-229)
- `ROLE_DEFAULT_KEYS` — **changed**: Associate and Operator per RO-15, Developer/Lead/Assistant unchanged; legacy
  entries are the canonical role's object.
- `FOCUS_DEFAULT_KEYS` — `{support: {can: customers.read, helpwidget.reply, tickets.tag; ask: refunds.issue}}`.
- `focusDefaultKeys(role, focus?)` → `KeySet` (role + focus; `focus` undefined = a legacy role's own, null = none).
- `roleDefaultGrants(agentId, role, focus?)` — onboarding; focus param added.
- `hireKeyOptions(role: AgentRole, focus?)` — rows follow `focusDefaultKeys` for every role but the Developer (mock
  rows); legacy roles = canonical role + own focus.
- `hireGrants(agentId, selected, channelIds, role?, tiers = {}, focus?)` — focus param added (6th); now also grants the
  defaults' `ask` keys that no row shows (Associate `messages.external`, Support `refunds.issue`, Developer
  `branch.shared.push`). Pass the stored focus.
- `SEED_ROLE_KEYS` — gains `associate`; seed/test worlds should call `seedRoleGrants(id, agent.look ?? agent.role)` so
  the migrated crew keeps the mock's AG0 keys.

## Packs (`@whombat/core/packs`, CT-230)
- `PackManifest.focuses: AgentFocus[]` (default `[]`, distinct). `PACK_ROLES_MAX` = 19, `PACK_FOCUSES_MAX` = 17.
- `PackVersionSummary.focuses`, `BundledPack.focuses` — default `[]`, required in the output type (builders must set it).
- `rolePacks(role, catalog, focus?)` — role packs without focuses + focus packs; catalog entries may carry `focuses`.
- `rolePackSuggestionText` — unchanged signature; reads the canonical noun (“Pippa is an associate. …”).

## Protocol (CT-231)
- `SESSION_API_LEVEL` = 27 (window 25…28). Feature `agents.focus` (`SINCE_0_37`): the runtime must announce it once it
  serves focus/job/`associate`; clients gate the new picker and the focus select on it.

## Fixtures (CT-231)
- Crew migrated (RO-23): `sketch` developer/planning/look architect, `pippa` associate/research/look researcher, `hazel`
  developer/review/look reviewer, `clover` associate/support/look support; jobs verbatim; `GRANTS` unchanged (seeded by
  look).
- `AGENT_TEMPLATES` = `ONBOARDING_ROLES` with `ROLE_DEFAULT_NAMES`/`ROLE_JOBS`; `onboarding.selectedRoles` =
  `['associate']`.
- Fixture `agents.hire` canonicalises the role, stores `focus` (or the legacy role's) and `job`, passes focus to
  `hireGrants`.

## Breaks downstream (Whombat `role-consolidation` after vendoring; `pnpm -r --no-bail typecheck`)
Only `apps/server` fails (`apps/cli` and `scripts/package` fail through it); `apps/runner`, `apps/computerd`,
`packages/agent-runtime`, `packages/computer` pass.
- `apps/server/src/packs/read.ts:293` — `PackVersionSummary` needs `focuses` (read the manifest's `focuses`).
- `apps/server/src/packs/routes.ts:237` — `BundledPack` needs `focuses`.
- `apps/server/src/routes/burrows.ts:124` — `onboarding.update` body's `selectedRoles` is `TeamRole[]`; the command's
  input type is `HireableRole[]` (canonicalise, or widen the command).
- `apps/server/src/routes/burrows.ts:148` — `CompleteOnboardingBody.roles` is `TeamRole[]` (same).
- `apps/server/src/commands/roles.int.test.ts:93,96,123,124,140,147,182,238` — tests hire legacy roles through
  `HireableRole` (`tester`, `security`, `analyst`, `writer`, `HIREABLE_ROLES` loops).
- `apps/server/src/domain/personal-agents.int.test.ts:438` — `'architect'` as a `HireableRole`.
Not type errors but behaviour the server stream must follow: `HIREABLE_ROLES` is four roles (work-views' onboarding
list should use `ONBOARDING_ROLES`), `hireGrants` grants asks, `roleDefaultGrants` and every role table changed for
legacy roles, the runtime should announce `agents.focus` (`managed/runtime-features.ts`), the persona builder should add
`focusPromptLines(agentFocusOf(agent))` after the job line and use `roleGuidance`, and the Whombat seed should pass
`look` to `seedRoleGrants`.
