/**
 * The checks of a pull request wake the agent whose work it is (docs/decisions/health-checks-wake.md HW-01…HW-07), so
 * no agent schedules turns to wait for CI. When every check of a pull request's head has its result and a later poll
 * finds the round unchanged (`checksDue`, poll-plan.ts), the poller commits `github.checks_finished` as GitHub's system
 * principal. Under the burrow's lock it checks again and, once per head commit (`pull_requests.checks_handled_sha`):
 *
 * - a live run of an agent on the pull request (its number, or its branch while it has none): GitHub posts the result
 *   in one plain line where the run was asked — its conversation, the starting turn's thread, else its card's —
 *   mentioning the agent, with the commit and the counts in the agent's brief only, and the mention wakes the agent on
 *   the run (`mention`, mode `run`, for the run's person), in its checkout;
 * - a paused run: the same message and no turn (a person paused it; the turn that resumes it reads the message);
 * - else, when the pull request is an agent's (it opened it), the head is a commit Whombat pushed for that agent and a
 *   check failed: the message in the branch room wakes it there (the assistant: in the person's default chat);
 * - else nobody: the head is only marked handled, so a run started on it later isn't woken with old news.
 *
 * In the assistant shell the assistant is woken like a team agent for its own run or pull request, for the person
 * (assistant-name-server.md AN-S31…AN-S33). The message, the turn and the mark commit together. The poller's plan is
 * pure and this command checks everything again, so repeated polls and restarts wake nobody twice.
 */
import { type CheckState, shortSha } from '@whombat/core';
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import {
  dispatches,
  githubPushGrants,
  messages,
  prChecks,
  pullRequests,
  repos,
  runs,
} from '../db/schema/index';
import { briefAgent } from '../domain/agent-brief';
import { enqueueInSession } from '../domain/dispatch';
import { postMessage } from '../domain/messages';
import { personalDmId } from '../domain/personal-dm';
import { thePerson } from '../domain/the-person';
import { type ConversationRow, loadConversationRow } from '../read/conversations';
import { loadPrincipalRow, type PrincipalRow } from '../read/principals';
import { cardThread } from '../runtime/dispatch-scope';
import { checksOutcome, checksResultLine } from './checks-words';
import { checkDone, sameSha } from './poll-plan';

type RunRow = typeof runs.$inferSelect;
type PrRow = typeof pullRequests.$inferSelect;
type CheckRow = { name: string; state: CheckState };

/**
 * The wake: one plain line in the chat, “The checks on [PR #1](https://github.com/…/pull/1) failed (build).”
 * The commit and the counts are the agent's, in its brief (`checksWakeBrief`).
 */
export function checksWakeText(p: {
  prNumber: number;
  url: string | null;
  checks: readonly CheckRow[];
}): string {
  return checksResultLine(p);
}

/** What the woken agent reads after that line: which commit the round ran on and how every check ended. */
export function checksWakeBrief(p: {
  repo: string;
  prNumber: number;
  branch: string;
  headSha: string;
  checks: readonly CheckRow[];
}): string {
  return `Details for you: ${p.repo} PR #${p.prNumber}, branch ${p.branch}, commit ${shortSha(p.headSha)}: ${checksOutcome(p.checks)}.`;
}

/** The agent, woken for its own work (assistant-name-server.md AN-S31); never one of Whombat's own signers. */
async function wakeable(tx: Tx, id: string): Promise<PrincipalRow | null> {
  const row = await loadPrincipalRow(tx, id);
  return row?.kind === 'agent' ? row : null;
}

/** The agent's own pull request's place: the person's Chat with it (one-person.md OP-01), else the branch room. */
async function ownPlace(tx: Tx, pr: PrRow, author: PrincipalRow): Promise<Place | null> {
  const person = await thePerson(tx, author.burrowId);
  const id = person ? await personalDmId(tx, author.id, person.id) : pr.conversationId;
  const room = id ? await loadConversationRow(tx, id) : undefined;
  if (!room || room.burrowId !== author.burrowId) return null;
  return { conversation: room, threadRootId: null };
}

