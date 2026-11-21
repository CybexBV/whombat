/**
 * Steps with an external effect (bp-automations BP-C05…C07, BP-C11): a step marked `running` by this process does its
 * effect now — opening a pull request, a comment on GitHub, a merge, a tracker write or reply, a URL call —, outside
 * any transaction, and commits what came of it. A `running` step this process didn't mark was left by one that died (or
 * lost the lease, or an update restarted): it is reconciled from what the mirror or GitHub shows, sent again when the
 * other side replays requests or provably never got it, or else set `uncertain` for a person — never done twice.
 */
import { type AutomationStep, namesOrganization, REPEATABLE_EXTERNAL_STEP_KINDS } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { mergeTarget } from '../../commands/prs';
import { repos } from '../../db/schema/index';
import { type GhPullRequest, GitHubError } from '../../github/adapter';
import { OutboundError, outboundRequest } from '../../lib/outbound';
import { githubScope } from '../../managed/providers/github-adapter';
import { MERGE_WORDS, mergeOutputOf } from '../merge';
import { openedPr, openPrStep } from '../steps';
import { shotsBranch, shotsSection } from '../steps/shots';
import { type AutomationStepRow, loadStepRows } from '../store';
import { commentOnGitHub, commentOnOpenedPr } from './github-comments';
import { mergePullRequest } from './merge-step';
import { failure, type LeasedRun } from './step-ops';
import { replyOnTracker, writeToTracker } from './tracker-effects';

/**
 * A step with an external effect: do it (`mine`: this process marked it), or reconcile it after a crash. False when the
 * run has to wait (a person checks an uncertain step) or the step has no external effect.
 */
export async function runExternal(
  lease: LeasedRun,
  row: AutomationStepRow,
  step: AutomationStep,
  mine: boolean,
): Promise<boolean> {
  if (!mine) return recoverExternal(lease, row, step);
  if (step.kind === 'open_pull_request') {
    await openPullRequest(lease, row, step);
    return true;
  }
  if (step.kind === 'github_comment') {
    await commentOnGitHub(lease, row, step);
    return true;
  }
  if (step.kind === 'merge_pull_request') {
    await mergePullRequest(lease, row, step);
    return true;
  }
  if (step.kind === 'tracker_update') {
    await writeToTracker(lease, row, step, row.attempt > 0);
    return true;
  }
  if (step.kind === 'tracker_reply') {
    await replyOnTracker(lease, row, step);
    return true;
  }
  if (step.kind === 'http_callback') {
    await callUrl(lease, row, step);
    return true;
  }
  return false;
}

