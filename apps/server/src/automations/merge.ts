/**
 * An automation merges its fix once its checks pass (docs/decisions/automation-recipes.md AR-44…AR-47): the
 * `merge_pull_request` step. Its pull request is the one a template names (a recipe's `{{steps.pr.prNumber}}`); its key
 * is the automation's “Merge into main” (`merge.main`, into the repository's default branch) else “Merge” (`merge`),
 * within what its publisher may do. Allowed (or a person said yes), it waits for the pull request's checks as the mirror
 * knows them (`mergeReadiness`), then merges as the automation under merge_pr's own rules (commands/prs.ts). Anything
 * that means a person should look — closed, changed after the run's review, changes requested, failed checks, checks
 * that don't finish in time — fails the step with one plain line, and the pull request stays as it is. Checks that fail
 * in GitHub Actions are first run once more (AR-57): a flaky test doesn't need a person, a real failure fails twice; a
 * repository set to `infrastructure` re-runs only jobs whose runner or setup failed (merge-rerun.ts).
 *
 * The step keeps what it needs on its row (`output`, `MergeOutput`): no table of its own.
 */
import {
  type AutomationDefinition,
  type AutomationStep,
  type AutomationVerdict,
  type Check,
  checksState,
  type JsonObject,
  renderTemplate,
} from '@whombat/core';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { type MergeTarget, mergeKeyOf } from '../commands/prs';
import type { Db } from '../db/client';
import { prChecks, pullRequests, repos } from '../db/schema/index';
import { checkDone, sameSha } from '../github/poll-plan';
import type { AutomationRunRow, AutomationStepRow } from './store';
import { rowWorkspace } from './workspace';

export type MergeStep = Extract<AutomationStep, { kind: 'merge_pull_request' }>;

/** A pull request without checks may still get them this long after it opened: CI needs a moment to register. */
export const MERGE_CHECKS_GRACE_MS = 10 * 60_000;

/**
 * How long a merge waits for a check its repository runs on its merges that hasn't reported at all, once the others
 * passed (TA-58): a check that still runs has the step's whole wait, one that never shows doesn't.
 */
export const MERGE_MISSING_CHECKS_MS = 3 * 60 * 60_000;

/**
 * How long after asking GitHub to run failed checks again the step waits for the mirror to show them again (AR-57); a
 * re-run GitHub never started leaves it for a person after that.
 */
export const MERGE_RERUN_SEEN_MS = 10 * 60_000;

/** At most this many failed checks are run once more; more fail the step at once (AR-57). */
export const MERGE_RERUN_MAX_CHECKS = 100;

/** Why a merge step was skipped: its pull request number rendered to nothing (no pull request was opened). */
export const NOTHING_TO_MERGE = 'Nothing to merge: no pull request was opened.';

/**
 * What the step says, in the run's thread and on its run page: one short line each, no hashes or ids (CLAUDE.md, “talk
 * like people”). The input summary (`MERGE_SUMMARIES`) says where it stands — “Waiting for checks on PR #10” while it
 * waits, then what it found —, the output text or the error what came of it.
 */
