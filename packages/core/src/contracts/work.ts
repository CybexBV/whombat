/** Branch rooms (pull requests), runs, approvals and plans. */
import { z } from 'zod';
import { CommandScope } from '../commands/commands.js';
import { Activity } from '../domain/activity.js';
import { Approval, ApprovalState } from '../domain/approval.js';
import { AutomationId } from '../domain/automation.js';
import { Canvas } from '../domain/canvas.js';
import { Count, Cursor } from '../domain/common.js';
import { ConversationSummary } from '../domain/conversation.js';
import { PrFileView } from '../domain/file-view.js';
import { Grant } from '../domain/grant.js';
import { PLAN_MAX_STEPS, Plan, PlanStepNote, PlanStepState } from '../domain/plan.js';
import { MergeBlockReason, PrState, PrStatus, PullRequest } from '../domain/repo.js';
import { Run, RunLogLine, RunStatus } from '../domain/run.js';
import { WorkOverview } from '../domain/work.js';
import { ConversationId, DispatchId, EventId, MessageId, PlanId, StepId } from '../ids.js';
import { BurrowParam, endpoint, limitQuery, NumberParam } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });
const BN = B.extend({ number: NumberParam });

/* Pull requests / branch rooms ------------------------------------------------------------------- */

export const PullRequestDetail = z.object({
  pr: PullRequest,
  /** Drives the header chip ("Open · changes requested") and sidebar dot. */
  status: PrStatus,
  /** Why Merge into main is disabled for the viewer, or null when they can merge. */
  mergeBlock: MergeBlockReason.nullable(),
  /** STAGING section: the latest deploy approval for this branch, if any. */
  staging: Approval.nullable(),
});
export type PullRequestDetail = z.infer<typeof PullRequestDetail>;

export const prEndpoints = {
  list: endpoint({
    id: 'prs.list',
    method: 'GET',
    path: '/burrows/:burrow/prs',
    summary: 'Pull requests in switched-on repos.',
    params: B,
    query: z.object({ state: PrState.optional() }),
    response: z.object({ prs: z.array(PullRequest) }),
  }),
  get: endpoint({
    id: 'prs.get',
    method: 'GET',
    path: '/burrows/:burrow/prs/:number',
    summary: 'Branch room side pane and Files changed tab: checks, reviewers, files, staging, merge state.',
    params: BN,
    query: z.object({ repo: z.string().optional() }),
    response: PullRequestDetail,
  }),
  /** CT-241: the file view, opened from Files changed. 404 when the PR doesn't change `path`. */
  file: endpoint({
    id: 'prs.file',
    method: 'GET',
    path: '/burrows/:burrow/prs/:number/file',
    summary: 'One file of a pull request, whole: its lines with what the branch removed and added in place.',
    params: BN,
    query: z.object({ repo: z.string().optional(), path: z.string().min(1).max(4096) }),
    response: PrFileView,
  }),
  merge: endpoint({
    id: 'prs.merge',
    method: 'POST',
    path: '/burrows/:burrow/prs/:number/merge',
    summary: 'Merge into main. People only; disabled until checks and review pass.',
    params: BN,
    query: z.object({ repo: z.string().optional() }),
    body: z.object({ method: z.enum(['merge', 'squash', 'rebase']).default('squash') }),
    response: PullRequestDetail,
  }),
};

/* Runs ------------------------------------------------------------------------------------------- */

export const RunDetail = z.object({
  run: Run,
  /** Latest log lines, oldest first (the page shows the last 12). */
  log: z.array(RunLogLine),
  /** The agent's grants: "Banjo’s keys for this run". */
  grants: z.array(Grant),
  /** "Asked by Waffle in #billing-v2". */
  conversation: ConversationSummary,
});
export type RunDetail = z.infer<typeof RunDetail>;

export const TakeOverResponse = z.object({
  run: Run,
  /** The branch the person now owns and how to pick it up locally. */
  branch: z.string(),
  instructions: z.string(),
});

