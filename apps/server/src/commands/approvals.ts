/** Approval decisions (approve in advance / now, decline, undo) and agents asking (`request_approval`). */
import {
  type Approval,
  type ApprovalAction,
  type ApprovalCondition,
  type ApprovalConditionInput,
  actionCopy,
  actionKey,
  actionScope,
  alwaysAllowRow,
  approve,
  CommandScope,
  conversationLabel,
  DispatchId,
  decline,
  defaultConditionLabel,
  describeAction,
  describeActionForLog,
  isPersonalAction,
  joinWithAnd,
  KEY_CATALOG,
  type KeyId,
  type KeyTierRow,
  keyRequestProblem,
  keyRowTier,
  MCP_TOOLS,
  NumberParam,
  requestedTier,
  TEAM_REPORT_DRAFT_ACTION,
  undo,
} from '@whombat/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { commandPassOf, mayAlwaysAllow } from '../agent-commands/commands';
import { approvalChanged } from '../agent-commands/waiters';
import { createApproval } from '../approvals/create';
import { NO_ACTION_HASH, publishApproval, syncPlanSteps } from '../approvals/engine';
import { refuseUnavailable } from '../approvals/executors';
import { approvalRun, approvalThread } from '../approvals/wake';
import { isAutomationPrincipal } from '../automations/principal';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import { approvals, dispatches, events, principals, runs } from '../db/schema/index';
import { linkOfConversation } from '../domain/links';
import { postMessage } from '../domain/messages';
import { followPlanWork } from '../domain/plan-follow';
import { wakeQuietly } from '../domain/wake';
import { actorManagesServers, setServerAsksIn } from '../hosts/asks';
import { serverAsksOf } from '../hosts/asks-store';
import { ONLY_YOU_CHANGE_SERVERS_TEXT } from '../hosts/person';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { type ConversationRow, loadConversationRow } from '../read/conversations';
import {
  engineActor,
  loadGrants,
  loadPrincipalRow,
  loadPrincipalsByIds,
  shortName,
} from '../read/principals';
import { approvalByNumber, prByNumber, toApproval } from '../read/work';
import { setAgentKeyRow } from './agents';
import { linkWorkToStep } from './plans';

/** "Dusty’s staging deploy of feat/invoice-pdf", "Dusty’s request to refund €24,00 on account 3310". */
export function approvalSubject(approval: Approval, requesterName: string): string {
  if (approval.action.type === 'deploy')
    return `${requesterName}’s ${approval.action.params.environment} deploy of ${approval.action.params.ref}`;
  if (approval.action.type === 'custom') return `${requesterName}’s request: ${approval.title}`;
  return `${requesterName}’s request to ${describeActionForLog(approval.action)}`;
}

/** “Deploy …” for Blocked texts; a personal action's title names recipients or files, so its number instead. */
function titleForLog(row: { title: string; action: ApprovalAction } | undefined, number: number): string {
  if (!row || isPersonalAction(row.action)) return `request #${number}`;
  return `“${row.title}”`;
}

async function requesterName(ctx: ApplyContext, approval: Approval): Promise<string> {
  const [row] = await loadPrincipalsByIds(ctx.tx, [approval.requesterId]);
  return row ? shortName(row) : 'Someone';
}

async function loadForDecision(ctx: ApplyContext, number: number) {
  const row = await approvalByNumber(ctx.tx, ctx.burrow.id, number);
  if (!row) throw notFound('Request');
  return toApproval(row);
}

function transitionError(error: string, message: string): ApiError {
  if (error === 'not_an_approver' || error === 'agents_cannot_decide')
    return new ApiError('not_allowed', message);
  return new ApiError('conflict', message);
}

async function store(ctx: ApplyContext, approval: Approval): Promise<void> {
  await ctx.tx
    .update(approvals)
    .set({
      state: approval.state,
      decidedById: approval.decidedById,
      decidedAt: approval.decidedAt ? new Date(approval.decidedAt) : null,
      conditions: approval.conditions,
      execution: approval.execution,
      updatedAt: ctx.now,
    })
    .where(eq(approvals.id, approval.id));
}

