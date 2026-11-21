/**
 * Pull requests: merge, reviews and CI checks (the GitHub mirror feeds these later). Who may merge is the keys
 * engine's call: people, and agents by their Merge row (`merge.main` into the default branch, `merge` elsewhere),
 * Off · Ask · On (docs/decisions/runs-approvals.md MDS-01…MDS-03).
 */
import {
  Check,
  ConversationId,
  checksState,
  decide,
  defaultConditionLabel,
  MCP_TOOLS,
  type MergeBlock,
  MergeMethod,
  mergeBlock,
  NumberParam,
  type PullRequest,
  topics,
} from '@whombat/core';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplyContext, RequirementContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { prChecks, principals, prReviewers, pullRequests, repos } from '../db/schema/index';
import { prLink } from '../domain/links';
import { postMessage } from '../domain/messages';
import { indexPullRequest } from '../domain/search-index';
import { principalForLogin } from '../github/actors';
import { checksActivityLine } from '../github/checks-words';
import { mergeOnOrigin } from '../github/local-prs';
import { prepareMerge } from '../github/merge-intents';
import { ApiError, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadGrants } from '../read/principals';
import { loadPullRequest, prByNumber } from '../read/work';
import type { Services } from '../services';

async function prAndRepo(db: RequirementContext['db'], burrowId: string, number: number, repo?: string) {
  const pr = await prByNumber(db, burrowId, number, repo);
  if (!pr) return null;
  const [r] = await db.select().from(repos).where(eq(repos.id, pr.repoId));
  return r ? { pr, repo: r } : null;
}

/**
 * The key a merge into `base` needs: “Merge into main” (`merge.main`) into the repository's default branch (or a `main`
 * or `master`), “Merge” elsewhere (MDS-01). Also an automation's merge step's (automation-recipes.md AR-45).
 */
export function mergeKeyOf(base: string, defaultBranch: string): 'merge' | 'merge.main' {
  return base === defaultBranch || base === 'main' || base === 'master' ? 'merge.main' : 'merge';
}

/** A pull request about to be merged: its mirror row, its repository and what `mergeBlock` reads. */
export interface MergeTarget {
  row: typeof pullRequests.$inferSelect;
  repo: typeof repos.$inferSelect;
  pr: PullRequest;
}

/** The pull request `number` (of `repo`, when given) as the mirror has it, with its repository; null when unknown. */
export async function mergeTarget(
  db: Db,
  burrowId: string,
  number: number,
  repo?: string,
): Promise<MergeTarget | null> {
  const found = await prAndRepo(db, burrowId, number, repo);
  if (!found) return null;
  return { row: found.pr, repo: found.repo, pr: await loadPullRequest(db, found.pr) };
}

/**
 * Who merges, where merge_pr's rules are checked: in its command (the command's transaction) and before an automation's
 * merge step reaches GitHub (the database, outside any transaction; automation-recipes.md AR-47).
 */
export interface MergeActor {
  db: Db;
  services: Services;
  burrowId: string;
  actor: { id: string; kind: 'person' | 'agent' };
}

export function mergeActorOf(ctx: ApplyContext): MergeActor {
  return { db: ctx.tx, services: ctx.services, burrowId: ctx.burrow.id, actor: ctx.actor };
}

export async function publishPr(ctx: ApplyContext, prId: string, eventId: string | null) {
  const [row] = await ctx.tx.select().from(pullRequests).where(eq(pullRequests.id, prId));
  if (!row) return;
  const pr = await loadPullRequest(ctx.tx, row);
  ctx.publish(topics.burrow(ctx.burrow.id), { type: 'pr.updated', pr }, { eventId });
}

/** Whether an agent opened the PR and the GitHub account Whombat acts as is the acting person's own (MOA-01). */
async function agentPrUnderOwnAccount(m: MergeActor, authorId: string | null): Promise<boolean> {
  if (!authorId) return false;
  const [author] = await m.db
    .select({ kind: principals.kind })
    .from(principals)
    .where(eq(principals.id, authorId));
  if (author?.kind !== 'agent') return false;
  const login = await m.services.github.connectionLoginFor(m.burrowId);
  return (await principalForLogin(m.services.db, m.burrowId, login)) === m.actor.id;
}