export const MERGE_WORDS = {
  waiting: (n: number) => `Waiting for checks on PR #${n}`,
  asked: (n: number, base: string, request: number) =>
    `Asked to merge PR #${n} into ${base} (request #${request})`,
  merged: (n: number, base: string) => `Merged PR #${n} into ${base}.`,
  alreadyMerged: (n: number) => `PR #${n} was already merged.`,
  isMerged: (n: number, base: string) => `PR #${n} is merged into ${base}.`,
  closed: (n: number) => `PR #${n} was closed, so there was nothing to merge.`,
  changed: (n: number) => `PR #${n} changed after the review, so I left it for you.`,
  reviewAskedChanges: (n: number) => `The review asked for changes, so I left PR #${n} for you.`,
  changesRequested: (n: number) => `Someone asked for changes on PR #${n}, so I left it for you.`,
  checksFailed: (n: number) => `Checks failed on PR #${n}, so I left it for you.`,
  checksFailedAgain: (n: number) => `Checks failed again on PR #${n}, so I left it for you.`,
  timedOut: (n: number) => `Checks on PR #${n} didn’t finish in time, so I left it for you.`,
  missing: (n: number, names: readonly string[]) =>
    `${names.join(', ')} never reported on PR #${n}, so I left it for you.`.slice(0, 400),
  noChecks: (n: number) => `No checks ran on PR #${n}, so I left it for you.`,
  needsReview: (n: number) => `PR #${n} needs an approving review first, so I left it for you.`,
  unknown: (n: number, repo: string) => `Whombat doesn’t know PR #${n} in ${repo}, so I left it for you.`,
  refused: (n: number, reason: string) => `GitHub wouldn’t merge PR #${n}: ${reason}`,
  failed: (n: number, reason: string) => `I couldn’t merge PR #${n}: ${reason}`,
  noAnswer: (n: number) =>
    `GitHub didn’t answer, so PR #${n} may or may not be merged. Check it on GitHub, then say what happened.`,
  declined: (name: string, n: number) => `${name} said no to merging PR #${n}.`,
  mayNot: (base: string, repo: string, key: string) =>
    `It may not merge into ${base} in ${repo}: it doesn’t hold “${key}” for it.`,
  mayNoLonger: (base: string, repo: string) => `It may no longer merge into ${base} in ${repo}.`,
  notOn: (repo: string) => `${repo} isn’t switched on, so it can’t merge there.`,
} as const;

/** A merge step's input summary once it stopped waiting for the checks: what it found (the app shows it, AR-46). */
export const MERGE_SUMMARIES = {
  passed: (n: number) => `Checks passed on PR #${n}`,
  none: (n: number) => `No checks on PR #${n}`,
  failed: (n: number) => `Checks failed on PR #${n}`,
  rerun: (n: number) => `Running the failed checks on PR #${n} once more`,
  failedAgain: (n: number) => `Checks failed again on PR #${n}`,
  timedOut: (n: number) => `Checks on PR #${n} didn’t finish in time`,
  missing: (n: number) => `Some checks never reported on PR #${n}`,
  noChecks: (n: number) => `No checks ran on PR #${n}`,
  merged: (n: number) => `PR #${n} was already merged`,
  closed: (n: number) => `PR #${n} was closed`,
  changed: (n: number) => `PR #${n} changed after the review`,
  reviewAskedChanges: (n: number) => `The review asked for changes on PR #${n}`,
  changesRequested: (n: number) => `Changes requested on PR #${n}`,
  noReview: (n: number) => `No approving review on PR #${n}`,
  unknown: (n: number) => `PR #${n} not found`,
} as const;

/**
 * Why a merge step failed, kept on its row (`output.cause`) so what comes next reads it from there, never from its words:
 * a run whose merge failed for something new commits can change goes round again (`again.ts`).
 */
export type MergeCause =
  | 'unknown'
  | 'closed'
  | 'changed'
  | 'review_changes'
  | 'changes_requested'
  | 'checks_failed'
  | 'checks_failed_again'
  | 'timed_out'
  | 'missing_checks'
  | 'no_checks'
  | 'needs_review'
  | 'refused'
  /** GitHub refused it and says it clashes with its base branch (`mergeable_state` dirty). */
  | 'conflict'
  | 'merge_failed'
  | 'declined';

/** What a merge step's row keeps (`output`). */
export interface MergeOutput {
  repo?: string;
  number?: number;
  base?: string;
  /** When it began waiting for the checks (ISO): `waitMinutes` count from here. Unset while a person decides. */
  waitingSince?: string;
  /** The approval a person gave for this attempt when its key asks. */
  mergeApprovalId?: string;
  merged?: boolean;
  text?: string;
  /** The failed checks it asked GitHub Actions to run once more (AR-57); at most once per attempt. */
  rerun?: MergeRerun;
  /** Why it didn't run them once more, when the repository re-runs only infrastructure faults (merge-rerun.ts). */
  noRerun?: string;
  /** Why it failed, once it did. */
  cause?: MergeCause;
}

