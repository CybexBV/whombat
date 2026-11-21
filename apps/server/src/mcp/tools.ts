/**
 * The Whombat MCP tools (`MCP_TOOLS` in core) mapped onto commit-pipeline commands. An agent calling a tool
 * runs exactly the command a person's click runs, as itself: the keys engine decides (allow / ask / block),
 * the change is signed with the agent's key, realtime frames go out. Results are `commitOutcome()` unions
 * (`ok` / `pending_approval` / `blocked`) returned as MCP `structuredContent`.
 */
import {
  type AuditKeyRef,
  conversationLabel,
  MCP_TOOLS,
  type McpToolName,
  type McpToolOutput,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { automationsForAgent } from '../automations/agent-read';
import { assessesInTurn, NOT_AN_ASSESSMENT, reportAssessment } from '../automations/assessment';
import { proposeAutomationPlan } from '../automations/plans';
import { automationOpensPrText, automationOwnsPullRequest } from '../automations/workspace';
import { backupBringBackTool } from '../backups/look/tool';
import { BROWSER_TOOL_HANDLERS } from '../browser/preview-tool';
import { setChatTitle } from '../chats/commands';
import { editCanvas } from '../collab/commands';
import {
  finishRun,
  runBranchIn,
  runFilesTouched,
  runLogLines,
  runStep,
  runTests,
  startRun,
} from '../commands/agent-runs';
import { setAgentStatus } from '../commands/agent-status';
import { agentSearch, deliverAnswer, openPr, performAction, postCard } from '../commands/agent-tools';
import { requestApproval } from '../commands/approvals';
import { createCanvas } from '../commands/content';
import { sendMessage } from '../commands/messages';
import { createPlan, createPlanCanvas, updatePlanByAgent } from '../commands/plans';
import { mergePr, reviewPr } from '../commands/prs';
import type { CommandDef, CommitOptions, CommitResult } from '../commit/types';
import { connectionAddTool } from '../connections/ask';
import { connectionLookTool } from '../connections/look';
import { CONNECTION_TOOL_HANDLERS } from '../connections/tools';
import { CONNECTOR_TOOL_HANDLERS } from '../connectors/tools';
import { COUNCIL_TOOL_HANDLERS } from '../council/tools';
import { runs, searchAnswers } from '../db/schema/index';
import { DELEGATE_TOOL_HANDLERS } from '../delegate/tools';
import { recordDeploy } from '../deployments/commands';
import { deviceProbeTool, proposeDeviceSkillTool } from '../devices/tools';
import { personOfAccountIn } from '../domain/turn-person';
import { assessorReplyTool, similarReportsTool, submitAssessmentTool } from '../feedback/tools';
import { ATTACHMENT_TOOL_HANDLERS } from '../files/tools';
import { startGuide } from '../guides/commands';
import { doneInputFor, reportDoneCommand } from '../home/done';
import { reportChange } from '../home/reports';
import { pinWidget } from '../home/widgets';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { looksInTurn, NOT_A_LOOK, reportLook } from '../looks/research';
import { whombatBackupTool } from '../managed/backup-tool';
import { tailnetDevicesTool } from '../managed/tailnet-tool';
import { PAGES_TOOL_HANDLERS } from '../pages/tool';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow } from '../read/messages';
import { loadPrincipalRow, shortName } from '../read/principals';
import { messagePage, threadView } from '../read/views';
import { loadPlan } from '../read/work';
import { canvasDetail, readableCanvas } from '../read/work-views';
import { checkoutBlocker, startRunRefusalText } from '../runtime/checkout-access';
import { completionEvidence } from '../runtime/completion-evidence';
import { type DispatchRow, dispatchCheckout } from '../runtime/context';
import { outsidersTurn } from '../runtime/person';
import { scheduleTool } from '../schedules/tool';
import type { Services } from '../services';
import { SETTINGS_TOOL_HANDLERS } from '../settings/tools';
import { shareLinkTool } from '../shares/tool';
import { watchChecksTool } from '../things/quiet/agent';
import { trackerItemTool, trackerReadTool } from '../trackers/access';
import { vaultAddServerTool } from '../vault/add-server';
import { vaultAskTool } from '../vault/ask';
import { vaultSaveTool } from '../vault/save';

