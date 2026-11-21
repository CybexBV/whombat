# One agent: what changes in the contracts (0.123.0)

For the streams that code against `oa-c` (Whombat SA/SB, whombat-app W/M, appliance P). Names only; the decisions are
CT-1100…CT-1144 in `docs/contracts/decisions/contracts.md`. Nothing is kept for compatibility. `SESSION_API_LEVEL` 45 → 46.

## The agent (`@whombat/core/domain`, new `domain/agent.ts`; `roles.ts`, `personal.ts`, `characters.ts` deleted)

- New: `AgentFace` / `AGENT_FACES` (`dusty`, `banjo`, `neo`, `skipper`, `hazel`: the five drawings, keyed by their
  name), `DEFAULT_AGENT_FACE` (`dusty`), `DEFAULT_AGENT_NAME` (`Dusty`), `AGENT_NAME_MAX` (24), `AGENT_NAME_PATTERN`,
  `AgentName` (Zod), `agentName(typed)`, `agentCharacter(face)`, `AgentCharacter {face, name, accent, accentDeep}`.
- Kept, same names: `AGENT_CHARACTERS` (now keyed by face), `RESERVED_AGENT_NAMES`, `isReservedAgentName`,
  `AGENT_NAME_RESERVED_TEXT`, `AGENT_NAME_FORM_TEXT`, `AgentStatus`, `AGENT_STATUS_COPY`, `AgentProvider`,
  `AgentCheckout`, `AgentAccess`, `TurnSandbox`, `TurnCommands`, `TurnAccess`, `turnAccessLabel`, `AgentModelRuntime`,
  `AgentRuntime`, `DEFAULT_AGENT_RUNTIME`, `OrgCredentialId`, `OrgCredentialSource`, `CredentialSource`,
  `diffAgentRuntime`, `describeRuntimeChange`, `describeDefaultWorkdirChange`, `PersonRole` (now in `principal.ts`).
- `CredentialSource` = `requester` (`fallback`: an `org` or `member` source, or null) | `org` | `member`
  (`MemberCredentialSource {kind: 'member', accountId}`: a member's own sign-in shared for every turn, SUB-57).
  `account` and `shared` are gone. New `DEFAULT_CREDENTIAL_SOURCE` (`requester`, no fallback).
- Removed: every role thing (`AgentRole`, `AGENT_ROLES`, `CanonicalRole`, `HIREABLE_ROLES`, `TEAM_ROLES`, `TeamRole`,
  `LEGACY_*`, `AgentFocus`, `FOCUS_*`, `ROLE_*`, `roleNoun*`, `rolePromptLines`, `roleGuidance`, `roleCoverLine`,
  `canonicalRole`, `isTeamAgent`, `LEAD_TEAM_MIN`, `hireableRolesFor`, `HIRE_NAMES`, `HIRE_DEFAULTS`, `suggestHireName`,
  `HIRE_DEFAULT_CHANNEL_SLUGS`, `ONBOARDING_ROLES`, `ONBOARDING_DEFAULT_ROLES`, `CAPABILITY_ROLES`), every name pool and
  personal-agent helper (`PERSONAL_AGENT_NAMES`, `PERSONAL_AGENT_DEFAULT_NAME`, `PERSONAL_AGENT_NAME_PATTERN`,
  `ASSISTANT_NAMES`, `pickPersonalAgentName`, `pickAssistantName`, `personalAgentHandle`, `assistantOf`,
  `isPersonalAgent`, `agentWorksFor`, `personalAgentOf`, `mentionTargetsFor`, `personalAgentDoing`,
  `personalAgentJoinedText`, `onlyWorksForText`, `onlyOwnerChangesText`, `meetAssistantText`, `agentNameTaken`,
  `agentNameTakenText`, `worksOnlyForText`), and characters' crew helpers (`agentFace`, `assistantLookFor`,
  `ASSISTANT_FACES`, `assistantName`, `ASSISTANT_NAME_MAX`, `isRenamable`, `hireName`, `fixedNameRenames`,
  `ONLY_ASSISTANT_*`, `ASSISTANT_RESET_TAKEN_TEXT`), `DEFAULT_TEAM_CREDENTIAL_SOURCE`, `credentialSourceOf`,
  `AgentRuntime.credentialOwnerAccountId`.

