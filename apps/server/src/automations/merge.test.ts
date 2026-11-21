/**
 * The pure parts of an automation's merge (automation-recipes.md AR-46): whether it merges now from what the mirror knows
 * of the pull request and the run's own review, and which review that is and which commit it read.
 */
import { AutomationDefinition, type Check, type PullRequest, recipeDefinition } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { MergeTarget } from '../commands/prs';
import {
  actionsJobOf,
  actionsRunOf,
  MERGE_CHECKS_GRACE_MS,
  MERGE_RERUN_SEEN_MS,
  type MergeRerun,
  mergeReadiness,
  type RunReview,
  runReview,
  usualChecks,
} from './merge';
import type { AutomationStepRow } from './store';

const T0 = Date.parse('2026-10-10T08:00:00.000Z');
const HEAD = 'a'.repeat(40);

function target(
  over: {
    state?: 'open' | 'merged' | 'closed';
    headSha?: string;
    checks?: Check['state'][];
    /** Checks with their pages (GitHub Actions jobs), instead of `checks`. */
    jobs?: Pick<Check, 'name' | 'state' | 'url'>[];
    reviewers?: PullRequest['reviewers'][number]['state'][];
    openedAt?: number;
  } = {},
): MergeTarget {
  const headSha = over.headSha ?? HEAD;
  return {
    row: {
      state: over.state ?? 'open',
      headSha,
      openedAt: new Date(over.openedAt ?? T0),
      branch: 'feat/issue-5',
      baseBranch: 'main',
    },
    repo: { fullName: 'acme/web', source: 'github' },
    pr: {
      state: over.state ?? 'open',
      headSha,
      checks: over.jobs ?? (over.checks ?? []).map((state, i) => ({ name: `c${i}`, state })),
      reviewers: (over.reviewers ?? []).map((state, i) => ({ principalId: `prn_${i}`, state, at: null })),
    },
  } as unknown as MergeTarget;
}

const approved: RunReview = { stepId: 'review', verdict: 'approve', head: HEAD };

function ready(
  t: MergeTarget | null,
  o: {
    review?: RunReview | null;
    at?: number;
    waitMinutes?: number;
    since?: number;
    rerun?: MergeRerun;
    expected?: string[];
    requireChecks?: boolean;
  } = {},
) {
  return mergeReadiness({
    ...(o.expected ? { expected: o.expected } : {}),
    ...(o.requireChecks ? { requireChecks: true } : {}),
    number: 10,
    repo: 'acme/web',
    target: t,
    review: o.review === undefined ? approved : o.review,
    waitingSince: new Date(o.since ?? T0),
    waitMinutes: o.waitMinutes ?? 24 * 60,
    rerun: o.rerun ?? null,
    now: new Date(o.at ?? T0 + 60_000),
  });
}