const DecideInput = z.object({
  number: NumberParam,
  decision: z.enum(['approve', 'decline']),
  note: z.string().max(500).optional(),
  /** A yes to one of the agent's commands: once, for this task, or always (agent-computer.md AC-42). */
  scope: CommandScope.optional(),
  /** Approve later (one-whombat.md ONE-10, CT-338): the yes runs then, not now. Approve only, ≤ 7 days ahead. */
  executeAt: z.iso.datetime({ offset: true }).optional(),
});

/** How far ahead Approve later may run an action (CT-338). */
export const APPROVE_LATER_MAX_MS = 7 * 24 * 3600_000;

function executeAtProblem(message: string) {
  return new ApiError('validation_failed', message, { fields: { executeAt: [message] } });
}

export const decideApproval = defineCommand({
  name: 'decide_approval',
  schema: DecideInput,
  async requiredKey(input, { db, burrow }) {
    const row = await approvalByNumber(db, burrow.id, input.number);
    return {
      keyId: 'approvals.decide',
      attempt: `${input.decision} ${titleForLog(row, input.number)}`,
      where: null,
      ...(row ? { ref: { type: 'approval' as const, number: row.number } } : {}),
    };
  },
  async apply(tx, ctx, input) {
    const approval = await loadForDecision(ctx, input.number);
    const decider = engineActor(ctx.actor);
    // A scope belongs to a yes to a command (AC-42) or to a typed action under a risk row (resourceful-agents.md RA-06:
    // once, or always); absent it is once.
    const command = approval.action.type === 'run_command' ? approval.action : null;
    const riskRow = alwaysAllowRow(approval.action);
    // A Servers call that asked only for the sensitive rules (server-asks.md SA-07): once, or “Don’t ask again on
    // {server}” (`agent`), which sets the server to Never in this commit.
    const askServer =
      approval.action.type === 'connection_call' ? (approval.action.params.server ?? null) : null;
    const scoped = command || riskRow || askServer;
    if (input.scope !== undefined && (input.decision !== 'approve' || !scoped))
      throw new ApiError('validation_failed', 'Only a yes to a command or a risky action has a scope.', {
        fields: { scope: ['Only a yes to a command or a risky action has a scope.'] },
      });
    if ((riskRow || askServer) && input.scope === 'task')
      throw new ApiError('validation_failed', 'This is allowed once or always: its scope is once or agent.', {
        fields: { scope: ['This is allowed once or always: its scope is once or agent.'] },
      });
    const scope = scoped && input.decision === 'approve' ? (input.scope ?? 'once') : null;
    // Stop asking on a server is the person's (SA-05), whoever asked.
    if (askServer && scope === 'agent' && !actorManagesServers(ctx.actor))
      throw forbidden(ONLY_YOU_CHANGE_SERVERS_TEXT);
    // “Always allow” changes what the agent may do from now on: the person's (AC-DS09, RA-06).
    const always =
      scope === 'agent' && !askServer && (await mayAlwaysAllow(tx, ctx.actor, approval.requesterId));
    if (scope === 'agent' && !askServer && !always) {
      if (riskRow) throw forbidden('Only you can always allow it.');
      throw new ApiError('not_allowed', 'Only you can always allow a command.');
    }
    // Approve later (ONE-10): the yes is given now and the action waits until then (the engine skips it till due).
    let executeAt: Date | null = null;
    if (input.executeAt !== undefined) {
      if (input.decision !== 'approve') throw executeAtProblem('Only a yes can run later.');
      // The assistant's draft report to the Whombat Team goes now or not at all: a report waiting for the night helps
      // nobody, and the person may send it from the form meanwhile.
      if (approval.action.type === 'custom' && approval.action.params.name === TEAM_REPORT_DRAFT_ACTION)
        throw executeAtProblem('This report goes now or not at all.');
      executeAt = new Date(input.executeAt);
      if (executeAt.getTime() <= ctx.now.getTime())
        throw executeAtProblem('Pick a time that is still to come.');
      if (executeAt.getTime() - ctx.now.getTime() > APPROVE_LATER_MAX_MS)
        throw executeAtProblem('Pick a time within the next 7 days.');
    }
    // A yes needs the hash its execution is checked against; a no runs nothing, so it is always allowed.
    if (input.decision === 'approve' && !approval.actionHash) throw conflict(NO_ACTION_HASH);
    const decided =
      input.decision === 'approve' ? approve(approval, decider, ctx.at) : decline(approval, decider, ctx.at);
    if (!decided.ok) throw transitionError(decided.error, decided.message);
    const next = scope ? { ...decided, approval: { ...decided.approval, scope } } : decided;
    await store(ctx, next.approval);
    if (scope) await tx.update(approvals).set({ scope }).where(eq(approvals.id, approval.id));
    if (executeAt) await tx.update(approvals).set({ executeAt }).where(eq(approvals.id, approval.id));
    // “Always allow {Agent} to {row}” (RA-06): the row goes On for the agent, signed as the key change it is.
    const rowChange = riskRow && scope === 'agent' ? await alwaysAllowRowOn(ctx, approval, riskRow) : null;
    // “Don’t ask again on {server}” (SA-07): the server goes to Never, signed and on Done recently with its Undo.
    if (askServer && scope === 'agent')
      await setServerAsksIn(ctx, {
        serverId: askServer.id,
        serverName: askServer.name,
        asksFirst: 'never',
        approvalId: approval.id,
        conversationId: approval.conversationId,
      });
    const conversation = await loadConversationRow(tx, approval.conversationId);
    const requester = await requesterName(ctx, approval);
    const text = `${input.decision === 'approve' ? 'Approved' : 'Declined'} ${approvalSubject(approval, requester)}`;
    const event = await ctx.emit({
      type: input.decision === 'approve' ? 'approval.approved' : 'approval.declined',
      kind: 'Asks',
      text,
      where: conversation ? conversationLabel(conversation) : null,
      aboutId: approval.requesterId,
      approvalId: approval.id,
      ref: {
        type: 'approval',
        number: approval.number,
        ...(conversation ? { in: await linkOfConversation(tx, conversation) } : {}),
      },
      payload: {
        approvalId: approval.id,
        decision: input.decision,
        note: input.note ?? null,
        ...(scope ? { scope } : {}),
        ...(executeAt ? { executeAt: executeAt.toISOString() } : {}),
        // What the row was before “Always allow”: an undo puts it back (RA-DS33).
        ...(rowChange ? { row: riskRow, rowBefore: rowChange.before } : {}),
      },
    });
    publishApproval(ctx, next.approval, event.id);
    await syncPlanSteps(ctx, next.approval);

    // A command's no reaches the command that waits for it (AC-41): no message, no second wake while its turn goes on.
    const commandWaits =
      command && input.decision === 'decline' ? await askingTurnGoesOn(tx, approval.id) : false;
    if (input.decision === 'decline' && conversation && !commandWaits) {
      // Tell the requester and the agents involved: a thread reply under the card that wakes them.
      const told = await loadPrincipalsByIds(tx, [approval.requesterId, ...approval.involvedIds]);
      const byId = new Map(told.map((p) => [p.id, p]));
      // An automation's card isn't addressed: its run reads the no itself, and “@Assess,” is nobody (AR-D01).
      const automationAsked = isAutomationPrincipal(byId.get(approval.requesterId));
      const requesterRow = automationAsked ? undefined : byId.get(approval.requesterId);
      // Everyone named once: the requester is addressed already, and whoever said no needs no heads-up.
      const othersIds = [...new Set(approval.involvedIds)].filter(
        (id) => id !== approval.requesterId && id !== ctx.actor.id,
      );
      const others = othersIds.map((id) => byId.get(id)).filter((p) => !!p);
      const at = (p: { name: string }) => `@${p.name.split(/\s+/)[0]}`;
      // A key request's title already quotes the key (“Give Dusty “Browse the web””): say it plainly.
      const declined =
        approval.action.type === 'grant_key'
          ? `I didn’t give you “${KEY_CATALOG[approval.action.params.keyId].label}”.`
          : `I declined “${approval.title}”.`;
      const text = [
        `${requesterRow ? `${at(requesterRow)}, ` : ''}${declined}`,
        input.note?.trim() ?? '',
        others.length ? `Heads up, ${joinWithAnd(others.map(at))}.` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const [request] = await tx.select().from(approvals).where(eq(approvals.id, approval.id));
      const runId = request ? await approvalRun(tx, request) : null;
      const posted = await postMessage(ctx, {
        conversation,
        text,
        threadRootId: approval.messageId,
        mentions: [...(automationAsked ? [] : [approval.requesterId]), ...othersIds].filter(
          (id) => id !== ctx.actor.id,
        ),
        dispatchTrigger: 'approval_declined',
        ...(runId ? { dispatch: false } : {}),
      });
      if (runId) {
        const [run] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
        if (run?.status === 'live')
          await wakeQuietly(ctx, {
            agentId: approval.requesterId,
            conversationId: approval.conversationId,
            threadRootId: await approvalThread(tx, approval.id, approval.conversationId),
            person: request?.onBehalfOfAccountId ?? null,
            trigger: 'approval_declined',
            coalesce: false,
            own: true,
            messageId: posted.id,
            runId,
          });
      }
    }

    const services = ctx.services;
    // A runner waiting on the command hears it at once (`runner.authorizeWait`).
    if (command) ctx.after(async () => approvalChanged(services, approval.id));
    ctx.after(() => services.approvals.reevaluate(approval.burrowId, { approvalIds: [approval.id] }));
    return { approvalId: approval.id, eventId: event.id };
  },
});

/** Whether the turn whose command asked is still going (its runner waits for the answer, or will ask again). */
async function askingTurnGoesOn(tx: ApplyContext['tx'], approvalId: string): Promise<boolean> {
  const pass = await commandPassOf(tx, approvalId);
  if (!pass) return false;
  const [row] = await tx
    .select({ state: dispatches.state })
    .from(dispatches)
    .where(eq(dispatches.id, pass.dispatchId));
  return !!row && ['queued', 'claimed', 'running'].includes(row.state);
}

export const undoDecision = defineCommand({
  name: 'undo_approval',
  schema: z.object({ number: NumberParam }),
  async requiredKey(input, { db, burrow }) {
    const row = await approvalByNumber(db, burrow.id, input.number);
    return {
      keyId: 'approvals.decide',
      attempt: `undo the decision on ${titleForLog(row, input.number)}`,
      where: null,
    };
  },
  async apply(tx, ctx, input) {
    const approval = await loadForDecision(ctx, input.number);
    const decider = engineActor(ctx.actor);
    const previous = approval.state;
    const next = undo(approval, decider, ctx.at);
    if (!next.ok) throw transitionError(next.error, next.message);
    await store(ctx, next.approval);
    // An undone yes for later runs at no time (ONE-10).
    await tx.update(approvals).set({ executeAt: null }).where(eq(approvals.id, approval.id));
    // Undoing “Always allow” (RA-06) puts the row back where it was, when nobody changed it since (RA-DS33).
    const [scoped] = await tx
      .select({ scope: approvals.scope })
      .from(approvals)
      .where(eq(approvals.id, approval.id));
    const riskRow = alwaysAllowRow(approval.action);
    if (riskRow && scoped?.scope) {
      await tx.update(approvals).set({ scope: null }).where(eq(approvals.id, approval.id));
      if (scoped.scope === 'agent') await alwaysAllowRowBack(ctx, approval, riskRow);
    }
    // Undoing “Don’t ask again on {server}” (server-asks.md SA-07) asks there again, when it is still Never and the
    // person may change it (server-asks-server.md SA-S06).
    const askServer =
      approval.action.type === 'connection_call' ? (approval.action.params.server ?? null) : null;
    if (askServer && scoped?.scope) {
      await tx.update(approvals).set({ scope: null }).where(eq(approvals.id, approval.id));
      if (
        scoped.scope === 'agent' &&
        actorManagesServers(ctx.actor) &&
        (await serverAsksOf(tx, ctx.burrow.id, askServer.id)) === 'never'
      )
        await setServerAsksIn(ctx, {
          serverId: askServer.id,
          serverName: askServer.name,
          asksFirst: 'risky',
          approvalId: approval.id,
          conversationId: approval.conversationId,
        });
    }
    const conversation = await loadConversationRow(tx, approval.conversationId);
    const requester = await requesterName(ctx, approval);
    const event = await ctx.emit({
      type: 'approval.undone',
      kind: 'Asks',
      text: `Undid ${previous === 'approved' ? 'approving' : 'declining'} ${approvalSubject(approval, requester)}`,
      where: conversation ? conversationLabel(conversation) : null,
      aboutId: approval.requesterId,
      approvalId: approval.id,
      ref: { type: 'approval', number: approval.number },
      payload: { approvalId: approval.id, previous },
    });
    publishApproval(ctx, next.approval, event.id);
    await syncPlanSteps(ctx, next.approval);
    return { approvalId: approval.id, eventId: event.id };
  },
});

/** The requesting agent of a risk-row approval, if it is this burrow's agent. */
async function riskRowAgent(ctx: ApplyContext, approval: Approval) {
  const agent = await loadPrincipalRow(ctx.tx, approval.requesterId);
  if (agent?.kind !== 'agent' || agent.burrowId !== ctx.burrow.id) return null;
  return agent;
}

/**
 * “Always allow {Agent} to {row}” (resourceful-agents.md RA-06): the row of the action goes On for the agent that asked
 * (`withKeyRowTier(…, 'can')`), with Configure's signed Keys events, signed by the person and naming the approval.
 */
async function alwaysAllowRowOn(ctx: ApplyContext, approval: Approval, row: KeyTierRow) {
  const agent = await riskRowAgent(ctx, approval);
  if (!agent) throw conflict('That agent can’t be given keys any more.');
  return setAgentKeyRow(ctx, agent, row, 'can', { approvalId: approval.id, scope: 'agent' });
}

/**
 * Undo of an “Always allow” (RA-DS33): the row goes back to the tier it had before, as the decision's signed event
 * recorded, unless it is no longer On (a person changed it since).
 */
async function alwaysAllowRowBack(ctx: ApplyContext, approval: Approval, row: KeyTierRow) {
  const agent = await riskRowAgent(ctx, approval);
  if (!agent) return;
  const [decided] = await ctx.tx
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.burrowId, ctx.burrow.id),
        eq(events.approvalId, approval.id),
        eq(events.type, 'approval.approved'),
      ),
    )
    .orderBy(desc(events.seq))
    .limit(1);
  const before = decided?.payload.rowBefore;
  if (before !== 'ask' && before !== 'cannot') return;
  if (keyRowTier(await loadGrants(ctx.tx, agent.id), row) !== 'can') return;
  await setAgentKeyRow(ctx, agent, row, before, { approvalId: approval.id, scope: 'undo' });
}