export const runEndpoints = {
  list: endpoint({
    id: 'runs.list',
    method: 'GET',
    path: '/burrows/:burrow/runs',
    summary: 'Runs, newest first, optionally by agent handle or status.',
    params: B,
    query: z.object({ agent: z.string().optional(), status: RunStatus.optional(), limit: limitQuery(20) }),
    response: z.object({ runs: z.array(Run) }),
  }),
  get: endpoint({
    id: 'runs.get',
    method: 'GET',
    path: '/burrows/:burrow/runs/:number',
    summary: 'Run page: header, steps, live log, keys, files touched.',
    params: BN,
    response: RunDetail,
  }),
  log: endpoint({
    id: 'runs.log',
    method: 'GET',
    path: '/burrows/:burrow/runs/:number/log',
    summary: 'Log lines after a sequence number (catch-up after reconnecting).',
    params: BN,
    query: z.object({ after: z.coerce.number().int().min(-1).default(-1), limit: limitQuery(200, 1000) }),
    response: z.object({ lines: z.array(RunLogLine), hasMore: z.boolean() }),
  }),
  pause: endpoint({
    id: 'runs.pause',
    method: 'POST',
    path: '/burrows/:burrow/runs/:number/pause',
    summary: 'Pause: interrupt the agent’s turn; the run shows PAUSED.',
    params: BN,
    response: z.object({ run: Run }),
  }),
  resume: endpoint({
    id: 'runs.resume',
    method: 'POST',
    path: '/burrows/:burrow/runs/:number/resume',
    summary: 'Resume a paused run in a new turn on the same provider session.',
    params: BN,
    response: z.object({ run: Run }),
  }),
  retry: endpoint({
    id: 'runs.retry',
    method: 'POST',
    path: '/burrows/:burrow/runs/:number/retry',
    summary:
      'Try again (CT-197): a failed run goes live again and its agent gets a new turn with the run’s checkout, answering where the run was asked. Feature `runs.recovery`.',
    params: BN,
    response: z.object({ run: Run }),
  }),
  takeOver: endpoint({
    id: 'runs.takeOver',
    method: 'POST',
    path: '/burrows/:burrow/runs/:number/take-over',
    summary: 'Take over: stop the agent and hand the branch to the person.',
    params: BN,
    response: TakeOverResponse,
  }),
};

/* Approvals -------------------------------------------------------------------------------------- */

export const ApprovalResponse = z.object({
  approval: Approval,
  /** Signed event of the decision (decide / undo). */
  eventId: EventId.nullable(),
});
export type ApprovalResponse = z.infer<typeof ApprovalResponse>;

/**
 * `approvals.decide`'s body. `scope` (agent-computer.md AC-42, 0.36.0) is how long a yes to a `run_command` lasts:
 * `once` (this command, this turn), `task` (the same command and target for the rest of the run, or of the thread
 * without a run) or `agent` (always: a `CommandAllowance`). Since 0.43.0 (GF-05) also a `vault_use`'s: `once` (this
 * turn) or `task` (the rest of the run, or of the thread without a run); `agent` isn't one of its choices. Since 0.44.0
 * (Whombat resourceful-agents.md RA-06) a typed action under a risk row (`alwaysAllowRow(action)` not null: a deploy,
 * a merge, a push to main, an outside message, a refund) takes `once` or `agent`: “Always allow {Agent} to …” approves
 * it and sets the row to On (`withKeyRowTier(grants, row, 'can')`), signed as a key change, for people who may change
 * the agent's keys (`agents.manage`; anyone else gets `forbidden`). Valid only with `approve` of those actions (the
 * server answers `validation_failed` otherwise); absent means `once`, so a client that doesn't know scopes still
 * allows once.
 */
export const DecideApprovalBody = z.object({
  decision: z.enum(['approve', 'decline']),
  note: z.string().max(500).optional(),
  scope: CommandScope.optional(),
  /**
   * “Approve later” (0.80, CT-338; one-whombat.md ONE-10): run the approved action at this time instead of at once
   * (“Tonight at 03:00”). Approve only, in the future, at most 7 days ahead; `validation_failed` otherwise. An older
   * runtime ignores it and runs the action at once, so clients offer it only with the feature `shell.assistant`.
   */
  executeAt: z.iso.datetime({ offset: true }).optional(),
});
export type DecideApprovalBody = z.input<typeof DecideApprovalBody>;

