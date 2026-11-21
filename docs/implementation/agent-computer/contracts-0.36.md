# Contracts 0.36.0 — what the agent-computer streams build on

Released 2026-10-02: whombat-contracts main `e20eb87` (merge of `agent-computer`), tag `contracts-v0.36.0`, pushed;
decisions CT-217…CT-227 in `~/Code/whombat-contracts/docs/decisions/contracts.md` (CT-226 lists where names differ from
the assignment). Vendored into Whombat `agent-computer` (`441a080b`) and whombat-app `agent-computer` (`63b2e47`,
worktree `~/Code/.wt/app-agent-computer`); the stubs each left are listed at the end. A computer is an unprivileged
container inside the appliance (AC-00): `AgentComputer.kind` is `'container'`.
Source of truth: `~/Code/whombat-contracts/packages/core/src/computer/*`, `domain/approval.ts`, `keys/{catalog,grants,
actions}.ts`, `approvals/{copy,display,transitions}.ts`, `vault/{computer,schemas,copy,tools}.ts`,
`contracts/{computers,runner,vault,mcp-vault,agents,work,host,skills,mcp-skills}.ts`, `domain/skills.ts`,
`packages/protocol/src/session/*`. New subpath **`@whombat/core/computer`** (also re-exported from the root).

## Commands and the guard (`@whombat/core/computer`, CT-217, CT-218)
- `COMMAND_CATEGORIES` / `CommandCategory`: `deploy`, `deploy_production`, `merge`, `push_main`, `destructive`,
  `message_external`. `COMMAND_CATEGORY_KEYS`, `commandCategoryKey(c)` → `deploy`, `deploy.production`, `merge.main`,
  `branch.main.push`, `commands.destructive`, `messages.external`. `COMMAND_CATEGORY_RANK` (most severe first:
  deploy_production > push_main > merge > deploy > destructive > message_external), `moreSevereCategory(a, b)`.
- `COMMAND_SCOPES` / `CommandScope`: `once`, `task`, `agent`. `COMMAND_MAX` 8000, `COMMAND_TARGET_MAX` 253,
  `COMMAND_REASON_MAX` 500. `normaliseCommand(command)` (whitespace runs → one space, trimmed).
- `classifyCommand(command, ctx: ClassifyContext {productionServers: ClassifyProductionServer[] {name, host,
  addresses?}, defaultBranches?})` → `CommandClassification {category, target, summary} | null`. `DEFAULT_BRANCHES`
  `['main','master']`, `CLASSIFY_MAX_DEPTH` 4. Never throws. Targets: production server's name, the branch, the repo
  (merge, when named), the other host (destructive), the webhook host or mail address. Full rules in CT-218.

## The `run_command` approval (CT-217)
- `RunCommandAction` `{type: 'run_command', params: {command, category, target, reason}}` in `ApprovalAction`;
  `SERVER_ONLY_ACTION_TYPES` = `['vault_use', 'run_command']`. `Approval.scope?: CommandScope | null` (the scope chosen).
- `actionKey` → `commandCategoryKey(category)`; `actionScope` → `{branch}` for `push_main`, else `{}`;
  `describeAction`/`describeActionForLog` never contain the command: `runCommandPhrase(category, target)` (“run a command
  on the production server web-1”, “run a deploy command”, “run a command that pushes to main”, “run a destructive
  command on staging”, …). `undoBlock` → `already_executed` (no Undo).
- Copy: title “Run a command on the production server web-1”, question + “?”, target “web-1 · Deploy to production”,
  WHAT HAPPENS 01 “Run “<command>” on Banjo’s computer”. Verbs “run the command” / “ran”.
- `ApprovalView.content` = `{label: 'COMMAND', text: command}`; new **`ApprovalView.scopeChoices`** `{scope, label}[] |
  null` (“Allow once”, “Allow for this task”, “Always allow for Banjo”; null for other actions); `cta`/`mobileCta` “Allow
  once”; `declineCta` “Don’t allow”. Messages/toasts after a yes: “Allowed once. Banjo runs the command in its turn.”
  (`task` “Allowed for this task.”, `agent` “Always allowed for Banjo.”).
- **`approvals.decide`** body is `DecideApprovalBody {decision, note?, scope?}`; `scope` only with approve of a
  `run_command` (else `validation_failed`); absent = once.