/**
 * Whether anyone could give an agent's PR the approving review its agent's merge at On needs (MOA-02): another active
 * team agent that may approve it (`review_pull_request` with `pr.approve` at On or Ask for the repository, MOA-04), or,
 * on GitHub, a person other than the one Whombat acts there as (people review on GitHub; a Whombat-only repo has
 * nowhere for them to, MDS-D06).
 */
async function someoneCouldReview(
  m: MergeActor,
  pr: { local: boolean; authorId: string | null; repo: string },
): Promise<boolean> {
  const others = await m.db
    .select({ id: principals.id, kind: principals.kind })
    .from(principals)
    .where(
      and(eq(principals.burrowId, m.burrowId), ne(principals.id, m.actor.id), isNull(principals.system)),
    );
  const agents = others.filter((p) => p.kind === 'agent' && p.id !== pr.authorId);
  const grants = await loadGrants(
    m.db,
    agents.map((a) => a.id),
  );
  const mayApprove = (id: string) =>
    decide({ id, kind: 'agent' }, grants, 'pr.approve', { repo: pr.repo }).outcome !== 'deny';
  if (agents.some((a) => mayApprove(a.id))) return true;
  if (pr.local) return false;
  const login = await m.services.github.connectionLoginFor(m.burrowId);
  const actsAs = await principalForLogin(m.services.db, m.burrowId, login);
  return others.some((p) => p.kind === 'person' && p.id !== actsAs);
}

const MERGE_BLOCK_MESSAGES = {
  agent: 'Only you can merge this: the agent doesn’t hold a merge key.',
  not_open: 'This pull request is not open.',
  checks: 'Checks have to pass before this can be merged.',
  review: 'It needs an approving review (and no changes requested) before it can be merged.',
} as const;

/**
 * What holds a merge by `m.actor` back under merge_pr's rules, null when nothing does. The keys engine already decided
 * who may merge (an agent holds Merge On, or a person approved its card): the rest of the rules are the same for
 * everyone — open, checks green, an approving review (MDS-03). A repository kept on this Whombat has nowhere else a
 * person reviews: a person merging it (or approving an agent's card) is the review (MDS-D06). So is it for an agent's PR
 * on GitHub when Whombat acts there as this person's own account: GitHub shows them as its author and won't take their
 * approving review (MOA-01). An agent merging at On needs a review only while someone could give one (MOA-02), and an
 * automation's run whose own review approved this very commit has one (`reviewed`, automation-recipes.md AR-47).
 * Changes someone requested still hold it.
 */
export async function mergeHold(
  m: MergeActor,
  target: MergeTarget,
  options: { reviewed?: boolean } = {},
): Promise<MergeBlock> {
  const pr = target.pr;
  const local = target.repo.source === 'local';
  const block = mergeBlock(pr, 'person');
  if (block !== 'review' || pr.reviewers.some((r) => r.state === 'changes_requested')) return block;
  if (options.reviewed) return null;
  const waived =
    m.actor.kind === 'person'
      ? local || (await agentPrUnderOwnAccount(m, pr.authorId))
      : !(await someoneCouldReview(m, { local, authorId: pr.authorId, repo: target.repo.fullName }));
  return waived ? null : block;
}

/**
 * A merge done (on GitHub, in the origin, or Whombat's own PR): the mirror says merged by the actor, signed `pr.merged`,
 * and the PR's readers, search and approvals hear it. Merge_pr's, and an automation's merge step's (AR-47).
 */
export async function recordMerge(
  ctx: ApplyContext,
  target: MergeTarget,
  method: MergeMethod,
  done: { github: { sha: string | null } | null; onOrigin: { sha: string; headSha: string } | null },
): Promise<void> {
  const pr = target.pr;
  await ctx.tx
    .update(pullRequests)
    .set({ state: 'merged', mergedAt: ctx.now, mergedById: ctx.actor.id, updatedAt: ctx.now })
    .where(eq(pullRequests.id, pr.id));
  const event = await ctx.emit({
    type: 'pr.merged',
    kind: 'Code',
    text: `Merged PR #${pr.number} into ${pr.baseBranch}`,
    where: `${target.repo.fullName} · PR #${pr.number}`,
    ref: prLink(pr.number, target.repo.fullName),
    payload: {
      prId: pr.id,
      number: pr.number,
      method,
      headSha: done.onOrigin?.headSha ?? pr.headSha,
      mergeSha: done.github?.sha ?? done.onOrigin?.sha ?? null,
      onGitHub: done.github !== null,
      ...(done.onOrigin ? { onWhombat: true } : {}),
    },
  });
  await publishPr(ctx, pr.id, event.id);
  const services = ctx.services;
  const tz = ctx.burrow.timeZone;
  ctx.after(() => indexPullRequest(services.db, pr.id, tz));
  ctx.after(() => services.approvals.reevaluate(ctx.burrow.id));
}

