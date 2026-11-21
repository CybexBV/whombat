/**
 * The GitHub mirror's commands: what the poller reads from GitHub becomes burrow state
 * through the commit pipeline, signed by the GitHub-side actor (github/actors.ts). No keys are asked — GitHub
 * already decided; the keys engine applied when the runner got its push token — but an agent's push still
 * records the branch key it used, as a push through Whombat would. Pushes and reviews are mirrored once
 * (`github_branch_heads`, `github_seen`, written in the same transaction), so polling again changes nothing.
 *
 * Room copy (docs/decisions/github.md): a PR opened on GitHub posts "Opened PR #N · title." with the
 * commits card; pushes by people post a commits card (agents announce their own pushes, as Dusty does);
 * checks post a status pill only when a finished round has failures ("Checks failed on PR #N." and the failing
 * checks); reviews post the review card (changes requested) or an "Approved · PR #N" pill.
 */
import {
  branchWriteKey,
  Check,
  type CheckState,
  checksState,
  type DiffStat,
  formatDuration,
  keyRefOf,
  newId,
  type ReviewState,
  randomIdBody,
  type StoredCard,
  shortSha,
} from '@whombat/core';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { publishPr } from '../commands/prs';
import type { ApplyContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Tx } from '../db/client';
import {
  conversations,
  githubBranchHeads,
  githubIssues,
  githubSeen,
  prChecks,
  prCommits,
  prFiles,
  prReviewers,
  pullRequests,
  repos,
} from '../db/schema/index';
import { prLink } from '../domain/links';
import { publishConversation } from '../domain/members';
import { postMessage } from '../domain/messages';
import { indexPullRequest } from '../domain/search-index';
import { notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { loadPrincipalRow, shortName } from '../read/principals';
import { isSystemPrincipal } from './actors';
import type { GhFile, GhReviewComment } from './adapter';
import { checksActivityLine, failedNames, prMention } from './checks-words';
import { recordMirroredMerge } from './merge-intents';

/* Helpers ---------------------------------------------------------------------------------------- */

async function repoByName(tx: Tx, burrowId: string, fullName: string) {
  const [repo] = await tx
    .select()
    .from(repos)
    .where(and(eq(repos.burrowId, burrowId), eq(repos.fullName, fullName)));
  return repo;
}

async function prByRepoNumber(tx: Tx, repoId: string, number: number) {
  const [pr] = await tx
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.number, number)));
  return pr;
}

async function openPrByNumber(tx: Tx, repoId: string, number: number) {
  const pr = await prByRepoNumber(tx, repoId, number);
  return pr?.state === 'open' ? pr : undefined;
}

async function openPrOnBranch(tx: Tx, repoId: string, branch: string) {
  const [pr] = await tx
    .select()
    .from(pullRequests)
    .where(
      and(eq(pullRequests.repoId, repoId), eq(pullRequests.branch, branch), eq(pullRequests.state, 'open')),
    );
  return pr;
}

const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/** Every check back to `queued`: a new head needs a new CI round (stale greens must not satisfy approvals). */
async function requeueChecks(tx: Tx, prId: string): Promise<void> {
  await tx
    .update(prChecks)
    .set({ state: 'queued', note: 'queued', durationMs: null, tests: null })
    .where(eq(prChecks.prId, prId));
}

async function upsertCommits(
  tx: Tx,
  prId: string,
  commits: readonly { sha: string; message: string; authorId: string | null; at: string }[],
): Promise<number> {
  if (commits.length === 0) return 0;
  const [{ max } = { max: -1 }] = await tx
    .select({ max: sql<number>`coalesce(max(${prCommits.position}), -1)::int` })
    .from(prCommits)
    .where(eq(prCommits.prId, prId));
  const inserted = await tx
    .insert(prCommits)
    .values(
      commits.map((c, i) => ({
        prId,
        sha: c.sha,
        message: c.message.slice(0, 500) || 'Commit',
        authorId: c.authorId,
        at: new Date(c.at),
        position: max + 1 + i,
      })),
    )
    .onConflictDoNothing()
    .returning({ sha: prCommits.sha });
  return inserted.length;
}

/** A PR's commits in GitHub's order (pushes may have recorded later commits first). */
async function orderCommits(tx: Tx, prId: string, commits: readonly { sha: string }[]): Promise<void> {
  for (const [position, c] of commits.entries())
    await tx
      .update(prCommits)
      .set({ position })
      .where(and(eq(prCommits.prId, prId), eq(prCommits.sha, c.sha)));
}