/** Builds full conditions from `request_approval` inputs, with live PR data and default labels. */
async function conditionsFrom(
  ctx: ApplyContext,
  inputs: z.output<typeof ApprovalConditionInput>[],
  fallbackPr: number | undefined,
): Promise<ApprovalCondition[]> {
  const out: ApprovalCondition[] = [];
  for (const [i, c] of inputs.entries()) {
    const prNumber = c.prNumber ?? fallbackPr ?? null;
    const pr = prNumber ? await prByNumber(ctx.tx, ctx.burrow.id, prNumber) : undefined;
    if (c.kind === 'checks_pass') {
      out.push({
        id: i === 0 ? 'checks' : `checks-${i}`,
        kind: 'checks_pass',
        label: defaultConditionLabel({ kind: 'checks_pass' }),
        met: false,
        prNumber,
        headSha: pr?.headSha ?? null,
        state: 'pending',
        passed: 0,
        total: 0,
        fixing: false,
      });
    } else {
      const [reviewer] = await ctx.tx.select().from(principals).where(eq(principals.id, c.reviewerId));
      if (!reviewer || reviewer.burrowId !== ctx.burrow.id) throw notFound('Reviewer');
      out.push({
        id: `review-${reviewer.handle}`,
        kind: 'review_approved',
        label: defaultConditionLabel({ kind: 'review_approved', reviewerName: shortName(reviewer) }),
        met: false,
        prNumber,
        reviewerId: reviewer.id,
        reviewState: 'pending',
        reviewedAt: null,
      });
    }
  }
  return out;
}

