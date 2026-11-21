# Hermes is the only engine: what changes in the contracts (0.124.0)

For the streams that code against `he2-c` (Whombat E, S, P, X; whombat-app W; appliance N2). Names only; the decisions are
CT-1150…CT-1179 in `docs/contracts/decisions/contracts.md`. Nothing is kept for compatibility. `SESSION_API_LEVEL` 46 → 47.

## Removed

- `@whombat/core/domain`, ACP (`domain/acp.ts` deleted): `AcpRuntimeId`, `AcpRuntimeDefinition`,
  `AcpRuntimeDefinitionInput`, `AcpRuntimesFile`, `AcpTrust`, `ACP_FORBIDDEN_ENV`, `ACP_GUARDABLE_UNSUPPORTED`,
  `AcpNegotiated`, `AcpRuntimeCheck`, `MAX_ACP_RUNTIMES`, `acpRuntimeOf`; fields `AgentModelRuntime.acpRuntime`,
  `RunnerStatus.acp`, `AgentSetupStatus.acpRuntimes`.
- `@whombat/core/domain`, providers: `ProviderCapabilities`, `ProviderCheck.capabilities`, `ProviderSetup.capabilities`,
  `AgentsMode`, `RunnerStatus.mode`, `AgentSetupStatus.mode`, `isLiveProvider`, the providers `acp` and `scripted`
  (`PROVIDER_LABELS.acp`, `.scripted`).
- `@whombat/core/text`: `acpGuardedRefusal`, `CAPABILITY_LABELS`, `capabilityValue`, `UnrunnableCause` `{kind: 'acp'}`.
- `@whombat/core/contracts`, runner: `PromptHash`, `ForkFromSession`, `EarlierRun`, `EARLIER_RUNS_MAX`,
  `EARLIER_RUN_LOG_LINES_MAX`, `EARLIER_RUN_LOG_LINE_MAX`, `SESSION_PROMPT_CHANGED`; fields
  `DispatchContext.resumePromptHash`, `.forkFrom`, `.earlierRuns`, `ClaimBody.acpRuntimes`, `ProgressBody.promptHash`,
  `ProgressBody.forked`, `CompleteBody.promptHash`, `AgentPersona.doing`, `.status`, `.fingerprint`.
- `@whombat/core/domain`: `stablePromptHash` (memory), `ACTIVITY_NO_TELEMETRY`; the activity labels of `delegate`,
  `pass_on`, `report_back`, `plan_start_step`.
- `@whombat/core/contracts`: `activity.list`'s `reported`.
- `@whombat/core/backup`: `BackupAgentRuntime.acpRuntime`.
- `@whombat/protocol`: the error code `managed.acp_runtimes`.

## Changed

- `AgentProvider` = `claude` | `codex` | `local` (new `AGENT_PROVIDERS`); `DEFAULT_AGENT_RUNTIME.provider` `claude`.
- `AgentPersona` = `{id, name, face, handle, runtime, keys}` (`face` is new and required).
- `defaultAgentProvider(providers)` (no mode); `providerRunnable(status, provider, localModel?)` (the third argument
  was the ACP runtime id; `local` needs `Burrow.localModel`); `agentsCanReply(status, localModel?)`; both need
  `status.hermes.ready`. `agentsBlockedNotice(status, name)` reads `hermes`.
- `RunnerStatus.hermes` (required); `AgentSetupStatus.hermes` (`HermesCheck | null`).
- `Burrow.localModel` (`LocalModelView | null`, default null).
- `CHAT_PROVIDERS` / `ChatProvider` / `ChatRuntime` / `RanOn` / `ChatRuntimeProvider` take `local`;
  `CHAT_PROVIDER_LABELS.local` “Custom”; `ChatRuntimeView.providers` up to 3; `CHAT_RUNTIME_COPY.fastHint` has `claude`
  and `codex` only.
- `PROVIDER_LABELS.local` “Custom AI model”; `turnFailureText(…, {provider: 'local'})`.
- `ModelFallbackWhere.kind` takes `local`.
- `BackupSettingsRecord.localModel`; `BACKUP_SCHEMA_VERSION` 4.

## New

- Domain (`domain/local-model.ts`): `LocalModelView`, `LocalModelCheck`, `LocalModelCheckState`,
  `LOCAL_MODEL_CHECK_STATES`, `LocalModelBaseUrl`, `LocalModelLabel`, `LocalModelApiKey`, `LocalModelUrlProblem`,
  `LOCAL_MODEL_URL_PROBLEMS`, `LOCAL_MODEL_URL_PROBLEM_TEXT`, `localModelUrlProblem`, `localModelAddressProblem`,
  `localModelName`, `localProviderModels`, `LOCAL_MODEL_URL_MAX`, `LOCAL_MODEL_LABEL_MAX`, `LOCAL_MODEL_KEY_MAX`.
- Domain (providers): `HermesCheck`, `HermesProblem`, `HERMES_PROBLEMS`, `engineReady`.
- Contracts: `api.burrows.setLocalModel` (`SetLocalModelBody`), `.testLocalModel` (`TestLocalModelBody`),
  `.clearLocalModel`; `LocalModelDispatchContext`, `DispatchContext.localModel`.
- Text: `ENGINE_PROBLEM_COPY`, `UnrunnableCause` `{kind: 'engine', problem}` and `{kind: 'local'}`, `LOCAL_MODEL_COPY`,
  `localModelCheckText`, `localModelKeysText`, `LocalModelChange`.
- Audit type `burrow.local_model_changed` (Keys). Feature `ai.local_model`. Secret ops `burrows.setLocalModel`,
  `burrows.testLocalModel`.

## Kept on purpose

`SandboxCheck`, `RunnerStatus.sandbox`, `ProviderSetup.sandboxProblem` (managed mode reads them), `LIVE_PROVIDERS`
(the two CLIs), `TurnInjection` and `ProgressResponse.inject` (follow-ups as `/steer`), `DispatchContext.memory`,
`skills`, `skillHint`, `notes`, `profile`, `browser`, `reflect`, `scratch` (steps 3 and 4).

# Step 3 — Hermes keeps memory and skills; its browser; the Vault without relays (0.125.0)

For the streams that code against `he3-c` (Whombat M, K, B, V; whombat-app W3; appliance N3). Names only; the decisions
are CT-1200…CT-1249 in `docs/contracts/decisions/contracts.md`. Nothing is kept for compatibility. `SESSION_API_LEVEL` 47 → 48.

## Removed

- Memory (`@whombat/core/domain`, `/contracts`): `MemoryKind`, `MemoryScope`, `MemoryScopeType`, `MemoryStatus`,
  `MemorySource`, `MemorySourceType`, `MemoryTitle`, `MemoryBody`, `MemoryItem`, `Checkpoint`, `CheckpointState`,
  `SummaryStatus`, `ContextSummary`, `memoryPermissions` and its types, `CHARS_PER_TOKEN`, `estimateTokens`,
  `CONTEXT_BUDGET_CHARS`, `KNOWLEDGE_MAX_ITEMS`, `planContext`, `extractiveSummary`, `SessionParts`,
  `SESSION_PART_LABELS`, `hashText`, `sessionPartHashes`, `sessionFingerprint`, `sessionChange`, `memoryKindLabel`,
  `MEMORY_*` bounds of the old store, `PROFILE_ENTRY_MAX`, `PROFILE_BUDGET`, `NOTE_ENTRY_MAX`, `NOTES_BUDGET`,
  `MEMORY_OPERATIONS_MAX`, `PROFILE_ENTRY_KINDS`, `ProfileEntryKind`, `PreferenceEvidence`, `preferenceIsCurrent`,
  `memorySearchWords`, `MEMORY_TARGETS`, `MemoryTarget`, `MEMORY_LIMITS`, `ProfileEntry`, `NoteEntry`,
  `normalizeMemoryText`, `MemoryOperation`, `MemoryStoreEntry`, `MEMORY_OP_ERRORS`, `applyMemoryOps`, `memoryUsedChars`,
  `scanMemoryText`, `PROFILE_COPY`, `profileCopy`, `profileEntryKindLabel`; `MemoryEntry`, `MemoryContext`,
  `DispatchProfileContext`, `DispatchNotesContext`, `MemoryItemView`, `MemorySourceView`, `MemoryScopeInput`,
  `MemoryListQuery`, `CreateMemoryBody`, `ReviseMemoryBody`, `DecideMemoryBody`, `MemorySession`,
  `AgentContextResponse`, `PersonProfileResponse`, `AddProfileEntryBody`, `UpdateProfileEntryBody`, `SetLearningBody`,
  `AgentNotesResponse`, `UpdateNoteBody`, `MemoryToolEntry`, `MemoryToolInput`, `MemoryToolOutput`, `MEMORY_MCP_TOOLS`,
  `UNLISTED_MEMORY_TOOL_NAMES`, `UNLISTED_MCP_TOOL_NAMES`, `REFLECT_DISPATCH_TOOLS`; ops `memory.list`, `.get`,
  `.create`, `.decide`, `.revise`, `.remove`, `.checkpoints`, `.context`, `.profile`, `.addProfileEntry`,
  `.updateProfileEntry`, `.removeProfileEntry`, `.setLearning`, `.updateNote`, `.removeNote`; MCP tools `remember`,
  `propose_instruction`, `recall`, `save_checkpoint`, `memory`; `DispatchContext.memory`, `.profile`, `.skills`,
  `.skillHint`, `.reflect`; key `memory.propose`.