export const approvalEndpoints = {
  list: endpoint({
    id: 'approvals.list',
    method: 'GET',
    path: '/burrows/:burrow/approvals',
    summary: 'Approvals, newest first, optionally by state.',
    params: B,
    query: z.object({ state: ApprovalState.optional(), before: Cursor.optional(), limit: limitQuery(50) }),
    response: z.object({ approvals: z.array(Approval), before: Cursor.nullable() }),
  }),
  get: endpoint({
    id: 'approvals.get',
    method: 'GET',
    path: '/burrows/:burrow/approvals/:number',
    summary: 'Approval modal / mobile approval screen (`?approval=<number>`).',
    params: BN,
    response: ApprovalResponse,
  }),
  decide: endpoint({
    id: 'approvals.decide',
    method: 'POST',
    path: '/burrows/:burrow/approvals/:number/decide',
    summary:
      'Approve (in advance or now) or decline. People only. A `run_command` approve takes `scope` (once, for this task, or always for the agent; absent: once), a `vault_use` once or for the task, a risk-row action (`alwaysAllowRow`) once or `agent` (always allow: the row goes On; people who hold `agents.manage` for the agent); `scope` on any other approval, or with decline, is `validation_failed`.',
    params: BN,
    body: DecideApprovalBody,
    response: ApprovalResponse,
  }),
  undo: endpoint({
    id: 'approvals.undo',
    method: 'POST',
    path: '/burrows/:burrow/approvals/:number/undo',
    summary: 'Undo a decision: back to pending. Only until the action has executed.',
    params: BN,
    response: ApprovalResponse,
  }),
};

/* Plans (work-supervision WS-01…WS-10) -------------------------------------------------------------- */

const PlanTitle = z.string().trim().min(1).max(160);
const StepTitle = z.string().trim().min(1).max(160);
const PlanParams = B.extend({ planId: PlanId });
const StepParams = PlanParams.extend({ stepId: StepId });

export const PlanStepInput = z.object({ title: StepTitle });
export type PlanStepInput = z.infer<typeof PlanStepInput>;

export const CreatePlanBody = z.object({
  conversationId: ConversationId,
  title: PlanTitle,
  due: z.iso.date().nullable().optional(),
  steps: z.array(PlanStepInput).max(PLAN_MAX_STEPS).default([]),
  /** The message the plan is made from: the card goes into its thread, and the plan remembers it. */
  sourceMessageId: MessageId.optional(),
  /** Also create the plan canvas (`canvas.write`). */
  canvas: z.boolean().default(false),
});
export type CreatePlanBody = z.infer<typeof CreatePlanBody>;

/**
 * Link a step to existing work by number (WS-03). `null` unlinks that kind; the old link stays in the step's
 * signed event.
 */
export const PlanStepLinkInput = z.object({
  runNumber: z.number().int().positive().nullable().optional(),
  approvalNumber: z.number().int().positive().nullable().optional(),
  automationRunNumber: z.number().int().positive().nullable().optional(),
});
export type PlanStepLinkInput = z.infer<typeof PlanStepLinkInput>;

export const UpdatePlanStepBody = z.object({
  title: StepTitle.optional(),
  state: PlanStepState.optional(),
  note: PlanStepNote.nullable().optional(),
  link: PlanStepLinkInput.optional(),
});
export type UpdatePlanStepBody = z.infer<typeof UpdatePlanStepBody>;

export const StartPlanStepBody = z.object({
  /** Start the step with this automation (Run now; people only) instead of asking the agent. */
  automationId: AutomationId.optional(),
  /** Extra words for the agent, added to the message that asks it to do the step. */
  message: z.string().trim().max(2000).optional(),
});
export type StartPlanStepBody = z.infer<typeof StartPlanStepBody>;

export const PlanResponse = z.object({ plan: Plan });
export type PlanResponse = z.infer<typeof PlanResponse>;

export const StartPlanStepResponse = z.object({
  plan: Plan,
  /** The agent's turn asked to do the step. */
  dispatchId: DispatchId.nullable(),
  /** The message that asked for the step. */
  messageId: MessageId.nullable(),
  /** The automation run started for it. */
  automationRunNumber: z.number().int().positive().nullable(),
});
export type StartPlanStepResponse = z.infer<typeof StartPlanStepResponse>;