export interface ToolContext {
  services: Services;
  agentId: string;
  burrowId: string;
  dispatch: DispatchRow;
  /** "Mara in #billing-v2": who the dispatch's work is for (ON BEHALF OF in the log). */
  onBehalfOf: { text?: string; principalId?: string };
}

type Input<N extends McpToolName> = z.output<(typeof MCP_TOOLS)[N]['input']>;
type Handler<N extends McpToolName> = (ctx: ToolContext, input: Input<N>) => Promise<McpToolOutput<N>>;
/** A tool's handler: parsed input in, contract output out. */
export type ToolHandler<N extends McpToolName> = Handler<N>;

/**
 * What an agent working in a checkout reads when it asks for “Browse the web” (run-checkout.md RC-12): Dusty asked for it
 * “to push the feature branch and open the PR”, which need no network of its own. Said once per turn; asked again, the
 * request goes ahead (installing packages or reading a site do need it).
 */
export const NO_NETWORK_FOR_GIT =
  'Not asked yet: you don’t need “Browse the web” to push or to open a pull request. The runner pushes your commits after your turn, and open_pull_request opens the pull request. If you need the network for something else (installing packages, reading a site), call request_approval again in this turn and say what for.';

/** Turns already told (bounded: the oldest are forgotten first). */
const toldNoNetworkForGit = new Set<string>();

async function asksNetworkForGit(ctx: ToolContext, input: Input<'request_approval'>): Promise<boolean> {
  const action = input.action as { type?: string; params?: { keyId?: string } } | undefined;
  if (action?.type !== 'grant_key' || action.params?.keyId !== 'web.browse') return false;
  if (!ctx.dispatch.runId || toldNoNetworkForGit.has(ctx.dispatch.id)) return false;
  const [run] = await ctx.services.db
    .select({ repoId: runs.repoId })
    .from(runs)
    .where(eq(runs.id, ctx.dispatch.runId));
  if (!run?.repoId) return false;
  toldNoNetworkForGit.add(ctx.dispatch.id);
  if (toldNoNetworkForGit.size > 1000)
    toldNoNetworkForGit.delete(toldNoNetworkForGit.values().next().value as string);
  return true;
}

function options(ctx: ToolContext): CommitOptions {
  return { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf };
}

type Outcome<O> =
  | ({ status: 'ok' } & O)
  | {
      status: 'pending_approval';
      approvalId: string;
      approvalNumber: number;
      eventId: string;
      message: string;
    }
  | { status: 'blocked'; keyNeeded: AuditKeyRef; eventId: string; message: string };

/** A commit result as the MCP outcome union. */
export function toOutcome<R, O extends object>(res: CommitResult<R>, map: (r: R) => O): Outcome<O> {
  if (res.status === 'ok') return { status: 'ok', ...map(res.result) };
  if (res.status === 'pending_approval') {
    return {
      status: 'pending_approval',
      approvalId: res.approvalId,
      approvalNumber: res.approvalNumber,
      eventId: res.eventId,
      message: res.message,
    };
  }
  return { status: 'blocked', keyNeeded: res.keyNeeded, eventId: res.eventId, message: res.message };
}

async function run<S extends z.ZodType, R, O extends object>(
  ctx: ToolContext,
  command: CommandDef<S, R>,
  input: z.input<S>,
  map: (r: R) => O,
) {
  return toOutcome(await ctx.services.pipeline.commit(command, input, options(ctx)), map);
}

/**
 * The thread an outsiders' turn works in: the one it was asked in, or the thread its request opens when it was asked at
 * the top level. Null when it has neither: then it works nowhere.
 */
export function outsidersThreadOf(dispatch: Pick<DispatchRow, 'threadRootId' | 'messageId'>): string | null {
  return dispatch.threadRootId ?? dispatch.messageId;
}

