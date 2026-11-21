/**
 * The `merge_pull_request` step (automation-recipes.md AR-45…AR-47, AR-57): while a person decides (its key
 * asks), their answer; then whether its checks let it merge — on waiting, failed GitHub Actions checks run once more
 * (only for an infrastructure fault where the repository says so), a settle when a person should look or someone merged
 * it — and the merge, on GitHub outside any transaction, recorded in its own commit (`mergePrStep`).
 */
import type { JsonObject } from '@whombat/core';
import { type MergeTarget, mergeHold, mergeKeyOf, mergeTarget } from '../../commands/prs';
import { externalEffect } from '../../commit/scope';
import type { Db } from '../../db/client';
import { GitHubNotConnectedError } from '../../github/adapter';
import { githubRefused } from '../../github/service';
import { githubScope } from '../../managed/providers/github-adapter';
import { loadPrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import { keyDecision, publisherCheck } from '../authority';
import {
  actionsJobOf,
  actionsRunOf,
  expectedChecks,
  MERGE_SUMMARIES,
  MERGE_WORDS,
  type MergeOutput,
  type MergeReadiness,
  type MergeStep,
  mergeOutputOf,
  mergeReadiness,
  runReview,
} from '../merge';
import { type ActionsJobFacts, infrastructureRerun, mergeRerunPolicy } from '../merge-rerun';
import { mergePrStep, type StepOp, stepRoomsCheck } from '../steps';
import { type AutomationRunRow, type AutomationStepRow, loadStepRows } from '../store';
import { approvedBranchRequest } from '../workspace';
import { awaitingYes, failure, type LeasedRun } from './step-ops';

/**
 * A waiting merge step (AR-45, AR-46): while a person decides (its key asks), their answer; then whether its checks
 * let it merge — `merging` to running when they do, a settle when a person should look or someone merged it, null to
 * keep waiting.
 */
export async function observeMerge(
  db: Db,
  run: AutomationRunRow,
  row: AutomationStepRow,
  step: MergeStep,
  now: Date,
): Promise<StepOp | null> {
  const out = mergeOutputOf(row.output);
  if (!out.waitingSince)
    return awaitingYes(db, row, step, now, (name) => {
      const error = MERGE_WORDS.declined(name, out.number ?? 0);
      // A no is what `otherwise` is for, as for a comment: skip it and go on, or fail the run.
      return step.otherwise === 'fail'
        ? { op: 'settle', idx: row.idx, state: 'failed', error, from: ['waiting'] }
        : { op: 'settle', idx: row.idx, state: 'skipped', error, from: ['waiting'] };
    });
  const { ready } = await mergeState(db, run, row, step, out, now);
  return mergeOp(row, out, ready, now);
}

/**
 * Before failed checks run once more: a repository that re-runs only infrastructure faults (`WHOMBAT_MERGE_RERUN`,
 * merge-rerun.ts) has each failed job read from GitHub, outside any transaction, and the pull request is left for a
 * person at once — with the usual line, and why on the step and in the log — when one failed in its own run or test
 * step, or GitHub can't say. Null: run them once more.
 */
export async function noRerunOp(
  services: Services,
  run: AutomationRunRow,
  row: AutomationStepRow,
  step: MergeStep,
  checks: readonly { name: string; url: string }[],
): Promise<StepOp | null> {
  if (mergeRerunPolicy(services.config.WHOMBAT_MERGE_RERUN, step.repo) !== 'infrastructure') return null;
  const n = mergeOutputOf(row.output).number ?? 0;
  const facts = { runId: run.id, repo: step.repo, pr: n };
  let why: string;
  try {
    const adapter = services.github.adapter;
    if (!adapter) throw new GitHubNotConnectedError();
    const jobs: ActionsJobFacts[] = [];
    // One at a time, stopping at the first that isn't the infrastructure's: that already decides it.
    for (const c of checks) {
      const id = actionsJobOf(c.url, step.repo);
      if (id === null) throw new Error(`“${c.name}” isn’t a GitHub Actions job`);
      const job = await githubScope.run({ burrowId: run.burrowId }, () => adapter.actionsJob(step.repo, id));
      jobs.push(job);
      if (!infrastructureRerun([job]).rerun) break;
    }
    const verdict = infrastructureRerun(jobs);
    if (verdict.rerun) {
      services.log.info({ ...facts, why: verdict.why }, 'automations: failed checks were the infrastructure');
      return null;
    }
    why = verdict.why;
  } catch (err) {
    why = `GitHub couldn’t say why the checks failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  why = why.slice(0, 300);
  services.log.info(
    { ...facts, why },
    'automations: failed checks not run again: not an infrastructure fault',
  );
  return {
    op: 'settle',
    idx: row.idx,
    state: 'failed',
    error: MERGE_WORDS.checksFailed(n),
    summary: MERGE_SUMMARIES.failed(n),
    output: { noRerun: why },
    from: ['waiting'],
  };
}

/**
 * Asks GitHub to run the failed jobs of the workflow runs behind `checks` once more (AR-57), as the burrow's GitHub
 * connection. GitHub refusing (or not answering) leaves it for a person, as failed checks did before: the step fails
 * with that line, and the reason is logged.
 */
export async function rerunChecks(
  lease: LeasedRun,
  row: AutomationStepRow,
  step: MergeStep,
  checks: readonly { url: string }[],
): Promise<void> {
  const { services, run } = lease;
  const n = mergeOutputOf(row.output).number ?? 0;
  const runIds = new Set<number>();
  for (const c of checks) {
    const id = actionsRunOf(c.url, step.repo);
    if (id !== null) runIds.add(id);
  }
  const adapter = services.github.adapter;
  try {
    if (!adapter) throw new GitHubNotConnectedError();
    for (const id of runIds)
      await githubScope.run({ burrowId: run.burrowId }, () =>
        externalEffect('github.rerun', () => adapter.rerunFailedJobs(step.repo, id), {
          refused: githubRefused,
        }),
      );
  } catch (err) {
    services.log.warn(
      { err: String(err), runId: run.id, repo: step.repo, pr: n },
      'automations: GitHub would not run the failed checks again',
    );
    await lease.commit({
      op: 'settle',
      idx: row.idx,
      state: 'failed',
      error: MERGE_WORDS.checksFailed(n),
      summary: MERGE_SUMMARIES.failed(n),
      from: ['waiting'],
    });
  }
}

/**
 * A merge step marked running by this process (AR-47): the authority once more (the publisher, the rooms, the
 * automation's merge key for the base — or the approval a person gave for this attempt), the checks once more from the
 * mirror, merge_pr's own rules as the automation (the run's review that approved this very commit is the review), then
 * the merge: on GitHub outside any transaction, recorded in its own commit (`mergePrStep`). GitHub refusing fails the
 * step with its reason; no answer is `uncertain`, for a person to check.
 */
export async function mergePullRequest(
  lease: LeasedRun,
  row: AutomationStepRow,
  step: MergeStep,
): Promise<void> {
  const { services, run, fence } = lease;
  const db = services.db;
  const out = mergeOutputOf(row.output);
  const n = out.number ?? 0;
  const settle = (state: 'failed' | 'blocked' | 'uncertain', error: string, output?: JsonObject) =>
    lease.commit({
      op: 'settle',
      idx: row.idx,
      state,
      error,
      ...(output ? { output } : {}),
      from: ['running'],
    });
  const who = await publisherCheck(db, run.burrowId, run.publishedById);
  if (!who.ok) return void (await settle('blocked', who.reason));
  const rooms = await stepRoomsCheck(db, run, row.idx, who.publisher);
  if (!rooms.ok) return void (await settle('blocked', rooms.reason));
  const now = services.clock();
  const { target, ready } = await mergeState(db, run, row, step, out, now);
  if (!target || ready.kind !== 'merge') {
    // Something changed since it last looked: back to waiting (a re-run is asked from there), or the outcome as when
    // waiting.
    const op =
      ready.kind === 'wait' || ready.kind === 'rerun'
        ? ({ op: 'merging', idx: row.idx, state: 'waiting', summary: MERGE_WORDS.waiting(n) } as const)
        : mergeOp(row, out, ready, now);
    if (op) await lease.commit(op.op === 'settle' ? { ...op, from: ['running'] } : op);
    return;
  }
  const principalId = await lease.principal();
  const base = target.row.baseBranch;
  const decision = await keyDecision(
    db,
    principalId,
    who.publisher,
    mergeKeyOf(base, target.repo.defaultBranch),
    {
      repo: target.repo.fullName,
      branch: base,
    },
  );
  const approved =
    decision.outcome === 'allow' ||
    (decision.outcome === 'ask' &&
      !!out.mergeApprovalId &&
      (await approvedBranchRequest(db, out.mergeApprovalId, run.id, step, row.attempt)));
  if (!target.repo.enabled || !approved)
    return void (await settle('blocked', MERGE_WORDS.mayNoLonger(base, step.repo)));
  const hold = await mergeHold(
    { db, services, burrowId: run.burrowId, actor: { id: principalId, kind: 'agent' } },
    target,
    { reviewed: ready.reviewed },
  );
  if (hold) {
    const [summary, error] =
      hold === 'review'
        ? [MERGE_SUMMARIES.noReview(n), MERGE_WORDS.needsReview(n)]
        : hold === 'not_open'
          ? [MERGE_SUMMARIES.closed(n), MERGE_WORDS.closed(n)]
          : [MERGE_SUMMARIES.failed(n), MERGE_WORDS.checksFailed(n)];
    await lease.commit({
      op: 'settle',
      idx: row.idx,
      state: 'failed',
      error,
      summary,
      from: ['running'],
    });
    return;
  }
  const record = (via: 'github' | 'here' | 'origin', sha: string | null) =>
    services.pipeline.commit(
      mergePrStep,
      { runId: run.id, fence, owner: lease.owner, idx: row.idx, via, sha },
      { burrowId: run.burrowId, actorId: principalId },
    );
  if (target.repo.source === 'local') {
    // Kept on this Whombat: merged in its origin inside the recording commit, as merge_pr does (MDS-D05).
    try {
      await record('origin', null);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await lease.commit(failure(row, step, MERGE_WORDS.failed(n, reason).slice(0, 900)));
    }
    return;
  }
  const automation = await loadPrincipalRow(db, principalId);
  const res = await services.github.mergeOutcome({
    burrowId: run.burrowId,
    repo: target.repo.fullName,
    number: n,
    method: step.method,
    headSha: target.row.headSha,
    title: target.row.title,
    mergedBy: automation?.name ?? 'an automation',
  });
  if (res.outcome === 'refused') {
    await lease.commit(failure(row, step, MERGE_WORDS.refused(n, res.reason).slice(0, 900)));
    return;
  }
  if (res.outcome === 'unknown') {
    await settle('uncertain', MERGE_WORDS.noAnswer(n), { detail: res.reason });
    return;
  }
  try {
    await record(res.outcome === 'merged' ? 'github' : 'here', res.outcome === 'merged' ? res.sha : null);
  } catch (err) {
    // Merged, but not recorded (another engine took the run, say): the step stays running, and whoever holds the run
    // next finds the pull request merged in the mirror (`external.ts`'s recovery).
    services.log.warn(
      { err: String(err), runId: run.id, pr: n },
      'automations: a merge went through but was not recorded',
    );
  }
}

/** The pull request a merge step merges, as the mirror has it now, and whether the step merges now (AR-46). */
async function mergeState(
  db: Db,
  run: AutomationRunRow,
  row: AutomationStepRow,
  step: MergeStep,
  out: MergeOutput,
  now: Date,
): Promise<{ target: MergeTarget | null; ready: MergeReadiness }> {
  const number = out.number ?? 0;
  const target = number ? await mergeTarget(db, run.burrowId, number, step.repo) : null;
  const review = target
    ? runReview(run.definition, await loadStepRows(db, run.id), row.idx, {
        repo: target.repo.fullName,
        branch: target.row.branch,
      })
    : null;
  const ready = mergeReadiness({
    number,
    repo: step.repo,
    target,
    review,
    waitingSince: new Date(out.waitingSince ?? row.startedAt ?? now),
    waitMinutes: step.waitMinutes,
    rerun: out.rerun ?? null,
    now,
    expected: target ? await expectedChecks(db, target.repo.id, target.row.baseBranch, target.row.id) : [],
    // A fix of a customer's report never merges without checks (TA-58).
    requireChecks: (run.scope as { kind?: unknown } | null)?.kind === 'tracker',
  });
  return { target, ready };
}

/**
 * A merge step's readiness as the op to commit (AR-46), its input summary now what it found; null to keep waiting.
 */
function mergeOp(row: AutomationStepRow, out: MergeOutput, ready: MergeReadiness, now: Date): StepOp | null {
  const n = out.number ?? 0;
  switch (ready.kind) {
    case 'wait':
      return null;
    case 'rerun':
      return {
        op: 'rerun_checks',
        idx: row.idx,
        summary: ready.summary,
        rerun: { at: now.toISOString(), checks: ready.checks },
      };
    case 'merged':
      return {
        op: 'settle',
        idx: row.idx,
        state: 'succeeded',
        output: { merged: true, alreadyMerged: true, text: MERGE_WORDS.alreadyMerged(n) },
        summary: ready.summary,
        from: ['waiting', 'running'],
      };
    case 'fail':
      return {
        op: 'settle',
        idx: row.idx,
        state: 'failed',
        error: ready.error,
        summary: ready.summary,
        from: ['waiting', 'running'],
      };
    case 'merge':
      return { op: 'merging', idx: row.idx, state: 'running', summary: ready.summary };
  }
}
