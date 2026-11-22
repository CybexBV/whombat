/**
 * Runner protocol (`/internal/runner/*`, runner token). The runner long-polls `claim`, receives a
 * `DispatchContext`, runs a provider turn that acts through the Whombat MCP tools with the per-dispatch
 * agent token, streams `progress` (which may tell it to stop: pause / take over), then `complete`s.
 */
import { z } from 'zod';
import { COMMAND_MAX, COMMAND_TARGET_MAX, CommandCategory, CommandScope } from '../commands/commands.js';
import { ACTIVITY_REPORTS_MAX, ActivityReport } from '../domain/activity.js';
import { AgentFace, AgentProvider, AgentRuntime } from '../domain/agent.js';
import { Approval } from '../domain/approval.js';
import { CareStepId, ChangeWindow } from '../domain/care-plan.js';
import { Count, Timestamp } from '../domain/common.js';
import {
  ConnectionAccessLevel,
  ConnectionHandle,
  DispatchConnection,
} from '../domain/connections-catalog.js';
import { ConnectorProvider, ConnectorService } from '../domain/connectors.js';
import { ConversationKind } from '../domain/conversation.js';
import {
  COUNCIL_ANSWER_MAX,
  COUNCIL_AREAS_MAX,
  COUNCIL_PLAN_MAX,
  COUNCIL_QUESTION_MAX,
  COUNCIL_ROUNDS_ASKED_MAX,
  COUNCIL_SHOT_NOTE_MAX,
  COUNCIL_SHOTS_MAX,
  COUNCIL_TITLE_MAX,
  CouncilKind,
  CouncilMemberState,
  CouncilScore,
  CouncilStage,
  CouncilVerdict,
} from '../domain/council.js';
import {
  DELEGATION_ANSWER_MAX,
  DELEGATION_AREA_MAX,
  DELEGATION_AREAS_MAX,
  DELEGATION_AT_ONCE_MAX,
  DELEGATION_BRIEF_MAX,
  DELEGATION_CARD_TASKS_MAX,
  DELEGATION_RULES_MAX,
  DELEGATION_TASK_NOTE_MAX,
  DELEGATION_TASK_TITLE_MAX,
  DELEGATION_TITLE_MAX,
  DELEGATION_WHY_MAX,
  DelegationStage,
  DelegationTaskChecks,
  DelegationTaskMerge,
  DelegationTaskPending,
  DelegationTaskState,
} from '../domain/delegation.js';
import { DeskServerId } from '../domain/desk.js';
import {
  Dispatch,
  NOTIFY_TEXT_MAX,
  NotifyEventId,
  TURN_FAILURE_REASON_MAX,
  TurnFailureCode,
  TurnFailureReport,
} from '../domain/dispatch.js';
import { FeedbackAssessment, FeedbackContext } from '../domain/feedback.js';
import { FeedbackReference, FeedbackReportType } from '../domain/feedback-card.js';
import { AiGatewaySwitches, GatewayKind, GatewayName, GatewayProvider } from '../domain/gateway.js';
import { ConversationLink } from '../domain/links.js';
import { LOCAL_MODEL_KEY_MAX, LOCAL_MODEL_URL_MAX } from '../domain/local-model.js';
import {
  LOOK_FIX_LABEL_MAX,
  LOOK_FIX_STEP_MAX,
  LOOK_LINES_MAX,
  LOOK_PLAN_STEP_MAX,
  LOOK_PLAN_STEPS_MAX,
  LOOK_SUMMARY_MAX,
  LOOK_TITLE_MAX,
} from '../domain/look-research.js';
import { AGENT_NOTES_MAX } from '../domain/memory.js';
import { Message } from '../domain/message.js';
import { ModelFallbackReport, ModelId, TurnRanReport } from '../domain/models.js';
import { RunnerStatus } from '../domain/providers.js';
import { Run } from '../domain/run.js';
import { SCHEDULE_PROMPT_MAX, ScheduleWhen } from '../domain/schedules.js';
import { SearchResult } from '../domain/search.js';
import { TaskKey } from '../domain/session.js';
import {
  ConsoleCols,
  ConsoleInputText,
  ConsoleOffset,
  ConsoleOutputData,
  ConsoleRows,
  ProviderConsoleId,
} from '../domain/signins.js';
import { SpendUsage } from '../domain/spend.js';
import {
  TASK_RESULT_MAX,
  TASK_SERVER_ID_MAX,
  TASK_SERVER_MAX,
  TASK_TITLE_MAX,
  TaskEndState,
} from '../domain/task-card.js';
import {
  USAGE_ERROR_MAX,
  USAGE_PLAN_MAX,
  USAGE_WINDOWS_MAX,
  UsageCredentialKind,
  UsageProvider,
  UsageWindow,
} from '../domain/usage.js';
import { WEB_SEARCH_KEY_MAX, WebSearchProvider } from '../domain/web-search.js';
import {
  AccountId,
  AgentScheduleId,
  AnswerId,
  ApprovalId,
  ChangeId,
  ConnectionId,
  CouncilId,
  CouncilMemberId,
  DelegationId,
  DelegationTaskId,
  DispatchId,
  FeedbackReportId,
  FollowedTaskId,
  MessageId,
  PlanId,
  RunnerId,
  StepId,
  VaultEntryId,
} from '../ids.js';
import { KeyId } from '../keys/catalog.js';
import { HTML_PREVIEW_MAX } from '../text/html.js';
import { PAGES_TITLE_MAX, PageSetPath } from '../text/pages.js';
import { VAULT_SECRET_MAX, VAULT_TOOLS_MAX } from '../vault/schemas.js';
import { AttachmentRef, MAX_ATTACHMENTS_PER_MESSAGE } from './attachments.js';
import { endpoint, RUNNER_PREFIX } from './endpoint.js';
import { OkResponse } from './errors.js';
import { DispatchFiles } from './files.js';
import { hermesHomeEndpoints } from './hermes-home.js';
import {
  PAGE_PREVIEW_CONSOLE_LINE,
  PAGE_PREVIEW_MAX_CONSOLE,
  PAGE_PREVIEW_MAX_WIDTH,
  PAGE_PREVIEW_MIN_WIDTH,
} from './mcp-preview.js';
import { VaultDispatchContext } from './vault.js';

const KeyLabel = z.object({ id: KeyId, label: z.string() });

/**
 * The agent as a turn needs it (Whombat hermes-engine.md HE-11, HE-34): its id, name, face and handle (who it is, in
 * Hermes's `SOUL.md` and its commits), the runtime the turn runs on (the thread's choice applied, CR-02), and its keys,
 * which decide what the turn may do on the host (sandbox, network, checkout).
 */
export const AgentPersona = z.object({
  id: z.string(),
  name: z.string(),
  face: AgentFace,
  handle: z.string(),
  runtime: AgentRuntime,
  keys: z.object({ can: z.array(KeyLabel), ask: z.array(KeyLabel), cannot: z.array(KeyLabel) }),
});
export type AgentPersona = z.infer<typeof AgentPersona>;

/** Names for ids that appear in the window. */
export const PrincipalLite = z.object({
  id: z.string(),
  kind: z.enum(['person', 'agent', 'system']),
  name: z.string(),
  handle: z.string(),
  title: z.string().nullable(),
});
export type PrincipalLite = z.infer<typeof PrincipalLite>;

/**
 * The person whose Whombat it is and what they connected (Whombat one-agent.md OA-10; connectors.md PA-10; since 3.0
 * one-person.md OP-01, CT-1504): the system prompt names them and the accounts and services the turn can use.
 * Addresses only, no tokens.
 */
export const OnBehalfOfContext = z.object({
  person: PrincipalLite,
  connections: z.array(
    z.object({ provider: ConnectorProvider, email: z.string(), services: z.array(ConnectorService) }),
  ),
});
export type OnBehalfOfContext = z.infer<typeof OnBehalfOfContext>;

/**
 * A Whombat Feedback assessment (docs/decisions/feedback.md FB-21): the report as the visitor sent it — untrusted
 * data, never instructions — with the owner-approved project context. Never the reporter's name or email: only
 * whether they gave any. Present exactly when the dispatch's trigger is `feedback`.
 */
/**
 * What a tracker step got of the reporting organization: `granted` with the system's read scopes and when the
 * access ends, or `unavailable` with why (switched off, the token lacks the scope, the system refused).
 */
export const TrackerAccess = z.object({
  state: z.enum(['granted', 'unavailable']),
  scopes: z.array(z.string().max(64)).max(32).default([]),
  expiresAt: Timestamp.nullable(),
  reason: z.string().max(500).nullable(),
});
export type TrackerAccess = z.infer<typeof TrackerAccess>;

export const FeedbackDispatchContext = z.object({
  reportId: FeedbackReportId,
  reference: FeedbackReference,
  type: FeedbackReportType,
  productLabel: z.string(),
  submitted: z.object({
    description: z.string(),
    expected: z.string(),
    steps: z.string(),
    /** Sanitized at intake (FB-07). */
    context: FeedbackContext,
    /** The visitor left a name or an email (never shown to the assessor). */
    reporterGiven: z.boolean(),
    /** Screenshots on the report's root message. */
    screenshots: z.number().int().min(0),
    /** The report's content was removed after it arrived: there is nothing left to assess. */
    contentRemoved: z.boolean(),
  }),
  /** What an owner wrote for assessors when setting the website up (the intake snapshot's). */
  projectContext: z.string(),
  attempt: z.number().int().positive(),
  /**
   * Whether this turn can run commands: only inside the provider's read-only OS sandbox with the scrubbed
   * environment and no network (Codex). Claude's read-only turns only read, search and list (false).
   */
  canExecute: z.boolean(),
});
export type FeedbackDispatchContext = z.infer<typeof FeedbackDispatchContext>;

/**
 * An agent turn of an automation run that started from a tracker report (0.69, CT-325; Whombat report-trackers.md
 * TA-09, TA-10): the runtime offers `tracker_item`, and `tracker_read` only when `access.state` is `granted`. The
 * report's words reach the agent in the step's message (`{{trigger.text}}`) and through `tracker_item`, never the
 * reporter's name or email.
 */
export const TrackerDispatchContext = z.object({
  /** The connection's label (“Acme Desk dev”). */
  connection: z.string().max(80),
  /** What the tracker is called (its driver's `words.product`): “a report an Acme Desk customer sent”. */
  product: z.string().max(40).default('the tracker'),
  /** The report's number in its tracker. */
  number: z.number().int().positive(),
  /**
   * The step's access to the reporting organization: granted (scopes, until when) or unavailable (why, e.g. “The
   * token lacks the scope to look inside an organization”). Null: the step didn't ask — a step that writes code or gives a verdict
   * (`trackerAccessAsked`, TA-23).
   */
  access: TrackerAccess.nullable(),
});
export type TrackerDispatchContext = z.infer<typeof TrackerDispatchContext>;

/**
 * An approved development handoff (docs/decisions/feedback.md FB-24, review-2 F1; one-agent.md OA-16): set on the
 * agent's development turn whose trigger is the handoff message. The message itself is Whombat's fixed text; the report
 * (a website visitor's words) and the assessment (the agent's earlier reading of them) travel here as data — the prompt
 * shows both in untrusted-data blocks, never as anyone's instructions. The note is the words of the person who asked.
 */
export const FeedbackHandoffContext = z.object({
  reportId: FeedbackReportId,
  reference: FeedbackReference,
  type: FeedbackReportType,
  productLabel: z.string(),
  approvalNumber: z.number().int().positive(),
  /** The person who asked for development, and their own note (empty when they wrote none). */
  requestedById: z.string(),
  note: z.string(),
  submitted: FeedbackDispatchContext.shape.submitted,
  assessment: FeedbackAssessment,
  /** The repository the handoff is about, when the report had one. */
  repo: z.string().nullable(),
  /**
   * The code the assessment read: the commit the assessor's runner exported (`verified`), else the revision the
   * assessor wrote itself (not verified). Null when it read no code.
   */
  commit: z.object({ sha: z.string(), verified: z.boolean() }).nullable(),
});
export type FeedbackHandoffContext = z.infer<typeof FeedbackHandoffContext>;