- Runner/agent copy (`computer/copy.ts`): `commandBlockedText(category, agentName)` (Off, exit 126),
  `commandWaitingText(category)`, `commandDeclinedText(personName)` “Mara said no; the command didn’t run.” (exit 126),
  `commandTimedOutText(minutes)` (exit 125), `commandAllowedText(scope, personName)`, `COMMAND_EXIT_CODES` `{refused:
  126, timedOut: 125}`, `COMMAND_APPROVAL_WAIT_MINUTES_DEFAULT` 15, `COMMAND_CATEGORY_LABELS`, `commandScopeLabels(agent)`,
  `COMMAND_DECLINE_CTA`.

## Command allowances (CT-221)
- `CommandAllowance {id: CommandAllowanceId ('cma_'), agentId, keyId, command (normalised), target | null, createdById,
  createdAt}`; `ID_PREFIXES.commandAllowance` `cma`; `COMMAND_ALLOWANCES_MAX` 200.
- `agents.commandAllowances` GET `/burrows/:burrow/agents/:agent/command-allowances` → `CommandAllowancesResponse
  {allowances}`; `agents.removeCommandAllowance` DELETE `…/command-allowances/:allowanceId` → `{allowances, eventId}`
  (`agents.manage`).
- Copy: `COMMAND_ALLOWANCES_COPY` {title ALWAYS ALLOWED COMMANDS, empty, remove, removed}, `commandAllowanceLine(a)`
  (“web-1 · Deploy to production”).

## Computers (CT-219)
- `COMPUTER_STATES` / `ComputerState`: `unavailable`, `none`, `creating`, `stopped`, `running`, `error`.
  `COMPUTER_KINDS` `['container']` / `ComputerKind`. `COMPUTER_DEFAULTS` `{cpus: 2, memoryMiB: 4096, diskGiB: 40,
  idleMinutes: 30}`, `COMPUTER_REASON_MAX` 500.
- `AgentComputer {agentId, state, kind, reason, cpus, memoryMiB, diskGiB, diskUsedGiB, imageVersion, createdAt,
  lastUsedAt, servingAccountId}`.
- Ops `api.computers.*` (session ops too): `computers.get` GET `/burrows/:burrow/agents/:agent/computer` (anyone who can
  see the agent); `computers.start|stop|reset` POST `…/computer/start|stop|reset` (`agents.manage`; stop/reset
  `conflict` while a turn runs). All → `AgentComputerResponse {computer, eventId}`.
- `HostInfo.computers?: ComputersHostStatus {available, reason}`; `COMPUTERS_NOT_HERE` “This Whombat doesn’t run agent
  computers.” (dev stack / not an appliance).
- Copy: `COMPUTER_STATE_LABELS`, `COMPUTER_COPY` / `computerCopy(agent)` (tab, intro, none, start, stop, reset,
  resetTitle, resetBody, resetConfirm, cancel, size, lastUsed, image), `computerSizeText`, `computerStatusLine`,
  `computerActions(state)`.

## Runner API (`contracts/runner.ts`, CT-220)
- `DispatchContext.computer?: DispatchComputerContext | null` `{productionServers: ComputerProductionServer[] {entryId,
  name, host, port, addresses}, homeNetworks: string[]}`.
- `runner.authorizeCommand` POST `/internal/runner/commands/authorize`, `AuthorizeCommandBody {dispatchId, attempt,
  runnerId, command, category, target, reason?}` → `AuthorizeCommandReply {outcome: run|blocked|pending, approvalId,
  message, open: ComputerOpening[] {host, port|null}}`.
- `runner.authorizeWait` GET `/internal/runner/commands/authorize/:approvalId` query `AuthorizeWaitQuery {dispatchId,
  attempt, runnerId, waitMs=25000}` → `AuthorizeWaitReply {outcome: run|declined|pending, scope|null, message, open}`.
- `runner.computerKeys` GET `/internal/runner/dispatches/:dispatchId/computer-keys?runnerId&attempt` → `ComputerKeys
  {files: {path: ComputerKeyPath, mode ('600'), base64}[], env: {name, value}[], needles: string[], entries: {entryId,
  name, ownerName}[]}`.