async function replaceFiles(tx: Tx, prId: string, files: readonly GhFile[]): Promise<void> {
  await tx.delete(prFiles).where(eq(prFiles.prId, prId));
  if (files.length)
    await tx
      .insert(prFiles)
      .values(
        files.slice(0, 500).map((f, position) => ({ prId, path: f.path, add: f.add, del: f.del, position })),
      );
}

async function addReviewers(tx: Tx, prId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const have = await tx.select().from(prReviewers).where(eq(prReviewers.prId, prId));
  const fresh = [...new Set(ids)].filter((id) => !have.some((h) => h.principalId === id));
  const max = have.reduce((m, h) => Math.max(m, h.position), -1);
  if (fresh.length)
    await tx.insert(prReviewers).values(
      fresh.map((principalId, i) => ({
        prId,
        principalId,
        state: 'pending' as const,
        position: max + 1 + i,
      })),
    );
  return fresh;
}

/** A branch room for a PR: slug = branch (suffixed when an older room holds it). */
async function createBranchRoom(
  ctx: ApplyContext,
  p: { repoId: string; number: number; branch: string; title: string; openedBy: string },
): Promise<string> {
  const taken = await ctx.tx
    .select({ slug: conversations.slug })
    .from(conversations)
    .where(and(eq(conversations.burrowId, ctx.burrow.id), eq(conversations.kind, 'branch')));
  const slugs = new Set(taken.map((t) => t.slug));
  let slug = p.branch;
  for (let i = 2; slugs.has(slug); i++) slug = `${p.branch}-${i}`;
  const id = newId('conversation');
  await ctx.tx.insert(conversations).values({
    id,
    burrowId: ctx.burrow.id,
    kind: 'branch',
    slug,
    title: p.branch,
    topic: `PR #${p.number} · ${p.title} · opened by ${p.openedBy}`.slice(0, 280),
    prNumber: p.number,
    repoId: p.repoId,
    createdAt: ctx.now,
  });
  return id;
}

async function nameOf(tx: Tx, id: string | null, fallback: string): Promise<string> {
  if (!id) return fallback;
  const row = await loadPrincipalRow(tx, id);
  return row ? shortName(row) : fallback;
}

function after(ctx: ApplyContext, prId: string) {
  const services = ctx.services;
  const tz = ctx.burrow.timeZone;
  const burrowId = ctx.burrow.id;
  ctx.after(() => indexPullRequest(services.db, prId, tz));
  ctx.after(() => services.approvals.reevaluate(burrowId));
}

const CommitInput = z.object({
  sha: z.string().min(4).max(64),
  message: z.string().max(2000),
  authorId: z.string().nullable(),
  at: z.string(),
});

const FileInput = z.object({ path: z.string(), add: z.number().int(), del: z.number().int() });

/* Pull requests ---------------------------------------------------------------------------------- */

