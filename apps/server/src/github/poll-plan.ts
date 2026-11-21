/**
 * What the poller has to mirror, worked out from GitHub's answers and what the burrow already has
 * (docs/decisions/github-gh.md, "Polling"). Pure: the same inputs give the same plan, and a plan applied
 * to the burrow gives an empty plan the next time — that is what makes repeated polls and restarts safe.
 */
import type { Check } from '@whombat/core';
import {
  type GhCheckRun,
  type GhCommit,
  type GhPullRequest,
  type GhReview,
  type GhWorkflowRun,
  prBranch,
} from './adapter';
import { checkFromRun } from './mirror';

/** A PR as the burrow has it. */
export interface KnownPr {
  number: number;
  state: 'open' | 'merged' | 'closed';
  headSha: string;
  title: string;
  /** Its branch as the burrow keys it (`prBranch`: a fork's is `owner:ref`). */
  branch: string;
  baseBranch: string;
  /** Lowercase GitHub logins of its reviewers (those linked to a principal). */
  reviewerLogins: readonly string[];
  /** Opened in Whombat while the repo was not connected: GitHub has no such PR (its number may be another's). */
  localOnly: boolean;
  /** How many of its commits the burrow has (none: a PR Whombat opened on GitHub itself). */
  commits: number;
  /** A draft as the burrow last saw it (absent: not a draft). */
  draft?: boolean;
}

export interface PullsPlan {
  /** Open on GitHub, unknown here and active since the poller started watching (minus the lookback). */
  opened: GhPullRequest[];
  /** More were due to open than one poll opens: read the list again next time. */
  truncated: boolean;
  /** Open here and on GitHub with another head: a push (then the PR's commits and files). */
  headMoved: { pr: GhPullRequest; before: string }[];
  /** Open here and on GitHub, same head, but a new title or base, reviewers asked for, or marked ready (or draft). */
  edited: GhPullRequest[];
  /**
   * Open here and on GitHub, same head, but the burrow has none of its commits (a PR Whombat opened on
   * GitHub: the agent pushed, opened it and stopped): read its commits and files.
   */
  refresh: GhPullRequest[];
  /** On GitHub with the number of a PR only Whombat has: not mirrored (the number is taken here). */
  collisions: number[];
  /** Closed here (not merged), open on GitHub. */
  reopened: GhPullRequest[];
  /** Open here, not in GitHub's list of open PRs: read it (merged or closed). */
  vanished: number[];
}

/** Pull requests the list can hold before "not in the list" stops meaning "closed" (10 pages of 100). */
export const MAX_OPEN_PRS = 1000;

export const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

const activity = (pr: GhPullRequest) => Date.parse(pr.updatedAt ?? pr.createdAt ?? '') || 0;

export function planPulls(
  known: readonly KnownPr[],
  open: readonly GhPullRequest[],
  opts: {
    since: number;
    maxOpened: number;
    /**
     * Lowercase logins linked to a principal of the burrow. Only they can become reviewers here, so a review
     * asked of anyone else is no change to mirror (it would be asked again on every read).
     */
    linkedLogins: ReadonlySet<string>;
  },
): PullsPlan {
  const byNumber = new Map(known.map((k) => [k.number, k]));
  const due: GhPullRequest[] = [];
  const plan: PullsPlan = {
    opened: [],
    truncated: false,
    headMoved: [],
    edited: [],
    refresh: [],
    collisions: [],
    reopened: [],
    vanished: [],
  };
  for (const pr of open) {
    const k = byNumber.get(pr.number);
    if (k?.localOnly) {
      plan.collisions.push(pr.number);
      continue;
    }
    if (!k) {
      if (activity(pr) >= opts.since) due.push(pr);
      continue;
    }
    if (k.state === 'closed') {
      plan.reopened.push(pr);
      continue;
    }
    if (k.state !== 'open') continue; // merged stays merged
    if (!sameSha(k.headSha, pr.headSha)) {
      plan.headMoved.push({ pr, before: k.headSha });
      continue;
    }
    const reviewers = new Set(k.reviewerLogins.map((l) => l.toLowerCase()));
    const asked = pr.requestedReviewers.some(
      (l) => opts.linkedLogins.has(l.toLowerCase()) && !reviewers.has(l.toLowerCase()),
    );
    // A refresh is an update too (title, base and reviewers come with it).
    if (k.commits === 0) plan.refresh.push(pr);
    else if (
      pr.title !== k.title ||
      pr.baseRef !== k.baseBranch ||
      prBranch(pr) !== k.branch ||
      asked ||
      pr.draft !== (k.draft ?? false)
    )
      plan.edited.push(pr);
  }
  due.sort((a, b) => a.number - b.number);
  plan.opened = due.slice(0, opts.maxOpened);
  plan.truncated = due.length > opts.maxOpened;
  if (open.length < MAX_OPEN_PRS) {
    const listed = new Set(open.map((p) => p.number));
    plan.vanished = known
      .filter((k) => k.state === 'open' && !k.localOnly && !listed.has(k.number))
      .map((k) => k.number)
      .sort((a, b) => a - b);
  }
  return plan;
}