- Dispatch (`/domain`, `/contracts`): triggers `reflect` and `vault_pass`; `REFLECT_QUIET_MINUTES`, `REFLECT_MIN_TURNS`,
  `REFLECT_EVERY_HOURS`, `REFLECT_NOTHING`, `REFLECT_REASONS`, `ReflectReason`, `REFLECT_LONG_TURN_*`,
  `longTurnReviewDue`, `ReflectDispatchContext`.
- Skills (`/domain`, `/contracts`, `/skills`): `skills.proposals`, `.proposal`, `.decide`, `.removeLearned`,
  `.previewLink`, `.addLink`, `.uses`, `.libraryPin`, `.libraryRest`, `.libraryReset` (and `libraryRestore` by version);
  `SkillProposal*`, `SKILL_PROPOSAL_*`, `isLearnedSkill`, `SkillCard`, `StoredSkillCard`, `SKILL_CARD_HIDDEN`,
  `skillCardLabel`, `skillCardText`, `SKILL_LEARNED_COPY`, `skillLearnedTitle`, `SkillHint`, `parseSkillCommand`,
  `skillHintText`, `SkillUses`, `skillUsesText`, `SKILL_LINK_COPY`, `SkillSource` (the URL; the name is reused, below),
  `SKILL_SOURCE_MAX`, `SKILL_PROPOSALS_PENDING_MAX`, `LEARNED_SKILLS_MAX`, `SKILL_BODY_MAX_BYTES`,
  `SKILL_DESCRIPTION_MAX`, `SKILL_REASON_MAX`, `SKILL_FILES_MAX`, `SKILL_FILES_MAX_BYTES`, `LIBRARY_SKILL_*_MAX*`,
  `SKILL_FILE_MAX_BYTES`, `SKILL_DECISION_NOTE_MAX`, `SkillBody`, `SkillFileInput`, `SkillFiles`, `LibrarySkillFiles`;
  `SkillContext`, `DispatchSkill`, `SKILLS_NEW_MAX`, `SkillFileData` (the old one), `RunnerSkillFiles`, `SkillFilesBody`,
  `skillRunnerEndpoints` (`runner.skillFiles`); `SKILL_MCP_TOOLS`, `ProposeSkillOutput`, `FindSkill*`, `ReadSkill*`,
  `SkillMatch*`, `SkillWrite*`, `skillWriteChange`, `SKILL_WRITE_ACTIONS`, `FIND_SKILL_LIMIT_MAX`,
  `SKILL_SUGGESTIONS_MAX`; `SkillListing`, `SKILL_LISTING_*`, `skillListingRank`, `skillListingCost`,
  `planSkillListing`, `cutSkillDescription`, `SkillListingItem/Plan/Result`, `SKILL_REST_AFTER_DAYS`,
  `SKILL_SNAPSHOT_HOURS`, `FOREIGN_SKILL_RUNTIMES`, `FOREIGN_SKILL_TOOLS`, `translateForeignSkill`,
  `LEARNED_SKILL_CATEGORY`, `learnedSkillsTitle`, `SKILL_ORIGINS`, `SkillOrigin`, `SkillPackRef`, `SkillChangedBy`,
  `SkillChange`, `LEGACY_SKILL_SOURCES`, `LegacySkillSource`, `legacySkillKey`, `legacySkillSource`,
  `legacySkillItemFields`, `SkillLibraryBudget`, `SkillVersion`, `SkillPinBody`, `SkillRestBody`, `SkillResetBody`;
  `Message.skillHint`, `SendMessageBody.skillHint`, the card kind `skill`; key `skills.propose`.
- Browser (`@whombat/core/browser` subpath and everything in it): `BROWSER_TOOL_NAMES`, `BrowserToolName`,
  `BROWSER_SIGN_IN_TOOL`, `BROWSER_OPENING_TOOLS`, `BROWSER_PREVIEW_TOOL` (moved, below), `isBrowserToolName`,
  `browserToolOf`, `BROWSER_*` limits, destinations (`parseBrowserUrl`, `browserUrlProblem`, `browserDestinationProblem`,
  `browserUrlHost`, …), `BrowserState`, `BrowserStatus`, `BrowserContextLogin`, `BrowserContextInfo`,
  `BROWSER_STATE_LABELS`, `browserStatusLine`, `BROWSER_REFUSAL_*`, `BrowserRefusalCode`, `browserBlockedText`,
  `browserSignInOnlyText`, `BROWSER_SCREENSHOT_STAYS`, `BROWSER_NOT_A_LOGIN`, `browserRefusal`; `contracts/mcp-browser.ts`
  (`BROWSER_MCP_TOOLS`, the twelve tools besides `browser_preview`, `Browser*Input/Output`, `BrowserRef`, `BrowserUrl`,
  `BrowserKey`, `BrowserPage`, `BROWSER_PAGE_SHAPE`, `browserOutcome`, `BROWSER_PREVIEW_ORIGIN`); `HostInfo.browser`,
  `AgentSetupStatus.browser`.
- Vault (`/vault`, `/contracts`): `VAULT_KEY_TIERS`, `VaultKeyTier`, `VAULT_TIER_LABELS`, `VAULT_KEY_DELIVERIES`,
  `VaultKeyDelivery`, `VaultPackUse`, `VaultEntry.packCount`, `VaultEntryDetail.packs`, `VaultTool.mcpName`,
  `VaultCssSelector`, the form auth's selectors, `VAULT_REQUEST_BODY_MAX`, `VAULT_RESPONSE_*_MAX`,
  `VAULT_TOOL_OUTPUT_MAX`, `VAULT_CALLS_IN_FLIGHT_MAX`, `VAULT_POOL_IDLE_MS`, `VAULT_SELECTOR_MAX`,
  `VAULT_SIGN_IN_WAIT_MS`, `VAULT_SIGN_IN_SCREENSHOT_MAX`, `VAULT_SSH_COMMAND_MAX`, `VAULT_SSH_STDIN_MAX`,
  `VAULT_SSH_OUTPUT_MAX`, `VAULT_SSH_TIMEOUT_*`, `VAULT_SSH_FILE_MAX`, `VAULT_SSH_PATH_MAX`, `VAULT_SSH_WHAT_COMMAND_MAX`,
  `VAULT_SSH_KEEPALIVE_MS`, `VAULT_SSH_IDLE_MS`, `VAULT_SSH_CHANNELS_MAX`, `VAULT_SIGN_IN_OUTCOMES`,
  `VaultSignInOutcome`, `VaultSignInScreenshot`, `VaultSignInResult`, `VAULT_BROWSER_SIGN_IN_WHAT`, the check outcome
  `blocked`; `VaultUse.status`, `.server`, `.exitCode`, `.ms`, `.bytes`; `vault/decide.ts` (`VaultUseKind`,
  `VAULT_USE_ENTRY_KIND`, `VaultUseInput`, `VaultUseDecision`, `decideVaultUse`, `VAULT_USE_MESSAGES`,
  `vaultServerNotCoveredText`, `vaultUseMessage`); `normaliseVaultPath`, `vaultRequestTarget`, `vaultRequestWhat`,
  `VAULT_AGENT_HEADERS`, `vaultRequestHeaders`, `vaultRefusedHeadersText`; failures `protocol`, `tool_error`,
  `withheld`, `file_error`; `VAULT_REQUEST_TOOL`, `VAULT_SSH_TOOL_NAMES`, `VaultSshToolName`, `VAULT_REQUEST_KEY_TOOL`,
  `VAULT_TOOL_PREFIX`, `VAULT_TOOL_NAME_PATTERN`, `vaultToolMcpName`, `parseVaultToolMcpName`, `isVaultToolName`,
  `vaultToolDescription`; `VaultSshPath`, `VaultSshFileMode`, `VaultSshCommand`, `vaultSshPathProblem`,
  `vaultSshUseWhat`, `VAULT_SSH_FILE_ERRORS`, `VaultSshFileError`, `VAULT_SSH_FILE_ERROR_TEXT`; copy `VAULT_COPY
  .testSignIn/.signInScreenshotNote/.selectorsHint`, `VAULT_SIGN_IN_UNAVAILABLE`, `vaultSignInSummary`,
  `vaultSignInCheck`, `vaultUseWhatText`, `VaultApprovalFacts`, `vaultApprovalCopy`, `vaultPurposeLine`,
  `VAULT_APPROVAL_CTA`, `VAULT_SCOPE_LABELS`, `vaultSshServerLine`, `VAULT_SSH_NO_SERVERS_FOR_AGENTS`,
  `VAULT_SSH_ADD_SERVER_RULE`, `VAULT_SSH_AGENT_RULES`, `VAULT_SAVE_RULES`, `VAULT_ACCESS_RULES`, `vaultAccessRules`,
  `VAULT_SSH_SETUP_INTRO`, `VAULT_SSH_SETUP_STEPS`, `vaultSshSetupSteps`, `VAULT_UNHELD_NOTE`, `vaultKeyDeliveryLabels`,
  `vaultKeyDeliveryHints`, `VAULT_COMPUTER_COPY.delivery/.notDeliverable/.othersTurns`, `VAULT_ACCESS_RULES_COMPUTER`,
  the audit texts `approval.*`; `VaultContextTool`, `VaultContextEntry.key/ownerFirstName/requesterIsOwner/applies/
  passHeld/baseUrl/tools/site/delivery/onComputer`, `VaultUnheldEntry.ownerFirstName/servers`,
  `VaultDispatchContext.tools`, `SetVaultKeyDeliveryBody`, `VaultTestSignInResponse`, `GiveVaultKeyBody.tier/.delivery`;
  ops `vault.testSignIn`, `vault.setKeyDelivery`; `VaultRequestMethod(s)`, `VaultRequestInput`, `VaultHttpResponse`,
  `VaultRequestOutput`, `VaultSsh*Input/Result/Output`, `RequestVaultKeyInput/Output`, `VaultToolRefusal`'s
  `pending_approval`; MCP tools `vault_request`, `ssh_exec`, `ssh_read_file`, `ssh_write_file`, `ssh_upload`,
  `request_vault_key`.