/**
 * The provider sign-in a dispatch runs on (CT-26, CT-69; since 3.0 Whombat one-person.md OP-09, CT-1503): the
 * person's one credential home for `provider` — a subscription sign-in or an API key the person added. There is no
 * source to pick, no other person's sign-in and no fallback; without a sign-in for the provider the runner refuses the
 * turn (`provider.not_signed_in`).
 */
export const DispatchCredential = z.object({
  v: z.literal(1),
  provider: AgentProvider,
  /** How the sign-in authenticates (`subscription`, `api_key`, …); null when not known yet. */
  authMode: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z][a-z0-9_]*$/)
    .nullable(),
});
export type DispatchCredential = z.infer<typeof DispatchCredential>;

/** What the agent is told about the plan step it was asked to do (`DispatchContext.planStep`). */
export const PlanStepContext = z.object({
  planId: PlanId,
  stepId: StepId,
  planTitle: z.string(),
  /** 1-based position of the step in the plan. */
  position: z.number().int().positive(),
  title: z.string(),
  /** The plan's other steps, in order, as “n. title · state”. */
  outline: z.array(z.string()).max(40),
});
export type PlanStepContext = z.infer<typeof PlanStepContext>;

/**
 * A retry's origin (trigger `retry`, 0.26, CT-167): the failed turn and why it failed, so the agent knows it is trying
 * again.
 */
export const RetryContext = z.object({
  dispatchId: DispatchId,
  code: TurnFailureCode,
  reason: z.string().max(TURN_FAILURE_REASON_MAX),
});
export type RetryContext = z.infer<typeof RetryContext>;

/**
 * A person asked the agent to undo a change it reported (trigger `undo_requested`, 0.91, CT-406; Whombat
 * home-redesign.md HR-03): the change, its title and the agent's own private note on how to put it back. The note goes
 * to the agent here, never into the chat. When it is back, the agent calls `report_change` with `undoes: changeId`.
 */
export const UndoRequestContext = z.object({
  changeId: ChangeId,
  title: z.string().min(1).max(200),
  undo: z.string().max(1000),
});
export type UndoRequestContext = z.infer<typeof UndoRequestContext>;

/** Longest call result an `approval_granted` turn carries (`GrantedResultContext.text`). */
export const GRANTED_RESULT_TEXT_MAX = 4000;

/**
 * What a call a person approved returned (trigger `approval_granted` after an approved `connection_call`,
 * 0.91, CT-407; HR-04), so the agent answers in its own words instead of Whombat posting the raw output: `done` (it ran
 * and the service answered), `error` (it ran and the service said it failed), `failed` (it couldn't run). `text` is the
 * answer as the agent would have read it, cut at `GRANTED_RESULT_TEXT_MAX` (`truncated`).
 */
export const GrantedResultContext = z.object({
  outcome: z.enum(['done', 'error', 'failed']),
  text: z.string().max(GRANTED_RESULT_TEXT_MAX),
  truncated: z.boolean(),
});
export type GrantedResultContext = z.infer<typeof GrantedResultContext>;

/* The agent's commands (Whombat one-person.md OP-07; agent-computer.md AC-11, AC-40…AC-42; contracts 3.0, CT-1531) -- */

/**
 * A production server of the Vault the guard matches commands against and the commands' network keeps closed (AC-11):
 * the entry it belongs to, its name (the `ssh_config` alias), host and port, and the addresses the host resolved to
 * when the turn started.
 */
export const CommandProductionServer = z.object({
  entryId: VaultEntryId,
  name: z.string().min(1).max(40),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  addresses: z.array(z.string().max(64)).max(16),
});
export type CommandProductionServer = z.infer<typeof CommandProductionServer>;

/**
 * `DispatchContext.commands` (since 3.0, CT-1531; was `computer`): the turn runs commands through Hermes's own terminal,
 * each in its thin wrapper on the person's Whombat (OP-07). What the runner needs for the guard and the commands'
 * network: production servers (AC-11, closed unless the person opened one) and the home networks the commands may
 * reach (CIDRs of the Vault's list, VT-11). Null exactly in an `outside` turn.
 */
export const DispatchCommandsContext = z.object({
  productionServers: z.array(CommandProductionServer).max(200),
  homeNetworks: z.array(z.string().max(60)).max(64),
  /**
   * Commands may reach the local network (Whombat resourceful-agents.md RA-41; local-network.md LN-01: every private
   * address): the burrow's “Agents may reach your local network” (`agentsReachLanOn`). Production servers stay closed
   * whatever it says.
   */
  lan: z.boolean(),
});
export type DispatchCommandsContext = z.infer<typeof DispatchCommandsContext>;

/** At most this many words in one `gh` command line (Whombat agent-gh.md AGH-02, contracts 0.41.0). */
export const GH_ARGS_MAX = 200;
/** At most this many characters in one word of a `gh` command line. */
export const GH_ARG_MAX = 65_536;
/** At most this many files one `gh` command reads (`--body-file`, `-F`, `--input`, `-F key=@file`). */
export const GH_FILES_MAX = 8;
/** At most this many bytes of files and stdin together, before base64. */
export const GH_INPUT_MAX_BYTES = 1024 * 1024;
/** At most this many switched-on repositories in `DispatchContext.gh.repos`. */
export const GH_REPOS_MAX = 100;

/**
 * `DispatchContext.gh` (Whombat agent-gh.md AGH-01, AGH-12, contracts 0.41.0): the agent's `gh` works in this turn,
 * through Whombat, as the GitHub sign-in its pushes use. `repos` are the burrow's switched-on GitHub repositories (full
 * names) gh may reach; `defaultRepo` is the one a command that names none uses (the turn's checkout, else the only
 * one), null when the command has to say. Null: no `gh` through Whombat (GitHub off or not connected, no switched-on
 * GitHub repository, Feedback assessments, search answers).
 */
export const GhDispatchContext = z.object({
  repos: z.array(z.string().min(3).max(200)).max(GH_REPOS_MAX),
  defaultRepo: z.string().min(3).max(200).nullable(),
});
export type GhDispatchContext = z.infer<typeof GhDispatchContext>;

/**
 * `DispatchContext.gateway` (0.76, CT-332; Whombat ai-gateway.md AIG-07, AIG-08, AIG-10, AIG-20): this turn's Claude
 * Code or Codex traffic goes through the burrow's AI gateway — the connection, its name and kind. Set at claim while
 * the burrow's switch for the agent's provider is on, and kept for the turn (a switch change applies to turns that
 * start after it). The runner then uses no sign-in for the provider (`credential` doesn't apply): it gives the CLI a home
 * of its own per connection and provider and points it at the relay (`aiGatewayRelayPath`; through the sandbox's
 * loopback bridge on a managed appliance) with the turn's agent token as its key, drops the provider's hosts from the
 * turn's egress, and skips sign-in bookkeeping, usage probes and rate-limit readings. Null: the turn runs on the
 * agent's own sign-in.
 */
export const GatewayDispatchContext = z.object({
  v: z.literal(1),
  provider: GatewayProvider,
  connectionId: ConnectionId,
  name: GatewayName,
  kind: GatewayKind,
});
export type GatewayDispatchContext = z.infer<typeof GatewayDispatchContext>;

/**
 * `DispatchContext.localModel` (0.124, CT-1172; Whombat hermes-engine.md HE-32): the turn runs on the burrow's model on
 * its network, on Hermes's own loop — its base URL, the model this turn asks for (the thread's or the agent's, else the
 * burrow's own) and its API key (null: none). Set exactly when the turn's provider is `local`. The runner puts the key
 * only into Hermes's environment for the turn, never into its configuration file, the prompt or a log, and lets the
 * turn's egress reach the base URL's host. Null or absent: the turn isn't on `local`.
 */
export const LocalModelDispatchContext = z.object({
  v: z.literal(1),
  baseUrl: z.string().min(1).max(LOCAL_MODEL_URL_MAX),
  model: ModelId,
  /** The burrow's configured Custom AI model default, kept apart from per-turn overrides for fallback retries. */
  defaultModel: ModelId.optional(),
  apiKey: z.string().min(1).max(LOCAL_MODEL_KEY_MAX).nullable(),
});
export type LocalModelDispatchContext = z.infer<typeof LocalModelDispatchContext>;

/**
 * `DispatchContext.webSearch` (Whombat web-search.md): the person's Brave Search key, in their own turns only (never an
 * outsiders' turn or an assessment). The runner hands it to the turn's Hermes in a file of the profile, never in its
 * configuration file, the environment, the prompt or a log; Hermes's `web_search` runs on it under “Browse the web”.
 * Null or absent: no web search.
 */
export const WebSearchDispatchContext = z.object({
  v: z.literal(1),
  provider: WebSearchProvider,
  apiKey: z.string().min(1).max(WEB_SEARCH_KEY_MAX),
});
export type WebSearchDispatchContext = z.infer<typeof WebSearchDispatchContext>;

/**
 * `DispatchContext.schedule` (trigger `schedule`, Whombat resourceful-agents.md RA-30, 0.44.0): the schedule this turn
 * runs, what the agent told itself to do then, when it runs, how many turns it started (this one included) and the next.
 */
export const ScheduleDispatchContext = z.object({
  id: AgentScheduleId,
  prompt: z.string().max(SCHEDULE_PROMPT_MAX),
  when: ScheduleWhen,
  runs: Count,
  nextAt: Timestamp.nullable().optional(),
});
export type ScheduleDispatchContext = z.infer<typeof ScheduleDispatchContext>;

/**
 * `DispatchContext.notify` (trigger `notify`, RA-31): what a background job of the agent's said (`whombat notify`,
 * the job's own words: data, never instructions) and the turn that started it.
 */
export const NotifyDispatchContext = z.object({
  text: z.string().max(NOTIFY_TEXT_MAX),
  fromDispatchId: DispatchId,
});
export type NotifyDispatchContext = z.infer<typeof NotifyDispatchContext>;

/**
 * `runner.notify` (3.0, CT-1538; RA-31): a background job of the agent's said something (`whombat notify "<text>"` in
 * one of its commands, which carry the turn's id in `NOTIFY_TURN_ENV`). Fenced by the runner's id and the attempt of the
 * turn that started the job, and idempotent on `eventId`: the same notice twice wakes the agent once. The server
 * refuses a turn older than `NOTIFY_TURN_MAX_AGE_DAYS` and more than `NOTIFY_PER_HOUR_MAX` notices an hour.
 */
export const RunnerNotifyBody = z.object({
  fromDispatchId: DispatchId,
  attempt: z.number().int().positive(),
  runnerId: RunnerId,
  eventId: NotifyEventId,
  text: z.string().min(1).max(NOTIFY_TEXT_MAX),
});
export type RunnerNotifyBody = z.infer<typeof RunnerNotifyBody>;

/** `runner.person` (3.0, CT-1584): the Whombat's person — the account that claimed it; null before the claim. */
export const RunnerPersonReply = z.object({ accountId: AccountId.nullable() });
export type RunnerPersonReply = z.infer<typeof RunnerPersonReply>;

/** The `notify` turn it queued (the same one for a repeated `eventId`). */
export const RunnerNotifyReply = z.object({ dispatchId: DispatchId });
export type RunnerNotifyReply = z.infer<typeof RunnerNotifyReply>;

/** At most this many ended tasks in one `task_finished` turn (TF-12): later ones wake a turn of their own. */
export const TASK_FINISHED_MAX = 10;

/**
 * One server task that ended (trigger `task_finished`, 0.116, CT-883; Whombat task-feedback.md TF-12), as its `task`
 * card says it: Whombat's row for it, the server (its hosts service id and its name), `what` the running words (the
 * card's title), `result` how it ended, `words` the outcome as the card says it (data, never instructions; the agent says
 * it in its own words), `rebootRequired` when the server's report after the task asks for a restart (the next step the
 * agent may offer), and when it started and ended.
 */