/** A check as the burrow stores it. */
export type KnownCheck = Pick<Check, 'name' | 'state' | 'note' | 'durationMs' | 'tests' | 'url'>;

const sameCheck = (a: KnownCheck, b: KnownCheck) =>
  a.state === b.state &&
  a.note === b.note &&
  (a.durationMs ?? null) === (b.durationMs ?? null) &&
  (a.url ?? null) === (b.url ?? null) &&
  (a.tests?.passed ?? null) === (b.tests?.passed ?? null) &&
  (a.tests?.total ?? null) === (b.tests?.total ?? null);

/** The check runs on a PR's head that differ from the burrow's checks (latest run per name, oldest first). */
export function checksToMirror(
  known: readonly KnownCheck[],
  runs: readonly GhCheckRun[],
): { check: Check; headSha: string }[] {
  const latest = new Map<string, GhCheckRun>();
  for (const run of [...runs].sort((a, b) => a.id - b.id)) latest.set(run.name, run);
  const out: { check: Check; headSha: string }[] = [];
  for (const run of latest.values()) {
    const check = checkFromRun({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      started_at: run.startedAt,
      completed_at: run.completedAt,
      html_url: run.url,
      output: { title: run.outputTitle, summary: run.outputSummary },
    });
    const have = known.find((k) => k.name === check.name);
    if (!have || !sameCheck(have, check)) out.push({ check, headSha: run.headSha });
  }
  return out;
}

/** A check that has its result: a round is finished when every check of the head has one. */
export const checkDone = (c: Pick<KnownCheck, 'state'>) =>
  c.state === 'passed' || c.state === 'failed' || c.state === 'skipped';

/**
 * Whether a pull request's finished checks are due to be handled now (docs/decisions/health-checks-wake.md HW-01,
 * HW-03): its head has checks and every one has its result, nothing about them changed in this poll (a job that needs
 * another shows up seconds after it, so a round counts as finished once a later poll finds it unchanged), and this head
 * wasn't handled yet.
 */
export function checksDue(
  pr: { headSha: string; checksHandledSha: string | null },
  checks: readonly Pick<KnownCheck, 'state'>[],
  changedNow: boolean,
): boolean {
  if (changedNow || checks.length === 0 || !checks.every(checkDone)) return false;
  return !(pr.checksHandledSha && sameSha(pr.checksHandledSha, pr.headSha));
}

/**
 * A head GitHub answers no check runs for (docs/decisions/polling.md PL-02), as the poller remembers it next to the
 * head's ETag: since when the answers were empty, and when it last asked.
 */
export interface NoChecks {
  since: number;
  checkedAt: number;
}

/** An empty answer must stay empty this long before its head counts as one without checks (CI may start late). */
export const NO_CHECKS_SETTLE_MS = 60_000;

/** `<since>/<checkedAt>` in the poll cursor (`checks:<n>:<sha>:none`). */
export const formatNoChecks = (n: NoChecks) => `${n.since}/${n.checkedAt}`;

export function parseNoChecks(value: string | undefined): NoChecks | null {
  const m = value?.match(/^(\d+)\/(\d+)$/);
  return m ? { since: Number(m[1]), checkedAt: Number(m[2]) } : null;
}