export const planEndpoints = {
  list: endpoint({
    id: 'plans.list',
    method: 'GET',
    path: '/burrows/:burrow/plans',
    summary:
      'Plans the viewer can see, newest first; by conversation, and open (any step not done or cancelled) or all.',
    params: B,
    query: z.object({
      conversationId: ConversationId.optional(),
      status: z.enum(['open', 'all']).default('open'),
      limit: limitQuery(50, 200),
    }),
    response: z.object({ plans: z.array(Plan) }),
  }),
  get: endpoint({
    id: 'plans.get',
    method: 'GET',
    path: '/burrows/:burrow/plans/:planId',
    summary: 'A plan with its steps (plan card, plan pane, canvas plan block).',
    params: PlanParams,
    response: PlanResponse,
  }),
  create: endpoint({
    id: 'plans.create',
    method: 'POST',
    path: '/burrows/:burrow/plans',
    summary: 'Make a plan in a conversation (and its card). Starts nothing.',
    params: B,
    body: CreatePlanBody,
    response: PlanResponse,
    status: 201,
  }),
  update: endpoint({
    id: 'plans.update',
    method: 'PATCH',
    path: '/burrows/:burrow/plans/:planId',
    summary: 'Rename, set the due date, or reorder the steps (`order` is every step id once).',
    params: PlanParams,
    body: z.object({
      title: PlanTitle.optional(),
      due: z.iso.date().nullable().optional(),
      order: z.array(StepId).max(PLAN_MAX_STEPS).optional(),
    }),
    response: PlanResponse,
  }),
  addStep: endpoint({
    id: 'plans.addStep',
    method: 'POST',
    path: '/burrows/:burrow/plans/:planId/steps',
    summary: 'Add a queued step, after `after` or at the end.',
    params: PlanParams,
    body: PlanStepInput.extend({ after: StepId.nullable().optional() }),
    response: PlanResponse,
    status: 201,
  }),
  updateStep: endpoint({
    id: 'plans.updateStep',
    method: 'PATCH',
    path: '/burrows/:burrow/plans/:planId/steps/:stepId',
    summary: 'Edit a step: title, state, note, links to existing work.',
    params: StepParams,
    body: UpdatePlanStepBody,
    response: PlanResponse,
  }),
  removeStep: endpoint({
    id: 'plans.removeStep',
    method: 'DELETE',
    path: '/burrows/:burrow/plans/:planId/steps/:stepId',
    summary:
      "Remove a step that never started (otherwise 409 `conflict`, details `{reason: 'step_started'}`: cancel it instead).",
    params: StepParams,
    response: PlanResponse,
  }),
  startStep: endpoint({
    id: 'plans.startStep',
    method: 'POST',
    path: '/burrows/:burrow/plans/:planId/steps/:stepId/start',
    summary: 'Start a step: ask the agent to do it in the plan’s thread, or run an automation.',
    params: StepParams,
    body: StartPlanStepBody,
    response: StartPlanStepResponse,
  }),
  createCanvas: endpoint({
    id: 'plans.createCanvas',
    method: 'POST',
    path: '/burrows/:burrow/plans/:planId/canvas',
    summary: 'Create the plan canvas (with the plan block), or return the one the plan has.',
    params: PlanParams,
    response: z.object({ plan: Plan, canvas: Canvas }),
    status: 201,
  }),
};

/* Activity and the Work view (WS-11…WS-19) ------------------------------------------------------------ */

export const activityEndpoints = {
  list: endpoint({
    id: 'activity.list',
    method: 'GET',
    path: '/burrows/:burrow/activity',
    summary:
      'Observed activity of a run (all its turns), a turn, or a conversation’s recent turns; oldest first after `after` (seq of the newest row seen).',
    params: B,
    query: z.object({
      runNumber: z.coerce.number().int().positive().optional(),
      dispatchId: DispatchId.optional(),
      conversationId: ConversationId.optional(),
      after: z.string().max(80).optional(),
      limit: limitQuery(200, 500),
    }),
    response: z.object({
      activities: z.array(Activity),
      /** Opaque cursor of the newest row returned (pass as `after`). */
      cursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
  }),
};

/**
 * `work.needsYou` (0.55, CT-302): the number of things waiting on the viewer. The only place that count is carried:
 * bootstrap's `Sidebar.counts.needsYou` is always 0.
 */
export const NeedsYouResponse = z.object({ count: Count });
export type NeedsYouResponse = z.infer<typeof NeedsYouResponse>;

export const workEndpoints = {
  overview: endpoint({
    id: 'work.overview',
    method: 'GET',
    path: '/burrows/:burrow/work',
    summary:
      'The viewer’s Work view: needs you, running, queued, blocked, failed and recently done, from approvals, plans, turns, runs and automation runs.',
    params: B,
    response: WorkOverview,
  }),
  needsYou: endpoint({
    id: 'work.needsYou',
    method: 'GET',
    path: '/burrows/:burrow/needs-you',
    summary:
      'How many things wait on the viewer, the only place that count is carried (`conversations.bootstrap`’s `sidebar.counts.needsYou` is always 0; 0.55, feature `work.needs_you_count`).',
    params: B,
    response: NeedsYouResponse,
  }),
};