- Approvals: `VaultUseAction` (`vault_use`), `VAULT_USE_PURPOSE_MAX`, `ApprovalVaultDetail`, `Approval.vault`; the
  desk's `DeskPhoneReason` `vault`.
- Backups: records `memory`, `note`, `profile`, `learning`, `skill`, `skill_version`, `skill_state`, `pack`,
  `pack_version`, `pack_attachment`, `learned_skill` (`Backup*Record` of each), `BackupSkillChange`; directory entries
  `skill`, `pack`, `pack_version`, `pack_attachment`; the Vault key record's `tier` and `delivery`.
- Ids: `MemoryItemId`, `CheckpointId`, `ProfileEntryId`, `AgentNoteId`, `SkillProposalId`, `SkillLinkPreviewId`,
  `SkillId`, `SkillVersionId`, `VaultPassId`, `VaultPassRequestId` (prefixes stay taken).
- Protocol: features `agents.memory`, `skills.learned`; `vault.testSignIn` as an export op.

## Changed

- `SkillName`: Hermes's rule (`^[a-z0-9][a-z0-9._-]{0,63}$`, no `..`). `SKILL_LIMITS` `{bodyBytes: 100_000, files: 49,
  fileBytes: 256 KiB, filesBytes: 2 MiB, depth: 6}`; `SKILL_FILE_DIRS` adds `assets`; `SkillDescription` up to 1,024;
  `LibrarySkillBody` up to `SKILL_LIMITS.bodyBytes`.
- `SkillLibraryItem` (new fields, below), `SkillLibraryResponse {agentName, items, canAdd}`, `SkillStatus` `ready` |
  `needs_setup` | `hidden` | `off` | `removed`, `SkillRefQuery {name, scope}`, `LibrarySkillResponse {item, text, files,
  original}`, `SkillEditBody {name, description?, body, ifVersion?}`, `SkillSwitchBody {name, on}`,
  `SkillRestoreBody {name}`, `SKILL_IMPORT_CLASHES` (`replaces_added`, `exists_learned`), `SkillImportItem` without
  `translated`; `skills.libraryRestore` brings a changed or removed shipped skill back.
- `VaultKeyView {givenAt, servers, envName}`; `GiveVaultKeyBody {servers?, envName?}`; `VaultContextEntry {id, name,
  description, kind, url, envNames, servers?, mcpServer?}`; `VaultContextSshServer.target` always set;
  `VaultUnheldEntry {id, name, description, kind, site}`; `VaultDispatchContext {entries, unheld}`; `VaultUse {id,
  entryId, agentId, requesterId, dispatchId, what, outcome, at, eventId}`; `VAULT_AGENT_ACCESS` `on` | `off` and
  `vaultAgentAccessCopy`; `vaultComputerDeliverable` (`http`, `ssh`); `vaultComputerEnvNames` (`http` only);
  `mergeVaultTools(stored, listed, firstCheck)`; `isVaultActivityTool` (`vault_save`, `vault_add_server`,
  `browser_vault`); `VAULT_FAILURES` without relay codes; `VaultToolRefusal` `blocked` | `failed`; `VaultEntryRef` = the
  id; `vaultAuditText` key texts (“Switched on … for {agent}”); `VAULT_COPY.intro`, `.keysNote`; `vaultUseOutcomeText`,
  `vaultUseRow` take the new `VaultUse`.
- `ComputerKeys` gains `mcpServers`; `runner.computerKeys` only the turn person's.
- `BrowserPreviewOutput` (`contracts/mcp-preview.ts`) `{title, url, attachmentId?, files, bytes}` or `refused` /
  `failed` with a reason; `PreviewRequest.render?`; `runner.submitPreview` body `shot?`.
- `DispatchContext.notes`: the owners' text (`string | null`). `OnBehalfOfContext.accountId` (required): the account the
  runner keys the person's Hermes profile on.
- `COMMAND_CATEGORIES`, `COMMAND_CATEGORY_RANK`, `COMMAND_CATEGORY_KEYS`, `COMMAND_CATEGORY_LABELS` gain `web`, `browser`;
  `commandDeclinedText(name, category?)`; `runCommandPhrase`, `commandWaitingText`, `commandBlockedText` word them.
- `ApprovalAction` takes `skill_share`; `SERVER_ONLY_ACTION_TYPES` `skill_share`, `run_command`, `connection_call`;
  `actionKey(skill_share)` null; `actionCopy(action, names?, requesterId?)` and `approvalCopy` without `vault`;
  `DESK_PHONE_REASONS` `money` | `release` | `delete` | `keys` | `outside` | `share`; `deskMayDecide` lets `web` and
  `browser` commands through.
- `ROUTINE_WHOMBAT_TOOLS` without `recall`; the activity verbs of `remember`, `propose_instruction`, `recall`,
  `save_checkpoint` gone; browser rows by `isBrowserActivityTool`.
- `BACKUP_SCHEMA_VERSION` 5; `BACKUP_COUNTED_TYPES.memories` `hermes_home`, `.skills` `hermes_skills`;
  `backupRecordCount` counts a `hermes_skills` by its `skills`; `backupCategoryMeta` for memories and skills.
- Keys: `browser.use`'s description. `SESSION_API_LEVEL` 48.

## New

- Memory (`domain/memory.ts`, `contracts/memory.ts`): `MEMORY_FILES`, `MemoryFile`, `MEMORY_FILE_LIMITS`,
  `MEMORY_ENTRY_SEPARATOR`, `MEMORY_TEXT_MAX`, `MEMORY_VIEW_TEXT_MAX`, `memoryEntries`, `memoryFileText`,
  `normalizeMemoryFile`, `memoryChars`, `memoryFileProblem`, `MemoryFileView`, `PersonMemory`, `emptyMemoryFile`,
  `AGENT_NOTES_MAX`, `AgentNotesText`, `AgentNotes`, `MEMORY_COPY`, `memoryCopy`, `NOTES_COPY` / `notesCopy` (new words),
  `memoryUsageText`; `WriteMemoryBody`, `SetAgentNotesBody`; ops `memory.mine`, `memory.write`, `memory.clear`,
  `memory.notes` (new shape), `memory.setNotes`.
- Sessions (`domain/session.ts`, `contracts/runner.ts`): `TaskKey`, `taskKeyFor`, `conversationKeyFor` (moved),
  `DispatchSession`, `DispatchContext.session`.
- Skills (`skills/skill.ts`, `contracts/skills-library.ts`): `SKILL_SOURCES`, `SkillSource` (`shipped` | `added` |
  `learned`), `SKILL_SCOPES`, `SkillScope` (`everyone` | `mine`), `SkillCan`, `SkillShareRequest`, `SkillLibraryItem`
  fields `source`, `scope`, `enabled`, `changed`, `originalChanged`, `overrides`, `shareRequest`, `version`, `updatedAt`,
  `can`; `SkillRemoveBody`, `SkillShareBody`, `SkillShareResponse`; ops `skills.libraryRemove`, `skills.libraryShare`,
  `skills.shareRequest`.
- Approvals: `SkillShareAction` (`skill_share {name, personId, version}`), `SKILL_SHARE_CTA`; audit type `skill.shared`.
- The runner's Hermes-home service (`contracts/hermes-home.ts`, as M and K wrote it): `HERMES_HOME_METHODS`
  (`MEMORY_METHODS`, `SESSION_METHODS`, `ARCHIVE_METHODS`, `SKILLS_METHODS`), `HermesHomeMethod`, `HermesHomeParams`,
  `HermesHomeArgs`, `HermesHomeResult`, `HermesHomeMethodName`, `HermesHomeRequest`, `HermesHomeAnswer`,
  `HermesHomeErrorCode`, `HermesAccountId`, `HermesProfileRef`, `HermesSessionId`, `HermesMemoryFile`,
  `HERMES_MEMORY_DELIMITER`, `HERMES_MEMORY_LIMITS`, `HERMES_MEMORY_ENTRIES_MAX`, `HERMES_MEMORY_ENTRY_MAX`,
  `HermesMemoryState`, `HermesMemoryBoth`, `HERMES_HOME_CHUNK_BYTES`, `HERMES_HOME_ARCHIVE_MAX_BYTES`,
  `HERMES_HOME_TRANSFER_TTL_MS`, `HermesHomeRef`, `HermesTransferId`, `HermesImportMode`, `HermesSkillPath`,
  `HermesSkillFilePath`, `HermesSkillScope`, `HermesSkillOrigin`, `HermesSkillState`, `HermesSkillChange`,
  `HERMES_SKILLS_MAX`, `HERMES_SKILL_FILES_MAX`, `HERMES_SKILL_MD_MAX_BYTES`, `HERMES_SKILL_FILE_MAX_BYTES`,
  `HERMES_SKILL_MAX_BYTES`, `HermesSkillFile`, `HermesSkillSummary` (with `requires`, `needs`), `HermesSkillRead`,
  `hermesHomeEndpoints`; `runnerApi.hermesPoll`, `runnerApi.hermesAnswer` (in `ALL_ENDPOINTS`).
- Browser and logins (`contracts/runner.ts`): `DISPATCH_LOGINS_MAX`, `DISPATCH_BROWSER_SITES_MAX`, `DispatchLogin`,
  `DispatchLoginSecret`, `BrowserSite`, `DispatchBrowser`, `DispatchContext.logins`, `DispatchContext.browser` (new
  shape), `runner.loginSecret`, `PREVIEW_SHOT_MAX_BYTES`, `PreviewShot`; `contracts/mcp-preview.ts`:
  `BROWSER_PREVIEW_TOOL`, `BROWSER_PREVIEW_VIEWPORT`, `BROWSER_PREVIEW_MAX_FILES`, `BROWSER_PREVIEW_MAX_BYTES`,
  `BrowserPreviewInput`, `BrowserPreviewOutput`, `PREVIEW_MCP_TOOLS`; activity `isBrowserActivityTool`,
  `browserActivityObject`, `stripUrlForActivity`, `activityUrlHost`.
- Vault: `vault.setKeyEnvName` (`SetVaultKeyEnvNameBody`), `ComputerMcpServer`, `ComputerKeys.mcpServers`,
  `VaultContextEntry.envNames` / `.mcpServer`, `HERMES_VAULT_TOOL`, `vaultTurnUseWhat`, `VAULT_COMPUTER_COPY.loginHint`
  / `.mcpHint`.
- Backups: `BackupHermesArchive`, `BackupHermesHomeRecord` (`hermes_home`), `BackupAgentNotesRecord` (`agent_notes`),
  `BackupHermesSkillsRecord` (`hermes_skills`).
- Protocol: features `memory.hermes`, `skills.hermes`; operation safety for the new ops; `EXPORT_OPS`
  `skills.importPreview` (read through an export stream, never resent by a client on its own).

## Kept on purpose

- `@whombat/core/packs` (`PackName`, `PackVersionString`, `PACK_LIMITS`, …), `PackVersionSummary`, `PackId`,
  `PackVersionId`, `PackAttachmentId`: the previous session protocol (0.20.3) Whombat keeps for skew tests imports them;
  they go with it in step 4.
- Audit event types of what went (`memory.*`, `instruction.*`, `checkpoint.saved`, `skill.proposed`, `browser.used`,
  `profile.changed`, `notes.changed`): the log's history; `profile.changed` and `notes.changed` also sign the new memory
  and notes changes.
- `skills.hubSearch` and its types (Whombat's own hub search, CT-1214); `skills.stage`; the scanner (`skills/scan.ts`);
  `vault_save`, `vault_add_server`; `browser.use` and `web.browse` as policy keys; `SkillImportId`.

# Step 4 — one product shape: the direct connection, Tailscale, no compatibility (1.0.0)

For the streams that code against `he4-c` (Whombat R1, R2; whombat-app W4; appliance N4; control A4). Names only; the
decisions are CT-1250…CT-1299 in `docs/contracts/decisions/contracts.md`. Nothing is kept for compatibility (HE-52).

## The version rule

- Session protocol **major 2** (`SESSION_PROTOCOL = {major: 2, minor: 0}`); contracts 0.x spoke major 1. A client sends
  `hello.versions: [SESSION_PROTOCOL]`; the box answers `welcome` when the major is its own, else
  `error{unsupported_version, details: UnsupportedVersionDetails}` and closes. `whoMustUpdate(clientMajors, details)` →
  `client` (“Update the app to use this Whombat.”) or `appliance` (“This Whombat needs an update to work with this
  app.”), `VERSION_REFUSAL_COPY`. A 0.x app meets a 1.0 box (and the reverse) through exactly this path.
- `negotiateVersion(offered, ours = SESSION_PROTOCOL)`: same major or null. Within a major, minors only add (CT-14); an op
  a box lacks is `unknown_op`; `decodeTolerant` stays for a newer minor's union members. The client security floor
  (`client_below_security_floor`, `clientFloor`) stays.

## New

- `@whombat/protocol/direct` (also from `@whombat/protocol`; Go `protocol.Direct*`): `DIRECT_PATH` `/v1/direct`,
  `DIRECT_SUBPROTOCOL` `whombat-direct.v1`, `DIRECT_PROTOCOL_VERSION` 1, `DIRECT_PORT` 4480, `DirectHello {t, v, class}`,
  `DirectWelcome {t, v, heartbeatMs, maxMessage}`, `DirectUpstreamMessage`, `DirectDownstreamMessage`,
  `parseDirectUpstream`, `parseDirectDownstream`, `DIRECT_CLOSE` (`badHello` 4400, `forbidden` 4403, `messageTooLarge`
  4413, `rateLimited` 4429, `draining` 4503), `DirectCloseName`, `DirectCloseCode`, `DirectDrainReason`,
  `DirectParseResult`; limits `DIRECT_MAX_TEXT_MESSAGE_BYTES`, `DIRECT_HELLO_TIMEOUT_MS`, `DIRECT_MAX_MESSAGE_BYTES`,
  `DIRECT_HEARTBEAT_MS`. After the welcome: Noise XX as through the relay (client initiator, box PeerId pinned); the box
  admits from the client's static key (enrolled → `app`, unknown → `enroll`, revoked → `revoked`).
- Session (`session/direct.ts`): `IpAddress` (moved from `network.ts`), `DIRECT_WAYS`, `DirectWay` (`lan` |
  `tailscale`), `DirectPortNumber`, `TailscaleName`, `DirectSocketUrl`, `DirectWebUrl`, `DirectRoute {way, socket, web}`,
  `DirectAddresses {port, lan, tailscale, routes}`, `DIRECT_LAN_ADDRESSES_MAX`, `DIRECT_ROUTES_MAX`,
  `directRoutesFor(addresses, {secureOnly})`; **`Welcome.direct`** (`DirectAddresses | null`, required: null on the
  `enroll` channel).
- Tailscale (`session/tailscale.ts`): `TAILSCALE_STATES`, `TailscaleState` (`off` | `starting` | `needs_sign_in` |
  `needs_approval` | `on` | `error`), `TAILSCALE_PROBLEMS`, `TailscaleProblem`, `TailscaleLoginUrl`,
  `TAILSCALE_ADDRESSES_MAX`, `TailscaleStatus {state, loginUrl, name, addresses, tailnet, https, problem}` (Go
  `protocol.TailscaleStatus`), `tailscaleStatusValid`, `TAILSCALE_OFF`, `TAILSCALE_POLL_MS`; ops (owners)
  `host.tailscale` (`HostTailscaleInput` → `HostTailscaleOutput {tailscale | null, reason?}`), `host.tailscale.on`
  (`HostTailscaleOnInput`), `.off` (`HostTailscaleOffInput {signOut?}`, destructive), `.signIn`
  (`HostTailscaleSignInInput`) → `HostTailscaleChangeOutput {tailscale}`; `TAILSCALE_ERROR_CODES`, `TailscaleErrorCode`
  (`tailscale.unavailable`, `tailscale.busy`).
- Manager socket (`@whombat/control-contracts/local`, Go `local`): `MANAGER_PATHS.tailscaleState`, `.tailscaleOn`,
  `.tailscaleOff`, `.tailscaleSignIn`, `.tailscaleCert` (`/v1/tailscale/state|on|off|sign-in|cert`);
  `TailscaleStateRequest`, `TailscaleStateResponse {v, tailscale}`, `TailscaleOnRequest`, `TailscaleOffRequest
  {v, signOut?}`, `TailscaleSignInRequest`, `TailscaleCertRequest`, `TailscaleCertResponse {v, name, certPem, keyPem,
  notAfter}`.
- Development enrolment: **`enroll.dev`** (`EnrollDevInput {account: {name, email}, endpoint}` → `EnrolledOutput`,
  `enroll` channel), `ENDPOINT_ENROLLED_VIA` `dev`, error code `dev_only`.
- Version: `VERSION_REFUSAL_COPY`.
- Fixtures (`@whombat/fixtures`, now depending on `@whombat/protocol`): `DIRECT_ADDRESSES`, `DIRECT_ADDRESSES_LAN_ONLY`,
  `TAILSCALE_STATES_FIXTURE`.

## Removed

- Versions and features (`@whombat/protocol`): `session/features.ts` whole (`RUNTIME_FEATURES`, `RuntimeFeature`,
  `LEGACY_FEATURES`, `WelcomeRuntime`, `runtimeHasFeature`, the `ApiLevel`/`FeatureName` re-exports);
  `SESSION_API_LEVEL`, `LEGACY_API_LEVEL`, `apiLevelWindow`, `runtimeSkew`, `SUPPORTED_SESSION_VERSIONS`;
  `Welcome.runtime`. Core: `FeatureName`, `ApiLevel`, `ReleaseManifest.apiLevel`, `.features`. Control:
  `ReleaseRecord.apiLevel`, `.features`; `FleetSummary.releases[].apiLevel`.
- HTTP sign-in (`@whombat/core/contracts`, `/domain`, `/ids`): `api.auth` whole (`auth.requestMagicLink`, `.options`,
  `.tailscale`, `.acceptInvite`, `.verify`, `.session`, `.logout`, `.listTokens`, `.createToken`, `.revokeToken`),
  `authEndpoints`, `SESSION_COOKIE`, `RequestMagicLinkBody`, `SignUpPolicy`, `AuthOptions`, `TailscaleSignInBody`,
  `AcceptInviteBody`, `VerifyBody`, `SignedInResponse`, `SessionResponse`; `ClientKind`, `Session`, `ApiToken`;
  `SessionId`, `TokenId`. (Files renamed: `contracts/auth.ts` → `contracts/me.ts`, `domain/auth.ts` →
  `domain/account.ts`; import names unchanged.)
- The agent on the host: `AgentAccess`, `AgentCheckout`, `TurnSandbox`, `TurnCommands`, `TurnAccess`,
  `turnAccessLabel`, `AGENT_CHECKOUT_COPY`, `AGENT_ACCESS_COPY`, `AgentRuntimeChange`, `diffAgentRuntime`,
  `describeRuntimeChange`, `describeDefaultWorkdirChange`, `AgentRuntimeInput`; `domain/workdir.ts` whole (`Workdir`,
  `WORKDIR_MAX_LENGTH`, `normalizeWorkdir`, `parseWorkdirRoots`, `expandHome`, `isWithinPath`, `displayPath`, …);
  `WorkdirInput`, `SetAgentRuntimeBody`, `SetAgentRuntimeResponse`, op `agent.setRuntime`; `SetBurrowWorkdirBody`, op
  `burrows.setWorkdir`; fields `AgentRuntime.workdir`, `.checkout`, `.access`, `Burrow.defaultWorkdir`, `Run.access`,
  `ProgressBody.access`, `BackupAgentRuntime.workdir`, `.checkout`, `.access`, `BackupSettingsRecord.defaultWorkdir`.
- Host facts: `HostInfo.home`, `.workdirRoots`. GitHub: `GitHubStatusResponse.via`. AI clients:
  `ClientStatus.installed.source`.
- `/ws`: `WS_PATH`, `ClientMessage`, `ServerMessage`, `parseClientMessage`, `parseServerMessage`.
- Session-native `providers.*` ops (`providers.list`, `.login.start`, `.login.submit`, `.login.status`,
  `.login.cancel`, `.logout`, `.org.list`, `.org.login.start`, `.org.remove`) and `ProvidersListInput`,
  `ProviderLoginStartInput`, `ProviderLoginSubmitInput`, `ProviderLoginRefInput`, `ProviderLogoutInput`,
  `ProvidersOrgListInput`, `ProvidersOrgLoginStartInput`, `ProvidersOrgRemoveInput`, `PROVIDER_OP_EQUIVALENTS`, and
  `@whombat/protocol/session`'s re-exports of `ProviderLogin`, `ProvidersListOutput`, … (import them from
  `@whombat/core`): use `signins.*`.
- Error codes `managed.trusted_access`, `.sandbox_fallback`, `.api_tokens`, `.email_sign_in`, `.host_directories`,
  `.host_admin`. `EnrollClaimOutput.recoveryKitRequired`.
- `AvatarMotionPreference`, `DEFAULT_AVATAR_MOTION`, `Preferences.avatarMotion`.
- Packs: `@whombat/core/packs` subpath (`PackName`, `PackVersionString`, `PackLimits`, `PACK_LIMITS`,
  `PACK_MANIFEST_FILE`), `PackVersionSummary`, `PackId`, `PackVersionId`, `PackAttachmentId`.
- The 0.70 recipe fixture (`__fixtures__/recipes-0.70.ts`, not exported); `DispatchAgentStep.trackerAccess`,
  `AutomationRecipe.organizationAccess`; `HomeOverview.working`.

## Changed

- Required now (the producer always sends them; CT-1282, CT-1285): `DispatchContext.planStep`, `.files`, `.scratch`,
  `.vault`, `.computer`, `.gh`, `.gateway`, `.localModel`, `.schedule` (nullable), the computer context's `lan`;
  `DeskScreen.paired.you`, `.hasPin`, `.self`, `display`, `on`, `onChosen`, `presenceAvailable`, `lockAgain`,
  `cameraWakeAvailable`; `DeskPaired.hasPin`, `DeskDecideAnswer.result` (Go values, not pointers);
  `ThreadView.more`; a feedback report's `can.decide`; `RuntimeFacts.clientAdapters` (Go a value);
  `HomeOverview.chats`, `.generatedAt`; `Automation.recentRuns`, `.glance`, `AutomationRunSummary.waitingOn`.
- `AgentRuntime` = `AgentModelRuntime` + `credentialSource?`; `DEFAULT_AGENT_RUNTIME` `{provider: 'claude'}`.
- `HostInfo {deployWorkflow, computers}`, both required. `GitHubStatusResponse.signInNeeded` required.
  `ClientStatus.installed {version, installedAt}` (`installedAt` never null). `Account.title`, `.isAdmin`,
  `.canCreateBurrows` required. `SESSION_EXCLUDED_API_OPS` is `['devices.vapidKey']`.
- `hello.versions` carries `{major: 2, …}`; `negotiateVersion`'s second argument is one version.

## Kept on purpose

- `decodeTolerant` and friends (minors within a major); the client security floor; the relay, admission tickets,
  frames, secure-channel, claim, licence, release (schema rollback classes), control-contracts and the Go bindings.
- `managed.feedback_intake`, `.automation_webhooks`, `.google_connect`, `.provider_*`: refusals the one runtime still
  gives by policy. The audit type `burrow.workdir_changed` (history). `@whombat/fixtures/fetch` (the mock REST the
  app's fixture tests use), without the workdir parts.

# Step 5 — the community edition (1.1.0)

For the streams that code against `he5-c` (Whombat R5; whombat-app W5; appliance E5). Names only; the decisions are
CT-1300…CT-1349 in `docs/contracts/decisions/contracts.md`. Everything is an addition within session major 2
(`SESSION_PROTOCOL` `{major: 2, minor: 1}`); a 1.0 box reads as `commercial`.

## The edition

- `@whombat/protocol` (and `/session`; Go `protocol.Edition`): `EDITIONS`, `Edition` (`commercial` | `community`),
  `DEFAULT_EDITION`, `editionOf`, `EDITION_PARTS` (`relay`, `control`, `remote_help`, `licence`, `phone_push`,
  `local_claim`), `EditionPart`, `editionHas(edition, part)`.
- **`Welcome.edition`** (optional; absent = `commercial`).
- `@whombat/protocol/direct` (Go `protocol.DirectIdentity`, `ParseDirectIdentity`): **`DirectIdentity {v: 1, appliance,
  edition?, claimed?}`**, the JSON of a plain GET of `/v1/direct` (the runtime writes all four).

## The claim on the box's own page (community only; enrollment channel)

- Ops: **`enroll.claim.local.start`** (`EnrollClaimLocalStartInput {}` → `EnrollClaimLocalStartOutput {claimId,
  expiresAt}`, ephemeral), **`enroll.claim.local.begin`** (`EnrollClaimLocalBeginInput {claimId, share}` →
  `EnrollClaimLocalBeginOutput {share}`, ephemeral), **`enroll.claim.local`** (`EnrollClaimLocalInput {claimId, confirm,
  account: {name, email}, endpoint}` → `EnrollClaimOutput`). `LocalClaimId`, `LOCAL_CLAIM_TTL_S` (300).
- PAKE (`@whombat/protocol/claim`): `LocalClaimPakeContext {password, appliancePeerId, clientPeerId, claimId}`,
  `localClaimPakeCi`, `localClaimPakeInputs`, `localClaimPakeInitiator`, `localClaimPakeInitiatorFinish`,
  `localClaimPakeResponder`, `LocalClaimPakeInitiatorState`, `LOCAL_CLAIM_CI_TAG`, `LOCAL_CLAIM_CONFIRM_INFO`; shares, tags
  and `claimConfirmEqual` as the claim's. Vectors: `cpace.json` `localClaim`.
- Refusals (`details.code`): new `claim_local_unavailable` (`not_allowed`: not a community box), `claim_start_missing`
  (`conflict`); as the claim's `claim_used`, `claim_not_ready`, `claim_backoff` (`ClaimBackoffDetails`),
  `claim_begin_missing`, `claim_invalid`, `claim_share_invalid`, `rate_limited`.
- The first owner: `account {name, email}`; the burrow follows with `burrows.create`. `endpoint.enrolled` `via: 'claim'`.

## Links the box makes, device links

- `@whombat/protocol/session` (`local-links.ts`): `LOCAL_LINK_KINDS` (`invite`, `reenroll`, `device`), `LocalLinkKind`,
  `LOCAL_LINK_PATHS` (`/join`, `/get-back-in`, `/add-device`), `LOCAL_LINK_MAX`, `LocalLinkSecret`, `LocalLinkParts
  {kind, appliance, secret, routes}`, **`localLinkFor(parts)`** (the box; throws without a route),
  **`parseLocalLink(text)`** (clients; null when it isn't one), `LocalLink` (schema). Format:
  `<first page><path>#s=<secret>&p=<PeerId>&l=<LAN page>&t=<Tailscale page>…`.