describe('mergeReadiness', () => {
  it('waits for the checks the repository runs on every merge, and never merges a report fix without checks', () => {
    const fast = target({ jobs: [{ name: 'fast', state: 'passed', url: null }] });
    const expected = ['Development CI', 'PR integration', 'fast'];
    // Only “fast” reported so far: the others report once they finish.
    expect(ready(fast, { expected })).toEqual({ kind: 'wait' });
    // A check that never shows is left for a person after three hours, not the step's whole day.
    expect(ready(fast, { expected, at: T0 + 3 * 60 * 60_000 })).toEqual({ kind: 'wait' });
    expect(ready(fast, { expected, at: T0 + 3 * 60 * 60_000 + 1 })).toMatchObject({
      kind: 'fail',
      summary: 'Some checks never reported on PR #10',
    });
    const all = target({
      jobs: expected.map((name) => ({ name, state: 'passed' as const, url: null })),
    });
    expect(ready(all, { expected })).toMatchObject({ kind: 'merge', summary: 'Checks passed on PR #10' });
    // A report's fix in a repository with no merge to learn from gives late checks the grace to show.
    const fresh = target({ checks: ['passed'], openedAt: T0 });
    expect(ready(fresh, { requireChecks: true, at: T0 + 60_000 })).toEqual({ kind: 'wait' });
    expect(ready(fresh, { requireChecks: true, at: T0 + MERGE_CHECKS_GRACE_MS })).toMatchObject({
      kind: 'merge',
    });
    // No checks at all: a repository with checks, or a report's fix without the run's review, waits and leaves it.
    const none = target({ openedAt: T0 - 60 * 60_000 });
    expect(ready(none, { expected })).toEqual({ kind: 'wait' });
    expect(ready(none, { requireChecks: true, review: null })).toEqual({ kind: 'wait' });
    // None at all is left for a person after the same three hours as one usual check that never reports.
    expect(ready(none, { requireChecks: true, review: null, at: T0 + 3 * 60 * 60_000 })).toEqual({
      kind: 'wait',
    });
    expect(ready(none, { requireChecks: true, review: null, at: T0 + 3 * 60 * 60_000 + 1 })).toEqual({
      kind: 'fail',
      error: 'No checks ran on PR #10, so I left it for you.',
      summary: 'No checks ran on PR #10',
    });
    // A repository that runs no checks (its gate runs in the fix's thread): a report's fix merges on the run's own
    // review of its head, after the same grace as any pull request without checks.
    const opened = target({ openedAt: T0 });
    expect(ready(opened, { requireChecks: true, at: T0 + 60_000 })).toEqual({ kind: 'wait' });
    expect(ready(opened, { requireChecks: true, at: T0 + MERGE_CHECKS_GRACE_MS })).toMatchObject({
      kind: 'merge',
      reviewed: true,
    });
    // A review that asked for changes, or one of another head, never merges it.
    expect(
      ready(none, { requireChecks: true, review: { ...approved, verdict: 'changes_needed' } }),
    ).toMatchObject({
      kind: 'fail',
    });
    expect(ready(none, { requireChecks: true, review: { ...approved, head: 'f'.repeat(40) } })).toMatchObject(
      {
        kind: 'fail',
      },
    );
    // A repository that runs checks still needs them, reviewed or not.
    expect(ready(none, { expected, requireChecks: true })).toEqual({ kind: 'wait' });
  });

  it('merges once the checks pass, with the run’s review as the review', () => {
    expect(ready(target({ checks: ['passed', 'skipped'] }))).toEqual({
      kind: 'merge',
      reviewed: true,
      summary: 'Checks passed on PR #10',
    });
    // No review of the run's own: merge_pr's review rule decides later.
    expect(ready(target({ checks: ['passed'] }), { review: null })).toMatchObject({
      kind: 'merge',
      reviewed: false,
    });
  });

  it('waits while checks run, until it gives up', () => {
    const running = target({ checks: ['passed', 'running'] });
    expect(ready(running)).toEqual({ kind: 'wait' });
    expect(ready(running, { at: T0 + 24 * 60 * 60_000 })).toEqual({ kind: 'wait' });
    expect(ready(running, { at: T0 + 24 * 60 * 60_000 + 1 })).toEqual({
      kind: 'fail',
      error: 'Checks on PR #10 didn’t finish in time, so I left it for you.',
      summary: 'Checks on PR #10 didn’t finish in time',
    });
  });

  it('waits for checks to register for the grace after the pull request opened, then merges without', () => {
    const none = target({ openedAt: T0 - 5 * 60_000 });
    expect(ready(none, { at: T0 })).toEqual({ kind: 'wait' });
    expect(ready(none, { at: T0 - 5 * 60_000 + MERGE_CHECKS_GRACE_MS })).toEqual({
      kind: 'merge',
      reviewed: true,
      summary: 'No checks on PR #10',
    });
    // Opened long ago: no grace left.
    expect(ready(target({ openedAt: T0 - 86_400_000 }), { at: T0 })).toMatchObject({ kind: 'merge' });
    // Never past its own wait.
    expect(ready(target(), { waitMinutes: 5, at: T0 + 5 * 60_000 })).toMatchObject({ kind: 'merge' });
  });

  it('leaves it for a person, in order', () => {
    const fails = (t: MergeTarget | null, o: Parameters<typeof ready>[1] = {}) => {
      const r = ready(t, o);
      return r.kind === 'fail' ? [r.error, r.summary] : r;
    };
    expect(fails(null)).toEqual([
      'Whombat doesn’t know PR #10 in acme/web, so I left it for you.',
      'PR #10 not found',
    ]);
    expect(fails(target({ state: 'closed', checks: ['failed'] }))).toEqual([
      'PR #10 was closed, so there was nothing to merge.',
      'PR #10 was closed',
    ]);
    expect(fails(target({ headSha: 'b'.repeat(40), checks: ['passed'] }))).toEqual([
      'PR #10 changed after the review, so I left it for you.',
      'PR #10 changed after the review',
    ]);
    expect(
      fails(target({ checks: ['passed'] }), { review: { ...approved, verdict: 'changes_needed' } }),
    ).toEqual([
      'The review asked for changes, so I left PR #10 for you.',
      'The review asked for changes on PR #10',
    ]);
    expect(fails(target({ checks: ['failed'], reviewers: ['approved', 'changes_requested'] }))).toEqual([
      'Someone asked for changes on PR #10, so I left it for you.',
      'Changes requested on PR #10',
    ]);
    expect(fails(target({ checks: ['passed', 'failed'] }))).toEqual([
      'Checks failed on PR #10, so I left it for you.',
      'Checks failed on PR #10',
    ]);
  });

  it('succeeds when someone merged it meanwhile, whatever else', () => {
    expect(ready(target({ state: 'merged', headSha: 'b'.repeat(40), checks: ['failed'] }))).toEqual({
      kind: 'merged',
      summary: 'PR #10 was already merged',
    });
  });

  it('doesn’t hold a review it can’t bind to a commit against the pull request', () => {
    const unbound = { ...approved, head: null };
    expect(ready(target({ headSha: 'b'.repeat(40), checks: ['passed'] }), { review: unbound })).toEqual({
      kind: 'merge',
      reviewed: false,
      summary: 'Checks passed on PR #10',
    });
  });
});