/** A merge step's one re-run of failed checks (AR-57). */
export interface MergeRerun {
  /** When it asked (ISO). */
  at: string;
  /** The failed checks it asked again, with the job each showed then: a re-run is another job behind the name. */
  checks: { name: string; url: string }[];
}

export function mergeOutputOf(output: unknown): MergeOutput {
  return (output ?? {}) as MergeOutput;
}

/**
 * What a merge step would do for this run, as its definition renders now: the pull request (its number; the mirror's row
 * when it has one), the base it goes into, the key that needs (`merge.main` into the default branch, else `merge`) and
 * the proposal a person approves when that key asks. Also the approval guard's re-render (engine.ts).
 */
export async function mergePlan(
  db: Db,
  run: Pick<AutomationRunRow, 'burrowId'>,
  step: MergeStep,
  scope: Record<string, unknown>,
): Promise<
  | {
      ok: true;
      number: number;
      repo: typeof repos.$inferSelect;
      headSha: string | null;
      base: string;
      keyId: 'merge' | 'merge.main';
      keyScope: { repo: string; branch: string };
      proposal: { title: string; details: string };
    }
  | { ok: false; nothing: boolean; reason: string }
> {
  const rendered = renderTemplate(step.number, scope, 64).trim();
  if (!/^[1-9][0-9]{0,9}$/.test(rendered)) return { ok: false, nothing: true, reason: NOTHING_TO_MERGE };
  const number = Number(rendered);
  const [repo] = await db
    .select()
    .from(repos)
    .where(and(eq(repos.burrowId, run.burrowId), eq(repos.fullName, step.repo)));
  if (!repo?.enabled) return { ok: false, nothing: false, reason: MERGE_WORDS.notOn(step.repo) };
  const [pr] = await db
    .select({ baseBranch: pullRequests.baseBranch, headSha: pullRequests.headSha })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.number, number)));
  const base = pr?.baseBranch ?? repo.defaultBranch;
  return {
    ok: true,
    number,
    repo,
    headSha: pr?.headSha ?? null,
    base,
    keyId: mergeKeyOf(base, repo.defaultBranch),
    keyScope: { repo: repo.fullName, branch: base },
    proposal: {
      title: `Merge PR #${number} into ${base}`,
      details: `Once its checks pass, the automation merges PR #${number} into ${base} in ${repo.fullName}. If checks fail or someone changes the pull request, it leaves it for you.`,
    },
  };
}

/**
 * The checks a repository runs on its merges into `base` (TA-58): the names that passed on at least two of its last
 * five merged pull requests there (on its only one, when it merged one) and passed on the newest of them it reported
 * on, as the mirror has them. One merge the mirror saw only part of, or a check a change didn't run, doesn't change
 * it. Empty when it merged none, or none with checks.
 */
export async function expectedChecks(
  db: Db,
  repoId: string,
  base: string,
  exceptPrId: string,
): Promise<string[]> {
  const merged = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repoId, repoId),
        eq(pullRequests.state, 'merged'),
        eq(pullRequests.baseBranch, base),
        ne(pullRequests.id, exceptPrId),
      ),
    )
    .orderBy(desc(pullRequests.mergedAt))
    .limit(5);
  if (!merged.length) return [];
  const rows = await db
    .select({ prId: prChecks.prId, name: prChecks.name, state: prChecks.state })
    .from(prChecks)
    .where(
      inArray(
        prChecks.prId,
        merged.map((m) => m.id),
      ),
    );
  return usualChecks(
    merged.map((m) => m.id),
    rows,
  );
}

