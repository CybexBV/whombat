/**
 * Commands behind the agent MCP tools that had no REST twin: cards, status, search answers, keyed actions,
 * opening pull requests, recording pushes (the GitHub mirror's job; the demo storyline plays it until the
 * GitHub phase), canvas edits and search. Every one runs through the commit pipeline, so the keys engine
 * and signing apply to agents exactly as to people.
 */

import { createHash } from 'node:crypto';
import {
  type Approval,
  type ApprovalAction,
  actionKey,
  actionScope,
  branchWriteKey,
  ConversationId,
  conversationLabel,
  describeAction,
  IDLE_EXECUTION,
  MCP_TOOLS,
  newId,
  shortSha,
  topics,
} from '@whombat/core';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { executedText } from '../approvals/engine';
import { refuseUnavailable } from '../approvals/executors';
import { unavailableAction } from '../approvals/unavailable';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import {
  conversations,
  plans,
  prCommits,
  pullRequests,
  repos,
  runs,
  searchAnswers,
  searchDocuments,
} from '../db/schema/index';
import { prLink } from '../domain/links';
import { publishConversation } from '../domain/members';
import { postMessage } from '../domain/messages';
import { indexPullRequest } from '../domain/search-index';
import { localBranchSnapshot, writeLocalChanges } from '../github/local-prs';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow, shortName } from '../read/principals';
import { docReadableBy, searchResults, toSearchAnswer } from '../read/search';
import { refuseDirectKeyGrant, refusePersonalAction } from './approvals';
import { mergePr, publishPr } from './prs';
import { publishRun } from './runs';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

async function onBehalfName(ctx: ApplyContext): Promise<string | null> {
  const id = ctx.onBehalfOf.principalId;
  if (!id) return null;
  const row = await loadPrincipalRow(ctx.tx, id);
  return row ? shortName(row) : null;
}

/* post_card -------------------------------------------------------------------------------------- */

export const postCard = defineCommand({
  name: 'post_card',
  schema: MCP_TOOLS.post_card.input,
  async apply(tx, ctx, input) {
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    if (input.card.kind === 'plan') {
      const [plan] = await tx
        .select({ burrowId: plans.burrowId })
        .from(plans)
        .where(eq(plans.id, input.card.planId));
      if (plan?.burrowId !== ctx.burrow.id) throw notFound('Plan');
    }
    let eventText: string | null = null;
    if (input.card.kind === 'answer') {
      // "Answered Priya with 3 receipts" (mock e-9ea4): an answer with receipts is a meaningful action.
      const who = await onBehalfName(ctx);
      const n = input.card.receipts.length;
      eventText = `Answered ${who ?? 'the question'} with ${n} ${n === 1 ? 'receipt' : 'receipts'}`;
    }
    const posted = await postMessage(ctx, {
      conversation,
      text: input.text,
      card: input.card,
      threadRootId: input.threadRootId ?? null,
      suggestions: input.suggestions ?? [],
      asks: input.asks ?? false,
      eventText,
    });
    return { messageId: posted.id };
  },
});

/* post_answer ------------------------------------------------------------------------------------ */