/** A `running` step another process left (died, lost its lease, restarted): reconciled, sent again or `uncertain`. */
async function recoverExternal(
  lease: LeasedRun,
  row: AutomationStepRow,
  step: AutomationStep,
): Promise<boolean> {
  const { services, run } = lease;
  // Safe to repeat (TA-13): its request id makes the other side replay it, so a step a crashed process left running is
  // simply sent again.
  if (REPEATABLE_EXTERNAL_STEP_KINDS.includes(step.kind) && step.kind === 'tracker_update') {
    await writeToTracker(lease, row, step, true);
    return true;
  }
  if (REPEATABLE_EXTERNAL_STEP_KINDS.includes(step.kind) && step.kind === 'tracker_reply') {
    await replyOnTracker(lease, row, step);
    return true;
  }
  // Recovery: a step this process didn't start is from a crashed one, or one an update restarted. Reconcile from the
  // mirror, else from GitHub, else a person decides.
  if (step.kind === 'merge_pull_request') {
    const out = mergeOutputOf(row.output);
    const merged = (number: number, base: string) =>
      lease.commit({
        op: 'settle',
        idx: row.idx,
        state: 'succeeded',
        output: { merged: true, text: MERGE_WORDS.isMerged(number, base) },
        from: ['running'],
      });
    const target = out.number ? await mergeTarget(services.db, run.burrowId, out.number, step.repo) : null;
    if (target?.row.state === 'merged') {
      await merged(target.row.number, target.row.baseBranch);
      return true;
    }
    // The mirror hasn't seen it merged. A merge happens whole or not at all, and the step checks everything again
    // before it merges, so one GitHub hasn't got is merged now, as it was about to be.
    const now = out.number ? await pullRequestOnGitHub(lease, step.repo, out.number) : null;
    if (now === 'kept' || now?.state === 'open') {
      await mergePullRequest(lease, row, step);
      return true;
    }
    if (now?.merged) {
      await merged(now.number, now.baseRef);
      return true;
    }
  }
  if (step.kind === 'open_pull_request') {
    const branch = String((row.output as { branch?: string }).branch ?? '');
    const opened = (pr: { number: number; url: string | null }) =>
      lease.commit({
        op: 'settle',
        idx: row.idx,
        state: 'succeeded',
        output: {
          opened: true,
          prNumber: pr.number,
          command: null,
          // A comment this process may or may not have posted isn't tried again (RN-S3d: once at most).
          comment: null,
          text: `PR #${pr.number} is open: ${pr.url ?? `#${pr.number}`}`,
        },
        from: ['running'],
      });
    const pr = await openedPr(services.db, run.burrowId, step.repo, branch);
    if (pr) {
      await opened(pr);
      return true;
    }
    // The mirror hasn't got it. Opening one either reached GitHub or it didn't, and GitHub keeps a single open pull
    // request per branch, so when it has none from this branch the step opens it now, as it was about to.
    const found = branch ? await openOnGitHub(lease, step.repo, branch) : null;
    if (found === 'none') {
      await openPullRequest(lease, row, step);
      return true;
    }
    if (found) {
      await opened(found);
      return true;
    }
  }
  await lease.commit({
    op: 'settle',
    idx: row.idx,
    state: 'uncertain',
    error:
      'Whombat stopped while this step was running, so it may or may not have happened. Check, then say what happened.',
    from: ['running'],
  });
  return false;
}

/** Whether `repo` is kept on this Whombat (no GitHub): its mirror is then the whole truth. */
async function keptHere(lease: LeasedRun, repo: string): Promise<boolean> {
  const [row] = await lease.services.db
    .select({ source: repos.source })
    .from(repos)
    .where(and(eq(repos.burrowId, lease.run.burrowId), eq(repos.fullName, repo)));
  return row?.source === 'local';
}

/**
 * The pull request open on GitHub from `branch` of `repo` (not a fork's): 'none' when GitHub answered without one,
 * null when it can't say.
 */
async function openOnGitHub(
  lease: LeasedRun,
  repo: string,
  branch: string,
): Promise<{ number: number; url: string | null } | 'none' | null> {
  if (await keptHere(lease, repo)) return 'none';
  const { services, run } = lease;
  const adapter = services.github.adapter;
  if (!adapter) return null;
  try {
    const open = await githubScope.run({ burrowId: run.burrowId }, () => adapter.openPullRequests(repo, []));
    if (!open.modified) return null;
    const pr = open.data.find((p) => p.fork === null && p.headRef === branch);
    return pr ? { number: pr.number, url: pr.url } : 'none';
  } catch (err) {
    services.log.warn(
      { err: err instanceof Error ? err.name : 'error', repo },
      'automation: GitHub didn’t say whether the pull request was opened',
    );
    return null;
  }
}

/** Pull request `number` as GitHub has it now; 'kept' for a repository kept on this Whombat; null when it can't say. */
async function pullRequestOnGitHub(
  lease: LeasedRun,
  repo: string,
  number: number,
): Promise<GhPullRequest | 'kept' | null> {
  if (await keptHere(lease, repo)) return 'kept';
  const { services, run } = lease;
  const adapter = services.github.adapter;
  if (!adapter) return null;
  try {
    return await githubScope.run({ burrowId: run.burrowId }, () => adapter.getPullRequest(repo, number));
  } catch (err) {
    services.log.warn(
      { err: err instanceof Error ? err.name : 'error', repo },
      'automation: GitHub didn’t say whether the pull request was merged',
    );
    return null;
  }
}

/**
 * An `open_pull_request` step marked running: opens it (`openPrStep`, which records it in the same commit), then posts
 * its own body on one it found already open (RN-S3d). A failure retries while retries are left, and the last one posts
 * the prepared pull request for a person and says why it wasn't opened (M1).
 */