/**
 * `expectedChecks`' rule over the merges (newest first) and their check rows (TA-58): a check is usual when it passed
 * on at least two of the merges (on the only one, when there is one) and reported at all — in any state — on one of the
 * two newest merges that ran checks. A merge it skipped, one the mirror saw only in part, or one merged while it was
 * red doesn't drop it; a check the repository stopped running drops out after two merges without it. Pure.
 */
export function usualChecks(
  merged: readonly string[],
  rows: readonly { prId: string; name: string; state: string }[],
): string[] {
  const known = new Set(merged);
  const ran = merged.filter((id) => rows.some((r) => r.prId === id)).slice(0, 2);
  const passed = new Map<string, Set<string>>();
  const recent = new Set<string>();
  for (const r of rows) {
    if (!known.has(r.prId)) continue;
    if (r.state === 'passed') passed.set(r.name, (passed.get(r.name) ?? new Set<string>()).add(r.prId));
    if (ran.includes(r.prId)) recent.add(r.name);
  }
  const needed = merged.length === 1 ? 1 : 2;
  return [...passed]
    .filter(([name, prs]) => prs.size >= needed && recent.has(name))
    .map(([name]) => name)
    .sort();
}

/** The run's own review of the pull request (AR-46, AR-47). */
export interface RunReview {
  /** The step that gave the verdict. */
  stepId: string;
  verdict: AutomationVerdict;
  /** The commit it read: what the branch's writer pushed (`output.head`), null when that isn't known. */
  head: string | null;
}

/**
 * The run's review of `pr`, if it had one: the last agent step before step `idx` that gave a verdict (BP-C27). The
 * commit it read is the branch head the nearest write checkout of the pull request's branch up to it left, as GitHub had
 * it when that step finished (`output.head`, the engine's commits check): a recipe's `fix` step before its `review`.
 */
export function runReview(
  def: Pick<AutomationDefinition, 'steps'>,
  steps: readonly AutomationStepRow[],
  idx: number,
  pr: { repo: string; branch: string },
): RunReview | null {
  for (let i = idx - 1; i >= 0; i--) {
    const step = def.steps[i];
    const row = steps[i];
    if (step?.kind !== 'dispatch_agent' || !step.verdict || row?.state !== 'succeeded') continue;
    const verdict = (row.output as { verdict?: unknown }).verdict;
    if (verdict !== 'approve' && verdict !== 'changes_needed') continue;
    let head: string | null = null;
    for (let j = i; j >= 0; j--) {
      const ws = rowWorkspace(steps[j]?.output);
      if (steps[j]?.state !== 'succeeded' || ws?.access !== 'write') continue;
      if (ws.repo.toLowerCase() !== pr.repo.toLowerCase() || ws.branch !== pr.branch) continue;
      const pushed = (steps[j]?.output as JsonObject | undefined)?.head;
      head = typeof pushed === 'string' && pushed ? pushed : null;
      break;
    }
    // Work a T3 Code thread pushed has no write checkout here: the review step kept the head it approved itself.
    if (head === null) {
      const own = (row.output as JsonObject).head;
      head = typeof own === 'string' && own ? own : null;
    }
    return { stepId: step.id, verdict, head };
  }
  return null;
}

export type MergeReadiness =
  /** Keep waiting (checks running, or none yet within the grace). */
  | { kind: 'wait' }
  /** Someone merged it meanwhile: the step succeeds. */
  | { kind: 'merged'; summary: string }
  /** A person should look: the step fails with this line. */
  | { kind: 'fail'; error: string; summary: string; cause: MergeCause }
  /** Checks failed in GitHub Actions: run these workflow runs' failed jobs once more and keep waiting (AR-57). */
  | { kind: 'rerun'; runIds: number[]; checks: MergeRerun['checks']; summary: string }
  /** Merge it now; `reviewed`: the run's own review approved exactly its head. */
  | { kind: 'merge'; reviewed: boolean; summary: string };