export const mergePr = defineCommand({
  name: 'merge_pr',
  schema: z.object({
    number: NumberParam,
    repo: z.string().optional(),
    method: MergeMethod.default('squash'),
    /** Where an agent was asked (the MCP adapter sets the dispatch's conversation): its card at Ask goes there. */
    conversationId: ConversationId.optional(),
  }),
  async requiredKey(input, { db, burrow }) {
    const found = await prAndRepo(db, burrow.id, input.number, input.repo);
    if (!found) throw notFound('Pull request');
    const base = found.pr.baseBranch;
    // An agent's merge at Ask is a card (MDS-03); while the PR has checks, it waits for them to pass on the latest
    // commit, so a person may approve it in advance and it merges once green (MDS-D03).
    const [checked] = await db
      .select({ prId: prChecks.prId })
      .from(prChecks)
      .where(eq(prChecks.prId, found.pr.id))
      .limit(1);
    return {
      keyId: mergeKeyOf(base, found.repo.defaultBranch),
      scope: { repo: found.repo.fullName, branch: base },
      attempt: `merge PR #${input.number} into ${base}`,
      where: `${found.repo.fullName} · PR #${input.number}`,
      ref: prLink(input.number, found.repo.fullName),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      // The method rides along, so the yes merges the way the agent asked (agent-gh.md AGH-22, CT-290).
      action: {
        type: 'merge_pr',
        params: {
          prNumber: input.number,
          repo: found.repo.fullName,
          base,
          ...(input.method !== 'squash' ? { method: input.method } : {}),
        },
      },
      // A yes merges as the person who said it (`approvals/executors.ts`, EA-02), however the agent asked: through
      // merge_pull_request, perform_action or request_approval (MDS-D02).
      approvalRunsAction: true,
      ...(checked
        ? {
            approval: {
              conditions: [
                {
                  id: 'checks',
                  kind: 'checks_pass' as const,
                  label: defaultConditionLabel({ kind: 'checks_pass' }),
                  met: false,
                  prNumber: input.number,
                  headSha: found.pr.headSha,
                  state: 'pending' as const,
                  passed: 0,
                  total: 0,
                  fixing: false,
                },
              ],
            },
          }
        : {}),
    };
  },
  async apply(tx, ctx, input) {
    const target = await mergeTarget(tx, ctx.burrow.id, input.number, input.repo);
    if (!target) throw notFound('Pull request');
    const block = await mergeHold(mergeActorOf(ctx), target);
    if (block)
      throw new ApiError('conflict', MERGE_BLOCK_MESSAGES[block], { details: { mergeBlock: block } });
    const { pr, repo } = target;
    if (repo.source === 'local') {
      const onOrigin = await mergeOnOrigin(ctx, { repo, pr, method: input.method });
      await recordMerge(ctx, target, input.method, { github: null, onOrigin });
    } else if (target.row.localOnly) {
      await recordMerge(ctx, target, input.method, { github: null, onOrigin: null });
    } else {
      await prepareMerge(ctx, target, input.method);
    }
    return { prId: pr.id, number: pr.number, repo: repo.fullName };
  },
});

const ReviewInput = MCP_TOOLS.review_pull_request.input;