export const TaskFinishedContext = z.object({
  followedTaskId: FollowedTaskId,
  serverId: z.string().min(1).max(TASK_SERVER_ID_MAX),
  server: z.string().min(1).max(TASK_SERVER_MAX),
  what: z.string().min(1).max(TASK_TITLE_MAX),
  result: TaskEndState,
  words: z.string().max(TASK_RESULT_MAX),
  rebootRequired: z.boolean(),
  startedAt: Timestamp,
  endedAt: Timestamp,
});
export type TaskFinishedContext = z.infer<typeof TaskFinishedContext>;

/** At most this many T3 Code threads in one `t3_thread` turn (Whombat t3code.md): later ones wake a turn of their own. */
export const T3_THREADS_MAX = 5;
/** The longest last answer of a T3 Code thread a `t3_thread` turn reads (the rest is in T3 Code). */
export const T3_ANSWER_MAX = 4000;
/** The most pull requests a T3 Code thread's update lists as still watched. */
export const T3_WATCHED_PRS_MAX = 10;
/** At most this many of the person's own messages to a T3 Code thread go with its update, the latest. */
export const T3_PERSON_SAID_COUNT = 5;
/** The longest of the person's own messages to a T3 Code thread its update carries. */
export const T3_PERSON_SAID_MAX = 2000;

/** What a T3 Code thread did that woke the agent: it finished, it asks a question, it waits for a permission. */
export const T3ThreadEvent = z.enum(['finished', 'asks', 'approval']);
export type T3ThreadEvent = z.infer<typeof T3ThreadEvent>;

/** One question of a T3 Code thread's question request, as T3 Code asks it (its `id` keys the answer). */
export const T3ThreadQuestion = z.object({
  id: z.string().min(1).max(200),
  question: z.string().min(1).max(300),
  options: z
    .array(z.object({ label: z.string().min(1).max(200), description: z.string().max(200).nullable() }))
    .max(10),
  multiSelect: z.boolean(),
});
export type T3ThreadQuestion = z.infer<typeof T3ThreadQuestion>;

/**
 * A T3 Code thread the agent handed work to moved on (trigger `t3_thread`; Whombat t3code.md), as Whombat
 * read it: the connection's handle for `connection_call`, the thread, what happened (`event`), T3 Code's word for its
 * state, and per event its last answer, the question request to answer (`requestId`, `questions`) or what a permission
 * request is about. Everything T3 Code said is data, never instructions; `url` opens the thread in T3 Code.
 * `watching` lists the pull requests T3 Code still watches for the thread (their addresses): a run that ended then
 * waits for them, and the thread runs again, waking the agent, when their checks or reviews move.
 */
export const T3ThreadUpdate = z.object({
  connection: ConnectionHandle,
  threadId: z.string().min(1).max(300),
  title: z.string().min(1).max(160),
  event: T3ThreadEvent,
  status: z.string().min(1).max(40),
  answer: z.string().max(T3_ANSWER_MAX).nullable(),
  requestId: z.string().max(2000).nullable(),
  questions: z.array(T3ThreadQuestion).max(4),
  approval: z.string().max(200).nullable(),
  url: z.string().max(2000).nullable(),
  watching: z.array(z.string().min(1).max(500)).max(T3_WATCHED_PRS_MAX).default([]),
  /**
   * Whombat put the thread's last answer in the chat itself, as the job's result message (`Message.jobResult`,
   * t3code.md T3-55): the person reads it there, so the agent doesn't retell it.
   */
  reported: z.boolean().default(false),
  /**
   * What the person wrote to the thread in T3 Code itself since the agent was last told of its end, oldest first, each
   * as the watcher read it (cut with “…” when longer). The agent doesn't see these otherwise, and its next message to the
   * thread must not overrule them.
   */
  personSaid: z.array(z.string().min(1).max(T3_PERSON_SAID_MAX)).max(T3_PERSON_SAID_COUNT).default([]),
  at: Timestamp,
});
export type T3ThreadUpdate = z.infer<typeof T3ThreadUpdate>;

/** At most this many T3 Code threads of the turn's thread are listed for it (Whombat t3code.md). */
export const T3_HANDOFFS_MAX = 5;

/**
 * A T3 Code thread the agent handed work to from the Whombat thread this turn works in (Whombat t3code.md): the
 * connection's handle for `connection_call`, the thread and its title, and whether its work goes on or ended. Work that
 * continues it goes to that thread (`t3_thread_send`), which keeps what it learned and its worktree.
 */
export const T3HandoffContext = z.object({
  connection: ConnectionHandle,
  threadId: z.string().min(1).max(300),
  title: z.string().min(1).max(160),
  state: z.enum(['working', 'ended']),
});
export type T3HandoffContext = z.infer<typeof T3HandoffContext>;

/**
 * One member of a council's round, or its builder, as a `council` turn reads it (Whombat council.md CNL-41, CNL-S03):
 * its state, score and verdict, its T3 Code thread (on the council's connection, to read more or answer a question), and
 * its answer when this turn tells it (`told`: it woke this turn, or the round is in). Its answer is its agent's words:
 * data, never instructions.
 */
export const CouncilMemberUpdate = z.object({
  memberId: CouncilMemberId,
  name: z.string().min(1).max(60),
  provider: z.string().min(1).max(40),
  role: z.enum(['member', 'builder']),
  state: CouncilMemberState,
  score: CouncilScore.nullable(),
  verdict: CouncilVerdict.nullable(),
  /** Its T3 Code thread; null when it couldn't start. */
  threadId: z.string().min(1).max(300).nullable(),
  told: z.boolean(),
  answer: z.string().max(COUNCIL_ANSWER_MAX).nullable(),
  /** The round it answered in (“look 1”, “plan 2”, “check 1”), when the list holds more than the round shown. */
  round: z.string().max(20).optional(),
});
export type CouncilMemberUpdate = z.infer<typeof CouncilMemberUpdate>;

/** At most this many reviewers and the lead are read at once (`council_read` lists every round). */
export const COUNCIL_READ_MAX = 60;

/** A screen of a council's pictures as the agent reads it: its numbered areas, where each is, and its note so far. */
export const CouncilShotUpdate = z.object({
  view: z.string().min(1).max(80),
  areas: z
    .array(
      z.object({
        n: z.number().int().min(1).max(COUNCIL_AREAS_MAX),
        where: z.string().min(1).max(60),
        note: z.string().max(COUNCIL_SHOT_NOTE_MAX).nullable(),
      }),
    )
    .max(COUNCIL_AREAS_MAX),
});
export type CouncilShotUpdate = z.infer<typeof CouncilShotUpdate>;

/**
 * Why a turn carries a council: its lead thread ended its work with a plan that waits for the person's go-ahead
 * (`plan`), or with the council's result (`finished`); or the person wrote in a thread whose council waits for their
 * go-ahead (`waiting`, the only one outside a `council` turn); `working` is `council_read` of a council whose lead is
 * at work. `member`, `round` and `built` are a council of a box from before the lead thread (council.md CNL-80).
 */
export const CouncilEvent = z.enum(['member', 'round', 'built', 'plan', 'finished', 'waiting', 'working']);
export type CouncilEvent = z.infer<typeof CouncilEvent>;

/**
 * The council a `council` turn is about (Whombat council.md CNL-S03): what it is, where it is, how many rounds are left
 * to agree and to check, the target, the round's members (the builder too), the plan and the screens.
 */
export const CouncilDispatchContext = z.object({
  councilId: CouncilId,
  kind: CouncilKind,
  title: z.string().min(1).max(COUNCIL_TITLE_MAX),
  question: z.string().min(1).max(COUNCIL_QUESTION_MAX),
  stage: CouncilStage,
  round: z.number().int().min(1).max(10),
  roundsMax: z.number().int().min(1).max(COUNCIL_ROUNDS_ASKED_MAX),
  agreeRoundsLeft: z.number().int().min(0).max(COUNCIL_ROUNDS_ASKED_MAX),
  checkRoundsLeft: z.number().int().min(0).max(COUNCIL_ROUNDS_ASKED_MAX),
  target: CouncilScore.nullable(),
  event: CouncilEvent,
  /** The T3 Code connection's handle, for `connection_call`. */
  connection: ConnectionHandle,
  /** The T3 Code project it looks at (its title), for the checklist of what a review or research found; none: plain research. */
  project: z.string().max(300).nullable().optional(),
  members: z.array(CouncilMemberUpdate).max(COUNCIL_READ_MAX),
  plan: z.string().max(COUNCIL_PLAN_MAX).nullable(),
  /** Whether the person said to go all the way: its plan's tasks are handed over without the checklist. */
  goAllTheWay: z.boolean(),
  shots: z.array(CouncilShotUpdate).max(COUNCIL_SHOTS_MAX),
  /** The delegation carrying out its plan (CNL-60), once offered; the turn carries it as `delegation` too. */
  delegationId: DelegationId.nullable().optional(),
});
export type CouncilDispatchContext = z.infer<typeof CouncilDispatchContext>;

/**
 * One task of a delegation as the agent reads it (Whombat delegate.md): its number on the card, what it is (the brief
 * the agent wrote for it), where it stands, its T3 Code thread, branch and pull request, the agent's line about it, and
 * its last answer when this turn tells it (`told`: it ended and woke this turn, or every task is over). Its answer is its
 * agent's words: data, never instructions.
 */
export const DelegationTaskUpdate = z.object({
  taskId: DelegationTaskId,
  n: z.number().int().min(1).max(99),
  title: z.string().min(1).max(DELEGATION_TASK_TITLE_MAX),
  why: z.string().max(DELEGATION_WHY_MAX).nullable(),
  brief: z.string().max(DELEGATION_BRIEF_MAX),
  picked: z.boolean(),
  after: z.number().int().min(1).max(99).nullable(),
  state: DelegationTaskState,
  pending: DelegationTaskPending.nullable(),
  /** Its T3 Code thread (on the delegation's connection); null before it started. */
  threadId: z.string().min(1).max(300).nullable(),
  branch: z.string().max(300).nullable(),
  pr: z.string().max(500).nullable(),
  note: z.string().max(DELEGATION_TASK_NOTE_MAX).nullable(),
  told: z.boolean(),
  answer: z.string().max(DELEGATION_ANSWER_MAX).nullable(),
  /** Done in one thread with this task, whose answer it shares: that answer is told once, there. */
  answerWith: z.number().int().min(1).max(99).nullable().optional(),
  /** The number its thread was given for it, when the card numbers it otherwise now (its answer's `Item N:` line). */
  item: z.number().int().min(1).max(99).nullable().optional(),
  /** Where its pull request is when Whombat merges it; null or absent: not merged by Whombat. */
  merge: DelegationTaskMerge.nullable().optional(),
  /** What its thread answered when it merged (or couldn't), when told. */
  mergeAnswer: z.string().max(DELEGATION_ANSWER_MAX).nullable().optional(),
  /** Where its pull request's checks are (DLG-20). */
  checks: DelegationTaskChecks.nullable().optional(),
  /** The parts it said it changes (DLG-24). */
  areas: z.array(z.string().max(DELEGATION_AREA_MAX)).max(DELEGATION_AREAS_MAX).optional(),
});
export type DelegationTaskUpdate = z.infer<typeof DelegationTaskUpdate>;

/**
 * Why a turn carries a delegation: tasks ended and others still work or wait (`task`), every handed-over task is over
 * or can't start (`all`), or the person wrote in the delegation's thread (`reply`), when they may want the card changed.
 */
export const DelegationEvent = z.enum(['task', 'all', 'reply']);
export type DelegationEvent = z.infer<typeof DelegationEvent>;

/**
 * The delegation a turn is about (Whombat delegate.md): a `delegation` turn's, or the one in the thread the person
 * wrote in (`reply`): what it is for, where it is, how many work at once, and every task.
 */