async function openPullRequest(
  lease: LeasedRun,
  row: AutomationStepRow,
  step: Extract<AutomationStep, { kind: 'open_pull_request' }>,
): Promise<void> {
  const { services, run, fence } = lease;
  // Found already open, with its own body still to post on it (RN-S3d).
  if ((row.output as { comment?: unknown }).comment) {
    await commentOnOpenedPr(lease, row, step);
    return;
  }
  // A report's organization never reaches GitHub (report-trackers.md TA-68): the server scrubs the title and body, but
  // the branch's own commits it can't change, so commits that name it leave the pull request for a person.
  const named = await commitsNameOrganization(lease, row);
  // GitHub didn't show the commits: asked again a little later, twice; still unread, the pull request waits for a
  // person like one that names the organization — never opened unchecked.
  if (named === COMMITS_UNREAD && row.attempt < COMMIT_READS - 1) {
    await lease.commit({
      op: 'settle',
      idx: row.idx,
      state: 'pending',
      retry: true,
      error: 'GitHub didn’t show the branch’s commits, so they are read again.',
      from: ['running'],
    });
    return;
  }
  if (named) {
    await lease.commit(
      step.otherwise === 'post_payload'
        ? { op: 'fallback', idx: row.idx, reason: named }
        : failure(row, step, named),
    );
    return;
  }
  try {
    const shots = await screenshotsOf(lease, row);
    const res = await services.pipeline.commit(
      openPrStep,
      { runId: run.id, fence, owner: lease.owner, idx: row.idx, ...(shots ? { shots } : {}) },
      { burrowId: run.burrowId, actorId: await lease.principal() },
    );
    if (res.status === 'ok' && res.result.status === 'commenting') {
      const [now] = (await loadStepRows(services.db, run.id)).filter((s) => s.idx === row.idx);
      if (now?.state === 'running') await commentOnOpenedPr(lease, now, step);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const op = failure(row, step, message);
    // No retries left: post the prepared pull request for a person, and say why it wasn't opened (M1).
    const last = op.op === 'settle' && op.state === 'failed' && step.otherwise === 'post_payload';
    await lease.commit(
      last ? { op: 'fallback', idx: row.idx, reason: `opening it failed: ${message}`.slice(0, 500) } : op,
    );
  }
}

/** Why a report's pull request isn't opened by itself when its branch's commits name the organization. */
export const ORGANIZATION_IN_COMMITS = 'its commits name the customer’s organization';
/** Why it isn't when GitHub doesn't show its commits, after `COMMIT_READS` tries. */
export const COMMITS_UNREAD = 'GitHub didn’t show its commits to check them for the customer’s organization';
/** How many times the step reads a report branch's commits before it leaves the pull request for a person. */
const COMMIT_READS = 3;
/** The most commits GitHub's comparison shows. */
const COMPARE_MAX = 100;
/** Why a report's pull request isn't opened by itself when its branch has more commits than can be checked. */
export const TOO_MANY_COMMITS =
  'its branch has more commits than I can check for the customer’s organization';

/**
 * `ORGANIZATION_IN_COMMITS` when a tracker report's branch has a commit (since its base) whose message names the
 * report's organization, `COMMITS_UNREAD` when GitHub can't say; null otherwise.
 */
async function commitsNameOrganization(lease: LeasedRun, row: AutomationStepRow): Promise<string | null> {
  const { services, run } = lease;
  const scope = run.scope as { kind?: unknown; organization?: unknown } | null;
  if (scope?.kind !== 'tracker' || typeof scope.organization !== 'string') return null;
  const organization = scope.organization;
  const input = (row.output as { command?: { input?: { repo?: unknown; branch?: unknown; base?: unknown } } })
    .command?.input;
  const adapter = services.github.adapter;
  if (!adapter || typeof input?.repo !== 'string' || typeof input.branch !== 'string') return null;
  const { repo, branch } = input;
  const base = typeof input.base === 'string' ? input.base : 'main';
  try {
    const commits = await githubScope.run({ burrowId: run.burrowId }, () =>
      adapter.compare(repo, base, branch),
    );
    if (commits.some((c) => namesOrganization(c.fullMessage ?? c.message, organization)))
      return ORGANIZATION_IN_COMMITS;
    // GitHub shows at most the last 100: a longer branch can't be checked whole.
    return commits.length >= COMPARE_MAX ? TOO_MANY_COMMITS : null;
  } catch (err) {
    // A branch GitHub doesn't have: opening the pull request says so itself. (A 422 may be a comparison too large to
    // show, so it counts as unread.)
    if (err instanceof GitHubError && err.status === 404) return null;
    services.log.warn(
      { err: err instanceof Error ? err.name : 'error', repo },
      'automation: the branch’s commits unread',
    );
    return COMMITS_UNREAD;
  }
}

/**
 * The “Screenshots” part of a pull request about to open (TA-52): the pictures on its branch's `pr-shots/` branch, read
 * outside the transaction. Null when there are none, and when GitHub can't say: the pull request opens without them.
 */
async function screenshotsOf(lease: LeasedRun, row: AutomationStepRow): Promise<string | null> {
  const { services, run } = lease;
  const input = (row.output as { command?: { input?: { repo?: unknown; branch?: unknown } } }).command?.input;
  const adapter = services.github.adapter;
  if (!adapter || typeof input?.repo !== 'string' || typeof input.branch !== 'string') return null;
  const { repo, branch } = input;
  try {
    const found = await githubScope.run({ burrowId: run.burrowId }, () =>
      adapter.branchFiles(repo, shotsBranch(branch)),
    );
    return found ? shotsSection(repo, found.sha, found.names) : null;
  } catch (err) {
    services.log.warn(
      { err: err instanceof Error ? err.name : 'error', repo },
      'automation: screenshots unread',
    );
    return null;
  }
}

/**
 * An `http_callback` step marked running (BP-C11): the POST with the step's idempotency key, the same on every try. A 2xx
 * succeeds; another answer below 500 is a refusal, so a failed attempt (retried as the step says); a 5xx, no answer or
 * a dropped connection may have happened (`uncertain`, for a person); refused before connecting, it certainly didn't
 * (a failed attempt).
 */
async function callUrl(
  lease: LeasedRun,
  row: AutomationStepRow,
  step: Extract<AutomationStep, { kind: 'http_callback' }>,
): Promise<void> {
  const { services, run } = lease;
  const key = row.idempotencyKey ?? `${run.id}:${step.id}`;
  const body = String((row.output as { body?: string }).body ?? '{}');
  try {
    const res = await outboundRequest(
      step.url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key,
          'x-whombat-automation': run.automationId,
          'x-whombat-run': String(run.number),
        },
        body,
      },
      {
        allowPrivate: services.config.WHOMBAT_OUTBOUND_ALLOW_PRIVATE,
        timeoutMs: 10_000,
        maxBytes: 64 * 1024,
      },
    );
    const ok = res.status >= 200 && res.status < 300;
    const text = res.body.toString('utf8').slice(0, 2000);
    // A 5xx came after the request arrived: the receiver may have acted and still answered with an error.
    const unsure = res.status >= 500;
    await lease.commit(
      ok
        ? {
            op: 'settle',
            idx: row.idx,
            state: 'succeeded',
            output: { status: res.status, text },
            from: ['running'],
          }
        : unsure
          ? {
              op: 'settle',
              idx: row.idx,
              state: 'uncertain',
              error: `It answered ${res.status}, so the call may or may not have worked. Check, then say what happened.`,
              from: ['running'],
            }
          : failure(row, step, `It answered ${res.status}.`),
    );
  } catch (err) {
    const refused = err instanceof OutboundError && err.refused;
    // Refused before connecting: it certainly didn't happen. Anything else: it may have.
    await lease.commit(
      refused
        ? failure(row, step, err.message)
        : {
            op: 'settle',
            idx: row.idx,
            state: 'uncertain',
            error: `The call may or may not have arrived (${err instanceof Error ? err.message : String(err)}). Check, then say what happened.`,
            from: ['running'],
          },
    );
  }
}