/** Live and paused runs on a pull request (its number, or its branch while they have none), newest first. */
function runsOnPullRequest(tx: Pick<Db, 'select'>, pr: PrRow, statuses: RunRow['status'][]) {
  return tx
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.burrowId, pr.burrowId),
        eq(runs.repoId, pr.repoId),
        inArray(runs.status, statuses),
        or(eq(runs.prNumber, pr.number), and(isNull(runs.prNumber), eq(runs.branch, pr.branch))),
      ),
    )
    .orderBy(desc(runs.number));
}

interface Place {
  conversation: ConversationRow;
  threadRootId: string | null;
}

/**
 * Where a run was asked (as Try again answers, RC-10): its conversation, in the thread of the turn that started it when
 * that turn was there, else its card's thread, else the top. Null when nothing can be posted there (archived, gone).
 */
async function runPlace(tx: Tx, run: RunRow): Promise<Place | null> {
  const conversation = await loadConversationRow(tx, run.conversationId);
  if (!conversation) return null;
  const [origin] = run.dispatchId
    ? await tx
        .select({ conversationId: dispatches.conversationId, threadRootId: dispatches.threadRootId })
        .from(dispatches)
        .where(eq(dispatches.id, run.dispatchId))
    : [];
  const asked = origin?.conversationId === run.conversationId ? origin.threadRootId : null;
  const root = asked ?? (await cardThread(tx, run.messageId));
  if (!root) return { conversation, threadRootId: null };
  const [kept] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, root), eq(messages.conversationId, conversation.id)));
  return { conversation, threadRootId: kept ? root : null };
}

/** The push grant Whombat recorded for exactly this commit of the agent's (GP-01), live or not. */
async function pushedFor(tx: Tx, burrowId: string, repo: string, pr: PrRow, agentId: string) {
  const [grant] = await tx
    .select()
    .from(githubPushGrants)
    .where(
      and(
        eq(githubPushGrants.burrowId, burrowId),
        eq(githubPushGrants.repo, repo),
        eq(githubPushGrants.branch, pr.branch),
        eq(githubPushGrants.agentId, agentId),
        eq(githubPushGrants.sha, pr.headSha.toLowerCase()),
      ),
    )
    .orderBy(desc(githubPushGrants.issuedAt))
    .limit(1);
  return grant ?? null;
}

async function postWake(
  ctx: ApplyContext,
  place: Place,
  agent: PrincipalRow,
  repo: string,
  pr: PrRow,
  checks: CheckRow[],
) {
  const posted = await postMessage(ctx, {
    conversation: place.conversation,
    threadRootId: place.threadRootId,
    text: checksWakeText({ prNumber: pr.number, url: pr.url, checks }),
    mentions: [agent.id],
    // Its turn is queued below: on the run when there is one, not postMessage's chat turn.
    dispatch: false,
  });
  await briefAgent(ctx, {
    messageId: posted.id,
    agentId: agent.id,
    brief: checksWakeBrief({ repo, prNumber: pr.number, branch: pr.branch, headSha: pr.headSha, checks }),
  });
  return posted;
}

export interface ChecksWake {
  /** Agents woken: a turn on their run, or (no run) in the branch room. */
  woken: string[];
  /** Agents told without a turn: their run is paused. */
  told: string[];
}

/**
 * The result of a pull request's finished round goes to the agent whose work it is (HW-01, HW-04), once per head
 * (HW-03). GitHub's system principal signs it; no key is asked (GitHub already ran the checks).
 */