## Principals (`domain/principal.ts`)

- `Agent` = base + `kind: 'agent'`, `face`, `status`, `doing`, `runtime`. Removed: `role`, `focus`, `look`, `job`,
  `channels`, `hiredBy`, `ownerId`, `system`, `retiredAt`.
- New `SystemPrincipal` (`kind: 'system'`, `system: SystemKind`), `SystemKind` (`github`, `automation`, `feedback`),
  OA-17. `Principal` = `Person | Agent | SystemPrincipal`; `PrincipalKindSchema` has `system`.
- Removed: `canRetireAgent`, `RETIRED_LABEL`; `isActivePrincipal` / `principalStatusLabel` read only `removedAt`.

## Keys (`@whombat/core/keys`)

- New: `AGENT_DEFAULT_KEYS` (KeySet: the assistant's keys plus the crew's defaults, OA-05), `agentDefaultGrants(agentId)`,
  `KeyOption` (was `HireKeyOption`), `RISK_KEY_OPTIONS` (was `HIRE_KEY_OPTIONS`), `ACCOUNT_KEYS` (a person's mail,
  calendar, files and contacts keys). `ALL_KEY_OPTIONS` lists the account keys too; a switch is on when the key is
  held at its cap and `configureGrants` writes it at its cap (`ask` for sending, invites, sharing, trashing).
- `KeysSummary` / `formatKeysSummary`: no channel count (“3 keys · 1 ask first”); `keysSummary(grants)`.
- Removed: `ASK_BY_DEFAULT_KEYS`, `PERSONAL_DEFAULT_GRANTS`, `personalDefaultGrants`, `SEED_ROLE_KEYS`,
  `ASSISTANT_ALWAYS_ON_KEYS`, `ROLE_DEFAULT_KEYS`, `assistantShellGrants`, `FOCUS_DEFAULT_KEYS`, `focusDefaultKeys`,
  `roleDefaultGrants`, `seedRoleGrants`, `alwaysOnUpgrade`, `AlwaysOnUpgrade`, `alwaysOnUpgradeText`, `hireKeyOptions`,
  `ROLE_LOCKED_NOTE`, `hireGrants`, `describeHire`, `configureChannels`, `PERSONAL_KEY_OPTIONS`, `personalKeyState`,
  `personalConfigureGrants`, `PERSONAL_KEYS`, `isPersonalKey`, `PERSONAL_AGENT_EXTRA_KEYS`, `PersonalKeyOptions`,
  `personalAgentMayHold`; keys `channels.read`, `channels.create`.

## REST (`@whombat/core/contracts`)

- `api.agents` → **`api.agent`** (one agent, no `:agent` param, paths `/burrows/:burrow/agent…`): `agent.get`
  (`AgentProfile`), `agent.update` (`name`, `face`, `runtime`), `agent.setRuntime`, `agent.setCredentialSource`,
  `agent.setKeys`, `agent.commandAllowances`, `agent.removeCommandAllowance`. Removed: `agents.list`, `agents.hire`,
  `agents.retire`, `agents.setChannels`, `agents.setCredentialOwner`, `AgentSummary`, `HireBody`, `HireResponse`,
  `AGENT_JOB_MAX`, `KeysSummarySchema.channels`, `AgentProfile.channels`.
- Onboarding: `OnboardingState` has `agentName`, `agentFace`; `onboarding.update` takes `agentName`, `agentFace`.
  Removed: `AgentTemplate`, `OnboardingState.agents/selectedRoles/repos/githubConnected`, `OnboardingRepo`.
- Plans (OA-14): `plans.delegate`, `plans.reportBack`, `plans.askReport`, `DelegateBody`, `ReportBackBody`,
  `HandoffFields` removed; `PlanStep.ownerId`, `PlanStep.handoff`, `PlanHandoff`, `HANDOFF_*`, `HandoffBudget`,
  `HandoffResult*`, `HandoffReportStatus`, `HandoffOutputSchema` removed; step bodies take no `ownerId`;
  `PlanStepAction` loses `reassign`, `open_lane`, `ask_for_report`, `report_back`.