export const mirrorPullRequest = defineCommand({
  name: 'github.sync_pr',
  schema: z.object({
    repo: z.string(),
    action: z.string(),
    pr: z.object({
      number: z.number().int().positive(),
      url: z.string().nullable(),
      title: z.string().min(1),
      state: z.enum(['open', 'closed']),
      merged: z.boolean(),
      mergedAt: z.string().nullable(),
      /** The branch as the burrow keys it: a fork's is `owner:ref` (`prBranch`). */
      headRef: z.string().min(1).max(255),
      headSha: z.string().min(4).max(64),
      baseRef: z.string(),
      createdAt: z.string().nullable(),
      additions: z.number().int().nullable(),
      deletions: z.number().int().nullable(),
      changedFiles: z.number().int().nullable(),
      /** A draft on GitHub (automation-recipes.md); absent from older callers: unchanged (new ones: not a draft). */
      draft: z.boolean().optional(),
      /** Opened by a bot account. */
      authorBot: z.boolean().optional(),
      /** Its description (cut to 8 KB here). */
      body: z.string().nullable().optional(),
      /** GitHub's `author_association` of whoever opened it (AR-27); absent from older callers: unchanged. */
      authorAssociation: z.string().max(40).nullable().optional(),
      /** Logins assigned to it; absent: unchanged. */
      assignees: z.array(z.string().max(100)).max(20).optional(),
    }),
    authorId: z.string().nullable(),
    /** Author's GitHub login for the room topic when they are not a principal. */
    authorLogin: z.string().nullable(),
    mergedById: z.string().nullable(),
    reviewerIds: z.array(z.string()).default([]),
    commits: z.array(CommitInput).nullable(),
    files: z.array(FileInput).nullable(),
  }),
  async apply(tx, ctx, input) {
    const repo = await repoByName(tx, ctx.burrow.id, input.repo);
    if (!repo) throw notFound(`Repo ${input.repo}`);
    const p = input.pr;
    const where = `${repo.fullName} · PR #${p.number}`;
    const ref = prLink(p.number, repo.fullName);
    const state = p.merged ? 'merged' : p.state;
    const diff =
      p.additions !== null && p.deletions !== null
        ? { add: p.additions, del: p.deletions, files: p.changedFiles ?? input.files?.length ?? 0 }
        : input.files
          ? {
              add: input.files.reduce((n, f) => n + f.add, 0),
              del: input.files.reduce((n, f) => n + f.del, 0),
              files: input.files.length,
            }
          : null;
    const existing = await prByRepoNumber(tx, repo.id, p.number);

    if (!existing) {
      if (state !== 'open') return { prId: null, created: false };
      const openedBy = input.authorId
        ? await nameOf(tx, input.authorId, 'GitHub')
        : (input.authorLogin ?? 'GitHub');
      const roomId = await createBranchRoom(ctx, {
        repoId: repo.id,
        number: p.number,
        branch: p.headRef,
        title: p.title,
        openedBy,
      });
      const prId = newId('pullRequest');
      await tx.insert(pullRequests).values({
        id: prId,
        burrowId: ctx.burrow.id,
        repoId: repo.id,
        number: p.number,
        branch: p.headRef,
        baseBranch: p.baseRef,
        title: p.title.slice(0, 256),
        state: 'open',
        headSha: p.headSha,
        authorId: input.authorId,
        diff: diff ?? { add: 0, del: 0, files: 0 },
        conversationId: roomId,
        openedAt: p.createdAt ? new Date(p.createdAt) : ctx.now,
        url: p.url,
        updatedAt: ctx.now,
        draft: p.draft ?? false,
        authorLogin: input.authorLogin,
        authorBot: p.authorBot ?? false,
        body: p.body ? p.body.slice(0, BODY_MAX) : null,
        authorAssociation: p.authorAssociation ?? null,
        assignees: p.assignees ?? [],
      });
      await addReviewers(tx, prId, input.reviewerIds);
      if (input.commits) await upsertCommits(tx, prId, input.commits);
      if (input.files) await replaceFiles(tx, prId, input.files);
      const room = await loadConversationRow(tx, roomId);
      if (!room) throw notFound('Branch room');
      const commits = (input.commits ?? []).slice(-20);
      const card: StoredCard | null = commits.length
        ? {
            kind: 'commits',
            prNumber: p.number,
            commits: commits.map((c) => ({ sha: c.sha, message: c.message.slice(0, 500) || 'Commit' })),
            diff: diff ?? { add: 0, del: 0, files: 0 },
            signedById: input.authorId ?? ctx.actor.id,
          }
        : null;
      await postMessage(ctx, {
        conversation: room,
        text: `Opened PR #${p.number} · ${p.title}.`.slice(0, 4000),
        card,
        dispatch: false,
      });
      const event = await ctx.emit({
        type: 'pr.opened',
        kind: 'Code',
        text: `Opened PR #${p.number} · ${p.title}`.slice(0, 500),
        where: repo.fullName,
        ref,
        payload: {
          prId,
          number: p.number,
          branch: p.headRef,
          base: p.baseRef,
          source: 'github',
          // As it was when it opened (automation-recipes.md): a trigger that leaves drafts out reads this.
          draft: p.draft ?? false,
          bot: p.authorBot ?? false,
        },
      });
      await publishConversation(ctx, roomId, event.id);
      await publishPr(ctx, prId, event.id);
      after(ctx, prId);
      return { prId, created: true };
    }

    // Update: title, head, base, url, diff, files, commits, reviewers, state, draft.
    const headMoved = !sameSha(existing.headSha, p.headSha);
    const draft = p.draft ?? existing.draft;
    // A draft marked ready for review: its own event, which `drafts: false` triggers start on (automation-recipes.md).
    const readied = existing.draft && !draft && state === 'open' && existing.state === 'open';
    const title = p.title.slice(0, 256);
    const newReviewers = await addReviewers(tx, existing.id, input.reviewerIds);
    const same = (a: DiffStat, b: DiffStat) => a.add === b.add && a.del === b.del && a.files === b.files;
    const unchanged =
      !headMoved &&
      !newReviewers.length &&
      !input.commits &&
      !input.files &&
      title === existing.title &&
      p.headRef === existing.branch &&
      p.baseRef === existing.baseBranch &&
      (p.url ?? existing.url) === existing.url &&
      (!diff || same(diff, existing.diff)) &&
      draft === existing.draft &&
      (state === existing.state || (state === 'closed' && existing.state === 'merged'));
    // Nothing GitHub said is new to the burrow: no event (a poll that changes nothing signs nothing).
    if (unchanged) return { prId: existing.id, created: false };
    await tx
      .update(pullRequests)
      .set({
        title,
        // A fork's PR mirrored before forks were told apart gets its `owner:ref` branch.
        branch: p.headRef,
        baseBranch: p.baseRef,
        headSha: headMoved ? p.headSha : existing.headSha,
        url: p.url ?? existing.url,
        ...(diff ? { diff } : {}),
        draft,
        // Mirrored before 0095: who opened it, and its description, from now on.
        ...(existing.authorLogin === null && input.authorLogin
          ? { authorLogin: input.authorLogin, authorBot: p.authorBot ?? false }
          : {}),
        ...(p.body !== undefined ? { body: p.body ? p.body.slice(0, BODY_MAX) : null } : {}),
        // Who opened it and who is assigned, as GitHub says now (AR-27): kept with any other change, never a change of
        // their own (a poll that only sees a new assignee signs nothing; the auto-fix gate reads GitHub itself).
        ...(p.authorAssociation !== undefined ? { authorAssociation: p.authorAssociation } : {}),
        ...(p.assignees !== undefined ? { assignees: p.assignees } : {}),
        updatedAt: ctx.now,
      })
      .where(eq(pullRequests.id, existing.id));
    if (headMoved) await requeueChecks(tx, existing.id);
    if (readied)
      await ctx.emit({
        type: 'pr.ready',
        kind: 'Code',
        text: `PR #${p.number} is ready for review`,
        where,
        ref,
        payload: { prId: existing.id, number: p.number, source: 'github' },
      });
    if (input.commits) {
      await upsertCommits(tx, existing.id, input.commits);
      await orderCommits(tx, existing.id, input.commits);
    }
    if (input.files) await replaceFiles(tx, existing.id, input.files);

    let eventId: string | null = null;
    if (state === 'merged' && existing.state !== 'merged') {
      eventId = await recordMirroredMerge(ctx, {
        prId: existing.id,
        number: p.number,
        repo: repo.fullName,
        headSha: p.headSha,
        baseBranch: p.baseRef,
      });
      if (!eventId) {
        const mergedById = input.mergedById ?? ctx.actor.id;
        await tx
          .update(pullRequests)
          .set({ state: 'merged', mergedAt: p.mergedAt ? new Date(p.mergedAt) : ctx.now, mergedById })
          .where(eq(pullRequests.id, existing.id));
        eventId = (
          await ctx.emit({
            type: 'pr.merged',
            kind: 'Code',
            text: `Merged PR #${p.number} into ${p.baseRef}`,
            where,
            ref,
            payload: { prId: existing.id, number: p.number, headSha: p.headSha, source: 'github' },
          })
        ).id;
      }
    } else if (state === 'closed' && existing.state === 'open') {
      await tx.update(pullRequests).set({ state: 'closed' }).where(eq(pullRequests.id, existing.id));
      eventId = (
        await ctx.emit({
          type: 'pr.closed',
          kind: 'Code',
          text: `Closed PR #${p.number}`,
          where,
          ref,
          payload: { prId: existing.id, number: p.number },
        })
      ).id;
    } else if (state === 'open' && existing.state !== 'open') {
      await tx
        .update(pullRequests)
        .set({ state: 'open', mergedAt: null, mergedById: null })
        .where(eq(pullRequests.id, existing.id));
      eventId = (
        await ctx.emit({
          type: 'pr.reopened',
          kind: 'Code',
          text: `Reopened PR #${p.number}`,
          where,
          ref,
          payload: { prId: existing.id, number: p.number },
        })
      ).id;
    } else if (newReviewers.length) {
      const names = await Promise.all(newReviewers.map((id) => nameOf(tx, id, 'someone')));
      eventId = (
        await ctx.emit({
          type: 'pr.review_requested',
          kind: 'Code',
          text: `Asked ${names.join(' and ')} to review PR #${p.number}`.slice(0, 500),
          where,
          ref,
          payload: { prId: existing.id, reviewerIds: newReviewers },
        })
      ).id;
    } else {
      eventId = (
        await ctx.emit({
          type: 'pr.updated',
          kind: 'Code',
          text: null,
          where,
          ref,
          payload: { prId: existing.id, action: input.action, headSha: p.headSha, headMoved },
        })
      ).id;
    }
    if (existing.title !== p.title) await publishConversation(ctx, existing.conversationId, eventId);
    await publishPr(ctx, existing.id, eventId);
    after(ctx, existing.id);
    return { prId: existing.id, created: false };
  },
});