/** What an outsiders' turn hears when it reaches past its own thread: where it may read and reply instead. */
export function outsideTurnText(
  dispatch: Pick<DispatchRow, 'conversationId' | 'threadRootId' | 'messageId'>,
): string {
  const own = outsidersThreadOf(dispatch);
  return own
    ? `This work came from outside: it stays in its own thread (conversationId ${dispatch.conversationId}, threadRootId ${own}).`
    : 'This work came from outside: it stays in its own thread.';
}

/** What an outsiders' turn hears for a tool it isn't served. */
export function outsideToolText(name: string): string {
  return `This work came from outside, so ${name} isn’t available. Say what you found in your reply in this thread.`;
}

/**
 * Whether the turn may read or act at the top level of `conversationId`, or in the thread `threadRootId` there: the
 * person's turn anywhere in the burrow (the caller checks the burrow), an outsiders' turn only in its own thread. Its
 * room is usually the person's Chat or Feedback room, so “its own conversation” would be all of theirs: what strangers
 * send must not pull the rest of the room into an answer or put words in it, as the turn's context holds only its
 * request and its thread.
 */
export function withinTurn(
  ctx: ToolContext,
  conversationId: string,
  threadRootId: string | null = null,
): true | string {
  if (!outsidersTurn(ctx.dispatch)) return true;
  const own = outsidersThreadOf(ctx.dispatch);
  if (own && conversationId === ctx.dispatch.conversationId && threadRootId === own) return true;
  return outsideTurnText(ctx.dispatch);
}

/** `withinTurn`, refused as `forbidden` with what the turn hears. */
function keepInTurn(ctx: ToolContext, conversationId: string, threadRootId: string | null = null): void {
  const reads = withinTurn(ctx, conversationId, threadRootId);
  if (reads !== true) throw forbidden(reads);
}

/** A plan of the burrow the turn may read (BP-C35, OP-S71). */
async function planForAgent(ctx: ToolContext, planId: string) {
  const plan = await loadPlan(ctx.services.db, planId);
  if (!plan || plan.burrowId !== ctx.burrowId) throw notFound('Plan');
  keepInTurn(ctx, plan.conversationId);
  return plan;
}

/** A conversation of the burrow the turn may read and post in, at the top level or in the thread named. */
async function readableBy(ctx: ToolContext, conversationId: string, threadRootId: string | null = null) {
  const conversation = await loadConversationRow(ctx.services.db, conversationId);
  if (!conversation || conversation.burrowId !== ctx.burrowId) throw notFound('Conversation');
  keepInTurn(ctx, conversation.id, threadRootId);
  return conversation;
}

/** A canvas of the burrow the turn may read: one without a room is the burrow's, so never an outsiders' turn's. */
async function canvasForAgent(ctx: ToolContext, slug: string) {
  const row = await readableCanvas(ctx.services.db, ctx.burrowId, slug);
  if (row.conversationId) keepInTurn(ctx, row.conversationId);
  else if (outsidersTurn(ctx.dispatch)) throw forbidden(outsideTurnText(ctx.dispatch));
  return row;
}

/**
 * An outsiders' turn opens a pull request only from the branch its automation step checked out for it, in that
 * repository: no other branch or repository of the person's is within reach of what strangers sent.
 */
async function keepToOwnBranch(ctx: ToolContext, repo: string, branch: string): Promise<void> {
  if (!outsidersTurn(ctx.dispatch)) return;
  const own = await dispatchCheckout(ctx.services.db, ctx.dispatch);
  if (own?.access === 'write' && own.repo === repo && own.branch === branch) return;
  throw forbidden(
    own?.access === 'write'
      ? `This work came from outside: open a pull request only from your own branch, ${own.branch} in ${own.repo}.`
      : 'This work came from outside: it has no branch of its own to open a pull request from.',
  );
}

/** A run of the burrow, by number, whose room the turn may act in. */
async function runInTurn(ctx: ToolContext, number: number): Promise<void> {
  const [row] = await ctx.services.db
    .select({ conversationId: runs.conversationId })
    .from(runs)
    .where(and(eq(runs.burrowId, ctx.burrowId), eq(runs.number, number)));
  if (row) keepInTurn(ctx, row.conversationId);
}

/**
 * A thread `read_conversation` was given with another conversation than its own, which the turn may read there: the
 * answer names the conversation to pass. Nothing otherwise (the usual rule answers: the turn, “Thread not found”).
 */