- **`EnrollInviteCreateOutput.link?`** and **`EnrollReenrollCreateOutput.link?`** (`LocalLink`, absent without a direct
  way). `enroll.invite.accept` and `enroll.reenroll.accept` unchanged.
- Ops: **`enroll.link.create`** (`EnrollLinkCreateInput {}` → `EnrollLinkCreateOutput {linkId, secret, expiresAt, link}`;
  app channel, secret) and **`enroll.link.accept`** (`EnrollLinkAcceptInput {secret, endpoint}` → `EnrolledOutput`;
  enrollment channel, secret). `DeviceLinkId`, `DeviceLinkSecret`, `DEVICE_LINK_TTL_S` (300). `ENDPOINT_ENROLLED_VIA`
  adds `link`. Refusals: `link_unavailable` (`unavailable`), `link_invalid` (`forbidden`), `link_expired` (`expired`),
  `link_used` (`conflict`), `endpoint_enrolled`, `rate_limited`.

## Tailscale's own login server, and its signed events

- `@whombat/protocol/session` (`tailscale.ts`): `TailscaleLoginServer`, `TAILSCALE_LOGIN_SERVER_MAX`,
  `TAILSCALE_LOGIN_SERVER_PROBLEMS`, `TailscaleLoginServerProblem`, `normalizeTailscaleLoginServer(raw)`,
  `tailscaleLoginUrlTrusted(loginUrl, loginServer)`; **`TailscaleStatus.loginServer?`** (absent = Tailscale's own;
  `tailscaleStatusValid` also checks the login link's origin); `TailscaleLoginUrl` admits `http://`;
  **`HostTailscaleOnInput {loginServer?: TailscaleLoginServer | null}`** (absent keeps, `null` = Tailscale's own, another
  signs out of the tailnet first).
- Manager socket (`@whombat/control-contracts/local`, Go `local`): **`TailscaleOnRequest {v, loginServer?}`** — the
  wanted server, absent for Tailscale's own; the manager keeps it across restarts.
- Signed appliance events `tailscale.on`, `tailscale.off`, `tailscale.sign_in` with `TailscaleAuditPayload {byAccountId,
  loginServer, loginServerChanged, signOut}`.

## Web Push and mail without control

- **`devices.vapidKey`** comes over the session (app channel): `VapidKeyResponse {publicKey: VapidPublicKey}`
  (`@whombat/core/contracts`); `SESSION_EXCLUDED_API_OPS` is `[]`. Refusal `push.web_unavailable` (`not_allowed`).
  `Bootstrap.capabilities.webPush` / `.emailNotifications` follow the box's keys and mail server.
- `@whombat/protocol/session` (`mail.ts`): `MAIL_SECURITY`, `MailSecurity`, `MAIL_DEFAULT_PORTS`, `MailHost`,
  `MailPort`, `MailUsername`, `MailPassword`, `MailFromName`, `MailSettingsInput`, `mailSettingsProblem`
  (`login_without_tls`), `MAIL_TEST_STATES`, `MailTestState`, `MailTest {state, at, to, detail}`, `MailSettings {source,
  host, port, security, username, hasPassword, from, fromName, updatedAt, lastTest}`, `MAIL_ERROR_CODES`
  (`mail.in_config`, `mail.not_set`, `mail.busy`), `MAIL_TEST_MESSAGE {subject, text}`, `MAIL_TEST_TEXT`,
  `MailAuditPayload {byAccountId, server}`.
- Ops (owners): **`host.mail`** (`HostMailInput` → `HostMailOutput {mail | null}`, read), **`host.mail.set`**
  (`HostMailSetInput` → `HostMailOutput`; secret), **`host.mail.test`** (`HostMailTestInput {draft?}` →
  `HostMailTestOutput {test}`; secret; to the asking owner's own email), **`host.mail.remove`** (`HostMailRemoveInput` →
  `HostMailOutput`; destructive). Signed events `mail.set`, `mail.removed`.

## Also

- `passkeys_unavailable_here` in `APP_ERROR_CODES`; passkeys on a community box's Tailscale page use its name as the RP ID
  (`PasskeyRpId` admits it).
- Fixtures (`@whombat/fixtures`): `COMMUNITY_APPLIANCE`, `DIRECT_IDENTITY_UNCLAIMED`, `DIRECT_IDENTITY_CLAIMED`,
  `LOCAL_CLAIM_START`, `LOCAL_INVITE_LINK`, `DEVICE_LINK`, `TAILSCALE_HEADSCALE` (`needs_sign_in`, `on`),
  `MAIL_SETTINGS`.
- Nothing removed; nothing changed in meaning. `appliance.status.claimReported` and the licence mean nothing on a
  community box (no control; the licence is absent as on a development runtime).

# Step 6 — Hermes's skills only (2.0.0)

For the streams that code against `hsk-c` (Whombat P, R; whombat-app W; appliance). Names only; the decisions are
CT-1400…CT-1449 in `docs/contracts/decisions/contracts.md` and Whombat's `docs/decisions/hermes-skills.md` (HSK-01…HSK-16).
**Session major 3** (`SESSION_PROTOCOL = {major: 3, minor: 0}`): a 1.x app or box and a 2.0 one refuse each other.

## Removed

- `@whombat/core/skills`: Whombat's scanner (`skills/scan.ts`: `scanSkillContent`, `scanSkillProposal`,
  `scanRefusalText`, `ScanFile`, `SCAN_CATEGORIES`, `SCAN_CATEGORY_LABELS`, `SCAN_VERDICT_LABELS`, `SCAN_EXCERPT_MAX`,
  the old `SkillScan`); the `whombat:` line (`skills/meta.ts`: `SkillMeta`, `SkillMetaInput`, `emptySkillMeta`,
  `parseSkillMeta`, `ParsedSkillMarkdown`, `renderSkillMeta`, `skillMetaLine`, `sanitizedSkillMarkdown`,
  `skillFrontMatterExtra`, `SKILL_META_KEY`, `SKILL_FRONT_MATTER_KEYS`); readiness (`skills/readiness.ts`:
  `skillReadiness`, `SkillReadiness`, `SkillReadinessAgent`, `SKILL_REQUIREMENT_KEYS`, `SKILL_REQUIREMENT_LABELS`);
  `skills/library.ts` (`serverSkillKinds`, `missingSkillNeeds`, `SKILL_IMPORT_MAX_SKILLS`, `SKILL_IMPORT_MAX_BYTES`);
  Whombat's needs (`SKILL_REQUIREMENTS`, `SkillRequirement`, `SkillRequirements`, `SkillPrerequisites`,
  `SkillPrerequisitesInput`, `SkillConnectionId`, `SkillServerKind`, the old `SkillNeeds {connections, servers}`);
  `SKILL_SOURCES`, `SkillSource`, `SKILL_CATEGORY_FILE`, the old `SkillCategoryInfo {title, description}`; the folder
  check (`validateSkill`, `ValidateSkillOptions`, `SkillValidation`, `SkillProblem`, `SkillEntry`).