describe('failed checks run once more (AR-57)', () => {
  const job = (run: number, id: number, repo = 'acme/web') =>
    `https://github.com/${repo}/actions/runs/${run}/job/${id}`;
  const ci = (macos: Check['state'], windows: Check['state'] = 'passed', macosJob = 72) =>
    target({
      jobs: [
        { name: 'test (ubuntu)', state: 'passed', url: job(7, 71) },
        { name: 'test (macos)', state: macos, url: job(7, macosJob) },
        { name: 'test (windows)', state: windows, url: job(7, 73) },
      ],
    });

  it('runs a GitHub Actions workflow run’s failed jobs again once all its jobs are done', () => {
    expect(ready(ci('failed', 'running'))).toEqual({ kind: 'wait' });
    expect(ready(ci('failed'))).toEqual({
      kind: 'rerun',
      runIds: [7],
      checks: [{ name: 'test (macos)', url: job(7, 72) }],
      summary: 'Running the failed checks on PR #10 once more',
    });
    // A check of another workflow run still going doesn't hold it.
    const other = target({
      jobs: [
        { name: 'test', state: 'failed', url: job(7, 72) },
        { name: 'deploy preview', state: 'running', url: job(8, 81) },
      ],
    });
    expect(ready(other)).toMatchObject({ kind: 'rerun', runIds: [7] });
    // Its workflow run not done when the wait is over: a person looks.
    expect(ready(ci('failed', 'running'), { at: T0 + 24 * 60 * 60_000 + 1 })).toMatchObject({
      kind: 'fail',
      error: 'Checks failed on PR #10, so I left it for you.',
    });
  });

  it('leaves it for a person when a failed check isn’t a GitHub Actions job of the repo', () => {
    const left = { kind: 'fail', error: 'Checks failed on PR #10, so I left it for you.' };
    expect(ready(target({ jobs: [{ name: 'ci', state: 'failed', url: null }] }))).toMatchObject(left);
    expect(
      ready(target({ jobs: [{ name: 'ci', state: 'failed', url: 'https://ci.example.com/build/5' }] })),
    ).toMatchObject(left);
    expect(
      ready(target({ jobs: [{ name: 'ci', state: 'failed', url: job(7, 72, 'acme/other') }] })),
    ).toMatchObject(left);
    // One of them can't run again: running the others wouldn't make it pass.
    const mixed = target({
      jobs: [
        { name: 'test', state: 'failed', url: job(7, 72) },
        { name: 'ci', state: 'failed', url: 'https://ci.example.com/build/5' },
      ],
    });
    expect(ready(mixed)).toMatchObject(left);
  });

  it('once asked, waits for the re-run, merges when it passes and leaves it for a person when it fails again', () => {
    const rerun: MergeRerun = {
      at: new Date(T0).toISOString(),
      checks: [{ name: 'test (macos)', url: job(7, 72) }],
    };
    // The mirror hasn't seen it run again yet.
    expect(ready(ci('failed'), { rerun })).toEqual({ kind: 'wait' });
    expect(ready(ci('failed'), { rerun, at: T0 + MERGE_RERUN_SEEN_MS })).toMatchObject({
      kind: 'fail',
      error: 'Checks failed on PR #10, so I left it for you.',
    });
    expect(ready(ci('queued', 'passed', 90), { rerun })).toEqual({ kind: 'wait' });
    expect(ready(ci('passed', 'passed', 90), { rerun })).toEqual({
      kind: 'merge',
      reviewed: true,
      summary: 'Checks passed on PR #10',
    });
    // Never a second time.
    expect(ready(ci('failed', 'passed', 90), { rerun })).toEqual({
      kind: 'fail',
      error: 'Checks failed again on PR #10, so I left it for you.',
      summary: 'Checks failed again on PR #10',
    });
  });

  it('reads the workflow run from a job’s page', () => {
    expect(actionsRunOf(job(38058353240, 114231333880), 'acme/web')).toBe(38058353240);
    expect(actionsRunOf(`${job(7, 72, 'Acme/Web')}?pr=10`, 'acme/web')).toBe(7);
    expect(actionsRunOf(job(7, 72, 'acme/other'), 'acme/web')).toBeNull();
    expect(actionsRunOf('https://github.com/acme/web/actions/runs/7', 'acme/web')).toBeNull();
    expect(actionsRunOf('https://github.com/acme/web/runs/72', 'acme/web')).toBeNull();
    expect(actionsRunOf(null, 'acme/web')).toBeNull();
  });

  it('reads the job from a job’s page', () => {
    expect(actionsJobOf(job(38058353240, 114231333880), 'acme/web')).toBe(114231333880);
    expect(actionsJobOf(job(7, 72, 'acme/other'), 'acme/web')).toBeNull();
    expect(actionsJobOf('https://github.com/acme/web/runs/72', 'acme/web')).toBeNull();
  });
});