/* Issues ----------------------------------------------------------------------------------------- */

/** What the mirror keeps of a description (an issue's, a pull request's). */
export const BODY_MAX = 8192;

/** A `github_issues` row's id: core has no id kind for it, so `newId`'s shape with its own prefix. */
function githubIssueId(): string {
  return `ghi_${randomIdBody(12)}`;
}

/**
 * A new issue on a watched repo (automation-recipes.md): stored once per burrow, repo and number, with its signed
 * `issue.opened` event — the event automations start on. Nothing is posted in a room. Polling again changes nothing.
 */
export const mirrorIssue = defineCommand({
  name: 'github.issue_opened',
  schema: z.object({
    repo: z.string(),
    issue: z.object({
      number: z.number().int().positive(),
      url: z.string().min(1),
      title: z.string().min(1),
      body: z.string().default(''),
      authorLogin: z.string().nullable(),
      bot: z.boolean().default(false),
      /** GitHub's `author_association` of whoever opened it (AR-27). */
      authorAssociation: z.string().max(40).nullable().default(null),
      /** Logins assigned to it. */
      assignees: z.array(z.string().max(100)).max(20).default([]),
      labels: z.array(z.string()).max(20).default([]),
      createdAt: z.string().nullable(),
    }),
  }),
  async apply(tx, ctx, input) {
    const repo = await repoByName(tx, ctx.burrow.id, input.repo);
    if (!repo) throw notFound(`Repo ${input.repo}`);
    const i = input.issue;
    const id = githubIssueId();
    const [stored] = await tx
      .insert(githubIssues)
      .values({
        id,
        burrowId: ctx.burrow.id,
        repo: repo.fullName,
        number: i.number,
        title: i.title.slice(0, 256),
        body: i.body.slice(0, BODY_MAX),
        authorLogin: i.authorLogin,
        authorBot: i.bot,
        authorAssociation: i.authorAssociation,
        assignees: i.assignees,
        url: i.url,
        labels: i.labels.map((l) => l.slice(0, 100)),
        state: 'open',
        openedAt: i.createdAt ? new Date(i.createdAt) : ctx.now,
        seenAt: ctx.now,
      })
      .onConflictDoNothing()
      .returning({ id: githubIssues.id });
    if (!stored) return { issueId: null, created: false };
    await ctx.emit({
      type: 'issue.opened',
      kind: 'Code',
      text: `Opened issue #${i.number} · ${i.title}`.slice(0, 500),
      where: repo.fullName,
      payload: { issueId: id, number: i.number, repo: repo.fullName, bot: i.bot, source: 'github' },
    });
    return { issueId: id, created: true };
  },
});