- `@whombat/core/domain`: `skillLinkRawUrl`, `skillLinkFiles` (Add skills from a link).
- `@whombat/core/contracts`: `skills.importPreview`, `skills.importCommit` and the old `skills.hubSearch` with
  `SkillImportPreviewBody`, `SkillImportPreview`, `SkillImportItem`, `SkillImportCommitBody`,
  `SkillImportCommitResponse`, `SkillImportUrl`, `SKILL_IMPORT_SOURCES`, `SkillImportSource`, `SKILL_IMPORT_CLASHES`,
  `SkillImportClash`, `SKILL_IMPORT_MAX_BASE64`, `SKILL_IMPORT_URL_MAX`, `SKILL_IMPORT_SECRETS_MAX`,
  `SKILL_IMPORT_NOTES_MAX`, `StagedArchiveId`, `SKILL_HUBS`, `SkillHub`, `SKILL_HUB_TRUST`; `SkillLibraryItem.source`,
  `.group`, `.missing`; `SkillStatus` `ready`, `needs_setup`, `hidden`. Runner steps: `skills.put`;
  `HermesSkillSummary.source`, `.requires` and the old `.needs`; origins `shipped`, `imported`.
- `@whombat/core/ids`: `SkillImportId` (the `ski` prefix stays taken).
- `@whombat/protocol` (`/session`): `skills.stage` (`SkillsStageInput`, `SkillsStageOutput`), the `skill-archive`
  upload target, `SkillStagedUploadOutput`, `StagedArchiveId`, `SKILL_ARCHIVE_MAX_BYTES`, `SKILL_STAGED_TTL_S`,
  `SKILL_STAGED_MAX_PER_ACCOUNT`; codes `skill_archive_too_large`, `skill_staged_*`. `EXPORT_OPS` is `[]`.