describe('runReview', () => {
  const def = AutomationDefinition.parse(
    recipeDefinition({
      when: { kind: 'github', repo: 'acme/web', events: ['issue_opened'] },
      job: 'assess',
      instructions: 'Assess this.',
      conversationId: 'cnv_web',
      replyOnGitHub: true,
      fix: { mode: 'ask', merge: 'checks' },
    }),
  );
  const ids = def.steps.map((s) => s.id);
  const rows = (outputs: Record<string, Record<string, unknown>>, failed: string[] = []) =>
    ids.map(
      (id, idx) =>
        ({
          idx,
          stepId: id,
          state: failed.includes(id) ? 'failed' : 'succeeded',
          output: outputs[id] ?? {},
        }) as unknown as AutomationStepRow,
    );
  const ws = { repo: 'acme/web', branch: 'feat/issue-5', baseBranch: 'main', defaultBranch: 'main' };
  const merge = ids.indexOf('merge');
  const pr = { repo: 'acme/web', branch: 'feat/issue-5' };

  it('is the review step’s verdict on the commit the fix pushed', () => {
    const steps = rows({
      fix: { workspace: { ...ws, access: 'write' }, commits: 1, head: HEAD },
      review: { workspace: { ...ws, access: 'read' }, verdict: 'approve' },
    });
    expect(ids.slice(-1)).toEqual(['merge']);
    expect(runReview(def, steps, merge, pr)).toEqual({ stepId: 'review', verdict: 'approve', head: HEAD });
  });

  it('knows no commit for another branch, or a fix that didn’t say its head', () => {
    const steps = rows({
      fix: { workspace: { ...ws, access: 'write' }, commits: 1 },
      review: { verdict: 'approve' },
    });
    expect(runReview(def, steps, merge, pr)).toEqual({ stepId: 'review', verdict: 'approve', head: null });
    const other = rows({
      fix: { workspace: { ...ws, access: 'write' }, head: HEAD },
      review: { verdict: 'approve' },
    });
    expect(runReview(def, other, merge, { ...pr, branch: 'feat/other' })?.head).toBeNull();
  });

  it('is the head the review step kept when T3 Code pushed the work (no write checkout here)', () => {
    const steps = rows({ fix: {}, review: { verdict: 'approve', head: HEAD } });
    expect(runReview(def, steps, merge, pr)).toEqual({ stepId: 'review', verdict: 'approve', head: HEAD });
    // The changed head then stops the merge.
    expect(ready(target({ headSha: 'b'.repeat(40), checks: ['passed'] }))).toMatchObject({ kind: 'fail' });
  });

  it('is none without a verdict before the step', () => {
    expect(runReview(def, rows({ review: { verdict: 'approve' } }, ['review']), merge, pr)).toBeNull();
    expect(runReview(def, rows({}), merge, pr)).toBeNull();
    expect(runReview(def, rows({ review: { verdict: 'approve' } }), ids.indexOf('review'), pr)).toBeNull();
  });
});

