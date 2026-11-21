# Contracts 0.44.0 for the resourceful-agents streams

Released as `contracts-v0.44.0` (whombat-contracts `main` c5354ac, pushed; artifacts in
`~/Code/whombat-contracts/dist-release/0.44.0`). Vendored on `resourceful-agents` in Whombat
(`vendor/whombat-contracts/0.44.0`, commit f991b205) and whombat-app (commit 30deb62). Decisions: CT-246…CT-258 in the
contracts repository's `docs/decisions/contracts.md`, summarised as RA-DC01…RA-DC22 in
`docs/decisions/resourceful-agents.md`. `SESSION_API_LEVEL` 30 (window 28…31), Go `SessionAPILevel` 30.

Imports: `@whombat/core` (everything), or the subpaths `@whombat/core/keys`, `/domain`, `/contracts`, `/approvals`,
`/computer`, `/text`, `/vault`, `/ids`; features from `@whombat/protocol/session`.

## Keys (RA-01…RA-05) — `@whombat/core/keys`

- `KEY_TIER_ROWS` — now six rows, in display order: `deploy`, `merge`, `branch.main.push`, `commands.destructive`,
  `messages.external`, `refunds.issue` (was Merge, Deploy, Push to main). A row is named by its first key.
- `KeyTierRow` — the union of those six.
- `KEY_TIER_ROW_KEYS` — the keys each row sets: Deploy `deploy`, `deploy.staging`, `deploy.production`; Merge `merge`,
  `merge.main`; Money `refunds.issue`, `billing.write`; the other three one key each.
- `KEY_TIER_ROW_READS` — the keys each row reads for its tier (the strictest wins).
- `RISK_ROW_KEYS` — all ten keys of the six rows.
- `KeyRiskRow` / `KEY_RISK_ROWS` — each row's `label`, `description`, `keys` and `verb` (“Merge into main” / “merge
  into main”, “Money” / “handle money”, …).