/* Pushes ----------------------------------------------------------------------------------------- */

export const mirrorPush = defineCommand({
  name: 'github.push',
  schema: z.object({
    repo: z.string(),
    branch: z.string(),
    before: z.string(),
    after: z.string().min(4).max(64),
    commits: z.array(CommitInput).max(100),
    /** The open PR whose head moved, when known: read by number (a fork's branch may be named like ours). */
    prNumber: z.number().int().positive().nullable().default(null),
    /** Post a commits card in the branch room (pushes not Whombat's; agents announce their own). */
    announce: z.boolean(),
    /** Whose commits they are, as git says ("Joris Visser and 2 others"): pushes signed by GitHub. */
    authoredBy: z.string().max(200).nullable().default(null),
  }),
  async apply(tx, ctx, input) {
    const repo = await repoByName(tx, ctx.burrow.id, input.repo);
    if (!repo) throw notFound(`Repo ${input.repo}`);
    const pr =
      input.prNumber !== null
        ? await openPrByNumber(tx, repo.id, input.prNumber)
        : await openPrOnBranch(tx, repo.id, input.branch);
    // Mirrored once: the head the burrow already has for this branch (its open PR's, else the last push).
    const [last] = await tx
      .select({ sha: githubBranchHeads.sha })
      .from(githubBranchHeads)
      .where(
        and(
          eq(githubBranchHeads.burrowId, ctx.burrow.id),
          eq(githubBranchHeads.repo, repo.fullName),
          eq(githubBranchHeads.branch, input.branch),
        ),
      );
    const current = pr?.headSha ?? last?.sha ?? null;
    if (current && sameSha(current, input.after))
      return { prNumber: pr?.number ?? null, moved: false, duplicate: true };
    await tx
      .insert(githubBranchHeads)
      .values({
        burrowId: ctx.burrow.id,
        repo: repo.fullName,
        branch: input.branch,
        sha: input.after,
        updatedAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: [githubBranchHeads.burrowId, githubBranchHeads.repo, githubBranchHeads.branch],
        set: { sha: input.after, updatedAt: ctx.now },
      });
    await tx.update(repos).set({ pushedAt: ctx.now }).where(eq(repos.id, repo.id));
    let moved = false;
    if (pr) {
      moved = !sameSha(pr.headSha, input.after);
      if (moved) {
        await tx
          .update(pullRequests)
          .set({ headSha: input.after, updatedAt: ctx.now })
          .where(eq(pullRequests.id, pr.id));
        await requeueChecks(tx, pr.id);
      }
      await upsertCommits(tx, pr.id, input.commits);
    }
    const onDefault = input.branch === repo.defaultBranch;
    // Only an agent's own push (its runner's push grant) used its branch key; GitHub's signer holds none.
    const keyUsed =
      ctx.actor.kind === 'agent' && !(await isSystemPrincipal(tx, ctx.actor.id))
        ? { keyUsed: keyRefOf(branchWriteKey(input.branch, repo.defaultBranch)) }
        : {};
    const event = await ctx.emit({
      type: 'branch.pushed',
      kind: 'Code',
      // Pushes to the default branch are merges (logged as "Merged PR #N"); every other push is logged.
      text: onDefault ? null : `Pushed ${shortSha(input.after)} to ${input.branch}`,
      where: pr ? `${repo.fullName} · PR #${pr.number}` : repo.fullName,
      ...(pr ? { ref: prLink(pr.number, repo.fullName) } : {}),
      ...keyUsed,
      payload: {
        repo: repo.fullName,
        branch: input.branch,
        sha: input.after,
        before: input.before,
        commits: input.commits.length,
        authors: input.authoredBy,
        prId: pr?.id ?? null,
        source: 'github',
      },
    });
    if (pr && input.announce && input.commits.length) {
      const room = await loadConversationRow(tx, pr.conversationId);
      const n = input.commits.length;
      if (room)
        await postMessage(ctx, {
          conversation: room,
          text: `Pushed ${n} ${n === 1 ? 'commit' : 'commits'}${input.authoredBy ? ` by ${input.authoredBy}` : ''} to ${input.branch}.`,
          card: {
            kind: 'commits',
            prNumber: pr.number,
            commits: input.commits
              .slice(-20)
              .map((c) => ({ sha: c.sha, message: c.message.slice(0, 500) || 'Commit' })),
            diff: pr.diff,
            signedById: ctx.actor.id,
          },
          dispatch: false,
        });
    }
    if (pr) {
      await publishPr(ctx, pr.id, event.id);
      after(ctx, pr.id);
    }
    return { prNumber: pr?.number ?? null, moved, duplicate: false };
  },
});