/** The researcher delivers the search-screen answer (`post_answer`): text with `[n]` citations. */
export const deliverAnswer = defineCommand({
  name: 'deliver_answer',
  schema: MCP_TOOLS.post_answer.input,
  requiredKey: () => ({ keyId: 'messages.search', attempt: 'answer a search', where: 'Search' }),
  async apply(tx, ctx, input) {
    const [answer] = await tx
      .select()
      .from(searchAnswers)
      .where(and(eq(searchAnswers.id, input.answerId), eq(searchAnswers.burrowId, ctx.burrow.id)));
    if (!answer) throw notFound('Answer');
    if (answer.agentId !== ctx.actor.id) throw forbidden('Someone else was asked this one.');
    if (answer.status === 'ready') throw conflict('This search already has an answer.');
    const numbers = input.citations.map((c) => c.n);
    if (new Set(numbers).size !== numbers.length)
      throw badRequest('Each receipt number can only be used once.');
    const ids = [...new Set(input.citations.map((c) => c.resultId))];
    const docs = await tx
      .select({
        id: searchDocuments.id,
        type: searchDocuments.type,
        conversationId: searchDocuments.conversationId,
      })
      .from(searchDocuments)
      .where(and(eq(searchDocuments.burrowId, ctx.burrow.id), inArray(searchDocuments.id, ids)));
    const askerRow = await loadPrincipalRow(tx, answer.askedById);
    for (const id of ids) {
      const doc = docs.find((d) => d.id === id);
      // Receipts must be results the person who asked may open now: the burrow's, and a decision's own rule (WS-22).
      if (!doc || !askerRow || !(await docReadableBy(tx, askerRow, doc)))
        throw badRequest(`Unknown search result ${id}.`);
    }
    const durationMs = Math.max(0, ctx.now.getTime() - answer.createdAt.getTime());
    const [row] = await tx
      .update(searchAnswers)
      .set({
        status: 'ready',
        text: input.text,
        citations: input.citations,
        actions: input.actions,
        durationMs,
        updatedAt: ctx.now,
      })
      .where(eq(searchAnswers.id, answer.id))
      .returning();
    const asker = await loadPrincipalRow(tx, answer.askedById);
    const n = input.citations.length;
    const event = await ctx.emit({
      type: 'answer.posted',
      kind: 'Messages',
      text: `Answered ${asker ? shortName(asker) : 'a search'} with ${n} ${n === 1 ? 'receipt' : 'receipts'}`,
      where: 'Search',
      ...(asker ? { onBehalfOfId: asker.id } : {}),
      ref: { type: 'search', q: answer.query },
      payload: { answerId: answer.id, citations: n },
    });
    if (row)
      ctx.publish(
        topics.me(answer.askedById),
        { type: 'search.answer', answer: toSearchAnswer(row) },
        { eventId: event.id },
      );
    return { answerId: answer.id };
  },
});

/* perform_action --------------------------------------------------------------------------------- */

const PerformInput = MCP_TOOLS.perform_action.input;

/** An approval-shaped view of a direct action, for the executor registry. */
function actionAsApproval(ctx: ApplyContext, action: ApprovalAction, conversationId: string): Approval {
  const title = cap(describeAction(action));
  return {
    id: `apr_direct${ctx.eventIds.length}`,
    number: 1,
    burrowId: ctx.burrow.id,
    requesterId: ctx.actor.id,
    keyId: actionKey(action),
    action,
    title,
    question: `${title}?`,
    target: '',
    whatHappens: [title],
    explainer: '',
    summary: '',
    conditions: [],
    state: 'approved',
    decidedById: null,
    decidedAt: null,
    execution: IDLE_EXECUTION,
    executedAt: null,
    conversationId,
    messageId: null,
    involvedIds: [],
    eventId: null,
    createdAt: ctx.at,
  };
}

export const performAction = defineCommand({
  name: 'perform_action',
  schema: PerformInput,
  async requiredKey(input, { db, services }) {
    refusePersonalAction(input.action);
    refuseDirectKeyGrant(input.action);
    // Only what Whombat itself can carry out, said before anything is asked or done (EA-03).
    await refuseUnavailable(input.action, services.approvals, { perform: true });
    const conversation = await loadConversationRow(db, input.conversationId);
    const attempt = describeAction(input.action);
    return {
      keyId: actionKey(input.action),
      scope: actionScope(input.action),
      attempt,
      action: input.action,
      where: conversation ? conversationLabel(conversation) : null,
      conversationId: input.conversationId,
      // Title, question, target and WHAT HAPPENS come from the action (createApproval).
      approval: input.reason ? { summary: input.reason } : {},
      // A yes runs the action's own executor (a merge as the person who approved, a deploy's workflow; EA-02).
      approvalRunsAction: true,
    };
  },
  async apply(tx, ctx, input) {
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation || conversation.burrowId !== ctx.burrow.id) throw notFound('Conversation');
    const action = input.action;
    // Actions with a command of their own run it (the keys decision above already covered its key).
    if (action.type === 'merge_pr') {
      await mergePr.apply(tx, ctx, {
        number: action.params.prNumber,
        repo: action.params.repo,
        method: action.params.method ?? 'squash',
      });
      return { result: `Merged PR #${action.params.prNumber}` };
    }
    const executor = ctx.services.approvals.executorFor(action.type);
    // Nothing here carries it out: never signed as done (EA-03; normally refused before this).
    if (!executor) throw badRequest(unavailableAction(action, ctx.services.approvals) ?? 'Not available.');
    const approval = actionAsApproval(ctx, action, conversation.id);
    const result = await executor(approval, ctx.services);
    // Only an action that finished here is signed as done; one that finishes later belongs to an approval.
    if ('deferred' in result)
      throw conflict(
        `Ask a person with request_approval to ${describeAction(action)}: it finishes after this turn.`,
      );
    const outcome = result;
    if (!outcome.ok) throw new ApiError('conflict', `Couldn’t ${describeAction(action)}: ${outcome.error}`);
    await ctx.emit({
      type: 'action.performed',
      kind: action.type === 'message_external' ? 'Messages' : 'Code',
      text: executedText(approval, { requester: ctx.actor.shortName }) ?? approval.title,
      where: conversationLabel(conversation),
      payload: {
        action: JSON.parse(JSON.stringify(action)),
        reason: input.reason,
        resultUrl: outcome.resultUrl ?? null,
      },
    });
    return {
      result:
        outcome.resultUrl ?? executedText(approval, { requester: ctx.actor.shortName }) ?? approval.title,
    };
  },
});