- `runner.computerReport` POST `/internal/runner/dispatches/:dispatchId/computer-report`, `ComputerReportBody
  {dispatchId, attempt, runnerId, sweep: {files, replaced}}` → `OkResponse`.

## Keys (CT-222)
- New key `commands.destructive` “Destructive commands on other machines” (operations, `can`).
- `branch.main.push` agentMaxTier `can`, “Push commits straight to the default branch, without a pull request.”;
  `PEOPLE_ONLY_KEYS` = the four burrow keys; key requests for it are given at ask.
- `KEY_TIER_ROWS` `['merge', 'deploy', 'branch.main.push']` (the row is named by its key; label “Push to main” from the
  catalog); `KEY_TIER_ROW_KEYS`/`KEY_TIER_ROW_READS['branch.main.push']` = `['branch.main.push']`;
  `KeyRowTiers['branch.main.push']`; `HIRE_KEY_OPTIONS` ends with the Push to main row; every hire grants it (Off by
  default).
- `ROLE_DEFAULT_KEYS` per AC-50 (every role but `assistant` holds `web.browse` and `workspace.scratch`; Developer can
  `branch.feature.readwrite`, `tests.run`, `pr.open`, ask `branch.shared.push`, `merge`, `merge.main`, `deploy`,
  `deploy.staging`, `deploy.production`, cannot `branch.main.push`; Researcher + `browser.use`). **`SEED_ROLE_KEYS` /
  `seedRoleGrants`** = the old (AG0) defaults for the mock world: fixtures' `GRANTS` and the Whombat test world use them.
- `pr.open` and `web.browse` follow the role in the hire modal for every role. `skills.propose` description “Agents save
  what they learn as skills, active at once; you can remove any.”

## Vault (CT-223)
- `VAULT_KEY_DELIVERIES` / `VaultKeyDelivery` `whombat|computer`; `VaultKeyView.delivery` (default `whombat`),
  `.envName` (default null); `VaultAgentKey.delivery` (default `whombat`).
- `GiveVaultKeyBody.delivery?`, `.envName?`; `VaultEnvName` (schema); `SetVaultKeyDeliveryBody {delivery, envName?}`;
  op **`vault.setKeyDelivery`** PUT `/burrows/:burrow/vault/:entryId/keys/:agent/delivery` → `VaultEntryWriteResponse`.
- Rules (`vault/computer.ts`): `VAULT_ENV_NAME_PATTERN`, `VAULT_ENV_NAMES_RESERVED`, `VAULT_ENV_PREFIXES_RESERVED`,
  `vaultEnvNameProblem(name)`, `defaultVaultEnvName(entryName)`, `vaultComputerDeliverable(entry)` (all but `mcp`),
  `vaultComputerEnvNames(envName, entry)` (`NAME`, or `NAME_USERNAME`/`NAME_PASSWORD`; none for ssh),
  `VAULT_COMPUTER_KEYS_DIR` `/run/whombat/keys`, `VAULT_COMPUTER_SWEEP_MARK` `[removed by Whombat]`.
- `VaultContextEntry.delivery?`, `.onComputer?`, `.envNames?`.
- `VaultSshServer.production` (default false); `AddVaultSshServerBody.production?`, `UpdateVaultSshServerBody.production?`.
- `VaultUseAction.params.purpose?: string|null` (≤ `VAULT_USE_PURPOSE_MAX` 300) and `.computer?: boolean`;
  `vaultApprovalCopy` facts `purpose?`, `computer?`; `vaultPurposeLine(purpose)` (“It says: “…””).
- MCP tool **`request_vault_key`** in `VAULT_MCP_TOOLS`: `RequestVaultKeyInput {entry: VaultEntryRef, purpose}` →
  `RequestVaultKeyOutput` (`{status:'ok', message}` | `VaultToolRefusal`), `requiredKey: null`. `VAULT_REQUEST_KEY_TOOL`;
  not in `isVaultToolName`, but `isVaultActivityTool` covers it.
- Copy: `vaultKeyDeliveryLabels(agent)` (“Whombat uses it for Banjo” / “On Banjo’s computer”), `vaultKeyDeliveryHints`,
  `VAULT_COMPUTER_COPY` (delivery, envName, envNameHint, sshHint, notDeliverable, othersTurns, swept),
  `vaultRotateNotice({agentName, entryName, kind})` → `{text, action}`, `VAULT_SSH_PRODUCTION_COPY` (label, hint, badge),
  `VAULT_ACCESS_RULES_COMPUTER` (three prompt lines).