/* Checks ----------------------------------------------------------------------------------------- */

/** A check run as the side pane shows it: `lint 12s`, `unit · billing 38/41`, `pdf-snapshot queued`. */
export function checkFromRun(run: {
  name: string;
  status: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string | null;
  details_url?: string | null;
  output?: { title?: string | null | undefined; summary?: string | null | undefined } | undefined;
}): Check {
  let state: CheckState;
  if (run.status === 'completed') {
    const c = run.conclusion ?? 'success';
    state =
      c === 'success'
        ? 'passed'
        : c === 'neutral' || c === 'skipped'
          ? 'skipped'
          : c === 'stale'
            ? 'queued'
            : 'failed';
  } else
    state =
      run.status === 'queued' ||
      run.status === 'requested' ||
      run.status === 'waiting' ||
      run.status === 'pending'
        ? 'queued'
        : 'running';
  const m = /(\d+)\s*(?:of|\/)\s*(\d+)/.exec(`${run.output?.title ?? ''} ${run.output?.summary ?? ''}`);
  const tests = m ? { passed: Number(m[1]), total: Number(m[2]) } : null;
  const durationMs =
    run.status === 'completed' && run.started_at && run.completed_at
      ? Math.max(0, Date.parse(run.completed_at) - Date.parse(run.started_at))
      : null;
  const note =
    state === 'queued'
      ? 'queued'
      : state === 'running'
        ? 'running'
        : tests
          ? `${tests.passed}/${tests.total}`
          : state === 'skipped'
            ? 'skipped'
            : durationMs !== null
              ? formatDuration(durationMs)
              : state;
  return Check.parse({
    name: run.name.slice(0, 120),
    state,
    note: note.slice(0, 60),
    durationMs,
    tests,
    url: (run.html_url ?? run.details_url ?? null)?.slice(0, 2048) ?? null,
  });
}