/**
 * A deploy's checks and review conditions must be about the code it deploys: every PR they name (and the
 * action's own `prNumber`) must be a PR of the deployed repo whose branch is the deployed `ref`. Otherwise
 * green checks on one branch would let another ref (say `main` to production) go out.
 */
async function checkDeployCovered(
  ctx: ApplyContext,
  action: ApprovalAction,
  conditions: ApprovalCondition[],
): Promise<void> {
  if (action.type !== 'deploy') return;
  const p = action.params;
  const numbers = new Set<number>();
  if (p.prNumber) numbers.add(p.prNumber);
  for (const c of conditions)
    if ((c.kind === 'checks_pass' || c.kind === 'review_approved') && c.prNumber) numbers.add(c.prNumber);
  if (conditions.some((c) => c.kind === 'checks_pass' && !c.prNumber))
    throw badRequest('Say which pull request’s checks this deploy waits for (prNumber).');
  for (const n of numbers) {
    const pr = await prByNumber(ctx.tx, ctx.burrow.id, n, p.repo);
    if (!pr) throw notFound(`PR #${n}${p.repo ? ` in ${p.repo}` : ''}`);
    if (pr.branch !== p.ref)
      throw badRequest(
        `PR #${n} is on ${pr.branch}, not ${p.ref}: its checks and review don’t cover what this deploy would run.`,
      );
  }
}