/**
 * Whether a merge step merges now (AR-46), from what the mirror knows of the pull request — its state, head, the checks
 * of that head and its reviews — and the run's own review. In this order: merged meanwhile (succeeded); closed; changed
 * after the run's review (its head isn't the commit the review read); the review asked for changes; someone requested
 * changes; checks failed (run once more first when GitHub Actions can, `failedChecks`); checks passed (merge); checks
 * running (wait, until `waitMinutes` after it began waiting); no checks (wait up to `MERGE_CHECKS_GRACE_MS` after the
 * pull request opened — never past its wait — then merge; a report's fix only on the run's review of its head). Pure.
 */
export function mergeReadiness(p: {
  number: number;
  repo: string;
  target: MergeTarget | null;
  review: RunReview | null;
  waitingSince: Date;
  waitMinutes: number;
  /** The step's one re-run of failed checks, once it asked (AR-57). */
  rerun: MergeRerun | null;
  now: Date;
  /** The checks that passed on each of the repository's last merges into this base (`expectedChecks`, TA-58). */
  expected?: readonly string[];
  /** Never merge without checks (a fix of a customer's report, TA-58). */
  requireChecks?: boolean;
}): MergeReadiness {
  const n = p.number;
  const S = MERGE_SUMMARIES;
  const fail = (summary: string, error: string, cause: MergeCause) =>
    ({ kind: 'fail', error, summary, cause }) as const;
  if (!p.target) return fail(S.unknown(n), MERGE_WORDS.unknown(n, p.repo), 'unknown');
  const { row, pr } = p.target;
  if (row.state === 'merged') return { kind: 'merged', summary: S.merged(n) };
  if (row.state !== 'open') return fail(S.closed(n), MERGE_WORDS.closed(n), 'closed');
  const review = p.review;
  if (review?.verdict === 'approve' && review.head && !sameSha(review.head, row.headSha))
    return fail(S.changed(n), MERGE_WORDS.changed(n), 'changed');
  if (review?.verdict === 'changes_needed')
    return fail(S.reviewAskedChanges(n), MERGE_WORDS.reviewAskedChanges(n), 'review_changes');
  if (pr.reviewers.some((r) => r.state === 'changes_requested'))
    return fail(S.changesRequested(n), MERGE_WORDS.changesRequested(n), 'changes_requested');
  const reviewed = review?.verdict === 'approve' && !!review.head;
  const checks = checksState(pr.checks);
  const timeout = p.waitingSince.getTime() + p.waitMinutes * 60_000;
  if (checks === 'failed') return failedChecks(n, p.repo, pr.checks, p.rerun, p.now.getTime(), timeout);
  const expected = p.expected ?? [];
  if (checks === 'passed') {
    // The checks this repository runs on its merges must have reported too: some only report once they finish (TA-58).
    const missing = expected.filter((name) => !pr.checks.some((c) => c.name === name));
    // Without a merge to learn them from, a report's fix gives late checks the grace to show before it merges.
    const settling =
      !expected.length &&
      p.requireChecks === true &&
      p.now.getTime() < Math.max(row.openedAt.getTime(), p.waitingSince.getTime()) + MERGE_CHECKS_GRACE_MS;
    if (!missing.length && !settling) return { kind: 'merge', reviewed, summary: S.passed(n) };
    if (!missing.length) return { kind: 'wait' };
    // A check that never reports is left for a person sooner than one that still runs (TA-58).
    const missingBy = Math.min(timeout, p.waitingSince.getTime() + MERGE_MISSING_CHECKS_MS);
    return p.now.getTime() > missingBy
      ? fail(S.missing(n), MERGE_WORDS.missing(n, missing), 'missing_checks')
      : { kind: 'wait' };
  }
  if (checks === 'none') {
    // A repository that runs checks never merges without them, and none showing at all is left for a person as soon
    // as a usual one that never reports is (TA-58). In a repository that runs none, its own gate runs in the fix's
    // thread before it pushes: a customer's report's fix merges there only on the run's own review of this very head.
    if (expected.length || (p.requireChecks && !reviewed))
      return p.now.getTime() > Math.min(timeout, p.waitingSince.getTime() + MERGE_MISSING_CHECKS_MS)
        ? fail(S.noChecks(n), MERGE_WORDS.noChecks(n), 'no_checks')
        : { kind: 'wait' };
    const opened = Math.min(row.openedAt.getTime(), p.waitingSince.getTime());
    return p.now.getTime() >= Math.min(opened + MERGE_CHECKS_GRACE_MS, timeout)
      ? { kind: 'merge', reviewed, summary: S.none(n) }
      : { kind: 'wait' };
  }
  return p.now.getTime() > timeout
    ? fail(S.timedOut(n), MERGE_WORDS.timedOut(n), 'timed_out')
    : { kind: 'wait' };
}