const finished = (checks: readonly { state: CheckState }[]) =>
  checks.length > 0 &&
  checks.every((c) => c.state === 'passed' || c.state === 'failed' || c.state === 'skipped');

export const mirrorChecks = defineCommand({
  name: 'github.checks',
  schema: z.object({
    repo: z.string(),
    prNumber: z.number().int().positive(),
    headSha: z.string().min(4).max(64),
    /** One check run to upsert (by name). */
    check: Check.nullable(),
    /** A new CI round started (`check_suite` requested): every check back to queued. */
    newRound: z.boolean().default(false),
  }),
  async apply(tx, ctx, input) {
    const repo = await repoByName(tx, ctx.burrow.id, input.repo);
    if (!repo) throw notFound(`Repo ${input.repo}`);
    const pr = await prByRepoNumber(tx, repo.id, input.prNumber);
    if (!pr) throw notFound(`PR #${input.prNumber}`);
    let headSha = pr.headSha;
    if (!sameSha(pr.headSha, input.headSha)) {
      // A result for an older commit is stale; a commit we have not heard of yet is the new head.
      const [known] = await tx
        .select({ sha: prCommits.sha })
        .from(prCommits)
        .where(and(eq(prCommits.prId, pr.id), eq(prCommits.sha, input.headSha)));
      if (known) return { state: 'stale' as const };
      headSha = input.headSha;
      await tx.update(pullRequests).set({ headSha, updatedAt: ctx.now }).where(eq(pullRequests.id, pr.id));
      await requeueChecks(tx, pr.id);
    }
    const before = await tx.select().from(prChecks).where(eq(prChecks.prId, pr.id));
    const wasFinished = finished(before);
    const wasState = checksState(before);
    if (input.newRound) await requeueChecks(tx, pr.id);
    if (input.check) {
      const c = input.check;
      const existing = before.find((b) => b.name === c.name);
      if (existing)
        await tx
          .update(prChecks)
          .set({ state: c.state, note: c.note, durationMs: c.durationMs, tests: c.tests, url: c.url })
          .where(and(eq(prChecks.prId, pr.id), eq(prChecks.name, c.name)));
      else
        await tx.insert(prChecks).values({
          prId: pr.id,
          name: c.name,
          state: c.state,
          note: c.note,
          durationMs: c.durationMs,
          tests: c.tests,
          url: c.url,
          position: before.reduce((m, b) => Math.max(m, b.position), -1) + 1,
        });
    }
    const now = await tx.select().from(prChecks).where(eq(prChecks.prId, pr.id));
    const aggregate = checksState(now);
    const done = finished(now);
    const changed = done && (!wasFinished || wasState !== aggregate || input.newRound);
    const where = `${repo.fullName} · PR #${pr.number}`;
    const event = await ctx.emit({
      type: 'checks.completed',
      kind: 'Code',
      text: changed ? checksActivityLine(pr.number, now) : null,
      where,
      ref: prLink(pr.number, repo.fullName),
      payload: { prId: pr.id, headSha, state: aggregate, check: input.check?.name ?? null, source: 'github' },
    });
    if (changed && aggregate === 'failed') {
      // One plain line and the failing checks by name; counts and the commit are on the pull request.
      const room = await loadConversationRow(tx, pr.conversationId);
      if (room)
        await postMessage(ctx, {
          conversation: room,
          text: `Checks failed on ${prMention(pr.number, pr.url)}.`,
          card: { kind: 'pill', text: `${failedNames(now)} failed`.slice(0, 200), tone: 'warn' },
          dispatch: false,
        });
    }
    await publishPr(ctx, pr.id, event.id);
    after(ctx, pr.id);
    return { state: aggregate };
  },
});

/* Reviews ---------------------------------------------------------------------------------------- */