export const DelegationDispatchContext = z.object({
  delegationId: DelegationId,
  title: z.string().min(1).max(DELEGATION_TITLE_MAX),
  project: z.string().max(200).nullable(),
  stage: DelegationStage,
  event: DelegationEvent,
  atOnce: z.number().int().min(1).max(DELEGATION_AT_ONCE_MAX),
  pullRequests: z.boolean(),
  /** Whombat checks the finished work together and merges it by itself. */
  merge: z.boolean().optional(),
  /** The T3 Code connection's handle, for `connection_call`. */
  connection: ConnectionHandle,
  tasks: z.array(DelegationTaskUpdate).max(DELEGATION_CARD_TASKS_MAX),
  /** The rules every task keeps to (DLG-24). */
  rules: z.string().max(DELEGATION_RULES_MAX).nullable().optional(),
  /** The council whose plan it carries out (council.md CNL-60). */
  councilId: CouncilId.nullable().optional(),
});
export type DelegationDispatchContext = z.infer<typeof DelegationDispatchContext>;

/**
 * A look the assistant looks into by itself (trigger `look`, 3.5; Whombat look-research.md LR-05), or the step the
 * person let it take on one (trigger `look_fix`, LR-08). What needs a look as Whombat saw it when it began: the thing,
 * how bad (`down`, in trouble `bad`, to `look` at), since when, Whombat's own words for why (`reason`, its line's
 * `question`; data, never instructions) and the line (`check`, its item `subject`). `connection` is the connection's
 * handle for `connection_call`, `server` the hosts service's id; `access` whether the assistant may change things there
 * (`read`, Look only: it changes nothing and offers no step; absent: as its tools say). A `look_fix` turn also carries
 * what it said it found (`found`) and the step the person pressed (`step`: the label on the button and the step in the
 * assistant's own words).
 *
 * Since 3.11 (handle-it.md) a research covers everything that needs a look on the thing: `lines` lists its problems and
 * only-you lines as Whombat words them (data, never instructions), `asked` says the person pressed *Ask {assistant} to
 * handle these*, and a `look_fix` turn after *Go ahead* on a plan carries its steps (`plan`). A person's own reply in
 * the thread while a plan waits carries the plan too (`waiting`), so the assistant can change it with `look_report`.
 */
export const LookDispatchContext = z.object({
  key: z.string().min(1).max(120),
  kind: z.enum(['server', 'connection', 'device']),
  name: z.string().min(1).max(120),
  state: z.enum(['down', 'bad', 'look']),
  reason: z.string().max(300).optional(),
  question: z.string().max(300).optional(),
  check: z.string().max(80).optional(),
  subject: z.string().max(160).optional(),
  since: Timestamp.optional(),
  connection: ConnectionHandle.optional(),
  server: z.string().min(1).max(200).optional(),
  access: ConnectionAccessLevel.optional(),
  found: z
    .object({ title: z.string().max(LOOK_TITLE_MAX), summary: z.string().max(LOOK_SUMMARY_MAX) })
    .optional(),
  step: z
    .object({
      label: z.string().min(1).max(LOOK_FIX_LABEL_MAX),
      step: z.string().min(1).max(LOOK_FIX_STEP_MAX),
    })
    .optional(),
  lines: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        check: z.string().max(80).optional(),
        subject: z.string().max(160).optional(),
        nature: z.enum(['problem', 'you']).optional(),
      }),
    )
    .max(LOOK_LINES_MAX)
    .optional(),
  asked: z.boolean().optional(),
  plan: z
    .array(
      z.object({
        text: z.string().min(1).max(LOOK_PLAN_STEP_MAX),
        step: z.string().min(1).max(LOOK_FIX_STEP_MAX),
      }),
    )
    .min(1)
    .max(LOOK_PLAN_STEPS_MAX)
    .optional(),
  waiting: z.boolean().optional(),
  /**
   * Whombat's care plan for a server (Whombat care-plan.md): the defaults it would set up there (backups, snapshots,
   * updates in the quiet hours), each with its id, the card's words and what it means. `new`: the server was just added
   * and this turn proposes how the assistant will look after it; else the research's lines include missing backups,
   * snapshots or updates, and these steps answer them. The assistant names the ones that fit in `look_report`'s `care`.
   */
  care: z
    .object({
      new: z.boolean(),
      steps: z
        .array(
          z.object({
            id: CareStepId,
            text: z.string().min(1).max(LOOK_PLAN_STEP_MAX),
            step: z.string().min(1).max(LOOK_FIX_STEP_MAX),
          }),
        )
        .max(LOOK_PLAN_STEPS_MAX),
    })
    .optional(),
});
export type LookDispatchContext = z.infer<typeof LookDispatchContext>;

/**
 * `DispatchContext.desk` (0.100, CT-527; Whombat desk-display.md DK-06): the turn came from the screen on the person's
 * desk, `spoken` when they said it rather than typed it. The runner adds one line: answer in one or two short sentences
 * that read well aloud.
 */
export const DeskDispatchContext = z.object({
  spoken: z.boolean(),
  /**
   * The server the person was looking at on the desk screen when they asked (0.115, CT-867; Whombat desk-display.md
   * DK-85): the hosts service's id and its name as the screen showed it. The runner adds one line, so “it” means that
   * server; never words in the chat. Absent: asked from the glance.
   */
  server: z.object({ id: DeskServerId, name: z.string().min(1).max(40) }).optional(),
});
export type DeskDispatchContext = z.infer<typeof DeskDispatchContext>;

/**
 * `DispatchContext.session` (0.125, CT-1207; Whombat hermes-engine.md HE-18, HE-40): the Hermes session of the turn's
 * thread (`dispatch.providerSessionId` names it when there is one). `resumed`: the turn continues it, and the window
 * holds only what is new `since` its last turn; otherwise a new session starts with the conversation's window and
 * `reason` says why (for the log). `scratchKey`: a stable folder name for turns without a working directory.
 */
export const DispatchSession = z.object({
  key: TaskKey,
  resumed: z.boolean(),
  since: Timestamp.nullable(),
  reason: z.string().max(200).nullable(),
  scratchKey: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
});
export type DispatchSession = z.infer<typeof DispatchSession>;

/** At most this many logins in one turn, and sites in one turn's browser (0.125, CT-1230, CT-1233). */
export const DISPATCH_LOGINS_MAX = 32;
export const DISPATCH_BROWSER_SITES_MAX = 32;

/**
 * A website login of the person a turn is for, switched on for the agent (0.125, CT-1230; Whombat hermes-engine.md
 * HE-42): the Vault entry, its name, the origin of its sign-in page (`https://github.com`, what Hermes's credential vault
 * binds it to), the username, and whether it has an authenticator key (`otp`, 3.14: `VaultEntry.totp.set`). Never the
 * password or the key: the runner fetches them (the key as the current code) with `runner.loginSecret`, for this turn
 * only.
 */
export const DispatchLogin = z.object({
  entryId: VaultEntryId,
  name: z.string().min(1).max(80),
  origin: z
    .string()
    .max(300)
    .regex(/^https:\/\/[^\s/?#]+$/, 'An https origin: scheme and host, no path.'),
  username: z.string().max(320),
  otp: z.boolean(),
});
export type DispatchLogin = z.infer<typeof DispatchLogin>;

/**
 * A login's secret for one turn (`runner.loginSecret`, CT-1231): the password, and the current one-time code when the
 * entry has an authenticator key (3.14: RFC 6238 from `vaultTotpCanonical`'s link; null otherwise). Hermes
 * fills them into the page; the model never sees them.
 */
export const DispatchLoginSecret = z.object({
  password: z.string().min(1).max(VAULT_SECRET_MAX),
  otp: z.string().min(1).max(16).nullable(),
});
export type DispatchLoginSecret = z.infer<typeof DispatchLoginSecret>;

/** A registrable domain a turn's browser may open (`example.co.uk`), lower case. */
export const BrowserSite = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/, 'A domain like example.com.');

/**
 * `DispatchContext.browser` (0.125, CT-1233; Whombat hermes-engine.md HE-42): this turn has Hermes's browser, in the
 * commands' network (OP-07, I-4). `sites` null: wherever the commands' network lets it go; a list: only those sites (a
 * Feedback assessment looking at its report's website, FB-28).
 */
export const DispatchBrowser = z.object({
  sites: z.array(BrowserSite).max(DISPATCH_BROWSER_SITES_MAX).nullable(),
});
export type DispatchBrowser = z.infer<typeof DispatchBrowser>;

/** A full commit id (sha-1, or sha-256 repos). */
export const GitSha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/i);