- Conversations (OA-04): `ConversationKind` = `dm` | `branch`. Removed: `conversations.getChannel`, `createChannel`,
  `addMembers`, `removeMember`, `openDirect`, `browse`, `join`, `archive`, `openDm`; `messages.ask`; `ChannelVisibility`,
  `channelVisibility`, `DIRECT_*`, `directMemberKey`, `canArchiveChannel`, `Conversation.dmAgentId/visibility/archivedAt/
  createdById`, `ConversationSummary.dmAgentId/memberIds/visibility/archivedAt`, `SendMessageBody.to/suggested`,
  `Broadcast`, `Message.asks`/`MessageAsk`.
- Routing (OA-07): `text/addressee.ts`, `text/suggest.ts`, `domain/ask.ts` deleted (`replyAddressee`, `suggestAgent`,
  `AskAgentBody`, `AddressedContext`, …); `MentionTarget.personal` gone. Connections: `lookedAfterBy`,
  `lookedAfterById/Name`, `ConnectionCaretaker`, `caretakerRoleFor`, `CATALOG_CATEGORY_CARETAKER_ROLE` removed.
  Feedback: `FeedbackIntegration.agentId/handoffAgentId` and the bodies' agent ids removed. Automations (OA-15):
  `DispatchAgentStep.agentId`, recipe `agentId`, fix recipe `developerId`/`reviewerId`, draft agent removed.
- Vault (OA-09): the entry's key is the agent's on/off — `vault.giveKey`, `vault.takeKey`, `vault.setKeyServers`,
  `vault.setKeyDelivery` lose the `:agent` param (paths `/vault/:entryId/key…`); `VaultEntryDetail.keys[]` →
  `VaultEntryDetail.key` (`VaultKeyView | null`, no `agentId`). Removed: `vault.agentKeys`, `VaultAgentKey`.
- Skills library: no `agentId` in any query or body. Spend: `SpendOverview.byAgent` removed; `spend.agent` →
  `spend.week` (`/spend/week`).
- Delegation (OA-06): `domain/handoff.ts`, `domain/pass-on.ts`, `fixtures/handoffs.ts` deleted; MCP tools `delegate`,
  `pass_on`, `report_back` removed; runner `Teammate`, `TEAMMATES_MAX`, `HandoffContext`, `HandoffResultContext`,
  `DispatchContext.teammates/handoff/handoffResult/passed/addressed` removed; triggers `handoff`, `handoff_result`,
  `passed` removed.
- Privacy (OA-10, OA-11): `PersonalContext` → **`OnBehalfOfContext`** (`person`, `connections`),
  `DispatchContext.personal` → **`DispatchContext.onBehalfOf`**; `DispatchCredential.personal` and
  `credentialOwnerAccountId` removed (`onBehalfOfAccountId` kept).

## Also changed (as built)

- Links: `ChannelLink`, `DirectLink` removed; `DmLink` is `{type: 'dm', room?: 'chat' | 'feedback'}` (`/:burrow/chat`,
  `/:burrow/feedback`); `AgentLink` is `{type: 'agent'}` (`/:burrow/settings/agent`). `conversationLink(c)` takes
  `room` instead of an agent handle; `conversationLabel(c)` is the title.
- Conversations: `Sidebar` = `branchRooms`, `dms`, `counts {canvases, needsYou}`; `ConversationDetail.agentChannels`
  and `SendMessageResponse.dispatches[].agentId` removed; `conversations.update` takes `topic`, `linkPreviews` only;
  `CHANNEL_LINK_PREVIEWS_COPY` → `LINK_PREVIEWS_COPY`; `NotificationKind` and `NotifyReason` lose `direct` and
  `broadcast`; `text/conversations.ts` (`directTitle`, …) and `parseBroadcast`/`BROADCAST_HINTS` deleted.
