/**
 * Git credentials for agent workspaces. The runner asks per dispatch; a push needs the agent's key for the
 * branch (feat/* → "Read and write feat/* branches", main → "Push to main", Off for agents unless a person turns it on,
 * agent-computer.md AC-41, AC-DS20), decided by the keys engine like
 * any command so a refused push leaves a signed Blocked event. Only switched-on repos get a token. The
 * token itself comes from the `GitHost` (github/service.ts: a person's own GitHub sign-in, PV-06), and
 * reaches git only through the environment of the one fetch or push the runner asked for.
 *
 * A push whose key asks (docs/decisions/essentials-agents.md EA-05): a `push_shared_branch` approval of exactly that
 * commit, with its card where the turn was asked; once a person said yes, the agent's next push of it goes through
 * (approvals/push.ts).
 */

import { branchWriteKey, KEY_CATALOG, shortSha } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { createApproval } from '../approvals/create';
import { pushAllowance, waitingPushRequest } from '../approvals/push';
import { approvedPushFor } from '../automations/workspace';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import { dispatches, repos } from '../db/schema/index';
import { forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';

/** A push that now waits for a person: the approval it waits for (the route answers 202). */
export interface PendingPush {
  pending: { approvalId: string; approvalNumber: number; eventId: string };
}

/** The keys decision for a git token: fetch needs a switched-on repo, push the branch key too. */
export const authorizeGit = defineCommand({
  name: 'runtime.authorize_git',
  schema: z.object({
    repo: z.string().min(1),
    branch: z.string().min(1),
    operation: z.enum(['fetch', 'push']),
    /** Push only: the commit the runner is pushing (set by the credentials route from its request). */
    sha: z.string().min(4).max(64).optional(),
    /** The dispatch asking (set by the credentials route): where a push that asks puts its card. */
    dispatchId: z.string().optional(),
    /**
     * Set by the credentials route only: a person approved this automation step's work on the branch
     * (bp-automations.md BP-C26), so a push the agent's key asks for runs under that approval. Checked again here.
     */
    stepApproval: z.object({ dispatchId: z.string(), approvalId: z.string() }).optional(),
    /** Set by the credentials route only: a person said yes to this push (approvals/push.ts). Checked again here. */
    pushApprovalId: z.string().optional(),
  }),
  async requiredKey(input, { db, burrow }) {
    if (input.operation !== 'push') return null;
    const [repo] = await db
      .select({ defaultBranch: repos.defaultBranch })
      .from(repos)
      .where(and(eq(repos.burrowId, burrow.id), eq(repos.fullName, input.repo)));
    return {
      keyId: branchWriteKey(input.branch, repo?.defaultBranch ?? 'main'),
      scope: { repo: input.repo, branch: input.branch },
      attempt: `push to ${input.branch}`,
      where: `${input.repo} · ${input.branch}`,
      // An `ask` is this command's own: it runs under a person's yes, or asks for one (below).
      onAsk: 'apply' as const,
    };
  },
  async apply(tx, ctx, input): Promise<{ repo: string; approvalId: string | null } | PendingPush> {
    let approvalId: string | null = null;
    if (ctx.decision?.outcome === 'ask') {
      if (input.stepApproval) {
        const approved = await approvedPushFor(tx, input.stepApproval.dispatchId, input.repo, input.branch);
        if (!approved || approved !== input.stepApproval.approvalId)
          throw forbidden('A person has to approve this push first.');
        approvalId = approved;
      } else if (input.pushApprovalId) {
        const allowed = await pushAllowance(tx, {
          burrowId: ctx.burrow.id,
          agentId: ctx.actor.id,
          repo: input.repo,
          branch: input.branch,
          sha: input.sha ?? null,
        });
        if (allowed !== input.pushApprovalId) throw forbidden('A person has to approve this push first.');
        approvalId = allowed;
      } else {
        return askToPush(ctx, input);
      }
    }
    const [repo] = await tx
      .select()
      .from(repos)
      .where(and(eq(repos.burrowId, ctx.burrow.id), eq(repos.fullName, input.repo)));
    if (!repo?.enabled) throw notFound(`Repo ${input.repo}`);
    await ctx.emit({
      type: 'git.credentials_issued',
      kind: 'System',
      text: null,
      where: `${repo.fullName} · ${input.branch}`,
      payload: {
        repo: repo.fullName,
        branch: input.branch,
        operation: input.operation,
        ...(approvalId ? { approvalId } : {}),
      },
    });
    return { repo: repo.fullName, approvalId };
  },
});

/**
 * The push asks a person (EA-05): one `push_shared_branch` approval of exactly this commit, its card where the turn was
 * asked (its conversation and thread), for the turn's person; a request still waiting for the same agent, repo and
 * branch answers instead of a second card.
 */
async function askToPush(
  ctx: ApplyContext,
  input: { repo: string; branch: string; sha?: string | undefined; dispatchId?: string | undefined },
): Promise<PendingPush> {
  const { tx } = ctx;
  const decision = ctx.decision;
  const [repo] = await tx
    .select()
    .from(repos)
    .where(and(eq(repos.burrowId, ctx.burrow.id), eq(repos.fullName, input.repo)));
  if (!repo?.enabled) throw notFound(`Repo ${input.repo}`);
  const [dispatch] = input.dispatchId
    ? await tx.select().from(dispatches).where(eq(dispatches.id, input.dispatchId))
    : [];
  // Without the commit or the turn there is nothing exact to ask about.
  if (!decision || !input.sha || dispatch?.agentId !== ctx.actor.id)
    throw forbidden('A person has to approve this push first.');
  const waiting = await waitingPushRequest(tx, {
    burrowId: ctx.burrow.id,
    agentId: ctx.actor.id,
    repo: repo.fullName,
    branch: input.branch,
  });
  if (waiting?.eventId)
    return { pending: { approvalId: waiting.id, approvalNumber: waiting.number, eventId: waiting.eventId } };
  const conversation = await loadConversationRow(tx, dispatch.conversationId);
  if (!conversation) throw notFound('Conversation');
  const label = KEY_CATALOG[decision.keyId].label;
  const sha = input.sha.toLowerCase();
  const { approval, eventId } = await createApproval(ctx, {
    keyId: decision.keyId,
    action: { type: 'push_shared_branch', params: { repo: repo.fullName, branch: input.branch, sha } },
    decision,
    // Title, question, target and the first WHAT HAPPENS line are written from the action.
    title: '',
    question: '',
    target: '',
    whatHappens: [`${ctx.actor.shortName} is woken to push it, and only this commit.`],
    explainer: `${ctx.actor.shortName} holds “${label}”, a key that only turns when a person approves. If you approve, ${ctx.actor.shortName} pushes ${shortSha(sha)} to ${input.branch} in its next turn.`,
    summary: '',
    conditions: [],
    involvedIds: [],
    conversation,
    threadRootId: dispatch.threadRootId,
    cardText: `I need a person to say yes before I push ${shortSha(sha)} to ${input.branch}.`,
    where: `${repo.fullName} · ${input.branch}`,
    command: null,
    onBehalfOfAccountId: dispatch.onBehalfOfAccountId ?? null,
  });
  return {
    pending: { approvalId: approval.id, approvalNumber: approval.number, eventId },
  };
}