/**
 * Whether a head's check runs are read in this poll (PL-02): always, unless the head was handled as one without
 * checks; then on the idle cadence's rhythm (`recheckMs`) and on the refresh without ETags, so checks that start late
 * on it are still seen.
 */
export function readChecksNow(p: {
  handled: boolean;
  none: NoChecks | null;
  now: number;
  recheckMs: number;
  refresh: boolean;
}): boolean {
  if (!p.handled || !p.none || p.refresh) return true;
  return p.now - p.none.checkedAt >= p.recheckMs;
}

/**
 * What GitHub's answer for a head's check runs means for its handled mark (PL-02; HW-03's `checks_handled_sha`).
 * `answer`: `runs` (a 200 with runs), `empty` (a 200 without any), `unchanged` (a 304: as the last answer).
 *
 * - An empty answer is remembered (`none`); when a later poll still finds none, at least `NO_CHECKS_SETTLE_MS` after
 *   the first, the head is marked handled (`mark`): it isn't due for checks any more, isn't “checks to come” for a run
 *   (HW-06), and doesn't keep its repo on the fast cadence.
 * - Runs that appear on a head handled that way lift the mark (`unmark`), so their round wakes the agent when it
 *   finishes (HW-01) — unlike a re-run on a head handled after a finished round, which wakes nobody (HW-03).
 */
export function noChecksAfter(p: {
  answer: 'runs' | 'empty' | 'unchanged';
  none: NoChecks | null;
  handled: boolean;
  now: number;
}): { none: NoChecks | null; mark: boolean; unmark: boolean } {
  if (p.answer === 'runs') return { none: null, mark: false, unmark: p.handled && p.none !== null };
  if (p.answer === 'unchanged' && !p.none) return { none: null, mark: false, unmark: false };
  const since = p.none?.since ?? p.now;
  const settled = p.none !== null && p.now - since >= NO_CHECKS_SETTLE_MS;
  return { none: { since, checkedAt: p.now }, mark: !p.handled && settled, unmark: false };
}

const MIRRORED_REVIEWS = new Set(['approved', 'changes_requested', 'commented']);

/**
 * Reviews not mirrored yet, oldest first. Those submitted before `historyBefore` (reviews on a PR the burrow
 * already had when the poller started watching) are history: marked seen, not posted again.
 */
export function reviewsToMirror(
  reviews: readonly GhReview[],
  seen: ReadonlySet<number>,
  historyBefore: number | null,
): { mirror: GhReview[]; history: GhReview[] } {
  const fresh = reviews
    .filter((r) => MIRRORED_REVIEWS.has(r.state) && !seen.has(r.id))
    .sort(
      (a, b) =>
        (Date.parse(a.submittedAt ?? '') || 0) - (Date.parse(b.submittedAt ?? '') || 0) || a.id - b.id,
    );
  const old = (r: GhReview) =>
    historyBefore !== null && (Date.parse(r.submittedAt ?? '') || 0) < historyBefore;
  return { mirror: fresh.filter((r) => !old(r)), history: fresh.filter(old) };
}

/** The commits a push brought: those after `before` in the PR's commits (all of them after a force push). */
export function pushCommits(commits: readonly GhCommit[], before: string): GhCommit[] {
  const at = commits.findIndex((c) => sameSha(c.sha, before));
  return (at >= 0 ? commits.slice(at + 1) : [...commits]).slice(-100);
}

/** Workflow runs that may belong to open deploys: started after the earliest dispatch (a minute of skew), oldest first. */
export function deployRuns(runs: readonly GhWorkflowRun[], dispatchedAt: readonly Date[]): GhWorkflowRun[] {
  if (!dispatchedAt.length) return [];
  const from = Math.min(...dispatchedAt.map((d) => d.getTime())) - 60_000;
  return runs
    .filter((r) => (Date.parse(r.createdAt ?? '') || 0) >= from)
    .sort((a, b) => (Date.parse(a.createdAt ?? '') || 0) - (Date.parse(b.createdAt ?? '') || 0));
}