/* open_pull_request ------------------------------------------------------------------------------ */

/** The last line of a PR body Whombat opens on GitHub (everything on GitHub happens as the gh account). */
export function openedVia(agentName: string): string {
  return `Opened by ${agentName} via Whombat`;
}

/** Placeholder head until the GitHub mirror reports the real one (first push replaces it). */
function placeholderSha(repo: string, branch: string): string {
  return createHash('sha256').update(`${repo}\0${branch}`).digest('hex').slice(0, 7);
}

export const openPr = defineCommand({
  name: 'open_pr',
  /** `conversationId` (set by the MCP adapter): the dispatch's conversation; its people join the room. */
  schema: MCP_TOOLS.open_pull_request.input.extend({ conversationId: ConversationId.optional() }),
  requiredKey: (input) => ({
    keyId: 'pr.open',
    scope: { repo: input.repo, branch: input.branch },
    attempt: `open a pull request from ${input.branch}`,
    where: input.repo,
  }),
  async apply(tx, ctx, input) {
    const [repo] = await tx
      .select()
      .from(repos)
      .where(and(eq(repos.burrowId, ctx.burrow.id), eq(repos.fullName, input.repo)));
    if (!repo) throw notFound(`Repo ${input.repo}`);
    if (!repo.enabled) throw conflict(`${repo.fullName} is not switched on for agents.`);
    if (input.branch === input.base)
      throw badRequest('Open the pull request from a branch other than its base.');
    const [open] = await tx
      .select({ number: pullRequests.number })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repoId, repo.id),
          eq(pullRequests.branch, input.branch),
          eq(pullRequests.state, 'open'),
        ),
      );
    if (open) throw conflict(`PR #${open.number} is already open for ${input.branch}.`);
    // A repository kept on this Whombat (repositories.md RP-05) has its pull requests here: the branch as the agent
    // pushed it to the origin, merged there too (runs-approvals.md MDS-D05). No URL: there is nothing to open outside.
    const local = repo.source === 'local' ? await localBranchSnapshot(repo, input.base, input.branch) : null;
    // Connected repos open the PR on GitHub first: its number, head and URL are GitHub's. It is opened as the
    // host's gh account, so its body says which agent opened it (and the PR row records the agent).
    const github = local
      ? null
      : await ctx.services.github.openOnGitHub({
          burrowId: ctx.burrow.id,
          repo: repo.fullName,
          head: input.branch,
          base: input.base,
          title: input.title,
          body: [input.body.trim(), openedVia(ctx.actor.name)].filter(Boolean).join('\n\n'),
        });
    const [{ max } = { max: 0 }] = await tx
      .select({ max: sql<number>`coalesce(max(${pullRequests.number}), 0)::int` })
      .from(pullRequests)
      .where(eq(pullRequests.repoId, repo.id));
    const next = github?.number ?? max + 1;

    // The branch room: slug = branch (suffixed when an older room holds it).
    const taken = await tx
      .select({ slug: conversations.slug })
      .from(conversations)
      .where(and(eq(conversations.burrowId, ctx.burrow.id), eq(conversations.kind, 'branch')));
    const slugs = new Set(taken.map((t) => t.slug));
    let slug = input.branch;
    for (let i = 2; slugs.has(slug); i++) slug = `${input.branch}-${i}`;
    const roomId = newId('conversation');
    await tx.insert(conversations).values({
      id: roomId,
      burrowId: ctx.burrow.id,
      kind: 'branch',
      slug,
      title: input.branch,
      topic: `PR #${next} · ${input.title} · opened by ${ctx.actor.shortName}`.slice(0, 280),
      prNumber: next,
      repoId: repo.id,
      createdAt: ctx.now,
    });
    const prId = newId('pullRequest');
    await tx.insert(pullRequests).values({
      id: prId,
      burrowId: ctx.burrow.id,
      repoId: repo.id,
      number: next,
      branch: input.branch,
      baseBranch: input.base,
      title: input.title,
      state: 'open',
      headSha: github?.headSha ?? local?.headSha ?? placeholderSha(repo.fullName, input.branch),
      authorId: ctx.actor.id,
      conversationId: roomId,
      openedAt: ctx.now,
      url: github?.url ?? (local ? null : `https://github.com/${repo.fullName}/pull/${next}`),
      updatedAt: ctx.now,
      // Not on GitHub: the poller leaves it alone (its number may be another PR's there).
      localOnly: github === null,
    });
    if (local) await writeLocalChanges(tx, ctx.burrow.id, prId, local, ctx.now);
    // The runs on this branch show their pull request (run-checkout.md RC-08).
    const linked = await tx
      .update(runs)
      .set({ prNumber: next, updatedAt: ctx.now })
      .where(and(eq(runs.repoId, repo.id), eq(runs.branch, input.branch), isNull(runs.prNumber)))
      .returning({ id: runs.id });
    const room = await loadConversationRow(tx, roomId);
    if (!room) throw notFound('Branch room');
    await postMessage(ctx, {
      conversation: room,
      text: `Opened PR #${next} · ${input.title}.${input.body.trim() ? `\n\n${input.body.trim()}` : ''}`.slice(
        0,
        8000,
      ),
      dispatch: false,
    });
    const event = await ctx.emit({
      type: 'pr.opened',
      kind: 'Code',
      text: `Opened PR #${next} · ${input.title}`.slice(0, 500),
      where: repo.fullName,
      ref: prLink(next, repo.fullName),
      payload: { prId, number: next, branch: input.branch, base: input.base, onGitHub: github !== null },
    });
    await publishConversation(ctx, roomId, event.id);
    await publishPr(ctx, prId, event.id);
    for (const r of linked) await publishRun(ctx, r.id, event.id);
    const services = ctx.services;
    const tz = ctx.burrow.timeZone;
    ctx.after(() => indexPullRequest(services.db, prId, tz));
    return { number: next, conversationId: roomId };
  },
});