- `keyRiskRow(row)` — a row's `KEY_RISK_ROWS` entry.
- `keyTierRowLabel(row)` — what people read for a row (“Money”, never the key's catalog label).
- `keyTierRowOf(key)` — now also finds `commands.destructive`, `messages.external`, `refunds.issue`, `billing.write`.
- `KeyRowTiers` — grows by `commands.destructive`, `messages.external`, `refunds.issue` (all optional); `HireBody.keyTiers`
  uses it.
- `KeyTiers` — `Partial<Record<KeyId, Tier>>`: tiers by key for Configure's three-state controls (`KeyRowTiers` fits).
- `keyHeldTier(grants, key)` — the tier a key is held at (exported; was private).
- `withKeyRowTier(grants, row, tier)` — now writes every key of the row that no other key of the row covers (Money:
  both keys always).
- `ALWAYS_ON_KEYS` — the 25 keys every team agent holds at On: `channels.read`, `canvas.write`, `tasks.create`,
  `channels.create`, `branch.feature.readwrite`, `tests.run`, `pr.open`, `branch.shared.push`, `workspace.scratch`,
  `messages.search`, `repos.read`, `web.browse`, `browser.use`, `pr.comment`, `pr.request_changes`, `ci.run`,
  `jobs.scheduled.run`, `pipelines.retry`, `customers.read`, `helpwidget.reply`, `tickets.tag`, `memory.propose`,
  `skills.propose`, `packs.tool.read`, `code.write`.
- `ALWAYS_ON_EXCEPTIONS` — `pr.approve` (a person's thing) and `packs.tool.write` (asks).
- `isAlwaysOnKey(key)` — whether a key (any wording) is always on.
- `ASSISTANT_ALWAYS_ON_KEYS` — the Assistant's: `PERSONAL_AGENT_EXTRA_KEYS`.
- `PERSONAL_AGENT_EXTRA_KEYS` (`keys/catalog`) — what a personal agent may hold besides its owner's keys: search, memory,
  skills, scratch, and new `web.browse`, `browser.use`, `tasks.create`.
- `personalAgentMayHold(key)` — now true for those three as well.
- `PERSONAL_DEFAULT_GRANTS` / `personalDefaultGrants` — a new assistant holds all of `PERSONAL_AGENT_EXTRA_KEYS` at On.
- `ROLE_DEFAULT_KEYS` — every team role: can `ALWAYS_ON_KEYS`, ask `RISK_ROW_KEYS` + `packs.tool.write`, cannot none.
  `roleDefaultGrants`, `grantsFromKeySet` follow. `SEED_ROLE_KEYS` / `seedRoleGrants` (mock world) unchanged.
- `HIRE_KEY_OPTIONS` / `hireKeyOptions(role)` — the six rows, three-state, at Ask, never locked.
- `hireGrants(agentId, keys, channels, role, keyTiers)` — always-on keys at On (Read channels scoped), each row at its
  tier, `packs.tool.write` at Ask (On when listed), other listed keys at On; never switches an always-on key off.
- `ALL_KEY_OPTIONS` — Configure's collapsed All keys: `ALWAYS_ON_KEYS` (switches, on), `pr.approve` (switch, off),
  `packs.tool.write` (three-state at Ask).
- `HireKeyOption.defaultTier` — now also on a single key shown in three states (`packs.tool.write`).
- `isThreeStateOption(option)` (`keys/configure`) — an option with `defaultTier`.
- `configureKeyState`, `configureKeyTiers`, `configureGrants` — handle single-key three-state options;
  `ConfigureEdit.tiers` / `baseTiers` are `KeyTiers`.
- `PERSONAL_KEY_OPTIONS` — the Assistant's Configure: `PERSONAL_AGENT_EXTRA_KEYS`, then its personal keys.
- `requestedTier(key)` — Ask for every key of the six rows.
- `alwaysOnUpgrade(grants, personSwitchedOff, {personal?})` → `{grants, added, raised}` — migration 0066's pure upgrade:
  `cannot` → `can` and missing always-on keys added, except what a person switched off after the hire; Ask stays Ask,
  rows keep their tier; idempotent.
- `AlwaysOnUpgrade` — its result type.
- `alwaysOnUpgradeText(agent)` — “Whombat gave Banjo the keys every agent has now” (the `keys.upgraded` event).
- `ROLE_GUIDANCE` (`domain/roles`) — Associate and Lead lines without fences (RA-05).
- `ROLE_LOCKED_NOTE` — deprecated; no row is locked by role.
- `HireBody.keys` / `.keyTiers` (`contracts/agents`) — docs: send `ALWAYS_ON_KEYS` in `keys` (older runtimes) and the six
  rows in `keyTiers`.

## Approvals: “Always allow” (RA-06)

- `ALWAYS_ALLOW_ACTION_TYPES` (`keys/actions`) — `deploy`, `merge_pr`, `push_shared_branch`, `message_external`,
  `refund`.
- `alwaysAllowRow(action)` — the risk row a card may offer “Always allow” for (a push only to the default branch), else
  null.
- `alwaysAllowLabel(agent, row)` (`keys/grants`) — “Always allow Banjo to merge into main”.
- `DecideApprovalBody.scope` — `agent` is now valid for an `alwaysAllowRow` action: approve and set the row to On
  (`agents.manage` only); `once` as before.
- `Approval.scope` — docs: a risk-row action's `once` or `agent`.
- `ApprovalViewContext.canChangeAgentKeys` — `false` leaves “Always allow” off the card.
- `ApprovalView.scopeChoices` — for a risk-row card: `once` labelled with the card's CTA (“Approve and deploy” /
  “Approve in advance”), then `agent` with `alwaysAllowLabel`.
- `ApprovalView.toasts.always` — “Approved. From now on Banjo may merge into main without asking.”; executing/executed
  messages end with the same sentence once `scope` is `agent`.

## Memory: profiles and notes (RA-20…RA-23, RA-26)

- `PROFILE_ENTRY_MAX` 300, `PROFILE_BUDGET` 2 000, `NOTE_ENTRY_MAX` 500, `NOTES_BUDGET` 4 000, `MEMORY_OPERATIONS_MAX` 10.
- `ProfileEntryKind` / `PROFILE_ENTRY_KINDS` — `stated` | `inferred`.
- `MemoryTarget` / `MEMORY_TARGETS` — `profile` | `notes`; `MEMORY_LIMITS[target]` — its `entryMax` and `budget`.
- `ProfileEntry` — `{id pfe_, text, kind, writtenBy, createdAt, updatedAt}`.
- `NoteEntry` — `{id nte_, text, writtenBy, createdAt, updatedAt}`.
- `normalizeMemoryText(text)` — one line, single spaces, trimmed.
- `MemoryOperation` — `{action: 'add', text, kind?}` | `{action: 'replace', match, text, kind?}` | `{action: 'remove',
  match}`.
- `MemoryStoreEntry`, `ApplyMemoryOptions`, `MemoryOpsResult`, `MEMORY_OP_ERRORS` / `MemoryOpError` — the store, options
  and result of the pure apply (`memory_full`, `no_match`, `ambiguous_match`, `too_long`, `scan_refused`).
- `applyMemoryOps(entries, ops, {budget, entryMax, writtenBy, now, newId, defaultKind?})` — atomic, budget checked on
  the result, `memory_full` returns the store unchanged.
- `memoryUsedChars(entries)` — characters a store uses.
- `scanMemoryText(text)` — why a text is refused (secret-like value, injection, hidden characters), or null.
- `DispatchProfileContext` / `DispatchContext.profile` — `{person {id, name}, entries} | null` (null: not for a person, or
  learning off).
- `DispatchNotesContext` / `DispatchContext.notes` — `{entries} | null`.
- `MemoryToolInput` — `{target, operations (1–10)}`; `MemoryToolEntry` `{text, kind | null}`.
- `MemoryToolOutput` — `ok {target, entries, usedChars, budgetChars}` | `memory_full` (same + message) | `no_match` /
  `ambiguous_match` / `too_long` / `scan_refused` `{message, operation}` | `unavailable {message}`.
- `MCP_TOOLS.memory` — the `memory` tool (no key, writes); its description carries RA-22/RA-23.
- `UNLISTED_MCP_TOOL_NAMES` (`['propose_instruction']`), `UNLISTED_MEMORY_TOOL_NAMES` — defined, but not listed by
  servers from 0.44.
- REST `memory.profile` GET `/burrows/:burrow/profile` → `PersonProfileResponse {learning, entries, usedChars,
  budgetChars, eventId}` (the caller's own only).
- REST `memory.addProfileEntry` POST `…/profile/entries` (`AddProfileEntryBody {text, kind = stated}`, 201),
  `memory.updateProfileEntry` PATCH `…/profile/entries/:entryId` (`UpdateProfileEntryBody {text?, kind?}`),
  `memory.removeProfileEntry` DELETE, `memory.setLearning` PUT `…/profile/learning` (`SetLearningBody {learning}`).
- REST `memory.notes` GET `/burrows/:burrow/agents/:agent/notes` → `AgentNotesResponse {entries, usedChars, budgetChars,
  canEdit, eventId}`; `memory.updateNote` PATCH `…/notes/:noteId` (`UpdateNoteBody {text}`), `memory.removeNote` DELETE.
  Refusals: `validation_failed` with `details.reason`.
- `PROFILE_COPY`, `NOTES_COPY` / `notesCopy(agent)`, `memoryUsageText(used, budget)` (“1,240 of 2,000 characters”),
  `profileEntryKindLabel(kind)` (“You said” / “Inferred”).
- `MCP_TOOLS.search` input `mine?: boolean` — only the agent's own earlier messages and runs; its description says words
  match as written and by English stems.

## Schedules (RA-30)

- `SCHEDULE_PROMPT_MAX` 2 000, `SCHEDULES_ACTIVE_MAX` 20, `SCHEDULE_REPEAT_DAYS` 90, `SCHEDULE_EVERY_MIN_MINUTES` 5,
  `SCHEDULE_EVERY_MAX_MINUTES` 525 600, `SCHEDULE_AT_MAX_DAYS` 366.
- `ScheduleWhen` — `{kind: 'at', at}` | `{kind: 'every', minutes}` | `{kind: 'cron', expr, zone}`.
- `ScheduleStatus` / `SCHEDULE_STATUSES` — `active` | `paused` | `ended`.
- `ScheduleEndReason` / `SCHEDULE_END_REASONS` — `done`, `cancelled`, `expired`, `person_left`, `agent_retired`.
- `AgentSchedule` — `{id sch_, agentId, conversationId, threadRootId, forAccountId, prompt, when, status, endedReason,
  nextAt, endsAt, runs, lastRunAt, createdAt}`.
- `AgentScheduleView` — plus `forName`, `canChange`; `prompt` null for a viewer who can't read the room.
- `nextScheduleRun(when, after, {anchor?})` — the next run after `after` (cron in its zone, automations' DST rules).
- `scheduleEndsAt(when, from)` — +90 days for a repeating one, null for a one-off.
- `scheduleWhenProblem(when, now)` — why a `when` is refused, or null.
- `scheduleLimitProblem(activeCount)` — the 20-active limit's message, or null.
- `describeScheduleWhen(when, zone, now?)` — “Once, Sun 4 Oct at 09:00”, “Every 30 minutes”, “Weekdays at 08:30 ·
  Europe/Amsterdam”.
- `schedulePromptLine(prompt, max)` — the prompt on one line, cut.
- `ScheduleCard` / `StoredScheduleCard` — the room card (`MessageCard`/`StoredCard` kind `schedule`, `CARD_KINDS`),
  server-made, never postable; `schedule` null = not visible to this viewer.
- `scheduleCardTitle(agent, schedule)` (“Dusty scheduled: …”), `scheduleCardText(card, zone)` (no prompt).
- `SCHEDULE_STATUS_LABELS`, `SCHEDULE_END_LABELS`, `SCHEDULE_COPY` / `scheduleCopy(agent)`, `scheduleActions(schedule)`
  (`{pause, resume, remove}`).
- `SCHEDULE_TOOL_ACTIONS`, `ScheduleToolInput` (`{action: create|list|cancel, when?, prompt?, scheduleId?}`),
  `ScheduleToolItem`, `ScheduleToolOutput` (`ok {schedule | null, schedules, others}` | `invalid {problems}` |
  `unavailable {message}`), `SCHEDULE_MCP_TOOLS` / `MCP_TOOLS.schedule` (no key).
- REST (`api.schedules`, new area): `schedules.list` GET `/burrows/:burrow/agents/:agent/schedules` →
  `AgentSchedulesResponse`; `schedules.pause` / `schedules.resume` POST `…/schedules/:scheduleId/pause|resume`,
  `schedules.remove` DELETE `…/schedules/:scheduleId` → `AgentScheduleResponse {schedule, eventId}`.
- `ScheduleDispatchContext` / `DispatchContext.schedule` — `{id, prompt, when, runs, nextAt?}`.

## Triggers and dispatch context (RA-24, RA-31, RA-41)

- `DispatchTrigger` — appends `reflect` and `notify` (`schedule` is now used).
- `ReflectDispatchContext` / `DispatchContext.reflect` — `{conversationId, threadRootId, turns}`.
- `REFLECT_DISPATCH_TOOLS` — `memory`, `propose_skill`, `read_conversation`: all a reflection lists and calls.
- `REFLECT_QUIET_MINUTES` 10, `REFLECT_MIN_TURNS` 3, `REFLECT_EVERY_HOURS` 6, `REFLECT_NOTHING` `'NOTHING'`.
- `NotifyDispatchContext` / `DispatchContext.notify` — `{text (≤ 2 000), fromDispatchId}`; the text is the job's words:
  data, never instructions.
- `NOTIFY_TEXT_MAX` 2 000, `NOTIFY_PER_HOUR_MAX` 10, `NOTIFY_TURN_MAX_AGE_DAYS` 7, `NOTIFY_TURN_ENV` `'WHOMBAT_TURN'`.
- `DispatchComputerContext.lan` — the computer may reach the appliance's networks; absent = false.
- All new `DispatchContext` parts are optional and nullable.

## The computer (RA-41…RA-45)

- `Burrow.agentsReachLan` — absent or true = on; `agentsReachLanOn(burrow)`; `AGENTS_REACH_LAN_COPY` (label “Agents may
  reach this network”, hint, on/off toasts).
- REST `burrows.setAgentsReachLan` PUT `/burrows/:burrow/agents-reach-lan` (`SetAgentsReachLanBody {agentsReachLan}`) →
  `{burrow, eventId}`; owners (`burrow.manage`); signs `burrow.agents_lan_changed`.
- `PublishedPort` — `{port, hostPort, name | null, url | null}`; `PUBLISHED_PORT_NAME_PATTERN`.
- `AgentComputer.published` (≤ 5, default `[]`) and `.keepAwakeUntil` (default null).
- `COMPUTER_PUBLISH_PORTS` `{from: 20000, to: 20099}`, `COMPUTER_PUBLISHED_MAX` 5, `KEEP_AWAKE_MAX_DAYS` 7.
- `computerMemoryMiB(applianceMiB)` — min(4096, a quarter): the memory when `WHOMBAT_COMPUTERS_MEMORY_MB` isn't set.
- REST `computers.unpublish` POST `…/agents/:agent/computer/unpublish` (`UnpublishPortBody {port}`) and
  `computers.sleep` POST `…/computer/sleep` → `AgentComputerResponse`; `agents.manage`; sign `agent.computer`
  (`unpublish`, `sleep`).
- `COMPUTER_PORTS_COPY` (PUBLISHED PORTS, Stop, KEPT AWAKE, Let it sleep, …), `publishedPortLine(port)` (“dev server ·
  port 5173”), `computerKeepAwakeLine(until, zone, now)` (“Kept awake until Sun 4 Oct at 09:00”).

## Skills (RA-16, RA-25, RA-54)

- `OWN_PACK_SKILLS_MAX` 100 (was 20); `PackManifest.skills` up to 100.
- `SKILL_FILES_MAX` 16, `SKILL_FILES_MAX_BYTES` 256 KB (were 8 and 64 KB).
- `SKILL_FILE_DIRS` (`references`, `templates`, `scripts`) and `skillFileDirProblem(path)`; `SkillFilePath` enforces it
  (files next to `SKILL.md` stay allowed).
- `OWN_PACK_LIMITS` (`packs/validate`) — 2 000 files and 32 MB for an own pack's next version.
- `SkillSource` / `SKILL_SOURCE_MAX` — an https link; `propose_skill` input `source?`; `SkillProposalSummary.source?`.
- `MCP_TOOLS.propose_skill` description — fix a wrong skill (supersedes), the folders, `source`, nothing private.
- REST `skills.previewLink` POST `/burrows/:burrow/agents/:agent/skill-links/preview` (`SkillLinkPreviewBody {url}`) →
  `SkillLinkPreview {previewId slp_, url, name, description, files [SkillLinkFile {path, bytes}], verdict, findings,
  problems, canAdd, expiresAt}`.
- REST `skills.addLink` POST `…/skill-links` (`AddSkillLinkBody {previewId}`, 201) → `AddSkillLinkResponse {proposal,
  eventId}`; signs `skill.learned`.
- `skillLinkRawUrl(url)` — a GitHub page → its raw `SKILL.md`; `skillLinkFiles(body)` — the files a body names (≤ 16).
- `SKILL_LINK_COPY` — `add`, `placeholder`, `hint`, `fetch`, `confirm`, `added`, `refused`.

## Copy without “stop” (RA-12) — `@whombat/core/text`

- `PENDING_APPROVAL_GUIDANCE` — “do what doesn’t depend on it, then end your turn with one line saying what waits; the
  answer wakes you”.
- `BLOCKED_GUIDANCE` — “ask for the key with request_approval (grant_key) in one line and carry on with what you can do
  without it”.
- Reworded with them: the descriptions of `request_approval`, `perform_action`, `merge_pull_request` (no “Never push to
  main or merge with git yourself”), `vault_request`, `ssh_exec`/`ssh_read_file`/`ssh_write_file`/`ssh_upload`,
  `request_vault_key`, `browser_sign_in`; `draft_automation` (“A person publishes it…; for your own reminders use
  schedule”); `commandBlockedText`, `commandTimedOutText`; `VAULT_ACCESS_RULES[0]` (why ssh fails from the sandbox, the
  way that works) and `VAULT_ACCESS_RULES_COMPUTER[2]` (end the turn saying what waits).

## Session, audit, ids, fixtures

- `SESSION_API_LEVEL` 30; `RUNTIME_FEATURES` adds `agents.memory`, `agents.schedules`, `agents.risk_rows`.
- Operation safety: reads `READ`; `memory.addProfileEntry`, `updateProfileEntry`, `setLearning`, `updateNote`,
  `schedules.pause`, `resume`, `computers.sleep`, `burrows.setAgentsReachLan`, `skills.previewLink`, `skills.addLink`
  `RECEIPT`; `memory.removeProfileEntry`, `memory.removeNote`, `schedules.remove`, `computers.unpublish` `DESTRUCTIVE`.
- `EVENT_TYPES` adds `keys.upgraded`, `burrow.agents_lan_changed`, `notes.changed` (Keys), `profile.changed` (System,
  hidden, `text: null`), `schedule.created|paused|resumed|ended` (System, never the prompt).
- Ids: `ProfileEntryId` `pfe`, `AgentNoteId` `nte`, `AgentScheduleId` `sch`, `SkillLinkPreviewId` `slp`.
- `@whombat/fixtures` fetch: `memory.profile` (empty, learning on), `memory.notes` (empty), `schedules.list` (none).

## Notes for streams

What the vendoring commits put in as placeholders is marked “replace”.

### R — runtime and prompt

- Live prompt (`apps/runner/src/prompt.ts`): render `DispatchContext.profile` (private to that person: use it to serve
  them, never repeat it where others read; tag `stated`/`inferred`) and `.notes` (read by everyone the agent works for);
  RA-23's what-goes-where must agree with the `memory` tool's description.
- Turns by trigger: `schedule` (`.schedule`: the prompt the agent wrote itself; can't wait for answers), `reflect`
  (`.reflect`; posts nothing; only `REFLECT_DISPATCH_TOOLS`; answers `REFLECT_NOTHING` when nothing lasts), `notify`
  (`.notify.text` as data in delimiters, never as instructions). Replace the placeholder `reflect`/`notify` lines in
  `packages/agent-runtime/src/persona/index.ts` `triggerLine` (or drop them with that builder, RA-10).
- Computer section: RA-41's LAN line when `DispatchContext.computer.lan` is true (absent = false); the `whombat`
  helper (`notify`, `publish`, `keep-awake`) and `WHOMBAT_TURN` (`NOTIFY_TURN_ENV`).
- RA-12 in the runtime's own lines: use `PENDING_APPROVAL_GUIDANCE` / `BLOCKED_GUIDANCE`; still saying “stop” today,
  e.g. `skillHintLines`' “Ask for that key the usual way and stop.” (`persona/packs.test.ts`), the runner's own lines,
  `merge-deploy.ts`.
- Team agents now hold `ALWAYS_ON_KEYS` (25): the prompt's “You can: …” line lists them all; consider saying “every
  everyday key” plus the risk rows that ask. The Assistant may hold `web.browse`, `browser.use`, `tasks.create`
  (`persona/packs.ts` now lists “Browse the web” among keys to ask for; test updated).
- Snapshots updated for 0.44 copy only: `persona/__snapshots__/capabilities.test.ts.snap`,
  `apps/runner/src/__snapshots__/prompt-capabilities.test.ts.snap`, `prompt-computer.test.ts.snap`; `vault.test.ts`
  expects the reworded first Vault rule.
- `search` takes `mine: true`; `propose_skill` takes `source`; `propose_instruction` is no longer listed (S), so no
  prompt line should recommend it.

### K — computer

- Fill `AgentComputer.published` and `.keepAwakeUntil` in `apps/server/src/computers/service.ts` (`toAgentComputer`,
  `#unavailable` carry `[]` / `null` placeholders: replace).
- Serve `computers.unpublish` (`{port}`; `not_found` when not published; DESTRUCTIVE) and `computers.sleep`;
  `agents.manage`; sign `agent.computer` with `unpublish` / `sleep`.
- Use `COMPUTER_PUBLISH_PORTS`, `COMPUTER_PUBLISHED_MAX`, `PUBLISHED_PORT_NAME_PATTERN`, `KEEP_AWAKE_MAX_DAYS`,
  `computerMemoryMiB(hostMiB)` (RA-45 default), `PublishedPort.url` = `http://<appliance LAN address>:<hostPort>` (null
  while unknown).
- Policy `lan` from `DispatchContext.computer.lan` (S sets it from `agentsReachLanOn(burrow)`).
- Notify: queue a `notify` dispatch with `DispatchContext.notify {text, fromDispatchId}` in the conversation and thread
  of `fromDispatchId`, for the same person; refuse more than `NOTIFY_PER_HOUR_MAX` per hour, a turn older than
  `NOTIFY_TURN_MAX_AGE_DAYS`, or another agent's.

### S — server

- Replace the `memory` and `schedule` stubs in `apps/server/src/mcp/tools.ts` (they answer `unavailable`).
- `memory`: `applyMemoryOps` with `MEMORY_LIMITS[target]`, `defaultKind: 'inferred'` for the profile, `newId('profileEntry'
  | 'agentNote')`; `unavailable` when the turn isn't for a person, their learning is off, or it's a Feedback assessment.
  REST `memory.profile`/`addProfileEntry`/`updateProfileEntry`/`removeProfileEntry`/`setLearning` (caller's own;
  person edits default `stated`) and `memory.notes`/`updateNote`/`removeNote` (`canEdit`), refusals `validation_failed`
  + `details.reason`; events `profile.changed` (hidden, no text) and `notes.changed` (ids and counts).
- `DispatchContext.profile` / `.notes`; stop listing `UNLISTED_MCP_TOOL_NAMES` in `mcpToolList` (`mcp/server.ts`).
- `schedule`: `scheduleWhenProblem`, `scheduleLimitProblem`, `nextScheduleRun`, `scheduleEndsAt`; post a
  `StoredScheduleCard` and resolve it per viewer in `apps/server/src/read/messages.ts` (placeholder resolves
  `schedule: null`: replace); ticker queues `schedule` dispatches with `DispatchContext.schedule`; ends with
  `endedReason`; REST `schedules.*` (`canChange`: the person it is for or `agents.manage`); events `schedule.*`.
- Reflection dispatches (RA-24) by the `REFLECT_*` constants, tools limited to `REFLECT_DISPATCH_TOOLS`.
- Keys: migration 0066 with `alwaysOnUpgrade(grants, personSwitchedOff, {personal})` and one `keys.upgraded` event
  (`alwaysOnUpgradeText`); hires through `hireGrants` (new behaviour); `approvals.decide` accepts `scope: 'agent'`
  exactly for `alwaysAllowRow(action)` actions, for `agents.manage`, approving and `withKeyRowTier(grants, row, 'can')`
  signed as a key change; pass `canChangeAgentKeys` where the server builds approval views.
- `burrows.setAgentsReachLan` + `Burrow.agentsReachLan` (absent = on) + `DispatchComputerContext.lan`.
- Skills: `skills.previewLink` / `skills.addLink` (`skillLinkRawUrl`, `skillLinkFiles`, `scanSkillProposal`, previews
  expire), `propose_skill.source` → `SkillProposalSummary.source`, SL-D40 dropped for own packs, `OWN_PACK_SKILLS_MAX`,
  `SKILL_FILES_MAX(_BYTES)`, `OWN_PACK_LIMITS`.
- `search` `mine: true`; RA-26 search vectors. RA-33: drop `mcp/server.ts`' `personal && (delegate | report_back)` filter
  and the ban in `commands/handoffs.ts`.
- When each lands, move `agents.memory`, `agents.schedules`, `agents.risk_rows` from `NOT_IMPLEMENTED` to
  `IMPLEMENTED_FEATURES` (`apps/server/src/managed/runtime-features.ts`; `agents.risk_rows` also needs K's ports and
  keep-awake). `TRIGGER_WORDS` (`read/work-overview.ts`) has placeholder words for `reflect` / `notify`.

### A — app

whombat-app `resourceful-agents` typechecks; 26 tests in 10 files still expect the 0.43 keys and are yours to move:
`apps/web/src/features/agents/{liveKeys.test.ts (5), keyTiers.test.tsx (2), agents.test.tsx (1),
settings/settings.test.tsx (6)}`, `apps/web/src/features/packs/skills.test.tsx (4)`,
`apps/web/src/features/settings/browser.test.tsx (1)`, `apps/web/src/features/computers/computers.test.tsx (1)`,
`apps/mobile/src/data/{keyTiers.test.ts (4), runCommand.test.ts (1), data.test.ts (1)}`.

- Hire modal: name, job title, “What it does” and `hireKeyOptions(role)` (six three-state rows at Ask) only; send
  `HireBody.keys` = `ALWAYS_ON_KEYS` (plus extras) and `keyTiers` for the six rows.
- Configure → Access: the six rows (`KEY_RISK_ROWS`: label, description; `keyTierRowLabel`), then collapsed **All keys**
  (`ALL_KEY_OPTIONS`; `isThreeStateOption`, `configureKeyTiers`, `configureGrants` with `KeyTiers`). The app's own
  “Destructive commands on other machines” row (AP-622, `features/agents/commandKeys.ts`) now duplicates the contract
  row: `computers.test.tsx` finds two radiogroups.
- “Always allow” on risk-row cards (web and Android): the cards already render `scopeChoices`, which deploy/merge/push/
  outside-message/refund cards now carry; pass `canChangeAgentKeys`, send `scope: 'agent'`, show `toasts.always`.
- Gate by feature: `agents.risk_rows` (rows, Always allow, LAN switch, ports, keep-awake), `agents.memory` (profile page,
  Notes, Add from a link), `agents.schedules` (Schedules tab, card Cancel). The `FEATURE_NAMES` added in
  `packages/client/src/managed/updates.ts` are placeholders: reword with the UI.
- Profile page (`PROFILE_COPY`, `memory.*`), Notes tab (`NOTES_COPY`), Schedules tab and room card (`SCHEDULE_COPY`,
  `scheduleActions`, `ScheduleCard`), Computer panel (`COMPUTER_PORTS_COPY`, `publishedPortLine`,
  `computerKeepAwakeLine`, `computers.unpublish`/`sleep`), burrow setting (`AGENTS_REACH_LAN_COPY`,
  `burrows.setAgentsReachLan`), Skills tab Add from a link (`SKILL_LINK_COPY`, `skills.previewLink`/`addLink`), the
  Assistant's Configure (`PERSONAL_KEY_OPTIONS`), audit labels for the new event types.
- Compile fixes already in: `AgentComputer` literals carry `published: []`, `keepAwakeUntil: null` (web and mobile
  fixtures, tests); the recovery vectors read 0.44.0.