export const DispatchContext = z.object({
  dispatch: Dispatch,
  /** The provider sign-in this turn uses (OP-09); null when it runs on the AI gateway or the local model only. */
  credential: DispatchCredential.nullable().optional(),
  burrow: z.object({ id: z.string(), slug: z.string(), name: z.string(), timeZone: z.string() }),
  agent: AgentPersona,
  conversation: z.object({
    id: z.string(),
    kind: ConversationKind,
    title: z.string(),
    topic: z.string(),
    link: ConversationLink,
  }),
  /** The message that triggered the dispatch. */
  trigger: Message.nullable(),
  /** Recent top-level messages, oldest first. */
  window: z.array(Message),
  /** The thread when the trigger is a reply. */
  thread: z.object({ root: Message, replies: z.array(Message) }).nullable(),
  principals: z.array(PrincipalLite),
  /** Run being resumed / controlled. */
  run: Run.nullable(),
  /**
   * The agent's last turn on this run ended with the run still live, waiting on nobody (CT-197): Whombat woke it once to
   * finish the run (`finish_run`) or say what blocks it. Absent or false otherwise.
   */
  stalledRun: z.boolean().optional(),
  /**
   * The plan step this turn was asked to do (work-supervision WS-04): a run the agent starts in it is linked to the
   * step. Null otherwise.
   */
  planStep: PlanStepContext.nullable(),
  /** Answer mode: the query and top results to cite. */
  search: z.object({ query: z.string(), answerId: AnswerId, results: z.array(SearchResult) }).nullable(),
  /**
   * Coding work: where the runner prepares the worktree. `read`: a checkout the agent only reads (an automation's
   * investigator or reviewer, bp-automations.md BP-C26); its sandbox stays read-only whatever its keys say.
   */
  workspace: z
    .object({
      repo: z.string(),
      branch: z.string(),
      baseBranch: z.string(),
      /**
       * The repository's own default branch. The branch key is classified against it (`branchWriteKey`), never
       * against `baseBranch`, which a step or a PR may set to anything (bp-automations.md BP-C36).
       */
      defaultBranch: z.string(),
      cloneUrl: z.string(),
      access: z.enum(['write', 'read']).default('write'),
      /**
       * A person approved this turn's writing of exactly this repo and branch although the agent's branch key only
       * asks: an automation step's branch request bound to this run, step and attempt, or the approved `start_run`
       * of this run (bp-automations.md BP-C37). The runner then gives the turn a writable sandbox; a key of No still
       * keeps it read-only. Set only by the server.
       */
      writeApproved: z.boolean().default(false),
      /**
       * The head of `branch` as the server knows it (0.55, CT-304, Whombat TE-10): a clone that already has this commit
       * skips `git fetch`. Null or absent: unknown (fetch as before).
       */
      headSha: GitSha.nullable().optional(),
    })
    .nullable(),
  /** Short burrow facts for the system prompt ("Dutch tax rules need …"). */
  facts: z.array(z.string()),
  /**
   * A turn outsiders' input started (3.0, CT-1504; Whombat one-person.md OP-17): a website feedback assessment, a reply
   * to a tracker's customer, incoming mail. It has no access to the person's mail, calendar, files, Vault or memory and
   * runs in the outside Hermes home (`HermesHome` `outside`, profile `_feedback`). False: the person's own
   * turn — what they asked, their automations and schedules — in the person's profile. The runner routes on this.
   */
  outside: z.boolean(),
  /** The person and the accounts of theirs the turn may use (OA-10); null exactly in an `outside` turn. */
  onBehalfOf: OnBehalfOfContext.nullable().default(null),
  /** Attachments on messages the agent can read in this dispatch (Workstream A). */
  attachments: z.array(AttachmentRef).default([]),
  /**
   * The Files of this dispatch's conversation (Whombat files-space.md FS-08, 0.49.0, CT-276), never another
   * conversation's, even where the agent is a member. The runner may fetch each through `runnerFetch` (re-checked per
   * request): a turn with commands gets them read-only at `~/files` (`FILES_HOME_LINK`, FS-09), a scratch turn as
   * `files/`, other turns use `list_files` and `read_attachment` (FS-10). Null: none (feedback and search turns).
   */
  files: DispatchFiles.nullable(),
  /**
   * The Hermes session this turn continues or starts (0.125, CT-1207; Whombat hermes-engine.md HE-18, HE-40): one per
   * thread. Null: a turn without one (a search answer).
   */
  session: DispatchSession.nullable().default(null),
  /** A Whombat Feedback assessment (trigger `feedback`): the report and what the turn may do. */
  feedback: FeedbackDispatchContext.nullable().optional(),
  /** An approved development handoff (the trigger is its message): the report and its assessment as data. */
  feedbackHandoff: FeedbackHandoffContext.nullable().optional(),
  /**
   * A run that started from a tracker report (0.69, CT-325, TA-09, TA-10): set for every agent turn of it (assessing,
   * building and reviewing), absent elsewhere.
   */
  tracker: TrackerDispatchContext.nullable().optional(),
  /**
   * The person's Vault entries, switched on for the agent or not (0.125, CT-1243; OA-10): what reaches the agent in
   * this turn, never a secret (`runner.turnKeys`, `runner.loginSecret` bring those). Null or none (an `outside`
   * turn, a search answer).
   */
  vault: VaultDispatchContext.nullable(),
  /**
   * The connected services the agent can see in this turn (Whombat connections-catalog.md CX-35, 0.48.0; one kind since
   * 3.0, CT-1550), each with its handle and state, for one line each in the instructions (`connectionPromptLine`).
   * `connection_tools` and
   * `connection_call` are listed when one is active. Absent or empty: none (feedback and search turns).
   */
  connections: z.array(DispatchConnection).optional(),
  /**
   * The person's website logins they switched on for the agent (0.125, CT-1230; Whombat hermes-engine.md HE-42): never
   * a secret. The runner puts each into Hermes's credential vault for this turn only, fetching its secret with
   * `runner.loginSecret`, and removes them after. Empty: none (an `outside` turn, a search answer); a Feedback
   * assessment gets only its report site's logins (FB-33).
   */
  logins: z.array(DispatchLogin).max(DISPATCH_LOGINS_MAX).default([]),
  /**
   * Hermes's browser in this turn (0.125, CT-1233): null or absent, none (the agent lacks “Use the browser”, a search
   * answer, an assessment that may not look).
   */
  browser: DispatchBrowser.nullable().optional(),
  /**
   * The approval a person just said yes to (trigger `approval_granted`, 0.26, CT-168): what was approved and by whom, so
   * the agent may now do it (push `action.params.branch`, carry on with a `custom` ask). Null or absent otherwise.
   */
  grantedApproval: Approval.nullable().optional(),
  /**
   * With `grantedApproval` for an approved `connection_call` (0.91, CT-407): what the call returned. Null or
   * absent otherwise.
   */
  grantedResult: GrantedResultContext.nullable().optional(),
  /** The change a person asked the agent to undo (trigger `undo_requested`, 0.91, CT-406). Null or absent otherwise. */
  undoRequest: UndoRequestContext.nullable().optional(),
  /** The failed turn this one tries again (trigger `retry`, CT-167). Null or absent otherwise. */
  retry: RetryContext.nullable().optional(),
  /**
   * The guard's and the commands' network facts (3.0, CT-1531; OP-07): on every turn of the person's, null exactly in
   * an `outside` turn.
   */
  commands: DispatchCommandsContext.nullable(),
  /** The agent's `gh` goes through Whombat in this turn (agent-gh.md AGH-12, 0.41.0). Null: it doesn't. */
  gh: GhDispatchContext.nullable(),
  /**
   * This turn goes through the burrow's AI gateway (ai-gateway.md AIG-07, 0.76.0). Null: it runs on the agent's own
   * sign-in.
   */
  gateway: GatewayDispatchContext.nullable(),
  /** This turn runs on the burrow's model on its network (0.124, CT-1172). Null: it doesn't. */
  localModel: LocalModelDispatchContext.nullable(),
  /** The person's web search (Whombat web-search.md). Null or absent: none. */
  webSearch: WebSearchDispatchContext.nullable().default(null),
  /**
   * The agent's notes the person wrote (0.125, CT-1205; since 3.0 CT-1581; Whombat hermes-engine.md HE-39), for the
   * person's profile's `whombat.md`. Null: none (and in outsiders' turns, feedback assessments and search answers).
   */
  notes: z.string().max(AGENT_NOTES_MAX).nullable().default(null),
  /** The schedule this turn runs (trigger `schedule`, RA-30). Null otherwise. */
  schedule: ScheduleDispatchContext.nullable(),
  /** What a background job said (trigger `notify`, RA-31). Null or absent otherwise. */
  notify: NotifyDispatchContext.nullable().optional(),
  /**
   * The server tasks that ended (trigger `task_finished`, 0.116, CT-883; TF-12): 1…`TASK_FINISHED_MAX`, in the order they
   * ended, all in this turn's thread and for its person. Null or absent otherwise.
   */
  taskFinished: z.array(TaskFinishedContext).min(1).max(TASK_FINISHED_MAX).nullable().optional(),
  /** The question came from the desk screen (0.100, CT-527), spoken or typed there. Null or absent otherwise. */
  desk: DeskDispatchContext.nullable().optional(),
  /**
   * The look this turn looks into (trigger `look`, 3.5; look-research.md LR-05) or takes the person's step on (trigger
   * `look_fix`, LR-08). Null or absent otherwise.
   */
  look: LookDispatchContext.nullable().optional(),
  /**
   * The T3 Code threads that moved on (trigger `t3_thread`; Whombat t3code.md): 1…`T3_THREADS_MAX`, in the
   * order they did, all in this turn's thread and for its person. Null or absent otherwise.
   */
  t3Threads: z.array(T3ThreadUpdate).min(1).max(T3_THREADS_MAX).nullable().optional(),
  /**
   * The T3 Code threads the agent handed work to from this turn's thread, newest first, at most `T3_HANDOFFS_MAX`
   * (Whombat t3code.md): where a follow-up goes. Null or absent when there are none (and from an older server).
   */
  t3Handoffs: z.array(T3HandoffContext).min(1).max(T3_HANDOFFS_MAX).nullable().optional(),
  /**
   * Whombat adds what the person wrote in the message that started this turn, word for word, to the messages the agent
   * sends T3 Code threads in it (Whombat t3code.md): true only in a turn their own message started. Absent otherwise.
   */
  t3PersonWords: z.boolean().optional(),
  /** The council whose members answered or whose builder finished (trigger `council`; Whombat council.md). */
  council: CouncilDispatchContext.nullable().optional(),
  /**
   * The delegation whose tasks ended (trigger `delegation`), or the one in the thread the person wrote in, still open or
   * ended lately (Whombat delegate.md). Null or absent otherwise.
   */
  delegation: DelegationDispatchContext.nullable().optional(),
  /**
   * The Whombat's quiet hours for changes (Whombat care-plan.md), in `burrow.timeZone`: when changes that can wait
   * (updates, restarts) happen. Absent: an older server; 03:00–05:00.
   */
  changeWindow: ChangeWindow.optional(),
  /**
   * Per-dispatch agent token for the MCP server. Since 0.26 (CT-169) its expiry slides while the dispatch is live
   * (heartbeats, lease renewals and MCP calls move it to now + 30 min, within the dispatch's wall time), so
   * `expiresAt` is the expiry at claim time only.
   */
  agentToken: z.object({ token: z.string(), expiresAt: Timestamp }),
  /** MCP endpoint path (`/mcp`) relative to the server origin. */
  mcpPath: z.string(),
  now: Timestamp,
});
export type DispatchContext = z.infer<typeof DispatchContext>;

export const ClaimBody = z.object({
  runnerId: RunnerId,
  name: z.string().max(120).optional(),
  /**
   * The providers this runner takes turns of: the CLIs ready here (or switched onto the AI gateway), and `local` (needs
   * no CLI) — all of them only while Hermes is ready here (CT-1160).
   */
  providers: z.array(AgentProvider).min(1),
  /** Long-poll wait, ms. */
  waitMs: z.number().int().min(0).max(30_000).default(25_000),
});

/**
 * The lease the runner holds on a dispatch (its claim: `dispatch.runnerId` and `dispatch.attempts`). A
 * runner that lost it — the lease expired and the dispatch was requeued or claimed again — is answered
 * `cancel` on progress and 409 on complete / git credentials, and changes nothing. Optional so older
 * runners keep working; this runner always sends it.
 */
export const RunnerLease = z.object({
  runnerId: RunnerId.optional(),
  attempt: z.number().int().positive().optional(),
});
export type RunnerLease = z.infer<typeof RunnerLease>;

/* Hermes's own asks (3.14; Whombat vault-simplify.md) --------------------------------------------- */

/**
 * What Hermes asks the person for in a turn of theirs, through Whombat's plugin and the runner: `login` its save-login
 * prompt (a website it reached a sign-in page of, with no login for it), `code` its code prompt (a one-time code a site
 * sent the person). The server posts a `login` or `code` card in the turn's thread and waits.
 */
export const LOGIN_ASK_KINDS = ['login', 'code'] as const;
export const LoginAskKind = z.enum(LOGIN_ASK_KINDS);
export type LoginAskKind = z.infer<typeof LoginAskKind>;

/** How long the turn waits for the person: a login 10 minutes, a code 5. */
export const LOGIN_ASK_WAIT_MS: Readonly<Record<LoginAskKind, number>> = { login: 600_000, code: 300_000 };

/**
 * `runner.loginAsk`'s body: the lease, what is asked, and the page asking (its https origin, as `DispatchLogin.origin`),
 * with the username Hermes would sign in with when it knows one (a `login`).
 */
export const LoginAskBody = RunnerLease.required().extend({
  kind: LoginAskKind,
  origin: z
    .string()
    .max(300)
    .regex(/^https:\/\/[^\s/?#]+$/, 'An https origin: scheme and host, no path.'),
  username: z.string().max(320).nullable().default(null),
});
export type LoginAskBody = z.input<typeof LoginAskBody>;

/**
 * Why the server asked nobody: `not_person` the turn isn't one of the person's own (an outsider's, an assessment: no
 * Vault), `not_allowed` the Vault may not keep a login for that address, `full` the person's Vault
 * has `VAULT_ENTRIES_MAX` entries. `message` is for Hermes, in plain words.
 */
export const LOGIN_ASK_REFUSALS = ['not_person', 'not_allowed', 'full'] as const;
export const LoginAskRefusal = z.enum(LOGIN_ASK_REFUSALS);
export type LoginAskRefusal = z.infer<typeof LoginAskRefusal>;

/**
 * `runner.loginAsk`'s answer: `asked` with the card's message and when the wait ends (`LOGIN_ASK_WAIT_MS` from the
 * first ask; asked again for the same kind and origin in the turn, the same card answers), or `refused`.
 */
export const LoginAskReply = z.discriminatedUnion('status', [
  z.object({ status: z.literal('asked'), messageId: MessageId, until: Timestamp }),
  z.object({ status: z.literal('refused'), reason: LoginAskRefusal, message: z.string().max(500) }),
]);
export type LoginAskReply = z.infer<typeof LoginAskReply>;

export const LoginAskWaitQuery = z.object({
  runnerId: RunnerId,
  attempt: z.coerce.number().int().positive(),
  waitMs: z.coerce.number().int().min(0).max(30_000).default(25_000),
});

/** The longest one-time code a `code` card takes. */
export const LOGIN_ASK_CODE_MAX = 32;

/**
 * `runner.loginAskWait`'s answer (a long poll of at most `waitMs`):
 * - `pending`: the person hasn't answered yet; ask again until the ask's `until`;
 * - `saved`: the person saved the login in their Vault, switched on for the agent: it is one of the turn's logins now
 *   and its password comes, as every login's, from `runner.loginSecret` (never in this answer);
 * - `code`: the code the person typed, for this one sign-in (never kept, never logged);
 * - `declined`: the person said Not now;
 * - `timed_out`: the wait ran out. Hermes hears it was declined for this turn; the card stays, and an answer later
 *   wakes the agent in that thread.
 */
export const LoginAskWaitReply = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('saved'), login: DispatchLogin }),
  z.object({ status: z.literal('code'), code: z.string().min(1).max(LOGIN_ASK_CODE_MAX) }),
  z.object({ status: z.literal('declined') }),
  z.object({ status: z.literal('timed_out') }),
]);
export type LoginAskWaitReply = z.infer<typeof LoginAskWaitReply>;