/**
 * Failed checks (AR-57): run once more when every failed one (at most `MERGE_RERUN_MAX_CHECKS`) is a GitHub Actions job
 * of the repo — once its workflow run is done, as GitHub only re-runs a finished one —, else a person looks, as when
 * they fail again. Once it asked, a failed check still showing the job it asked again is one the mirror hasn't seen run
 * again yet: it waits for that, up to `MERGE_RERUN_SEEN_MS`.
 */
function failedChecks(
  n: number,
  repo: string,
  all: readonly Check[],
  rerun: MergeRerun | null,
  now: number,
  timeout: number,
): MergeReadiness {
  const S = MERGE_SUMMARIES;
  const failed = all.filter((c) => c.state === 'failed');
  const leave = {
    kind: 'fail',
    error: MERGE_WORDS.checksFailed(n),
    summary: S.failed(n),
    cause: 'checks_failed',
  } as const;
  if (rerun) {
    const asked = new Map(rerun.checks.map((c) => [c.name, c.url]));
    if (!failed.some((c) => asked.get(c.name) === c.url))
      return {
        kind: 'fail',
        error: MERGE_WORDS.checksFailedAgain(n),
        summary: S.failedAgain(n),
        cause: 'checks_failed_again',
      };
    return now < Date.parse(rerun.at) + MERGE_RERUN_SEEN_MS && now <= timeout ? { kind: 'wait' } : leave;
  }
  // Many failing at once is no flaky test (and more than a step notes).
  if (failed.length > MERGE_RERUN_MAX_CHECKS) return leave;
  const runIds = new Set<number>();
  for (const c of failed) {
    const id = actionsRunOf(c.url, repo);
    if (id === null) return leave;
    runIds.add(id);
  }
  const going = all.some((c) => {
    const id = actionsRunOf(c.url, repo);
    return id !== null && runIds.has(id) && !checkDone(c);
  });
  if (going) return now <= timeout ? { kind: 'wait' } : leave;
  return {
    kind: 'rerun',
    runIds: [...runIds],
    checks: failed.map((c) => ({ name: c.name, url: c.url ?? '' })),
    summary: S.rerun(n),
  };
}

/**
 * The GitHub Actions workflow run a check is a job of, from its page (`https://github.com/owner/repo/actions/runs/1/job/2`);
 * null for any other check (another CI, a run in another repository).
 */
export function actionsRunOf(url: string | null | undefined, repo: string): number | null {
  return actionsPageOf(url, repo)?.runId ?? null;
}

/** The GitHub Actions job a check is, from its page as `actionsRunOf` reads it; null for any other check. */
export function actionsJobOf(url: string | null | undefined, repo: string): number | null {
  return actionsPageOf(url, repo)?.jobId ?? null;
}

function actionsPageOf(
  url: string | null | undefined,
  repo: string,
): { runId: number; jobId: number } | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)(?:[?#].*)?$/.exec(
    url ?? '',
  );
  if (!m || m[1]?.toLowerCase() !== repo.toLowerCase()) return null;
  const runId = Number(m[2]);
  const jobId = Number(m[3]);
  const ok = (id: number) => Number.isSafeInteger(id) && id > 0;
  return ok(runId) && ok(jobId) ? { runId, jobId } : null;
}