- Per-agent paths lose `:agent` (OA-19): `/burrows/:burrow/agent/computer…`, `…/agent/schedules…`,
  `…/agent/notes…`, `…/agent/context`, `…/agent/learned-skills/:skill`, `…/agent/skill-links…`, `…/agent/skill-uses`;
  `memory.*` queries and `MemoryScopeInput {type: 'agent'}` without a handle; `skills.proposals` without `agent`.
- Feedback: `FeedbackIntegrationSettings.channelId/agentId/handoffAgentId` → `handoff: 'on' | 'off'`;
  `FeedbackIntegration.channelId` → `conversationId`, `chat` always set (`{id, personId}`);
  `FeedbackIntakeSnapshot.channelId` → `conversationId`; no `agentId` on snapshots, statuses or attempts;
  `FeedbackHandoffContext.assessorId` removed.
- Automations: `AutomationGlance.agentId` → `agentStep: boolean`; `describeAutomation(…, {agent: string, …})`;
  `RecipeNames.developer`, `StoryNames.developer/reviewer` removed; template fields kind `channel`/`agent` →
  `conversation`, no agent fields; `NewAutomationSource` `describe` without `agentId`.
- Vault: `VaultEntry.keyCount` → `agentOn: boolean`; `vaultEntryMeta(entry, agentName)`; `VAULT_ASSISTANT_ACCESS`,
  `VaultAssistantAccess`, `vaultAssistantAccessCopy` → `VAULT_AGENT_ACCESS`, `VaultAgentAccess`,
  `vaultAgentAccessCopy`; the team/personal prompt variants collapse to one (`VAULT_SSH_AGENT_RULES`, `vaultSshAgentRules` gone,
  `vaultAccessRules()`, `vaultSshSetupSteps(name)`, `vaultUnheldAskLine(facts)`, `VAULT_UNHELD_NOTE` = “switched off
  for you”); `VaultGetResponse.eligibleAgentIds`, `vaultKeyHolderProblem`, `VAULT_KEYS_MAX`, error
  `not_eligible_agent`, limit `keys`, `vaultOwnKeysText`, `decideVaultUse`'s `ownerReachable` removed.
- Copy: `PROFILE_COPY` takes `{agent}` (`profileCopy(name)`); `welcomeToast`, `inviteNote`, `inviteLinkNote`,
  `auditSubtitle`, `githubConnectedToast`, `agentsBlockedNotice` take the agent's name; `MERGE_NOTE` → `mergeNote(name)`;
  `acpGuardedRefusal(label)`; `dmIntro`, `mobileDmSubtitle`, `dmTopic`, `rosterSubtitle`, `hireToast`, `agentJobText`,
  `agentRoleTitle`, `agentRowLabel`, `formatMemberCount`, `ownWorkdirNote`, `BURROW_CREATION_LOCKED`,
  `LEGACY_HIRED_DOING` removed; `customerSignature(name)`.
- `canRetryTurn(card, viewer)`, `canStopTurn(turn, viewer)`, `canAskForMore` without owners; `canClearConversation`,
  `Message.broadcast`, `CollabUser.role`, `TeammateReadyCode`… removed. Audit types `agent.hired`, `agent.retired`,
  `channel.*`, `direct.opened`, `agent.channel_*`, `keys.upgraded`, `pack.role_packs_dismissed`, `vault.keys.own_given`
  removed. Schedule end reason `agent_retired` removed. Backup records: one agent (`face`, no role/channels/…), one
  Vault `key`, no channel records.
- Desk (control-contracts local): `DeskAssistant.look` → `face: AgentFace`.
- Also removed: `channelNameFrom`, `AuditPrincipalInfo.roleLabel` (`auditTag` is `AGENT` or `PERSON`), `@channel`/`@here`
  as mention words in Markdown; `BackupFeedbackSourceRecord.channel` → `conversation`. `burrows.create` answers 409 once
  the Whombat has its burrow (OA-01).

## Canvas schema and fixtures