/** The last lines of a review comment's diff hunk as review-card diff lines. */
export function hunkLines(hunk: string, max = 6): { kind: 'context' | 'add' | 'del'; text: string }[] {
  const lines = hunk.split('\n').filter((l) => !l.startsWith('@@'));
  return lines.slice(-max).map((l) => ({
    kind: l.startsWith('+') ? ('add' as const) : l.startsWith('-') ? ('del' as const) : ('context' as const),
    text: l.slice(1).slice(0, 500),
  }));
}

export const mirrorReview = defineCommand({
  name: 'github.review',
  schema: z.object({
    repo: z.string(),
    prNumber: z.number().int().positive(),
    state: z.enum(['approved', 'changes_requested', 'commented']),
    body: z.string().max(20_000),
    comments: z.array(
      z.object({
        path: z.string(),
        line: z.number().int().nullable(),
        body: z.string(),
        diffHunk: z.string(),
      }),
    ),
    submittedAt: z.string().nullable(),
    /** GitHub's review id: a review is mirrored once. */
    reviewId: z.number().int().positive().nullable().default(null),
  }),
  async apply(tx, ctx, input) {
    const repo = await repoByName(tx, ctx.burrow.id, input.repo);
    if (!repo) throw notFound(`Repo ${input.repo}`);
    const pr = await prByRepoNumber(tx, repo.id, input.prNumber);
    if (!pr) throw notFound(`PR #${input.prNumber}`);
    if (input.reviewId !== null) {
      const fresh = await tx
        .insert(githubSeen)
        .values({
          burrowId: ctx.burrow.id,
          repo: repo.fullName,
          key: `review:${input.reviewId}`,
          seenAt: ctx.now,
        })
        .onConflictDoNothing()
        .returning({ key: githubSeen.key });
      if (!fresh.length) return { reviewState: input.state, duplicate: true };
    }
    const state: ReviewState = input.state;
    const at = input.submittedAt ? new Date(input.submittedAt) : ctx.now;
    const [{ max } = { max: -1 }] = await tx
      .select({ max: sql<number>`coalesce(max(${prReviewers.position}), -1)::int` })
      .from(prReviewers)
      .where(eq(prReviewers.prId, pr.id));
    await tx
      .insert(prReviewers)
      .values({ prId: pr.id, principalId: ctx.actor.id, state, at, position: max + 1 })
      .onConflictDoUpdate({ target: [prReviewers.prId, prReviewers.principalId], set: { state, at } });
    const n = Math.max(1, input.comments.length);
    const text =
      state === 'approved'
        ? `Approved PR #${pr.number}`
        : state === 'changes_requested'
          ? `Requested ${n} ${n === 1 ? 'change' : 'changes'} on PR #${pr.number}`
          : `Commented on PR #${pr.number}`;
    const event = await ctx.emit({
      type:
        state === 'approved'
          ? 'pr.approved'
          : state === 'changes_requested'
            ? 'pr.changes_requested'
            : 'pr.commented',
      kind: 'Code',
      text,
      where: `${repo.fullName} · PR #${pr.number}`,
      ref: prLink(pr.number, repo.fullName),
      payload: { prId: pr.id, decision: state, comments: input.comments.length, source: 'github' },
    });
    const room = await loadConversationRow(tx, pr.conversationId);
    const body = input.body.trim();
    if (room) {
      const first = input.comments[0] as GhReviewComment | undefined;
      let card: StoredCard | null = null;
      if (first)
        card = {
          kind: 'review',
          prNumber: pr.number,
          file: first.path.slice(0, 500) || 'file',
          line: first.line && first.line > 0 ? first.line : null,
          changesRequested: state === 'changes_requested' ? input.comments.length : 0,
          diff: hunkLines(first.diffHunk),
          comments: input.comments
            .slice(0, 20)
            .map((c, i) => ({ n: i + 1, text: c.body.slice(0, 2000) || '…' })),
        };
      else if (state === 'approved') card = { kind: 'pill', text: `Approved · PR #${pr.number}`, tone: 'ok' };
      const messageText =
        body ||
        (state === 'approved'
          ? 'Approved.'
          : state === 'changes_requested'
            ? `${text}.`
            : card
              ? 'Left comments.'
              : '');
      if (messageText || card)
        await postMessage(ctx, {
          conversation: room,
          text: messageText.slice(0, 8000),
          card,
          dispatch: false,
        });
    }
    await publishPr(ctx, pr.id, event.id);
    after(ctx, pr.id);
    return { reviewState: state, duplicate: false };
  },
});