/* record_push (GitHub mirror) -------------------------------------------------------------------- */

/**
 * A push landed on a PR branch (internal: the GitHub mirror, and the demo storyline until then). Signed by
 * the principal whose credentials pushed, under the branch key: "Pushed 7be20f to feat/invoice-pdf".
 */
export const recordPush = defineCommand({
  name: 'record_push',
  schema: z.object({
    repo: z.string().min(1),
    branch: z.string().min(1),
    sha: z.string().min(4).max(64),
    message: z.string().max(500).default(''),
  }),
  async requiredKey(input, { db, burrow }) {
    const [repo] = await db
      .select()
      .from(repos)
      .where(and(eq(repos.burrowId, burrow.id), eq(repos.fullName, input.repo)));
    const [pr] = repo
      ? await db
          .select({ number: pullRequests.number })
          .from(pullRequests)
          .where(
            and(
              eq(pullRequests.repoId, repo.id),
              eq(pullRequests.branch, input.branch),
              eq(pullRequests.state, 'open'),
            ),
          )
      : [];
    return {
      keyId: branchWriteKey(input.branch, repo?.defaultBranch ?? 'main'),
      scope: { branch: input.branch, repo: input.repo },
      attempt: `push ${shortSha(input.sha)} to ${input.branch}`,
      where: pr ? `${input.repo} · PR #${pr.number}` : input.repo,
      ...(pr ? { ref: prLink(pr.number, input.repo) } : {}),
      action: {
        type: 'push_shared_branch',
        params: { repo: input.repo, branch: input.branch, sha: input.sha },
      },
    };
  },
  async apply(tx, ctx, input) {
    const [repo] = await tx
      .select()
      .from(repos)
      .where(and(eq(repos.burrowId, ctx.burrow.id), eq(repos.fullName, input.repo)));
    if (!repo) throw notFound(`Repo ${input.repo}`);
    await tx.update(repos).set({ pushedAt: ctx.now }).where(eq(repos.id, repo.id));
    const [pr] = await tx
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repoId, repo.id),
          eq(pullRequests.branch, input.branch),
          eq(pullRequests.state, 'open'),
        ),
      );
    if (pr) {
      await tx
        .update(pullRequests)
        .set({ headSha: input.sha, updatedAt: ctx.now })
        .where(eq(pullRequests.id, pr.id));
      const [{ max } = { max: -1 }] = await tx
        .select({ max: sql<number>`coalesce(max(${prCommits.position}), -1)::int` })
        .from(prCommits)
        .where(eq(prCommits.prId, pr.id));
      await tx
        .insert(prCommits)
        .values({
          prId: pr.id,
          sha: input.sha,
          message: input.message || `Push to ${input.branch}`,
          authorId: ctx.actor.id,
          at: ctx.now,
          position: max + 1,
        })
        .onConflictDoNothing();
    }
    const event = await ctx.emit({
      type: 'branch.pushed',
      kind: 'Code',
      text: `Pushed ${shortSha(input.sha)} to ${input.branch}`,
      where: pr ? `${repo.fullName} · PR #${pr.number}` : repo.fullName,
      ...(pr ? { ref: prLink(pr.number, repo.fullName) } : {}),
      payload: { repo: repo.fullName, branch: input.branch, sha: input.sha, prId: pr?.id ?? null },
    });
    if (pr) await publishPr(ctx, pr.id, event.id);
    const services = ctx.services;
    const tz = ctx.burrow.timeZone;
    ctx.after(() => services.approvals.reevaluate(ctx.burrow.id));
    // A push adds a commit to `prCommits`, part of the patch's indexed text (`indexPullRequest`'s
    // `cardText`/commit-message join) — re-index so the new commit message is searchable immediately,
    // same as `open_pr` (agent-tools.ts) and `merge_pr`/`review_pr` (prs.ts) already do on their own writes.
    if (pr) ctx.after(() => indexPullRequest(services.db, pr.id, tz));
    return { prNumber: pr?.number ?? null, eventId: event.id };
  },
});

