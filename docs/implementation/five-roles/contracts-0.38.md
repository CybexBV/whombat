# Contracts 0.38.0 — roles without a focus (RO-40…RO-47)

Released 2026-10-02: whombat-contracts main `7911f5b` (merge of `role-skills`), tag `contracts-v0.38.0`, pushed;
decisions CT-234…CT-236 in `~/Code/whombat-contracts/docs/decisions/contracts.md`, details RO-DC21…RO-DC29 in
`docs/decisions/archive/role-consolidation.md`. Vendored into Whombat `role-skills` (`ab87c8dd`); **not** vendored into
whombat-app. Every 0.37 payload still parses; nothing was removed.

## Roles and copy (`@whombat/core/domain`)
- `ROLE_LABELS.developer` — **changed**: “Software Developer” (legacy developer roles too); role id stays `developer`.
- `ROLE_NOUNS.developer` / `roleNoun('developer')` — **changed**: “a software developer”.
- `roleNounForLabel` — also knows the old label: “Developer” → “a developer”; “Software Developer” → “a software developer”.
- `ROLE_DEFAULT_NAMES` — **changed**: assistant Hazel (was Tulip), lead Ace (was Compass); Pippa, Banjo, Dusty as before.
- `ROLE_CAPABILITIES: Record<AgentRole, readonly string[]>` — new, RO-42 verbatim; legacy roles mirror their canonical role.
- `roleCoverLine(role)` — new: “You cover: servers & deploys, homelabs, game servers, backups and monitoring.”
- `rolePromptLines(role)` — new: `[roleCoverLine(role), ...roleGuidance(role).map(l => '- ' + l)]`; the lines right after
  “Your job: …” in both prompt builders (replaces the focus line + guidance).
- `roleWithFocusLabel(role, focus?)` — **deprecated, changed**: returns `ROLE_LABELS[role]` (focus ignored, now optional).
- `agentRoleFocusLabel(agent)` — **deprecated, changed**: returns `ROLE_LABELS[agent.role]`.
- `focusPromptLines(focus?)` — **deprecated, changed**: returns `[]`.
- `FOCUS_GUIDANCE` — deprecated (unchanged content).
- `AGENT_FOCUSES`, `FOCUS_LABELS`, `ROLE_FOCUSES`, `focusesFor`, `isFocusFor`, `agentFocusOf`, `legacyFocus` — unchanged
  (stored data, older clients, manifest `focuses` as a grouping).
- `PERSONAL_AGENT_DEFAULT_NAME` — new: `'Hazel'` (= `ROLE_DEFAULT_NAMES.assistant`).
- `pickPersonalAgentName(taken, {prefer, seed})` — **changed**: `prefer` → Hazel if free → seeded pool → suffixes.
- `HIRE_NAMES`, `PERSONAL_AGENT_NAMES` — unchanged (checked: none of the five default names in either).

## Agents and bodies (`@whombat/core/contracts`, `domain/principal`)
- `Agent.focus` — deprecated (still parsed).
- `HireBody.focus` — deprecated (still parsed and refined against the role).
- `agents.update` body `focus` — deprecated (still parsed); summary now “Configure: name, job, model (provider/model).”
- `AgentPersona.focus` (`DispatchContext.agent`), `Teammate.focus` — deprecated.
- `HIRE_PACKS_MAX` — **changed**: 8 → 16 (`HireBody.packs`, `CompleteOnboardingBody.packs[].packs`).
- `LEGACY_HIRE_PACKS_MAX` — new: 8, the cap to respect on runtimes without `agents.role_skills`.

## Keys (`@whombat/core/keys`)
- `ROLE_DEFAULT_KEYS.associate` (and every legacy Associate role) — **changed**: adds can `customers.read`,
  `helpwidget.reply`, `tickets.tag`; ask `refunds.issue`.
