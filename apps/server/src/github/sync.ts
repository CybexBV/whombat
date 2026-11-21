/**
 * Applies what the poller found on GitHub to a burrow: the normalized changes (a PR opened / updated / closed,
 * a push, a check, a review) become the mirror's commands (github/mirror.ts), each signed by the GitHub-side
 * actor (github/actors.ts). The same commands the webhook receiver used to feed, so branch rooms, commits
 * cards, checks, review cards and approval re-evaluation are unchanged.
 */

import type { Check } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { CommandDef } from '../commit/types';
import { pullRequests, repos } from '../db/schema/index';
import type { Services } from '../services';
import {
  actorForLogin,
  canSign,
  ciReporter,
  type GhActor,
  principalForEmail,
  principalForLogin,
  pushGrantForSha,
  systemActor,
} from './actors';
import {
  firstLine,
  type GhCommit,
  type GhFile,
  type GhIssue,
  type GhPullRequest,
  type GhReview,
  type GhReviewComment,
  prBranch,
} from './adapter';
import { type ChecksWake, mirrorChecksFinished } from './checks-wake';
import { BODY_MAX, mirrorChecks, mirrorIssue, mirrorPullRequest, mirrorPush, mirrorReview } from './mirror';

export type PrAction = 'opened' | 'synchronize' | 'edited' | 'review_requested' | 'reopened' | 'closed';

/**
 * Whose commits a push brought, as git says (free text, shown, never signed as): "Joris Visser", "Joris
 * Visser and Mara Okafor", "Joris Visser and 2 others". Null when no commit says.
 */