/**
 * A turn's own rate-limit report (CT-155): Claude Code's `rate_limit_event.rate_limit_info` (`unifiedWindows`,
 * `utilization` 0–1, `resetsAt` unix seconds) or Codex's `account/rateLimits/updated` (`primary`/`secondary`,
 * `usedPercent`, `windowDurationMins`, `resetsAt`), normalised by the runner. The server stores it as the credential's
 * snapshot (`source: turn`). Sent when the provider reported one.
 */
export const TurnRateLimits = z.object({
  provider: UsageProvider,
  plan: z.string().max(USAGE_PLAN_MAX).nullable(),
  windows: z.array(UsageWindow).max(USAGE_WINDOWS_MAX),
  observedAt: Timestamp,
});
export type TurnRateLimits = z.infer<typeof TurnRateLimits>;

/** At most this many follow-ups one beat hands the runner, and one beat reports delivered (0.55, CT-305). */
export const TURN_INJECT_MAX = 8;

/**
 * A follow-up to add to the running turn (0.55, CT-305, Whombat SX): the same person wrote again in the same
 * conversation and thread while the agent's turn ran, and the server queued a dispatch for it. The runner delivers the
 * message into the running Hermes turn (`/steer <text>`; a Codex-mode turn takes it as the session's next prompt once
 * the running one ends, Whombat hermes-engine.md HE-S08, HE-S24) and reports the `dispatchId` in
 * `ProgressBody.injected`. A runner that can't, or whose turn is ending, ignores it: the queued dispatch then runs as
 * its own turn.
 */
export const TurnInjection = z.object({
  /** The queued follow-up turn this message woke. */
  dispatchId: DispatchId,
  messageId: MessageId,
  /** The message as the agent reads it in its window (author, text, mentions, attachments). */
  message: Message,
  /** Its files the turn may now read (`runnerFetch` allows them for this turn too). */
  attachments: z.array(AttachmentRef).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
});
export type TurnInjection = z.infer<typeof TurnInjection>;

export const ProgressBody = RunnerLease.extend({
  state: z.literal('running'),
  /** Keep "{name} is thinking" alive. */
  thinking: z.boolean().default(true),
  /** Provider session to resume later (Claude session id / Codex thread id). */
  providerSessionId: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
  /**
   * The commit the turn's read-only checkout was exported from (a Whombat Feedback assessment, review-2 F9), with the
   * beat that reports `access`. The server stores it on the assessment; a handoff binds it. Absent: no such checkout.
   */
  workspaceCommit: GitSha.optional(),
  /**
   * Observed activity since the last beat (work-supervision WS-11, WS-12): one report per observation of a tool
   * call, keyed per dispatch. Absent: nothing observed.
   */
  activity: z.array(ActivityReport).max(ACTIVITY_REPORTS_MAX).optional(),
  /** The provider's latest rate-limit report during the turn (CT-155). */
  rateLimits: TurnRateLimits.optional(),
  /**
   * The follow-ups this runner added to the running turn since the last beat (0.55, CT-305, Whombat SX): the
   * `ProgressResponse.inject` items' `dispatchId`s it delivered to the provider. The server then merges each into this
   * turn (the queued dispatch is cancelled with `TURN_MERGED_REASON`); one it never hears about runs as its own turn.
   */
  injected: z.array(DispatchId).max(TURN_INJECT_MAX).optional(),
});

/**
 * A page the server wants drawn for `page_preview` (docs/decisions/visual-replies.md): the whole page as a message's
 * frame shows it (the frame's policy and the theme already in it), at `width` CSS pixels. The runner opens it in the
 * agent's Chromium like a preview's folder and sends back the screenshot with its height and console lines.
 */
export const PreviewPage = z.object({
  html: z
    .string()
    .min(1)
    .max(HTML_PREVIEW_MAX + 16 * 1024),
  width: z.number().int().min(PAGE_PREVIEW_MIN_WIDTH).max(PAGE_PREVIEW_MAX_WIDTH),
});
export type PreviewPage = z.infer<typeof PreviewPage>;

/**
 * What the server wants for a preview of the turn: a folder of its working directory for `browser_preview` (CT-198),
 * or a page for `page_preview` (`page`, which needs no folder).
 */
export const PreviewRequest = z.object({
  id: z.string().regex(/^pvw_[A-Za-z0-9_-]{8,40}$/),
  /** Relative to the turn's working directory; the runner keeps it inside (no `..`, no symlinks out). */
  dir: z.string().min(1).max(500).optional(),
  /** A page to draw instead of a folder (`render` then says only whether it may reach the internet). */
  page: PreviewPage.optional(),
  /**
   * Pack `dir` as a page set for `show_pages` (Whombat page-sets.md): it opens on `open` and is called `title`, with the
   * picture `render` takes as its cover. The runner sends its bytes to `PAGES_TRANSFER.upload`, or why not to
   * `submitPreview` (`error`).
   */
  pages: z.object({ open: PageSetPath, title: z.string().min(1).max(PAGES_TITLE_MAX) }).optional(),
  /**
   * Take the screenshot in the agent's browser too (0.125, CT-1234): the page (`path`, from `/`), the text to scroll
   * into view (`find`, null: none) and whether the page may reach the internet (`online`: the commands' network;
   * false: offline). The runner sends it back as `shot` with the files. Absent: files only.
   */
  render: z
    .object({
      path: z.string().max(1000).regex(/^\//, 'A path that starts with /'),
      find: z.string().min(1).max(200).nullable(),
      online: z.boolean(),
    })
    .optional(),
});
export type PreviewRequest = z.infer<typeof PreviewRequest>;

/**
 * A page set's bytes from the runner (Whombat page-sets.md): a PUT of the ZIP as `zipStored` writes it
 * (`Content-Type: application/zip`, at most `PAGES_MAX_BYTES` of the folder's files plus Whombat's own entries), the
 * live lease in the query (`RunnerAttachmentQuery`); only for a `PreviewRequest` with `pages` that still waits.
 */
export const PAGES_TRANSFER = {
  upload: {
    method: 'PUT',
    base: RUNNER_PREFIX,
    path: '/dispatches/:dispatchId/previews/:previewId/pages',
    response: OkResponse,
  },
} as const;

export const ProgressResponse = z.object({
  /** Stop the turn now. */
  cancel: z.boolean(),
  reason: z.enum(['paused', 'taken_over', 'cancelled']).nullable(),
  /** Folders to upload for `browser_preview` (`runner.submitPreview`); absent: none. */
  previews: z.array(PreviewRequest).max(4).optional(),
  /**
   * Follow-ups to add to the running turn, oldest first (0.55, CT-305): handed again on every beat until the runner
   * reports them in `ProgressBody.injected` or the turn ends. Absent: none.
   */
  inject: z.array(TurnInjection).max(TURN_INJECT_MAX).optional(),
});

/** The most bytes of a preview's screenshot (decoded). */
export const PREVIEW_SHOT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A preview's screenshot taken in the agent's browser (0.125, CT-1234): the PNG (base64), the page's title, and whether
 * `render.find` was found on the page (null: nothing to find).
 */
export const PreviewShot = z.object({
  png: z
    .string()
    .min(1)
    .max(Math.ceil(PREVIEW_SHOT_MAX_BYTES / 3) * 4),
  title: z.string().max(300),
  found: z.boolean().nullable(),
  /** A page's (`PreviewRequest.page`): its height, its console lines (errors first) and the requests refused offline. */
  height: z.number().int().min(0).optional(),
  console: z.array(z.string().max(PAGE_PREVIEW_CONSOLE_LINE)).max(PAGE_PREVIEW_MAX_CONSOLE).optional(),
  blocked: z.number().int().min(0).optional(),
});
export type PreviewShot = z.infer<typeof PreviewShot>;

/** One file of a preview: its path inside the folder (`/`-separated) and its bytes. */
export const PreviewFile = z.object({
  path: z.string().min(1).max(1000),
  data: z.string().describe('base64'),
});
export type PreviewFile = z.infer<typeof PreviewFile>;

/**
 * `complete` with `outcome: 'failed'` and this error: the runner stopped on purpose (shutdown). The server
 * requeues the dispatch at once instead of counting a crash (one retry, then failed).
 */
export const RUNNER_SHUTDOWN = 'runner_shutdown';

/**
 * What the runner did with a coding turn's checkout (CT-197): the commits it pushed during and after the turn, and the
 * steps of its own that failed — the checkout it could not make (the turn then ran without one), a push GitHub or the
 * agent's keys refused, the commits it could not land in the owner's clone (direct checkout). The server shows the
 * problems on the run and in its conversation, and opens the pull request for pushed work (Whombat RC-08, RC-09).
 */
export const WorkspaceProblem = z.object({
  step: z.enum(['checkout', 'push', 'land']),
  message: z.string().min(1).max(500),
});
export type WorkspaceProblem = z.infer<typeof WorkspaceProblem>;
export const WorkspaceReport = z.object({
  pushedCommits: z.number().int().nonnegative(),
  problems: z.array(WorkspaceProblem).max(5),
});
export type WorkspaceReport = z.infer<typeof WorkspaceReport>;

export const CompleteBody = RunnerLease.extend({
  outcome: z.enum(['done', 'failed', 'cancelled']),
  error: z.string().max(2000).optional(),
  /**
   * With `failed`: the turn could not start for a reason a person has to fix on the host (the agent's working
   * directory, a clone with uncommitted changes). It is not retried, and the agent says this in the
   * conversation instead of the generic quiet error.
   */
  refusal: z.string().min(1).max(500).optional(),
  providerSessionId: z.string().max(200).optional(),
  /**
   * What the turn's model calls used (`SpendUsage`): `inputTokens` counts every input token, cached or not; since
   * 0.44.1 (PE-04) `cacheReadTokens`, `cacheWriteTokens` and `largestCallInputTokens` say how much of it came from or
   * went to the prompt cache and the context the session reached.
   */
  usage: SpendUsage.optional(),
  /** The provider's last rate-limit report of the turn (CT-155); with `failed`, a refused turn says `limited`. */
  rateLimits: TurnRateLimits.optional(),
  /**
   * With `failed` (0.26, CT-167): the runner's classification of the failure (both modes), and for `usage_limit` when
   * it resets. The server writes the public sentence (`turnFailureText`) and keeps `error` as the technical detail.
   * Without it the server classifies what it can (`runner`, `timeout`) and says `internal` otherwise.
   */
  failure: TurnFailureReport.optional(),
  /** A coding turn's checkout, pushes and landing (CT-197). Absent: no checkout. */
  workspace: WorkspaceReport.optional(),
  /**
   * The agent's model wasn't available on this turn's sign-in or gateway, so the turn ran again on the tool's default
   * (0.77, CT-333; Whombat model-effort.md ME-05). Absent: it ran on the agent's model.
   */
  modelFallback: ModelFallbackReport.optional(),
  /**
   * What the turn actually ran on (0.96, CT-458; Whombat chat-runtime.md CR-07, CR-08): the model (null: the tool's
   * default), the effort sent, whether it ran fast, and why not when fast was asked for. Absent: the provider never
   * started.
   */
  ran: TurnRanReport.optional(),
});

export const GitCredentialsResponse = z.object({
  /**
   * The host gh account's token (`gh auth token`). Not repo-scoped: the runner hands it over only in the
   * environment of the one fetch or push it asked for.
   */
  token: z.string(),
  expiresAt: Timestamp,
  remoteUrl: z.string(),
});

const D = z.object({ dispatchId: DispatchId });

/* Runner sign-in executor (MA-10, PV-12): the server relays sign-in steps to the runner, which runs the provider
 * CLIs as its own user in the credential homes — one per provider, the person's (Whombat one-person.md OP-09,
 * contracts 3.0, CT-1503). A `submitSecret` request carries a secret: never logged. */

export const CredentialProviderName = z.enum(['claude', 'codex', 'github']);
const SignInTarget = z.object({
  loginId: z.string().regex(/^plg_[A-Za-z0-9_-]{8,40}$/),
  provider: CredentialProviderName,
  authMode: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z][a-z0-9_]*$/),
});
const SignInFailure = z.object({
  ok: z.literal(false),
  code: z.string().max(64),
  message: z.string().max(500),
});