/** A review on a PR (agents: `review_pull_request`; keys pr.approve / pr.request_changes / pr.comment). */
export const reviewPr = defineCommand({
  name: 'review_pr',
  schema: ReviewInput,
  async requiredKey(input, { db, burrow }) {
    const found = await prAndRepo(db, burrow.id, input.prNumber, input.repo);
    if (!found) throw notFound('Pull request');
    const keyId =
      input.decision === 'approve'
        ? 'pr.approve'
        : input.decision === 'request_changes'
          ? 'pr.request_changes'
          : 'pr.comment';
    const verb =
      input.decision === 'approve'
        ? 'approve'
        : input.decision === 'request_changes'
          ? 'request changes on'
          : 'comment on';
    return {
      keyId,
      scope: { repo: found.repo.fullName },
      attempt: `${verb} PR #${input.prNumber}`,
      where: `${found.repo.fullName} · PR #${input.prNumber}`,
      ref: prLink(input.prNumber, found.repo.fullName),
    };
  },
  async apply(tx, ctx, input) {
    const found = await prAndRepo(tx, ctx.burrow.id, input.prNumber, input.repo);
    if (!found) throw notFound('Pull request');
    const state =
      input.decision === 'approve'
        ? 'approved'
        : input.decision === 'request_changes'
          ? 'changes_requested'
          : 'commented';
    const [{ max } = { max: -1 }] = await tx
      .select({ max: sql<number>`coalesce(max(${prReviewers.position}), -1)::int` })
      .from(prReviewers)
      .where(eq(prReviewers.prId, found.pr.id));
    await tx
      .insert(prReviewers)
      .values({ prId: found.pr.id, principalId: ctx.actor.id, state, at: ctx.now, position: max + 1 })
      .onConflictDoUpdate({
        target: [prReviewers.prId, prReviewers.principalId],
        set: { state, at: ctx.now },
      });
    const n = Math.max(1, input.comments.length);
    const text =
      state === 'approved'
        ? `Approved PR #${input.prNumber}`
        : state === 'changes_requested'
          ? `Requested ${n} ${n === 1 ? 'change' : 'changes'} on PR #${input.prNumber}`
          : `Commented on PR #${input.prNumber}`;
    const event = await ctx.emit({
      type:
        state === 'approved'
          ? 'pr.approved'
          : state === 'changes_requested'
            ? 'pr.changes_requested'
            : 'pr.commented',
      kind: 'Code',
      text,
      where: `${found.repo.fullName} · PR #${input.prNumber}`,
      ref: prLink(input.prNumber, found.repo.fullName),
      payload: { prId: found.pr.id, decision: input.decision, comments: input.comments.length },
    });
    const room = await loadConversationRow(tx, found.pr.conversationId);
    if (room && input.body.trim()) {
      await postMessage(ctx, {
        conversation: room,
        text: input.body.trim().slice(0, 8000),
      });
    }
    await publishPr(ctx, found.pr.id, event.id);
    const services = ctx.services;
    ctx.after(() => services.approvals.reevaluate(ctx.burrow.id));
    return { reviewState: state };
  },
});

/** CI results for a PR's head commit (internal: the GitHub mirror and the demo storyline call this). */
export const recordChecks = defineCommand({
  name: 'record_checks',
  schema: z.object({
    prNumber: z.number().int().positive(),
    repo: z.string().optional(),
    headSha: z.string().min(4).max(64).optional(),
    checks: z.array(Check).max(100),
  }),
  async apply(tx, ctx, input) {
    const found = await prAndRepo(tx, ctx.burrow.id, input.prNumber, input.repo);
    if (!found) throw notFound('Pull request');
    const headSha = input.headSha ?? found.pr.headSha;
    await tx.delete(prChecks).where(eq(prChecks.prId, found.pr.id));
    if (input.checks.length) {
      await tx.insert(prChecks).values(
        input.checks.map((c, i) => ({
          prId: found.pr.id,
          name: c.name,
          state: c.state,
          note: c.note,
          durationMs: c.durationMs,
          tests: c.tests,
          url: c.url,
          position: i,
        })),
      );
    }
    await tx
      .update(pullRequests)
      .set({ headSha, updatedAt: ctx.now })
      .where(eq(pullRequests.id, found.pr.id));
    const aggregate = checksState(input.checks);
    const finished = aggregate === 'passed' || aggregate === 'failed';
    const event = await ctx.emit({
      type: 'checks.completed',
      kind: 'Code',
      text: finished ? checksActivityLine(input.prNumber, input.checks) : null,
      where: `${found.repo.fullName} · PR #${input.prNumber}`,
      ref: prLink(input.prNumber, found.repo.fullName),
      payload: { prId: found.pr.id, headSha, state: aggregate },
    });
    await publishPr(ctx, found.pr.id, event.id);
    const services = ctx.services;
    ctx.after(() => services.approvals.reevaluate(ctx.burrow.id));
    return { state: aggregate };
  },
});