export function authorsText(commits: readonly GhCommit[]): string | null {
  const names: string[] = [];
  for (const c of commits) {
    const name = (c.authorName || c.authorLogin || c.authorEmail || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    if (name && !names.includes(name)) names.push(name);
  }
  const [first, second] = names;
  if (!first) return null;
  if (!second) return first;
  return names.length === 2 ? `${first} and ${second}` : `${first} and ${names.length - 1} others`;
}

export class GitHubSync {
  constructor(
    private readonly services: Services,
    /** The gh login everything Whombat does on GitHub happens as (null when unknown). */
    private readonly connectionLogin: () => Promise<string | null>,
  ) {}

  private async commitAs<S extends z.ZodType, R>(
    burrowId: string,
    signer: GhActor,
    command: CommandDef<S, R>,
    input: z.input<S>,
  ): Promise<R> {
    // A retired agent or a former member signs nothing any more: GitHub does (EP-20).
    const actor =
      signer.via === 'system' || (await canSign(this.services.db, signer.principalId))
        ? signer
        : await systemActor(this.services, burrowId);
    const res = await this.services.pipeline.commit(command, input, {
      burrowId,
      actorId: actor.principalId,
      ...(actor.onBehalfOf ? { onBehalfOf: actor.onBehalfOf } : {}),
    });
    if (res.status !== 'ok') throw new Error(`${command.name}: ${res.status} (${res.message})`);
    return res.result;
  }

  private async prRow(burrowId: string, repo: string, number: number) {
    const [row] = await this.services.db
      .select({ pr: pullRequests })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(eq(pullRequests.burrowId, burrowId), eq(repos.fullName, repo), eq(pullRequests.number, number)),
      );
    return row?.pr;
  }

  /** Commit authors → principals, for showing whose each commit is (never who signs). */
  private async commitInputs(burrowId: string, commits: readonly GhCommit[]) {
    const db = this.services.db;
    const out = [];
    for (const c of commits) {
      const authorId =
        (await principalForEmail(db, burrowId, c.authorEmail)) ??
        (await principalForLogin(db, burrowId, c.authorLogin));
      out.push({ sha: c.sha, message: firstLine(c.message), authorId, at: c.at });
    }
    return out;
  }

  /**
   * Who opened a PR. The host account opens PRs for agents too (Whombat records those itself), so a PR by
   * that account we don't know is the agent Whombat pushed its head for (a push grant for that commit),
   * else the person the account is linked to. Commit authors never decide it.
   */
  private async authorOf(burrowId: string, repo: string, pr: GhPullRequest) {
    const db = this.services.db;
    const conn = (await this.connectionLogin())?.toLowerCase() ?? null;
    if (pr.author && conn && pr.author.toLowerCase() === conn && !pr.fork) {
      const grant = await pushGrantForSha(db, burrowId, repo, pr.headRef, pr.headSha, this.services.clock());
      if (grant) return grant.agentId;
    }
    return principalForLogin(db, burrowId, pr.author);
  }

  /** A pull request opened, updated, reopened or closed on GitHub. */
  async pullRequest(
    burrowId: string,
    repo: string,
    action: PrAction,
    pr: GhPullRequest,
    extra: {
      commits?: GhCommit[] | null;
      files?: GhFile[] | null;
      closedBy?: string | null;
      /** Who pushed, for the update that follows a push. */
      actor?: GhActor;
    } = {},
  ): Promise<void> {
    const db = this.services.db;
    const existing = await this.prRow(burrowId, repo, pr.number);
    const commits = extra.commits ?? null;
    const authorId = existing?.authorId ?? (await this.authorOf(burrowId, repo, pr));
    const reviewerIds: string[] = [];
    for (const login of pr.requestedReviewers) {
      const id = await principalForLogin(db, burrowId, login);
      if (id && !reviewerIds.includes(id)) reviewerIds.push(id);
    }
    let actor: GhActor | null = extra.actor ?? null;
    if (!actor && action === 'opened' && authorId) actor = { principalId: authorId, via: 'identity' };
    if (!actor && action === 'closed') {
      const by = pr.merged ? pr.mergedBy : (extra.closedBy ?? null);
      const id = await principalForLogin(db, burrowId, by);
      if (id) actor = { principalId: id, via: 'identity' };
    }
    actor ??= await systemActor(this.services, burrowId);
    const mergedById = pr.merged
      ? ((await principalForLogin(db, burrowId, pr.mergedBy)) ?? existing?.mergedById ?? null)
      : null;
    await this.commitAs(burrowId, actor, mirrorPullRequest, {
      repo,
      action,
      pr: {
        number: pr.number,
        url: pr.url,
        title: pr.title,
        state: pr.state,
        merged: pr.merged,
        mergedAt: pr.mergedAt,
        headRef: prBranch(pr),
        headSha: pr.headSha,
        baseRef: pr.baseRef,
        createdAt: pr.createdAt,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
        draft: pr.draft,
        authorBot: pr.authorBot,
        body: pr.body,
        authorAssociation: pr.authorAssociation,
        assignees: pr.assignees.slice(0, 20),
      },
      authorId,
      authorLogin: pr.author,
      mergedById,
      reviewerIds,
      commits: commits ? await this.commitInputs(burrowId, commits) : null,
      files: extra.files ?? null,
    });
  }

  /**
   * A branch moved. Every push reaches GitHub as the host account and GitHub does not say who pushed, so a
   * push is the agent's only when Whombat pushed exactly that commit for it (a live push grant with that
   * sha; never a fork's), ON BEHALF OF whoever it worked for. Any other push is signed by GitHub, with
   * whose commits they are as text: a commit's author is free text anyone can write. Returns the signer.
   */
  async push(
    burrowId: string,
    repo: string,
    p: {
      branch: string;
      before: string;
      after: string;
      commits: readonly GhCommit[];
      /** The open PR whose head moved (read by number). */
      prNumber?: number | null;
      /** The push went to a fork's branch: never Whombat's. */
      fork?: boolean;
    },
  ): Promise<GhActor> {
    const found = p.fork
      ? null
      : await pushGrantForSha(this.services.db, burrowId, repo, p.branch, p.after, this.services.clock());
    // A push a retired agent made just before it retired is GitHub's, with a commits card (EP-20).
    const grant = found && (await canSign(this.services.db, found.agentId)) ? found : null;
    const actor: GhActor = grant
      ? { principalId: grant.agentId, via: 'grant', onBehalfOf: grant.onBehalfOf ?? {} }
      : await systemActor(this.services, burrowId);
    await this.commitAs(burrowId, actor, mirrorPush, {
      repo,
      branch: p.branch,
      before: p.before,
      after: p.after,
      prNumber: p.prNumber ?? null,
      commits: (await this.commitInputs(burrowId, p.commits)).slice(-100),
      // Agents announce their own pushes (Dusty: "Pushed 7be20f. …"); other pushes get a commits card.
      announce: !grant,
      authoredBy: grant ? null : authorsText(p.commits),
    });
    return actor;
  }

  /**
   * A new issue on a repo an automation listens to (automation-recipes.md): stored with its `issue.opened` event,
   * signed by whoever opened it when their login is linked, else by GitHub. Returns whether it was new.
   */
  async issue(burrowId: string, repo: string, issue: GhIssue): Promise<boolean> {
    const actor = await actorForLogin(this.services, burrowId, issue.author);
    const res = await this.commitAs(burrowId, actor, mirrorIssue, {
      repo,
      issue: {
        number: issue.number,
        url: issue.url,
        title: issue.title || `Issue #${issue.number}`,
        body: (issue.body ?? '').slice(0, BODY_MAX),
        authorLogin: issue.author,
        bot: issue.authorBot,
        authorAssociation: issue.authorAssociation,
        assignees: issue.assignees.slice(0, 20),
        labels: issue.labels.slice(0, 20),
        createdAt: issue.createdAt,
      },
    });
    return res.created;
  }

  /** A check on a PR's head changed; reported by the burrow's CI agent. */
  async check(
    burrowId: string,
    repo: string,
    prNumber: number,
    headSha: string,
    check: Check,
  ): Promise<void> {
    const reporter = await ciReporter(this.services.db, burrowId);
    const actor: GhActor = reporter
      ? { principalId: reporter, via: 'ci' }
      : await systemActor(this.services, burrowId);
    await this.commitAs(burrowId, actor, mirrorChecks, { repo, prNumber, headSha, check });
  }

  /**
   * Every check on a PR's head has its result, unchanged since the last poll: the agent whose work the PR is hears it,
   * from GitHub (docs/decisions/health-checks-wake.md HW-01), once per head.
   */
  async checksFinished(
    burrowId: string,
    repo: string,
    prNumber: number,
    headSha: string,
  ): Promise<ChecksWake> {
    const actor = await systemActor(this.services, burrowId);
    return this.commitAs(burrowId, actor, mirrorChecksFinished, { repo, prNumber, headSha });
  }

  /** A review submitted on GitHub; unknown reviewers are signed by GitHub, which says who it was. */
  async review(
    burrowId: string,
    repo: string,
    prNumber: number,
    review: GhReview,
    comments: GhReviewComment[],
  ): Promise<void> {
    const state = review.state as 'approved' | 'changes_requested' | 'commented';
    const actor = await actorForLogin(this.services, burrowId, review.author);
    const login = review.author ?? 'someone';
    const body = review.body.trim();
    await this.commitAs(burrowId, actor, mirrorReview, {
      repo,
      prNumber,
      state,
      body: actor.via === 'system' ? `${login} on GitHub${body ? `: ${body}` : '.'}` : body,
      comments,
      submittedAt: review.submittedAt,
      reviewId: review.id,
    });
  }
}