## Changed

- `SkillLibraryItem {name, description, category, origin, hub, scope, enabled, changed, originalChanged, overrides,
  status, needs, shareRequest, version, updatedAt, can}`: `origin` `SkillOrigin` (`builtin` | `hub` | `shared` |
  `learned`); `hub` `SkillHubInfo {source, identifier, trust, updateAvailable}` or null; `category` `SkillCategory`
  (Hermes's first folder) or null; `status` `on` | `off` | `removed`; `needs` `SkillNeeds {env: [{name, optional}],
  commands, files}`; `changed` / `originalChanged` / Restore / Compare mean a built-in an owner changed / Hermes ships a
  newer version / Hermes's reset / Hermes's diff. `SkillCan` adds `update`.
- `SkillLibraryResponse {agentName, items, categories, canAdd}` (`categories`: `SkillCategoryInfo {category, title,
  description}`, Hermes's `DESCRIPTION.md`). `LibrarySkillResponse.original {text, changes: SkillFileChange[]}`.
- `skills.hubSearch` (same id, new shape): query `SkillHubSearchQuery {q?, source?}` → `SkillHubSearchResponse {results:
  SkillHubResult[], unreachable: SkillHubSource[]}`; `SkillHubResult {source, identifier, name, description, trust,
  repo, path, installs, installed}`. `SkillTrust` is `builtin` | `trusted` | `community`; `ScanFinding`, `ScanVerdict`,
  `ScanSeverity`, `ScanCategory`, `SCAN_FINDINGS_MAX` are Hermes's (`skills/hub.ts`); `SkillScan {verdict, findings,
  findingsTotal}` is in `/contracts`.
- Runner (`HERMES_HOME_METHODS`): `HermesSkillPath` takes up to three segments (`mlops/training/axolotl`);
  `HermesSkillOrigin` `builtin` | `hub` | `shared`; `HermesSkillSummary` gains `hub` (`HermesHubEntry`) and Hermes's
  `needs`; `skills.list` answers `categories` (`HermesSkillCategory`); `skills.read`'s `original {text, changes}`;
  `skills.sync` → `{added, updated, kept, removed}` (names); `skills.restore` is Hermes's reset; `skills.remove` refuses a
  hub skill (`invalid`). `HermesHomeErrorCode` adds `unavailable` and `blocked`.
- `SESSION_PROTOCOL` `{major: 3, minor: 0}`. Every package 2.0.0.

## New

- `@whombat/core/skills`: `SKILL_ORIGINS`, `SkillOrigin`, `skillCategoryTitle`, `SKILL_CATEGORY_DESCRIPTION_MAX`,
  `SkillEnvName`, `SkillCommandName`, `SkillCredentialFile`, `SkillEnvNeed`, `SkillNeeds`, `NO_SKILL_NEEDS`,
  `SKILL_NEEDS_MAX` (16), `skillNeedsText`; `front-matter.ts` (`skillFrontMatter`, `skillBody`,
  `SKILL_MD_DESCRIPTION_MAX`, moved); `hub.ts`: `SKILL_HUB_SOURCES` (`official`, `github`, `skills-sh`),
  `SkillHubSource`, `SKILL_HUB_SOURCE_TEXT`, `SKILL_HUB_GITHUB_REPOS`, `SkillHubIdentifier`, `skillHubSourceOf`,
  `SKILL_TRUST_LEVELS`, `SKILL_TRUST_TEXT`, `SCAN_TRUST_LEVELS`, `ScanTrust`, `SCAN_VERDICTS`, `SCAN_VERDICT_TEXT`,
  `SCAN_SEVERITIES`, `SCAN_CATEGORY_TEXT`, `scanCategoryText`, `SCAN_MATCH_MAX`, `SKILL_INSTALL_DECISIONS`,
  `SkillInstallDecision`, `SkillPolicy {decision, reason}`, `skillPolicyReasonText`, `SKILL_UPDATE_CHECK_MS`.
- Session ops (owners): **`skills.hubPreview`** (`SkillHubIdentifierQuery` → `SkillHubPreview {result, text, files,
  needs, platforms, scan, policy, nameTaken}`), **`skills.hubInstall`** (`SkillHubInstallBody {identifier}` →
  `SkillInstalledResponse {item}`, 201), **`skills.hubUpdates`** (→ `SkillHubUpdatesResponse {checkedAt, available,
  unreachable}`), **`skills.hubUpdate`** (`SkillHubUpdateBody {name}` → `SkillInstalledResponse`). `SKILL_FILE_CHANGES`,
  `SkillFileChange`, `SKILL_CATEGORIES_MAX`. Install and update are `never` resent; previews, searches and the update
  check are reads.
- Runner steps: **`skills.scan`** (`HermesSkillScan {trust, verdict, findings, findingsTotal, decision: allow | block |
  ask}`), **`skills.hubSearch`** (`HermesHubResult`), **`skills.hubInspect`**, **`skills.hubInstall`**,
  **`skills.hubUninstall`**, **`skills.hubCheck`** (`HermesHubUpdateStatus`), **`skills.hubUpdate`**.
- `@whombat/protocol`: **`EXPORT_READ_OPS`** (`skills.library`, `.librarySkill`, `.librarySkillFile`, `.shareRequest`,
  `.hubSearch`, `.hubPreview`: read through an export stream). Codes `skill_hub_unavailable`, `skill_blocked`,
  `skill_exists`.
- Audit: `skill.installed`, `skill.updated` (`skill.imported` stays for the log's history).
- Fixtures: the mock world's skills are Hermes's (built-in, hub, shared, learned); `FIXTURE_SKILL_CATEGORIES`,
  `FIXTURE_HUB_RESULTS`, `fixtureHubPreview`; the fixture fetch serves the hub ops.

## Kept on purpose

- `skills/secrets.ts` (`redactSecrets`, `literalSecretKind`, `entropy`, `REDACTED`): `turnFailureDetail` redacts with it,
  and a finding's `match` is redacted with it. `skills/files.ts` keeps `SKILL_MD`, `SKILL_LIMITS`, `skillPathProblem`,
  `decodeText`, `skillContentHash`, `SkillFileInfo`, `SKILL_PROVIDER_FILE`; `domain/skills.ts` keeps
  `LibrarySkillBody`, `SkillDescription`, `SkillFilePath`, `SKILL_FILE_DIRS` (an owner's edit).
- `skill_share` approvals, `skills.libraryShare`, `skills.shareRequest` (HSK-11); the backup's `hermes_skills` record.

# Step 7 — ChatGPT by name, and listing Hermes sessions (2.1.0)

For the streams that code against `hn-ct` (Whombat HN; whombat-app). Names only; the decisions are CT-1450…CT-1499 in
`docs/contracts/decisions/contracts.md` and Whombat's `docs/decisions/hermes-native.md` (HN-02…HN-04, HN-K03). A minor:
`SESSION_PROTOCOL` stays `{major: 3, minor: 0}`; no id, enum or wire value changes.

## Changed (words)

- `@whombat/core/domain`: `PROVIDER_LABELS.codex` “ChatGPT”.
- `@whombat/core/text`: `USAGE_PROVIDER_LABELS.codex`, `GATEWAY_TOOL_LABELS.codex` “ChatGPT” (and every gateway line
  built on it: switch, hint, confirmation, “Runs on”, Usage, refusal, alerts, Keys); `turnFailureText`'s provider names;
  `unrunnableReply` (`no_provider`); `agentsBlockedNotice`. `providerStateLabel(setup)` takes an optional `provider`:
  ChatGPT is “Ready” without a version, “Not ready” when `missing`/`logged_out`. `providerFix` for ChatGPT has no
  command.
- Catalog `fusebox`, `ai_gateway`: description, tagline, key and address help, guide. Endpoint summaries of
  `clients.list`, `host.agents`, `host.recheckAgents`, `usage.list`, `burrows.setAiGateway`.

## New

- Runner step (`HERMES_HOME_METHODS`): **`sessions.list`** (`{account}` → `{sessions: HermesSessionListing[] {id, source,
  lastActiveAt}, more}`), `HERMES_SESSIONS_LIST_MAX` (5 000), `HermesSessionListing`.

# Step 8 — One person: one skills list and the person's Hermes profile (3.0.0)

For the streams that code against `one-person` (Whombat S2, R; whombat-app W, M; appliance). Names only; the decisions
are CT-1570…CT-1589 in `docs/contracts/decisions/contracts.md` and Whombat's `docs/decisions/one-person.md` (OP-08, OP-17).

## Removed

- `@whombat/core/skills`: `SKILL_SCOPES`, `SkillScope`; origin `shared`.
- `@whombat/core/contracts`: **`skills.libraryShare`**, **`skills.shareRequest`**, `SkillShareBody`,
  `SkillShareResponse`, `SkillShareRequest`; `SkillCan.share`; `SkillLibraryItem.scope`, `.overrides`,
  `.shareRequest`; `SkillLibraryResponse.canAdd`; `SkillRefQuery.scope` (so `SkillRemoveBody`'s). Runner steps:
  **`skills.share`**; `HermesProfileRef`, `HermesSkillScope`; `HermesSkillSummary.scope`, `.overrides`; `skills.list`'s
  `shared`/`learned`; every step's `account` (memory, sessions, skills) and `SkillRef.scope`/`.account`.
- `@whombat/core/domain`: `SkillShareAction` (`skill_share`), `DeskPhoneReason` `share`; `AgentNotes.updatedBy`,
  `.canEdit`; `NOTES_COPY.readOnly`, `.private`. `@whombat/core/approvals`: `SKILL_SHARE_CTA`.
- `@whombat/protocol`: `EXPORT_READ_OPS` loses `skills.shareRequest`; operation safety of the two ops.
- Fixtures: `ownerCan` (now `skillCan`).

## Changed

- `SkillOrigin` / `HermesSkillOrigin` `builtin` | `hub` | `learned`; `HermesSkillSummary.origin` is never null.
  `SkillRefQuery {name}`. `skills.list` → `{skills, categories}`; `skills.read`, `.readFile`, `.export`, `.scan`,
  `.write`, `.remove` take `{path, …}`. `memory.read` `{}`, `memory.write {file, entries, ifVersion?}`,
  `memory.clear {file?}` (the person's); `sessions.delete {home, sessions}`, `sessions.pending {home}`,
  `sessions.list {home}`. `HermesHomeRef` `{kind: 'profile', home}` (a home's profile without `skills/`) | `{kind:
  'skills'}` (the person's profile's `skills/`). Backups: `hermes_home {home, archive}`.
- `Approval.keyId` is a `KeyId` again (never null); `actionKey` always answers one.
- `skill.shared` leaves `EVENT_TYPES` (CT-1508); a signed one stays readable.

## New

- `HERMES_HOMES` (`person`, `outside`), `HermesHome`, `HERMES_HOME_PROFILES` (`default`, `_feedback`): the two Hermes
  homes (the lead with R1). `sessions.delete`, `.pending`, `.list` take `home`, and `HermesHomeRef` is
  `{kind: 'profile', home} | {kind: 'skills'}`; memory and skills are the person's only.

## The rest of 3.0.0 (CT-1500…CT-1549, CT-1599)

The whole list, with the people, the computer and the services, is the C-READY marker
(`~/.cache/wb-tmp/one-person/C-READY`) and `docs/contracts/decisions/contracts.md` CT-1500…CT-1599. In short:

- `@whombat/core/computer` → **`@whombat/core/commands`** (the guard, categories, allowances, their copy).
- Runner: `DispatchContext.computer` → **`commands`** (`DispatchCommandsContext`, `CommandProductionServer`),
  `DispatchContext.outside`, `DispatchCredential {v, provider, authMode}`, `runner.computerKeys` → **`runner.turnKeys`**
  (`TurnKeys`, `CommandKeyPath`, `VaultMcpServer`), `ComputerOpening` → `CommandOpening`, new **`runner.notify`**;
  `runner.computerReport` and `ProgressBody.computerBegun` gone; the sign-in steps without `owner`.
- New **`services.list`**, **`services.stop`** (`AgentService`, `ServicesListResponse`, `StopServiceResponse`),
  `HostInfo.services`, the `services.changed` event, audit `service.stopped`.
- Gone: `members.*`, `enroll.invite.*`, `enroll.reenroll.*`, `admins.*`, `presence.*`, `computers.*`,
  `agent.setCredentialSource`, `signins.org*`; roles, presence, credential sources, per-person spend and usage.
- Session major **4**.