async function refuseThreadElsewhere(
  ctx: ToolContext,
  conversationId: string,
  rootId: string,
): Promise<void> {
  const root = await loadMessageRow(ctx.services.db, rootId);
  if (!root || root.burrowId !== ctx.burrowId || root.conversationId === conversationId) return;
  if (withinTurn(ctx, root.conversationId, root.threadRootId ?? root.id) !== true) return;
  throw badRequest(
    `That thread is in another conversation: call read_conversation with conversationId ${root.conversationId} and threadRootId ${root.id}.`,
  );
}

export const TOOL_HANDLERS: { [N in McpToolName]: Handler<N> } = {
  post_message: async (ctx, input) => {
    keepInTurn(ctx, input.conversationId);
    return run(
      ctx,
      sendMessage,
      {
        conversationId: input.conversationId,
        text: input.text,
        ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.suggestions ? { suggestions: input.suggestions } : {}),
        ...(input.more ? { more: input.more } : {}),
        ...(input.asks ? { asks: true } : {}),
      },
      (r) => ({ messageId: r.id }),
    );
  },

  reply_in_thread: async (ctx, input) => {
    // An assessor replies only in its report's thread, inert (docs/decisions/feedback.md FB-21).
    if (ctx.dispatch.trigger === 'feedback') return assessorReplyTool(ctx, input);
    const root = await loadMessageRow(ctx.services.db, input.messageId);
    if (!root || root.burrowId !== ctx.burrowId) throw notFound('Message');
    keepInTurn(ctx, root.conversationId, root.threadRootId ?? root.id);
    // It can't upload, so a file it names could only be one it didn't make here.
    if (input.attachmentIds?.length && outsidersTurn(ctx.dispatch))
      throw forbidden('This work came from outside: reply in words, without files.');
    return run(
      ctx,
      sendMessage,
      {
        conversationId: root.conversationId,
        text: input.text,
        threadRootId: root.threadRootId ?? root.id,
        ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.suggestions ? { suggestions: input.suggestions } : {}),
        ...(input.more ? { more: input.more } : {}),
        ...(input.asks ? { asks: true } : {}),
      },
      (r) => ({ messageId: r.id }),
    );
  },

  post_card: async (ctx, input) => {
    keepInTurn(ctx, input.conversationId, input.threadRootId ?? null);
    return run(ctx, postCard, input, (r) => ({ messageId: r.messageId }));
  },

  read_conversation: async (ctx, input) => {
    // A thread named with the wrong room: the answer names the right one.
    if (input.threadRootId) await refuseThreadElsewhere(ctx, input.conversationId, input.threadRootId);
    const root = input.threadRootId ? await loadMessageRow(ctx.services.db, input.threadRootId) : null;
    const conversation = await readableBy(
      ctx,
      input.conversationId,
      root ? (root.threadRootId ?? root.id) : (input.threadRootId ?? null),
    );
    let messages: Awaited<ReturnType<typeof messagePage>>['messages'];
    if (input.threadRootId) {
      if (!root || root.conversationId !== conversation.id) throw notFound('Thread');
      const view = await threadView(ctx.services.db, ctx.agentId, root.id);
      messages = [view.root, ...view.replies].slice(-input.limit);
    } else {
      messages = (
        await messagePage(ctx.services.db, ctx.agentId, conversation.id, {
          limit: input.limit,
          ...(input.before ? { before: input.before } : {}),
          clearedAt: conversation.roomClearedAt,
        })
      ).messages;
    }
    return {
      status: 'ok',
      conversation: {
        id: conversation.id,
        kind: conversation.kind,
        title: conversation.title,
        topic: conversation.topic,
      },
      messages,
    };
  },

  search: async (ctx, input) => {
    // What an outsiders' turn finds could end up in its answer to them: it searches nothing (OP-S71).
    if (outsidersTurn(ctx.dispatch)) throw forbidden(outsideToolText('search'));
    return run(ctx, agentSearch, input, (r) => ({ results: r.results }));
  },

  start_run: async (ctx, input) => {
    keepInTurn(ctx, input.conversationId);
    // A named plan step keeps to the same rules as reading the plan (WS-03, BP-C35).
    if (input.planStep) await planForAgent(ctx, input.planStep.planId);
    // A run whose checkout can't be made here could only fail: refused now, with what is missing and where a person fixes
    // it, so the agent tells them at once (resourceful-agents.md RA-DS53). Runs on repositories it can reach start as ever.
    const blocked = await checkoutBlocker(ctx.services, {
      burrowId: ctx.burrowId,
      agentId: ctx.agentId,
      repo: input.repo,
    });
    if (blocked)
      throw new ApiError('conflict', startRunRefusalText(input.repo, blocked), {
        details: { code: 'checkout_unavailable' },
      });
    // A run on an open pull request works on its branch (agent-efficiency.md AE-05): the command — and the approval it
    // may wait in, whose yes covers exactly that branch (BP-C37) — names the branch the run will use.
    const branch = await runBranchIn(ctx.services.db, ctx.burrowId, input);
    return run(ctx, startRun, { ...input, branch, dispatchId: ctx.dispatch.id }, (r) => ({
      runId: r.runId,
      number: r.number,
      messageId: r.messageId,
      branch: r.branch,
    }));
  },

  run_step: async (ctx, input) => {
    await runInTurn(ctx, input.run);
    return run(ctx, runStep, input, (r) => ({ progress: r.progress }));
  },
  run_log: async (ctx, input) => {
    await runInTurn(ctx, input.run);
    return run(ctx, runLogLines, input, (r) => ({ logCount: r.logCount }));
  },
  run_tests: async (ctx, input) => {
    await runInTurn(ctx, input.run);
    return run(ctx, runTests, input, () => ({}));
  },
  run_files: async (ctx, input) => {
    await runInTurn(ctx, input.run);
    return run(ctx, runFilesTouched, input, (r) => ({ diff: r.diff }));
  },
  completion_evidence: async (ctx) => ({
    evidence: await completionEvidence(ctx.services.db, {
      burrowId: ctx.burrowId,
      agentId: ctx.agentId,
      dispatchId: ctx.dispatch.id,
      runId: ctx.dispatch.runId ?? undefined,
    }),
  }),
  finish_run: async (ctx, input) => {
    await runInTurn(ctx, input.run);
    return run(ctx, finishRun, { ...input, dispatchId: ctx.dispatch.id }, (r) => ({
      status: r.status,
      evidenceIds: r.evidenceIds,
    }));
  },

  request_approval: async (ctx, input) => {
    if (input.conversationId) keepInTurn(ctx, input.conversationId);
    if (await asksNetworkForGit(ctx, input)) throw conflict(NO_NETWORK_FOR_GIT);
    return run(ctx, requestApproval, { ...input, dispatchId: ctx.dispatch.id }, (r) => ({
      approvalId: r.approvalId,
      number: r.number,
      messageId: r.messageId,
    }));
  },

  perform_action: async (ctx, input) => {
    keepInTurn(ctx, input.conversationId);
    return run(ctx, performAction, input, (r) => ({ result: r.result }));
  },

  open_pull_request: async (ctx, input) => {
    // An automation that opens the pull request of this coding step itself, after the review, does (run9 review RN-S3b).
    await keepToOwnBranch(ctx, input.repo, input.branch);
    const owned = await automationOwnsPullRequest(ctx.services.db, ctx.dispatch.id);
    if (owned) throw forbidden(automationOpensPrText(owned.reviewed));
    return run(ctx, openPr, { ...input, conversationId: ctx.dispatch.conversationId }, (r) => ({
      number: r.number,
      conversationId: r.conversationId,
    }));
  },

  review_pull_request: async (ctx, input) =>
    run(ctx, reviewPr, input, (r) => ({ reviewState: r.reviewState })),

  // The agent's Merge row decides (runs-approvals.md MDS-03): On merges, Ask posts the card where it was asked.
  merge_pull_request: async (ctx, input) =>
    run(
      ctx,
      mergePr,
      {
        number: input.prNumber,
        ...(input.repo ? { repo: input.repo } : {}),
        ...(input.method ? { method: input.method } : {}),
        conversationId: ctx.dispatch.conversationId,
      },
      () => ({ merged: true }),
    ),

  canvas_read: async (ctx, input) => {
    // A room's canvas is read as the room itself (BP-C35, OP-S71); a canvas without a room is the whole burrow's.
    const row = await canvasForAgent(ctx, input.canvas);
    const detail = await canvasDetail(ctx.services.db, row);
    const markdown = await ctx.services.collab.readMarkdown(row);
    return { status: 'ok', canvas: detail.canvas, markdown, comments: detail.comments };
  },

  canvas_edit: async (ctx, input) => {
    // Editing answers “found / not found”, so it keeps to the same rule as reading (security re-check
    // SEC4-CANVAS-EDIT-ORACLE, BP-C35).
    await canvasForAgent(ctx, input.canvas);
    return run(ctx, editCanvas, input, (r) => ({ updatedAt: r.updatedAt }));
  },

  post_answer: async (ctx, input) => run(ctx, deliverAnswer, input, (r) => ({ answerId: r.answerId })),

  set_status: async (ctx, input) => run(ctx, setAgentStatus, input, () => ({})),
  // A plan the person turns on or not, posted in this turn's thread (automation-chat.md): turning it on
  // stays with the person.
  draft_automation: async (ctx, input) =>
    run(ctx, proposeAutomationPlan, { ...input, dispatchId: ctx.dispatch.id }, (r) => ({
      automationId: r.automationId,
      planId: r.planId,
      problems: r.problems,
    })),
  // The person's automations and how to write one: only in their own turns, like draft_automation.
  automation_read: async (ctx, input) => automationsForAgent(ctx, input),

  // Plans and plan canvases (docs/decisions/work-supervision.md WS-01…WS-08): the turn's reach (BP-C35, OP-S71), plus
  // “Create tasks for other agents” for writes (the commands' key).
  plan_create: async (ctx, input) => {
    await readableBy(ctx, input.conversationId);
    return run(ctx, createPlan, { ...input, canvas: false }, (r) => ({
      planId: r.planId,
      messageId: r.messageId,
    }));
  },
  plan_read: async (ctx, input) => ({ plan: await planForAgent(ctx, input.planId) }),
  plan_update: async (ctx, input) => {
    await planForAgent(ctx, input.planId);
    const res = await ctx.services.pipeline.commit(updatePlanByAgent, input, options(ctx));
    if (res.status !== 'ok') return toOutcome(res, () => ({ plan: null as never }));
    return { status: 'ok', plan: await planForAgent(ctx, input.planId) };
  },
  canvas_create: async (ctx, input) => {
    await readableBy(ctx, input.conversationId);
    if (input.planId) {
      const plan = await planForAgent(ctx, input.planId);
      if (plan.conversationId !== input.conversationId)
        throw badRequest('That plan is in another conversation: make its canvas there.');
      return run(
        ctx,
        createPlanCanvas,
        {
          planId: input.planId,
          title: input.title,
          ...(input.markdown ? { markdown: input.markdown } : {}),
        },
        (r) => ({ canvasId: r.canvasId, slug: r.slug }),
      );
    }
    return run(
      ctx,
      createCanvas,
      {
        title: input.title,
        conversationId: input.conversationId,
        ...(input.markdown ? { markdown: input.markdown } : {}),
      },
      (r) => ({ canvasId: r.canvasId, slug: r.slug }),
    );
  },

  // Attachments: read a text attachment, publish an artifact (files/tools.ts); an outsiders' turn reads only the files
  // of its request and thread (files/access.ts) and publishes none.
  ...ATTACHMENT_TOOL_HANDLERS,
  upload_file: async (ctx, input) => {
    keepInTurn(ctx, input.conversationId);
    return ATTACHMENT_TOOL_HANDLERS.upload_file(ctx, input);
  },
  // The person's mail, calendar and files, in their turns (connectors/tools.ts).
  ...CONNECTOR_TOOL_HANDLERS,
  // Catalog connections: Home Assistant, Notion, Todoist, … (connections/tools.ts, connections-catalog.md CX-30).
  ...CONNECTION_TOOL_HANDLERS,
  // An automation's assessment step (automation-recipes.md AR-24): listed and run only in that step's turn.
  report_assessment: async (ctx, input) => {
    if (!(await assessesInTurn(ctx.services.db, ctx.agentId, ctx.dispatch.id)))
      throw forbidden(NOT_AN_ASSESSMENT);
    return run(ctx, reportAssessment, { dispatchId: ctx.dispatch.id, assessment: input }, (r) => ({
      line: r.line,
    }));
  },
  // Whombat Feedback's assessor (feedback/tools.ts, docs/decisions/feedback.md FB-21).
  submit_assessment: submitAssessmentTool,
  feedback_similar_reports: similarReportsTool,
  // The reporting organization, read-only, with the attempt's grant (feedback-sources.md FBS-19).
  // A tracker run's report and its organization (report-trackers.md TA-09, TA-10): only in that run's turns.
  tracker_item: (ctx, input) => trackerItemTool(ctx, input),
  tracker_read: (ctx, input) => trackerReadTool(ctx, input),
  // The personal assistant's guide tools (docs/decisions/assistant-guides.md AG-01, AG-10); personal agents only.
  // A guide stays in the thread it was asked for in.
  start_guide: async (ctx, input) =>
    run(
      ctx,
      startGuide,
      {
        ...input,
        conversationId: ctx.dispatch.conversationId,
        threadRootId: ctx.dispatch.threadRootId ?? null,
      },
      (r) => ({ messageId: r.messageId }),
    ),
  // A person's own assistant saves what they send it and adds servers to their SSH keys (vault-self-serve.md VS-04…VS-12).
  vault_save: (ctx, input) => vaultSaveTool(ctx, input),
  vault_add_server: (ctx, input) => vaultAddServerTool(ctx, input),
  // Setting things up from the chat with cards the person fills in (connect-in-chat.md): the connect form filled in, and
  // a write-only field for a password that goes straight to the Vault.
  connection_add: (ctx, input) => connectionAddTool(ctx, input),
  // A Custom connection's logo and page (connection-looks.md): tried, then kept on save.
  connection_look: (ctx, input) => connectionLookTool(ctx, input),
  vault_ask: (ctx, input) => vaultAskTool(ctx, input),
  // This Whombat's own backups (first-day.md): where they go, set only while nothing backs it up.
  whombat_backup: (ctx, input) => whombatBackupTool(ctx, input),
  // One thing back from a backup (backup-look.md): finding is a read, bringing back asks the person first.
  backup_bring_back: (ctx, input) => backupBringBackTool(ctx, input),
  // A thread by link (share-links.md): always a card first.
  share_link: (ctx, input) => shareLinkTool(ctx, input),
  // The council the agent leads (council.md): its members run as T3 Code threads.
  ...COUNCIL_TOOL_HANDLERS,
  // Tasks the agent hands to T3 Code from a checklist card (delegate.md).
  ...DELEGATE_TOOL_HANDLERS,
  ...SETTINGS_TOOL_HANDLERS,
  tailnet_devices: (ctx, input) => tailnetDevicesTool(ctx, input),
  // Whombat's browser tools are gone for Hermes's (hermes-engine.md HE-20); `browser_preview` stays (HE-S142).
  ...BROWSER_TOOL_HANDLERS,
  ...PAGES_TOOL_HANDLERS,
  // Turns an agent schedules for itself (resourceful-agents.md RA-30): no key, kept for this turn's person.
  schedule: (ctx, input) => scheduleTool(ctx, input),
  // Recorded deploys (review-features.md RF-02, CT-296): no key, for this turn; its card in the turn's thread.
  record_deploy: async (ctx, input) =>
    run(ctx, recordDeploy, { ...input, dispatchId: ctx.dispatch.id }, (r) => ({
      deploymentId: r.deploymentId,
      previousId: r.previousId,
      messageId: r.messageId,
    })),
  // One Whombat (contracts 0.80): task chat titles and widgets (stream SW), device skills (stream SD).
  // The chat the turn is in (one-whombat-assistant.md ONE-DW15): once per task chat, never the default chat.
  set_chat_title: async (ctx, input) =>
    run(ctx, setChatTitle, { conversationId: ctx.dispatch.conversationId, title: input.title }, () => ({})),
  // A widget on the person's Home, refreshed without the model (one-whombat-assistant.md ONE-DW22).
  pin_widget: async (ctx, input) =>
    run(ctx, pinWidget, { ...input, conversationId: ctx.dispatch.conversationId }, (r) => ({
      widgetId: r.widgetId,
    })),
  device_probe: (ctx, input) => deviceProbeTool(ctx, input),
  propose_device_skill: (ctx, input) => proposeDeviceSkillTool(ctx, input),
  // A change the agent made outside connection_call, for Done recently with an Undo (home-redesign.md HR-03): no key.
  report_change: (ctx, input) =>
    reportChange(
      {
        services: ctx.services,
        burrowId: ctx.burrowId,
        agentId: ctx.agentId,
        dispatch: ctx.dispatch,
        personId: ctx.onBehalfOf.principalId ?? null,
      },
      input,
    ),
  // What the agent finished in this thread, for the desk's Done today (done-today.md DN-01): no key, one per thread.
  report_done: async (ctx, input) =>
    run(ctx, reportDoneCommand, await doneInputFor(ctx.services.db, ctx.dispatch, input.summary), () => ({})),
  // What Whombat watches, switched only on the person's word (on-purpose.md).
  watch_checks: (ctx, input) => watchChecksTool(ctx, input),
  // What the assistant found out about a look (look-research.md LR-05): listed and run only in a look's turns.
  look_report: async (ctx, input) => {
    if (!(await looksInTurn(ctx.services.db, ctx.agentId, ctx.dispatch.id))) throw forbidden(NOT_A_LOOK);
    return run(ctx, reportLook, { dispatchId: ctx.dispatch.id, report: input }, () => ({}));
  },
};