- `@whombat/canvas-schema`: plan steps carry no `ownerId` (`PlanStepLike`, `DocPlanStep`, the `planStep` node);
  `mergePlanEdits` options lose `defaultOwnerId`; `docToMarkdown(doc)` takes no options (`SerializeOptions` gone).
- `@whombat/fixtures`: one agent `AGENT` = `dusty` (`prn_dusty`); conversations `cnv_dm-dusty` (Mara's Chat),
  `cnv_feedback-mara` (`cnv_feedback_mara`, her Feedback room), `cnv_pr482`; new `roomOf`, `DM_DUSTY_REPLIES`,
  `msg_dm_dusty_*`, `msg_pr482_{dusty,joris}_*`. Renamed: `spendAgentWeek` → `spendWeek`, `sr_message_billing` →
  `sr_message_review`, `ntf_agent_banjo` → `ntf_agent_dusty`, `ntf_mention_incidents` → `ntf_mention_pr482`. Removed:
  `toffee`, `banjo`, `waffle`, `neo`, `muffin`, `AGENTS`, the channel and Waffle conversations and their messages,
  `conversationBySlug`, `agentSummary`, `agentByHandle`, `agentChannelSummaries`, `AGENT_TEMPLATES`, `ntf_agent_muffin`,
  `handoffs.ts`. `agentKeysSummary()` and `currentRunFor()` take no agent. The mock fetch answers `agent.*`,
  `spend.week` and the Vault key routes without `:agent`.

## Protocol and control

- Features removed: `delegation`, `roles`, `agents.retire`, `agents.focus`, `agents.role_skills`, `agents.fixed_names`,
  `agents.pass_on`, `agents.look`, `messages.reply_to`, `messages.ask_agent`, `connections.looked_after`,
  `shell.assistant`, `channels.clear`, `feedback.chat`, `conversations.direct`, `channels.browse`.
- `FeedbackHealthWarning` codes `no_agent`, `agent_not_member`, `agent_missing`, `channel_missing` removed;
  `ChannelName` removed.
- Plan limits (OA-02): `EntitlementLimits.agents`, `SetEntitlementBody.limits.agents`, `PlanUpdate.limits.agents` and the
  licence token's `limits.agents` removed (Go and vectors too).

## 0.123.0 rebuilt (`oa-c2`, CT-1137…CT-1144)

The same version, built again with the leftovers the streams found. Update consumers for:

- Work (`@whombat/core/domain`): `WorkItem.handoff` and `WorkHandoff` removed; `WorkAction` loses `reassign_step` and
  `ask_for_report`.
- Licence (`@whombat/protocol` session): `LicenceStatusView.usage` is `{members, connectors}` (no `agents`);
  `LicenceLimitDetails.limit` is `members` | `connectors`.
- Desk (`@whombat/core/domain`, control-contracts local, Go `local`): `DeskBoxPartKey` `agents` → `agent`
  (`DESK_BOX_PARTS`, `DESK_WORDS.box.parts.agent`, Go `DeskBoxPartKeyAgent`); `DESK_WORDS.box.parts.agent` and
  `DESK_WORDS.phoneReasons.keys` hold `{assistant}`: fill them with the agent's name (`fillDeskWords`).
- Automations: `templateParamsProblem` removed (it always answered null).
- Words only (no shape change): `STEP_KIND_LABELS.dispatch_agent`, `scheduleLimitProblem`, `AI_GATEWAY_COPY.switchHint`,
  `ACP_GUARDABLE_UNSUPPORTED`, `keyRequestProblem`, `describeDecision`, the `approvals.decide` key, the Website feedback
  and personal connection tiles, the connector and guide MCP tool descriptions (“the person’s”), `remember`, endpoint
  summaries of `feedback.moveSource` and `automations.cancelRun`, the `licence.*` and `not_yours` error texts.
- Kept on purpose (CT-1143): `agents.manage`, the `agents.*` features, `agentsReachLan`, `AgentsMode`,
  `agentsCanReply`, `agentsBlockedNotice`, `CATALOG_USES` `agents`, the inbox, audit and backup `agents` values.