/**
 * Mail, calendar and files actions run only through the connector tools, which ask the person (docs/decisions/
 * connectors.md "Tools"); a generic request would skip their rules.
 */
export function refusePersonalAction(action: ApprovalAction): void {
  if (isPersonalAction(action))
    throw badRequest('Use the mail, calendar and files tools for this: they ask the person first.');
}

/** A key is asked for with `request_approval` (docs/decisions/key-requests.md KR-02): never done directly. */
export function refuseDirectKeyGrant(action: ApprovalAction): void {
  if (action.type === 'grant_key')
    throw badRequest('Ask for a key with request_approval: only a person can give you one.');
}

type RequestInput = z.output<typeof MCP_TOOLS.request_approval.input>;

/**
 * An agent asks for a key it doesn't hold (docs/decisions/key-requests.md): refused when it may not hold it or
 * holds it already; otherwise one approval card, decided by the person (one-person.md OP-S62). Asking again while a request for the same key waits answers with that request.
 */
async function askForKey(
  ctx: ApplyContext,
  conversation: ConversationRow,
  input: RequestInput,
  keyId: KeyId,
): Promise<{ approvalId: string; number: number; messageId: string; eventId: string }> {
  const agent = ctx.actor.kind === 'agent' ? await loadPrincipalRow(ctx.tx, ctx.actor.id) : undefined;
  if (!agent) throw badRequest('Only agents ask for keys.');
  const problem = keyRequestProblem(
    { id: agent.id, name: agent.name },
    await loadGrants(ctx.tx, agent.id),
    keyId,
  );
  if (problem) throw badRequest(problem);
  const [open] = await ctx.tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.burrowId, ctx.burrow.id),
        eq(approvals.requesterId, agent.id),
        eq(approvals.state, 'pending'),
        sql`${approvals.action}->>'type' = 'grant_key'`,
        sql`${approvals.action}->'params'->>'keyId' = ${keyId}`,
      ),
    );
  if (open?.messageId && open.eventId)
    return { approvalId: open.id, number: open.number, messageId: open.messageId, eventId: open.eventId };
  const label = KEY_CATALOG[keyId].label;
  const asks = requestedTier(keyId) === 'ask';
  const { approval, eventId, messageId } = await createApproval(ctx, {
    keyId,
    action: input.action,
    decision: null,
    // Written from the action by createApproval (“Give Tinker “Browse the web””).
    title: 'Give a key',
    question: 'Give a key?',
    target: '',
    whatHappens: input.whatHappens,
    explainer:
      input.explainer.trim() ||
      `${agent.name} asked for “${label}”, a key it doesn’t hold. If you approve, ${agent.name} gets it right away${asks ? ' and still asks a person each time it uses it' : ''}.`,
    summary: input.summary,
    conditions: [],
    involvedIds: [],
    conversation,
    cardText: `I need “${label}” to go on. Only a person can give me a key.`,
    keyNote: 'asks a person for it',
    command: null,
  });
  return { approvalId: approval.id, number: approval.number, messageId, eventId };
}