describe('usualChecks (TA-58)', () => {
  const row = (prId: string, name: string, state = 'passed') => ({ prId, name, state });
  it('keeps a check a newest merge skipped, saw in part or merged red; drops one the repository stopped running', () => {
    const merges = ['m5', 'm4', 'm3', 'm2', 'm1'];
    const history = ['m4', 'm3', 'm2'].flatMap((m) => [
      row(m, 'fast'),
      row(m, 'Development CI'),
      row(m, 'PR integration'),
    ]);
    // The newest merge has only “fast” (a partial mirror, or a docs change): the others stay usual.
    expect(usualChecks(merges, [row('m5', 'fast'), ...history])).toEqual([
      'Development CI',
      'PR integration',
      'fast',
    ]);
    // Merged by hand while “PR integration” was red: it is still one the repository runs.
    expect(usualChecks(merges, [row('m5', 'PR integration', 'failed'), ...history])).toContain(
      'PR integration',
    );
    // Two merges in a row without “PR integration”: the repository stopped running it.
    const stopped = [
      ...['m5', 'm4'].flatMap((m) => [row(m, 'fast'), row(m, 'Development CI')]),
      ...['m3', 'm2'].flatMap((m) => [row(m, 'fast'), row(m, 'Development CI'), row(m, 'PR integration')]),
    ];
    expect(usualChecks(merges, stopped)).toEqual(['Development CI', 'fast']);
    // Seen once in five: not usual.
    expect(usualChecks(merges, [row('m1', 'lint'), ...history])).not.toContain('lint');
    // The only merge: its passed checks.
    expect(usualChecks(['m1'], [row('m1', 'ci')])).toEqual(['ci']);
    expect(usualChecks([], [])).toEqual([]);
  });
});