## Learned skills (CT-224)
- `SKILL_PROPOSAL_STATUSES` + `learned`, `removed` (labels “Learned”, “Removed”); `isLearnedSkill`;
  `SkillProposalSummary.canRemove` (default false); card label `SKILL · LEARNED` / `SKILL · REMOVED`, text `[skill: name;
  learned]`; `skillLearnedTitle(agent)` “Banjo learned a skill”; `SKILL_LEARNED_COPY` {remove, removeConfirm, removed}.
- Op **`skills.removeLearned`** DELETE `/burrows/:burrow/agents/:agent/learned-skills/:skill` →
  `RemoveLearnedSkillResponse {proposal | null, eventId}`. `propose_skill` description says active at once.

## Protocol, audit (CT-225)
- `SESSION_API_LEVEL` **26** (window 24…27). `RUNTIME_FEATURES` + `agent.computer`, `skills.learned` (`SINCE_0_36`).
- Safety: `computers.get` read, `computers.start` receipt, `computers.stop` destructive, `computers.reset` destructive +
  never, `agents.commandAllowances` read, `agents.removeCommandAllowance` destructive, `vault.setKeyDelivery` receipt,
  `skills.removeLearned` destructive.
- `EVENT_TYPES` + `agent.computer`, `command.allowance_added`, `command.allowance_removed`, `skill.learned`,
  `skill.removed` (Keys), `vault.swept` (Vault).

## What the runtime and app streams must know
- **Type-level**: `VaultKeyView` needs `delivery`, `envName`; `VaultSshServer` `production`; `VaultAgentKey` `delivery`;
  `SkillProposalSummary` `canRemove`; switches over `ApprovalAction['type']` gain `run_command`; `MCP_TOOLS` gains
  `request_vault_key`; `KeyRowTiers` has `'branch.main.push'`; `RuntimeFeature` has two more names.
- **Behaviour**: new hires and onboarding get the AC-50 keys (a Developer's hire opens Merge/Deploy at Ask, Push to main
  Off, Open pull requests and Browse the web on); every hire gets a `branch.main.push` grant; the mock world stays on
  `SEED_ROLE_KEYS`.
- **Vendoring stubs to replace — Whombat** (`441a080b`): `approvals/engine.ts` `executedText` returns null for
  `run_command`; `mcp/tools.ts` answers `request_vault_key` with `failed`/`not_allowed` and `mcp/server.ts` never lists
  it; `skills/read.ts` sets `canRemove: false`; `skills/routes.ts` answers `[]` for status `learned`/`removed` (the DB
  column doesn't know them yet); `vault/store.ts` fills `production: false`, key `delivery: 'whombat'`, `envName: null`,
  agent key `delivery: 'whombat'`; `managed/runtime-features.ts` has `agent.computer` and `skills.learned` in
  `NOT_IMPLEMENTED` (move them to `IMPLEMENTED_FEATURES`); `seed/test-world.ts` uses `SEED_ROLE_KEYS`.
- **Vendoring stubs to replace — whombat-app** (`63b2e47`): `FEATURE_NAMES['agent.computer']` “agents’ computers” and
  `['skills.learned']` “learned skills” (`packages/client/src/managed/updates.ts`); `decidedLine` returns null for
  learned/removed (`apps/web/src/features/packs/skillsCopy.ts`); fixtures carry `canRemove: false`, `delivery:
  'whombat'`, `envName: null`. The hire modal and Configure already draw the third row (Push to main) from
  `KEY_TIER_ROWS`, and Android's agent screen lists it; `KEY_TIERS_ON_WEB` still says “Merge and Deploy are set …”.
  No other UI.
- Names that differ from the spec: CT-226 (row `branch.main.push` not `push_main`; content label `COMMAND`;
  `request_vault_key` takes `entry`; `SEED_ROLE_KEYS`; `VaultUseAction.params.computer`;
  `ComputerProductionServer.entryId`; `AuthorizeCommandBody.reason?`; the classifier's three additions).