/** An agent asks a person before a keyed action (the MCP tool `request_approval`). */
export const requestApproval = defineCommand({
  name: 'request_approval',
  /** `dispatchId` is set by the MCP adapter: an approval asked for in a turn handed a plan step gates it (WS-03). */
  schema: MCP_TOOLS.request_approval.input.extend({ dispatchId: DispatchId.optional() }),
  async requiredKey(input, { db, services }) {
    refusePersonalAction(input.action);
    // Asking for a key needs no key: it is always an approval (key-requests.md KR-02).
    if (input.action.type === 'grant_key') return null;
    // Never ask a person for what nobody here can carry out: the agent reads why (EA-03).
    await refuseUnavailable(input.action, services.approvals);
    const conversation = await loadConversationRow(db, input.conversationId);
    return {
      keyId: actionKey(input.action),
      scope: actionScope(input.action),
      attempt: describeAction(input.action),
      action: input.action,
      where: conversation ? conversationLabel(conversation) : null,
      conversationId: input.conversationId,
      onAsk: 'apply',
    };
  },
  async apply(tx, ctx, input) {
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    if (input.action.type === 'grant_key')
      return askForKey(ctx, conversation, input, input.action.params.keyId);
    const prNumber = input.action.type === 'deploy' ? input.action.params.prNumber : undefined;
    const conditions = await conditionsFrom(ctx, input.conditions, prNumber);
    await checkDeployCovered(ctx, input.action, conditions);
    // The card's title, question and target are written from the action (createApproval); the agent's own
    // wording is kept only as the explainer, the extra WHAT HAPPENS lines and the summary's second part.
    // A `custom` action keeps what createApproval is given, so it is built here from the action too.
    const copy = actionCopy(input.action);
    const custom = input.action.type === 'custom';
    const { approval, eventId, messageId } = await createApproval(ctx, {
      keyId: actionKey(input.action),
      action: input.action,
      decision: ctx.decision,
      title: copy.title,
      question: copy.question,
      target: copy.target,
      whatHappens: custom ? [copy.runs, ...input.whatHappens] : input.whatHappens,
      explainer: input.explainer,
      summary: custom
        ? [`${copy.runs}.`, input.summary].filter(Boolean).join(' ').slice(0, 600)
        : input.summary,
      conditions,
      involvedIds: input.involvedIds ?? [],
      conversation,
      cardText: `I need a person to say yes before I ${describeAction(input.action)}.`,
      command: null,
    });
    // The plan step this turn was handed now waits for the person (WS-03, WS-05).
    if (await linkWorkToStep(ctx, { approvalId: approval.id }, null, input.dispatchId ?? null))
      await followPlanWork(ctx, { kind: 'approval', id: approval.id });
    const services = ctx.services;
    ctx.after(() => services.approvals.reevaluate(approval.burrowId, { approvalIds: [approval.id] }));
    return { approvalId: approval.id, number: approval.number, messageId, eventId };
  },
});