export const mirrorChecksFinished = defineCommand({
  name: 'github.checks_finished',
  schema: z.object({
    repo: z.string(),
    prNumber: z.number().int().positive(),
    headSha: z.string().min(4).max(64),
  }),
  async apply(tx, ctx, input): Promise<ChecksWake> {
    const out: ChecksWake = { woken: [], told: [] };
    // A lapsed licence starts no agent turn (LC-10): the round is handled after the resume.
    if (ctx.services.licence.lapsed) return out;
    const [found] = await tx
      .select({ pr: pullRequests })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          eq(pullRequests.burrowId, ctx.burrow.id),
          eq(repos.fullName, input.repo),
          eq(pullRequests.number, input.prNumber),
        ),
      );
    const pr = found?.pr;
    // Moved on since the poll read it (a push, a close): the next poll decides again.
    if (pr?.state !== 'open' || pr.localOnly || !sameSha(pr.headSha, input.headSha)) return out;
    if (pr.checksHandledSha && sameSha(pr.checksHandledSha, pr.headSha)) return out;
    const checks = await tx
      .select({ name: prChecks.name, state: prChecks.state })
      .from(prChecks)
      .where(eq(prChecks.prId, pr.id))
      .orderBy(asc(prChecks.position));
    if (checks.length === 0 || !checks.every(checkDone)) return out;

    // Each agent's newest live or paused run on the pull request.
    const seen = new Set<string>();
    for (const run of await runsOnPullRequest(tx, pr, ['live', 'paused'])) {
      if (seen.has(run.agentId)) continue;
      seen.add(run.agentId);
      const agent = await wakeable(tx, run.agentId);
      const place = agent ? await runPlace(tx, run) : null;
      if (!agent || !place || place.conversation.burrowId !== agent.burrowId) continue;
      const posted = await postWake(ctx, place, agent, input.repo, pr, checks);
      // A person paused it: the message waits in its thread for the turn that resumes it (HW-04).
      if (run.status !== 'live') {
        out.told.push(agent.id);
        continue;
      }
      // A turn on the run, the person's (`personBehind`), never held by AH-01 (HW-05).
      const queued = await enqueueInSession(ctx, {
        burrowId: ctx.burrow.id,
        causedById: ctx.actor.id,
        conversationId: place.conversation.id,
        messageId: posted.id,
        threadRootId: place.threadRootId,
        requests: [{ agentId: agent.id, trigger: 'mention', mode: 'run' }],
        at: ctx.now,
        runId: run.id,
      });
      if (queued.length) out.woken.push(agent.id);
    }

    // No run of an agent waits on it: an agent's own pull request whose check failed on the commit Whombat pushed for
    // it (HW-04). A pass on finished work is the person's news, in the branch room already.
    const author =
      !out.woken.length && !out.told.length && pr.authorId ? await wakeable(tx, pr.authorId) : null;
    if (author && checks.some((c) => c.state === 'failed')) {
      const grant = await pushedFor(tx, ctx.burrow.id, input.repo, pr, author.id);
      const place = grant ? await ownPlace(tx, pr, author) : null;
      if (grant && place) {
        const posted = await postWake(ctx, place, author, input.repo, pr, checks);
        const queued = await enqueueInSession(ctx, {
          burrowId: ctx.burrow.id,
          causedById: ctx.actor.id,
          conversationId: place.conversation.id,
          messageId: posted.id,
          threadRootId: null,
          requests: [{ agentId: author.id, trigger: 'mention' }],
          at: ctx.now,
        });
        if (queued.length) out.woken.push(author.id);
      }
    }

    await tx.update(pullRequests).set({ checksHandledSha: pr.headSha }).where(eq(pullRequests.id, pr.id));
    return out;
  },
});

/**
 * Whether a live run's pull request still has a check result to bring it (HW-06, run-checkout.md RC-11): checks on its
 * head whose round isn't handled yet, or — the turn that just ended pushed — the next round, when the repository's pull
 * requests have checks at all. Then the run waits on them, as on a turn it scheduled; without checks it doesn't.
 */
export async function checksToCome(db: Db, run: RunRow, pushed: boolean): Promise<boolean> {
  if (!run.repoId) return false;
  const [repo] = await db
    .select({ enabled: repos.enabled, source: repos.source })
    .from(repos)
    .where(eq(repos.id, run.repoId));
  // Only GitHub's pull requests are polled (RP-05).
  if (!repo?.enabled || repo.source !== 'github') return false;
  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repoId, run.repoId),
        eq(pullRequests.state, 'open'),
        eq(pullRequests.localOnly, false),
        run.prNumber ? eq(pullRequests.number, run.prNumber) : eq(pullRequests.branch, run.branch),
      ),
    )
    .limit(1);
  if (!pr) return false;
  const [check] = await db
    .select({ state: prChecks.state })
    .from(prChecks)
    .where(eq(prChecks.prId, pr.id))
    .limit(1);
  const handled = pr.checksHandledSha !== null && sameSha(pr.checksHandledSha, pr.headSha);
  if (check && !handled) return true;
  if (!pushed) return false;
  if (check) return true;
  const [any] = await db
    .select({ prId: prChecks.prId })
    .from(prChecks)
    .innerJoin(pullRequests, eq(pullRequests.id, prChecks.prId))
    .where(eq(pullRequests.repoId, run.repoId))
    .limit(1);
  return !!any;
}