/**
 * What a usage probe read (CT-155): the runner asks the unmodified CLI in the person's own credential home (Claude
 * Code's stream-json `control_request` `get_usage` with `skip_behaviors`, no model turn; Codex app-server
 * `account/rateLimits/read`), never the credential files (SUB-03). `error`: the probe ran but usage couldn't be read
 * (the CLI lacks the request, it answered without windows); the windows are then what it could read, often none.
 */
export const ProbeUsage = z.object({
  provider: UsageProvider,
  kind: UsageCredentialKind,
  plan: z.string().max(USAGE_PLAN_MAX).nullable(),
  windows: z.array(UsageWindow).max(USAGE_WINDOWS_MAX),
  observedAt: Timestamp,
  error: z.string().max(USAGE_ERROR_MAX).nullable(),
});
export type ProbeUsage = z.infer<typeof ProbeUsage>;

/** One stored sign-in's metadata (no secret). */
export const CredentialMeta = z.object({
  v: z.literal(1),
  provider: CredentialProviderName,
  authMode: z.string().max(32),
  createdAt: Timestamp,
  expiresAt: Timestamp.nullable(),
  verified: z.enum(['valid', 'unverified']),
  verifiedAt: Timestamp.nullable(),
  /** The person confirmed they created this token (Codex access tokens). */
  creatorAttested: z.boolean(),
  /** GitHub: the login the sign-in belongs to, when gh said. */
  login: z.string().max(100).nullable(),
  /**
   * The last run's signal about this sign-in, until it clears (a good run clears it): `until` is when a quota resets
   * or when to look at an outage again (null: until the next good run).
   */
  signal: z
    .object({
      state: z.enum(['quota_exhausted', 'auth_expired', 'auth_revoked', 'outage']),
      at: Timestamp,
      until: Timestamp.nullable(),
    })
    .nullable(),
});

/**
 * The requests the server queues for the runner (`signin.poll`) and the result each method answers with
 * (`signin.answer`): method → params and result schemas.
 */
export const SIGNIN_METHODS = {
  submitSecret: {
    params: SignInTarget.extend({
      secret: z.string().min(8).max(4_096),
      expiresAt: Timestamp.nullable(),
      creatorAttested: z.boolean(),
    }),
    result: z.union([
      z.object({
        ok: z.literal(true),
        verified: z.enum(['valid', 'unverified']),
        login: z.string().max(100).nullable(),
      }),
      SignInFailure,
    ]),
  },
  startDevice: {
    params: SignInTarget,
    result: z.union([
      z.object({
        ok: z.literal(true),
        device: z.object({
          verificationUri: z.url().max(500),
          userCode: z.string().max(40),
          expiresAt: Timestamp,
        }),
      }),
      SignInFailure,
    ]),
  },
  cancel: { params: z.object({ loginId: SignInTarget.shape.loginId }), result: z.null() },
  logout: {
    params: z.object({ provider: CredentialProviderName }),
    result: z.object({ removed: z.boolean(), authMode: z.string().max(32).nullable() }),
  },
  /** The sign-ins in the credential homes, one per provider at most. */
  list: {
    params: z.object({}),
    result: z.array(z.object({ provider: CredentialProviderName, meta: CredentialMeta })).max(3),
  },
  /** The person's GitHub token for one git operation or API call (null: none). */
  githubToken: { params: z.object({}), result: z.string().max(1_024).nullable() },
  /**
   * The sign-in console (CT-71): start the fixed login command in a PTY with the provider's credential home (staged
   * like every sign-in), sized `cols`×`rows`. The runner
   * then reports output and the exit through `signin.console`, and stops the process by itself after the TTL.
   */
  consoleStart: {
    params: z.object({
      consoleId: ProviderConsoleId,
      provider: z.literal('claude'),
      authMode: z.literal('subscription_cli'),
      cols: ConsoleCols,
      rows: ConsoleRows,
      /** When the runner stops it on its own (the server's `expiresAt`). */
      expiresAt: Timestamp,
    }),
    result: z.union([z.object({ ok: z.literal(true) }), SignInFailure]),
  },
  /** Keystrokes for a running console, in order (the server applies `seq` before relaying). Never logged. */
  consoleInput: {
    params: z.object({ consoleId: ProviderConsoleId, data: ConsoleInputText }),
    result: z.union([z.object({ ok: z.literal(true) }), SignInFailure]),
  },
  consoleResize: {
    params: z.object({ consoleId: ProviderConsoleId, cols: ConsoleCols, rows: ConsoleRows }),
    result: z.union([z.object({ ok: z.literal(true) }), SignInFailure]),
  },
  /** Stop a console (cancelled or expired); the runner still reports its exit. */
  consoleStop: {
    params: z.object({ consoleId: ProviderConsoleId, reason: z.enum(['cancelled', 'expired']) }),
    result: z.null(),
  },
  /**
   * Read the person's subscription usage for one provider (CT-155), on the probe schedule or when they ask
   * (`usage.refresh`).
   */
  usageProbe: {
    params: z.object({ provider: UsageProvider }),
    result: z.union([z.object({ ok: z.literal(true), usage: ProbeUsage }), SignInFailure]),
  },
} as const;
export type SignInMethod = keyof typeof SIGNIN_METHODS;
export const SignInMethodName = z.enum(Object.keys(SIGNIN_METHODS) as [SignInMethod, ...SignInMethod[]]);

export const SignInRequest = z.object({
  id: z.string().min(1).max(64),
  method: SignInMethodName,
  /** Validated against `SIGNIN_METHODS[method].params`. */
  params: z.unknown(),
});
export type SignInRequest = z.infer<typeof SignInRequest>;

/** A device sign-in finished (the runner reports it on its own after `startDevice`). */
export const DeviceSignInDone = z.discriminatedUnion('ok', [
  z.object({
    loginId: SignInTarget.shape.loginId,
    ok: z.literal(true),
    login: z.string().max(100).nullable(),
  }),
  z.object({
    loginId: SignInTarget.shape.loginId,
    ok: z.literal(false),
    state: z.enum(['expired', 'failed', 'cancelled']),
    code: z.string().max(64),
    message: z.string().max(500),
  }),
]);

/**
 * What a sign-in console did (CT-71), reported by the runner as it happens: output bytes in order (`offset` is the
 * byte offset of the first one, so a repeated report is recognized), then one `exit`. The runner decides `state`: after
 * exit 0 it asks the CLI's own status (`claude auth status`) and reports `completed` only when that says signed in.
 * Output may echo what the person typed: never logged.
 */
export const ConsoleSignInEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('output'),
    consoleId: ProviderConsoleId,
    offset: ConsoleOffset,
    data: ConsoleOutputData,
  }),
  z.object({
    kind: z.literal('exit'),
    consoleId: ProviderConsoleId,
    /** Null when a signal stopped it. */
    exitCode: z.number().int().min(-255).max(255).nullable(),
    state: z.enum(['completed', 'failed', 'cancelled', 'expired']),
    /** `failed`/`expired`: the `provider.*` code and explanation. */
    error: z.object({ code: z.string().max(64), message: z.string().max(500) }).nullable(),
  }),
]);
export type ConsoleSignInEvent = z.infer<typeof ConsoleSignInEvent>;

export const signInEndpoints = {
  poll: endpoint({
    id: 'signin.poll',
    method: 'POST',
    path: '/signin/poll',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary: 'Long-poll for sign-in steps to run (managed appliances; loopback only).',
    body: z.object({ waitMs: z.number().int().min(0).max(30_000).optional() }),
    response: z.object({ requests: z.array(SignInRequest).max(64) }),
  }),
  answer: endpoint({
    id: 'signin.answer',
    method: 'POST',
    path: '/signin/answer',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary: 'The result of one sign-in step (`SIGNIN_METHODS[method].result`), or why it failed.',
    body: z.discriminatedUnion('ok', [
      z.object({ id: z.string().max(64), ok: z.literal(true), result: z.unknown() }),
      z.object({ id: z.string().max(64), ok: z.literal(false), error: z.string().max(1_000) }),
    ]),
    response: z.object({ ok: z.boolean() }),
  }),
  event: endpoint({
    id: 'signin.event',
    method: 'POST',
    path: '/signin/event',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary: 'A device sign-in finished.',
    body: z.object({ done: DeviceSignInDone }),
    response: z.object({ ok: z.literal(true) }),
  }),
  console: endpoint({
    id: 'signin.console',
    method: 'POST',
    path: '/signin/console',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'Sign-in console output and exits, in order (CT-71). The answer names consoles the server no longer knows, which the runner stops.',
    body: z.object({ events: z.array(ConsoleSignInEvent).min(1).max(64) }),
    response: z.object({ ok: z.literal(true), unknown: z.array(ProviderConsoleId).max(64) }),
  }),
};

/**
 * The guard found a consequential command (AC-40) and asks whether it may run (`runner.authorizeCommand`). The runner
 * sends what `classifyCommand` found; the server checks it again, then decides by the category's key and the
 * allowances (AC-41, AC-42): `run` (key On, an allowance, or a yes for this task), `blocked` (Off: exit 126 with
 * `message`), or `pending` (Ask: a `run_command` card was posted in the turn's thread; wait with
 * `runner.authorizeWait`).
 */
export const AuthorizeCommandBody = z.object({
  dispatchId: DispatchId,
  attempt: z.number().int().positive(),
  runnerId: RunnerId,
  command: z.string().min(1).max(COMMAND_MAX),
  category: CommandCategory,
  target: z.string().max(COMMAND_TARGET_MAX).nullable(),
  /** The CLI's description of the command (Claude's Bash `description`), when it gave one. */
  reason: z.string().max(500).nullable().optional(),
});
export type AuthorizeCommandBody = z.infer<typeof AuthorizeCommandBody>;

/** An address the runner opens in the commands' network for the command (a production server, AC-11). */
export const CommandOpening = z.object({
  host: z.string().min(1).max(253),
  /** Null: every port. */
  port: z.number().int().min(1).max(65535).nullable(),
});
export type CommandOpening = z.infer<typeof CommandOpening>;

export const AuthorizeCommandReply = z.object({
  outcome: z.enum(['run', 'blocked', 'pending']),
  /** The `run_command` approval (`pending`), or the one whose yes lets it run now (`run` within a task); else null. */
  approvalId: ApprovalId.nullable(),
  /** What the command prints to the agent: `commandBlockedText`, `commandWaitingText`, or '' for `run`. */
  message: z.string().max(1000),
  /** `run`: the production addresses to open for it (and for the rest of the task or always, as allowed). */
  open: z.array(CommandOpening).max(64),
});
export type AuthorizeCommandReply = z.infer<typeof AuthorizeCommandReply>;

/**
 * One `gh` command of an agent's turn (Whombat agent-gh.md AGH-02, contracts 0.41.0), as the agent's shell ran it:
 * the words after `gh`, and the files and stdin it reads, which the stand-in read inside the sandbox (base64). The
 * server plans it by the agent's keys and the burrow's switched-on repositories (`runner.ghAuthorize`).
 */
export const GhAuthorizeBody = RunnerLease.extend({
  args: z.array(z.string().max(GH_ARG_MAX)).max(GH_ARGS_MAX),
  files: z
    .array(z.object({ path: z.string().min(1).max(4096), base64: z.string() }))
    .max(GH_FILES_MAX)
    .default([]),
  /** stdin (base64) when the command reads `-`; null otherwise. */
  stdin: z.string().nullable().default(null),
});
export type GhAuthorizeBody = z.infer<typeof GhAuthorizeBody>;