/** ON BEHALF OF for everything a dispatch does: whoever asked, and where ("Mara in #billing-v2"). */
export async function onBehalfOf(
  services: Services,
  dispatch: DispatchRow,
): Promise<{ text?: string; principalId?: string }> {
  const db = services.db;
  let principalId: string | null = null;
  let conversationId = dispatch.conversationId;
  if (dispatch.search) {
    const [answer] = await db
      .select()
      .from(searchAnswers)
      .where(eq(searchAnswers.id, dispatch.search.answerId));
    const asker = answer ? await loadPrincipalRow(db, answer.askedById) : undefined;
    return asker ? { text: `${shortName(asker)} in Search`, principalId: asker.id } : {};
  }
  if (dispatch.runId) {
    const [r] = await db.select().from(runs).where(eq(runs.id, dispatch.runId));
    if (r) {
      principalId = r.askedById;
      conversationId = r.conversationId;
    }
  } else if (dispatch.messageId) {
    const message = await loadMessageRow(db, dispatch.messageId);
    if (message) principalId = message.authorId;
  }
  if (!principalId || principalId === dispatch.agentId) return {};
  let who = await loadPrincipalRow(db, principalId);
  if (!who) return {};
  // An automation step's prompt is posted by the automation's own system principal while the turn acts for
  // `dispatch.onBehalfOfAccountId`: attribute the turn to that person so connector reads and approval cards resolve to them.
  if (who.kind !== 'person' && who.system && dispatch.onBehalfOfAccountId) {
    const person = await personOfAccountIn(db, dispatch.burrowId, dispatch.onBehalfOfAccountId);
    if (person) who = person;
  }
  const conversation = await loadConversationRow(db, conversationId);
  // The person's Chat (their `dm` conversation without a task); one with a task (the Feedback room) goes by its title.
  const where = !conversation
    ? null
    : conversation.kind !== 'dm'
      ? conversationLabel(conversation)
      : conversation.taskKey
        ? (conversation.chatTitle ?? conversationLabel(conversation))
        : 'Chat';
  return { text: where ? `${shortName(who)} in ${where}` : shortName(who), principalId: who.id };
}

export function isToolName(name: string): name is McpToolName {
  return Object.hasOwn(MCP_TOOLS, name);
}