- `SEED_ROLE_KEYS.associate` — **changed** the same way (it is the Associate's defaults).
- `focusDefaultKeys(role, focus?)` — **deprecated, changed**: returns `ROLE_DEFAULT_KEYS[role]`.
- `FOCUS_DEFAULT_KEYS` — deprecated (unchanged content, unused).
- `roleDefaultGrants(id, role, focus?)` — **changed**: focus ignored.
- `hireKeyOptions(role, focus?)` — **changed**: focus ignored; an Associate's rows gain the three Support keys as extra
  rows, on.
- `hireGrants(id, selected, channelIds, role?, tiers?, focus?)` — **changed**: focus ignored; an Associate gets
  `refunds.issue` at ask.
- `describeHire` — unchanged code; with the new label reads “Hired Nugget, a software developer, with 3 keys”.

## Packs (`@whombat/core/packs`)
- `rolePacks(role, catalog, focus?)` — **changed**: every pack whose `roles` hold the role or its canonical role, with or
  without `focuses`, catalog order; focus ignored; a focuses-only pack (no `roles`) matches nothing.
- `rolePackSuggestionText` — unchanged code; “Banjo is a software developer. Attach …?”.

## Protocol (`@whombat/protocol`)
- `SESSION_API_LEVEL` — **changed**: 27 → 28 (window 26…29; level-25 runtimes are now `runtime_too_old`). Go
  `SessionAPILevel` 28.
- Feature `agents.role_skills` — new (`SINCE_0_38`).

## Fixtures (`@whombat/fixtures`)
- Crew unchanged (names, roles, stored focus, look, grants). `AGENT_TEMPLATES` follow `ROLE_DEFAULT_NAMES` (unchanged
  for the three onboarding roles). Fixture hire grants by role only (still stores a sent focus).

## Breaks downstream (Whombat `role-skills` after vendoring)
`pnpm typecheck` passes everywhere — the focus parameters were kept. The breaks are behaviour and test expectations the
server stream must follow:
- `packages/agent-runtime/src/persona/roles.ts` — `roleGuidanceLines` still calls `focusPromptLines` (now `[]`), so the
  prompt has no focus line but also no cover line yet: make it `rolePromptLines(context.agent.role)`.
  `persona/capabilities.test.ts` (focus lines, assistant `[]`) and `apps/runner/src/prompt-capabilities.test.ts:99-101`
  (“Your focus: Legal.”, `FOCUS_GUIDANCE.legal`) expect the 0.37 lines.
- `packages/agent-runtime/src/persona/handoffs.ts:60`, `apps/server/src/runtime/context.ts:746` — teammate and burrow-fact
  labels now lose the focus (“developer · review focus” → “software developer”); drop `roleWithFocusLabel`/`agentFocusOf`
  there and update tests that expect the focus.
- `apps/server/src/commands/agents.ts:695` — the `agents.update` focus event “Changed X to Associate · Research focus” now
  reads “Changed X to Associate”; RO-40 says Configure sends no focus — stop writing that event (store a sent focus
  silently) or keep it; decide. `:377` passes focus to `hireGrants` (ignored).
- `apps/server/src/commands/burrows.ts:513` `roleDefaultGrants(…, focus)` — ignored now; every onboarded Associate gets the
  Support keys.
- `apps/server/src/packs/routes.ts:271`, `guides/place.ts:189`, `skills/skills.int.test.ts:385` — `rolePacks` ignores the
  focus: the suggestion offers every pack of the role.
- `apps/server/src/packs/shipped.test.ts` (`packsFor`, role × focus combinations, RO-DP02 Planning comment) — the rule is
  now per role; skill names are already unique per role (checked).
- `apps/server/src/managed/runtime-features.ts:88` — announce `agents.role_skills`.
- `apps/server/src/domain/personal-agents.ts` — gets Hazel automatically; `personal-agents.int.test.ts`,
  `packs/shipped-names.int.test.ts` and other tests that expect a first personal agent named Tulip (≈20 `'Tulip'` hits)
  get Hazel unless a Hazel exists (`seed/test-world.ts` has a Hazel, so tests on that world keep Tulip).
- “a developer” / “Developer” expectations: `apps/server/src/commands/roles.int.test.ts:283`, `commit/keys.int.test.ts:202`,
  `auth/auth.int.test.ts:319` (“Hired …, a developer, …”), `runtime/runner.int.test.ts:125` (`roleLabel: 'Developer'`),
  `apps/runner/src/test-context.ts:32` and `packages/agent-runtime/src/testing/contexts.ts:84,497,538` (fixture labels).
- `apps/server/src/commands/roles.int.test.ts` — focus key tests (Support focus brings help-widget keys, `hireKeyOptions(role,
  focus)`, `hireGrants(…, 'testing')`), names table (`lead: 'Compass'` at :118).
- Session level: no Whombat test pins 27 (they compare with `SESSION_API_LEVEL`).
- whombat-app (not vendored): labels lose the focus automatically; must gate the RO-46 picker on `agents.role_skills`,
  send no `focus`, cap packs at `LEGACY_HIRE_PACKS_MAX` on older runtimes, and update “Developer”/Tulip/Compass
  expectations.