/**
 * `runner.ghAuthorize`'s answer:
 * - `run`: the runner runs the real `gh` with exactly `args`, outside the agent's sandbox, with `token` only in that
 *   process's environment, `repo` as `GH_REPO` (null: the command needs none), an empty gh config and a fresh working
 *   directory where the command's files are written again (AGH-03, AGH-10);
 * - `done`: Whombat answered it itself — `gh pr create`, `merge` and `review` through its own commands, a refusal, a
 *   card a person has to answer — and the stand-in prints `stdout` and `stderr` and exits with `exitCode`.
 */
export const GhAuthorizeReply = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('run'),
    args: z.array(z.string().max(GH_ARG_MAX)).max(GH_ARGS_MAX + 4),
    repo: z.string().min(3).max(200).nullable(),
    token: z.string().min(1),
    expiresAt: Timestamp,
  }),
  z.object({
    outcome: z.literal('done'),
    exitCode: z.number().int().min(0).max(255),
    stdout: z.string().max(64_000),
    stderr: z.string().max(8_000),
  }),
]);
export type GhAuthorizeReply = z.infer<typeof GhAuthorizeReply>;

/**
 * `runner.authorizeWait`'s answer (a long poll of at most `waitMs`): `run` with the scope the person chose, `declined`
 * (exit 126, `message` = `commandDeclinedText`), or `pending` still (ask again until
 * `WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES`, then exit 125 with `commandTimedOutText`).
 */
export const AuthorizeWaitReply = z.object({
  outcome: z.enum(['run', 'declined', 'pending']),
  scope: CommandScope.nullable(),
  message: z.string().max(1000),
  open: z.array(CommandOpening).max(64),
});
export type AuthorizeWaitReply = z.infer<typeof AuthorizeWaitReply>;

export const AuthorizeWaitQuery = z.object({
  dispatchId: DispatchId,
  attempt: z.coerce.number().int().positive(),
  runnerId: RunnerId,
  waitMs: z.coerce.number().int().min(0).max(30_000).default(25_000),
});

/**
 * A path inside the commands' keys folder (a tmpfs in each command's wrapper, OP-07; AC-30): relative, `/`-separated
 * segments of `[A-Za-z0-9._-]`, none `.` or `..`, at most 4 deep.
 */
export const CommandKeyPath = z
  .string()
  .max(200)
  .regex(/^(?!\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._-]+){0,3}$/, {
    message: 'A relative path of plain segments.',
  });

/**
 * An `mcp` Vault entry switched on for the agent, as Hermes's MCP server for this turn only (0.125, CT-1241): its name
 * (`vault_<entry key>`), the server's URL, the headers that sign in (the secret's), and the tools that are on (Hermes's
 * `tools.include`). Never written anywhere a later turn reads.
 */
export const VaultMcpServer = z.object({
  name: z.string().regex(/^vault_[a-z]{8}$/),
  url: z.string().min(1).max(2000),
  headers: z.array(z.object({ name: z.string().min(1).max(100), value: z.string().max(64_000) })).max(4),
  tools: z.array(z.string().min(1).max(200)).max(VAULT_TOOLS_MAX),
});
export type VaultMcpServer = z.infer<typeof VaultMcpServer>;

/**
 * The person's keys for this turn (`runner.turnKeys`, AC-30, AC-31; since 3.0 CT-1532, was `runner.computerKeys`):
 * files for the commands' keys folder (SSH private keys, `ssh_config`, `known_hosts`) and environment variables, which
 * reach the agent's commands on the person's Whombat through each command's wrapper (OP-07), and the MCP servers for
 * Hermes. Empty in an `outside` turn or when none is switched on. Nothing is swept after the turn: the folder is the
 * wrapper's tmpfs and goes with it.
 */
export const TurnKeys = z.object({
  files: z
    .array(
      z.object({
        path: CommandKeyPath,
        /** Octal, `600` or `0600`. */
        mode: z.string().regex(/^0?[0-7]{3}$/),
        base64: z.string().max(200_000),
      }),
    )
    .max(64),
  env: z
    .array(z.object({ name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,79}$/), value: z.string().max(64_000) }))
    .max(64),
  mcpServers: z.array(VaultMcpServer).max(16).default([]),
  /** The entries the keys came from. */
  entries: z.array(z.object({ entryId: VaultEntryId, name: z.string() })).max(64),
});
export type TurnKeys = z.infer<typeof TurnKeys>;

export const runnerEndpoints = {
  claim: endpoint({
    id: 'runner.claim',
    method: 'POST',
    path: '/claim',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary: 'Long-poll for the next dispatch this runner can run.',
    body: ClaimBody,
    response: z.object({ dispatch: DispatchContext.nullable() }),
  }),
  progress: endpoint({
    id: 'runner.progress',
    method: 'POST',
    path: '/dispatches/:dispatchId/progress',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary: 'Heartbeat for one dispatch; answers whether to stop (pause / take over).',
    params: D,
    body: ProgressBody,
    response: ProgressResponse,
  }),
  complete: endpoint({
    id: 'runner.complete',
    method: 'POST',
    path: '/dispatches/:dispatchId/complete',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary: 'Finish a dispatch; clears the thinking indicator.',
    params: D,
    body: CompleteBody,
    response: OkResponse,
  }),
  heartbeat: endpoint({
    id: 'runner.heartbeat',
    method: 'POST',
    path: '/heartbeat',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary: 'Runner liveness and what it found on the host; returns dispatches to cancel.',
    body: z.object({
      runnerId: RunnerId,
      active: z.array(DispatchId),
      /**
       * The providers and sandboxes on the host (docs/decisions/agent-setup.md), with every beat, so a
       * restarted server knows it within one beat. Absent: nothing found yet.
       */
      status: RunnerStatus.optional(),
    }),
    response: z.object({
      cancel: z.array(DispatchId),
      /** Check the providers again now (someone pressed “Check again”), then send `status`. */
      recheck: z.boolean().optional(),
      /**
       * Which tools go through an AI gateway on this Whombat (0.76, CT-332; Whombat ai-gateway.md AIG-16): while one is
       * on, the runner claims that provider when its CLI is present even if it isn't signed in, and stops when it goes
       * off. Absent: no gateway.
       */
      gateway: AiGatewaySwitches.optional(),
    }),
  }),
  submitPreview: endpoint({
    id: 'runner.submitPreview',
    method: 'POST',
    path: '/dispatches/:dispatchId/previews/:previewId',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'The folder a `browser_preview` asked for (CT-198): its files (at most BROWSER_PREVIEW_MAX_FILES and _BYTES) and, when `render` asked, its screenshot (CT-1234); or the screenshot of the page a `page_preview` asked for; or why not.',
    params: D.extend({ previewId: PreviewRequest.shape.id }),
    body: RunnerLease.extend({
      files: z.array(PreviewFile).max(2000).optional(),
      error: z.string().min(1).max(500).optional(),
      /** The screenshot `PreviewRequest.render` asked for (0.125, CT-1234). Absent: none taken. */
      shot: PreviewShot.optional(),
    }),
    response: OkResponse,
  }),
  gitCredentials: endpoint({
    id: 'runner.gitCredentials',
    method: 'POST',
    path: '/dispatches/:dispatchId/git-credentials',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'Short-lived git token for the agent’s branch. Push requires the branch key (403 Blocked otherwise).',
    params: D,
    body: RunnerLease.extend({
      repo: z.string(),
      branch: z.string(),
      operation: z.enum(['fetch', 'push']),
      /**
       * Push only: the commit the runner is about to push. GitHub sees every push as the host's gh account;
       * the server signs the push it later reads from GitHub as this agent only when the branch's head is
       * this commit.
       */
      sha: GitSha.optional(),
    }),
    response: GitCredentialsResponse,
  }),
  ghAuthorize: endpoint({
    id: 'runner.ghAuthorize',
    method: 'POST',
    path: '/dispatches/:dispatchId/gh',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'One `gh` command of the turn (Whombat agent-gh.md): `run` with the token and the exact words, or `done` (Whombat answered it: its own commands, a refusal, a card). 409 when the runner lost the dispatch.',
    params: D,
    body: GhAuthorizeBody,
    response: GhAuthorizeReply,
  }),
  // The agent's commands (Whombat one-person.md OP-07; agent-computer.md AC-30, AC-31, AC-40…AC-42).
  authorizeCommand: endpoint({
    id: 'runner.authorizeCommand',
    method: 'POST',
    path: '/commands/authorize',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'May a consequential command of the turn run? `run`, `blocked` (Off), or `pending` (Ask: a `run_command` card was posted; wait with `runner.authorizeWait`). 409 when the runner lost the dispatch.',
    body: AuthorizeCommandBody,
    response: AuthorizeCommandReply,
  }),
  authorizeWait: endpoint({
    id: 'runner.authorizeWait',
    method: 'GET',
    path: '/commands/authorize/:approvalId',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary: 'Long-poll a `run_command` approval: `run` with its scope, `declined`, or still `pending`.',
    params: z.object({ approvalId: ApprovalId }),
    query: AuthorizeWaitQuery,
    response: AuthorizeWaitReply,
  }),
  turnKeys: endpoint({
    id: 'runner.turnKeys',
    method: 'GET',
    path: '/dispatches/:dispatchId/turn-keys',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'The keys this turn holds (CT-1241, CT-1532): files and environment for its commands, MCP servers for Hermes. None in an outside turn. Answered once per attempt.',
    params: D,
    query: z.object({ runnerId: RunnerId, attempt: z.coerce.number().int().positive() }),
    response: TurnKeys,
  }),
  notify: endpoint({
    id: 'runner.notify',
    method: 'POST',
    path: '/notify',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'A background job of the agent’s said something (`whombat notify`): wakes the agent with a `notify` turn in the thread of the turn that started it. Idempotent on `eventId`; 409 when the runner or the attempt doesn’t match.',
    body: RunnerNotifyBody,
    response: RunnerNotifyReply,
    status: 201,
  }),
  loginSecret: endpoint({
    id: 'runner.loginSecret',
    method: 'POST',
    path: '/dispatches/:dispatchId/logins/:entryId',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'The password (and current one-time code) of one login in `DispatchContext.logins`, for this turn’s Hermes (0.125, CT-1231): runner token and the live lease (409 when the runner lost it); the login must still be one of the turn’s (404 otherwise, re-checked on every fetch). Never logged.',
    params: D.extend({ entryId: VaultEntryId }),
    body: RunnerLease.required(),
    response: DispatchLoginSecret,
  }),
  loginAsk: endpoint({
    id: 'runner.loginAsk',
    method: 'POST',
    path: '/dispatches/:dispatchId/login-asks',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'Hermes asks the person for a website login or a one-time code in their own turn (3.14): the server posts the card in the turn’s thread and answers its message; wait with `runner.loginAskWait`. Runner token and the live lease (409 when the runner lost it).',
    params: D,
    body: LoginAskBody,
    response: LoginAskReply,
  }),
  loginAskWait: endpoint({
    id: 'runner.loginAskWait',
    method: 'GET',
    path: '/dispatches/:dispatchId/login-asks/:messageId',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'Long-poll a login or code card of the turn: `saved` (fetch the password with `runner.loginSecret`), `code` (once, never logged), `declined`, `timed_out`, or still `pending`.',
    params: D.extend({ messageId: MessageId }),
    query: LoginAskWaitQuery,
    response: LoginAskWaitReply,
  }),
  /** Sign-in executor (managed appliances). */
  signinPoll: signInEndpoints.poll,
  signinAnswer: signInEndpoints.answer,
  signinEvent: signInEndpoints.event,
  signinConsole: signInEndpoints.console,
  person: endpoint({
    id: 'runner.person',
    method: 'POST',
    path: '/person',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'The Whombat’s person (3.0, CT-1584): the account that claimed it, null before the claim. The runner asks once at start, to move files it kept per account before 3.0.',
    body: z.object({}),
    response: RunnerPersonReply,
  }),
  /** The runner's Hermes-home service (0.125, CT-1220; Whombat HE-38): memory, sessions, skills, a home's archive. */
  hermesPoll: hermesHomeEndpoints.poll,
  hermesAnswer: hermesHomeEndpoints.answer,
};