/* canvas_edit ------------------------------------------------------------------------------------ */

/** `canvas_edit` edits the canvas Y.Doc: see `collab/commands.ts` (collab-server.md). */
export { editCanvas } from '../collab/commands';

/* search ----------------------------------------------------------------------------------------- */

/**
 * The `search` tool: a read. The agent searches every conversation of the burrow, all of them the person's
 * (`visibleConversations`, ASR-01). Never in an outsiders' turn (one-person.md OP-S71).
 */
/** What `search` with `mine: true` finds of an agent's own (RA-26): its messages and threads, and its runs. */
const MINE_TYPES = ['MESSAGE', 'THREAD', 'RUN'] as const;

export const agentSearch = defineCommand({
  name: 'agent_search',
  schema: MCP_TOOLS.search.input,
  async apply(tx, ctx, input) {
    const viewer = await loadPrincipalRow(tx, ctx.actor.id);
    if (!viewer) throw notFound('Principal');
    const results = await searchResults(
      tx,
      viewer,
      ctx.burrow,
      {
        q: input.query,
        type: input.filter,
        limit: input.limit,
        // `mine` (resourceful-agents.md RA-26): only its own earlier messages and runs.
        ...(input.mine ? { authorId: viewer.id, types: MINE_TYPES } : {}),
        log: ctx.services.log,
      },
      ctx.now,
    );
    return { results };
  },
});
