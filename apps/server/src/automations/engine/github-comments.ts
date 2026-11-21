/**
 * Comments on GitHub, as the burrow's connection and outside any transaction, by a step this process marked running
 * (automation-recipes.md): a `github_comment` step's comment, and the body of an `open_pull_request` step that found its
 * pull request already open (RN-S3d).
 */
import type { AutomationStep, JsonObject } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { externalEffect } from '../../commit/scope';
import { repos } from '../../db/schema/index';
import { githubRefused } from '../../github/service';
import { githubScope } from '../../managed/providers/github-adapter';
import { keyDecision, publisherCheck } from '../authority';
import { mayCommentOnPr, stepRoomsCheck } from '../steps';
import type { AutomationStepRow } from '../store';
import { approvedBranchRequest } from '../workspace';
import { failure, type LeasedRun } from './step-ops';

/**
 * A `github_comment` step marked running by this process: the authority once more (the publisher, the rooms, the
 * automation's “Comment on pull requests” for the repo — or the approval a person gave for this attempt), then the
 * comment on GitHub as the burrow's connection. GitHub refusing (4xx) is a known failure; anything else (no answer, a
 * 5xx) may have posted it, so a person checks (`uncertain`).
 */
export async function commentOnGitHub(
  lease: LeasedRun,
  row: AutomationStepRow,
  step: Extract<AutomationStep, { kind: 'github_comment' }>,
): Promise<void> {
  const { services, run } = lease;
  const db = services.db;
  const out = row.output as { repo?: string; number?: number; body?: string; commentApprovalId?: string };
  const number = typeof out.number === 'number' ? out.number : 0;
  const body = typeof out.body === 'string' ? out.body : '';
  const refuse = (error: string) =>
    lease.commit({ op: 'settle', idx: row.idx, state: 'blocked', error, from: ['running'] });
  const who = await publisherCheck(db, run.burrowId, run.publishedById);
  if (!who.ok) return void (await refuse(who.reason));
  const rooms = await stepRoomsCheck(db, run, row.idx, who.publisher);
  if (!rooms.ok) return void (await refuse(rooms.reason));
  const [repo] = await db
    .select({ enabled: repos.enabled })
    .from(repos)
    .where(and(eq(repos.burrowId, run.burrowId), eq(repos.fullName, step.repo)));
  const decision = await keyDecision(db, await lease.principal(), who.publisher, 'pr.comment', {
    repo: step.repo,
  });
  const approved =
    decision.outcome === 'allow' ||
    (decision.outcome === 'ask' &&
      !!out.commentApprovalId &&
      (await approvedBranchRequest(db, out.commentApprovalId, run.id, step, row.attempt)));
  if (!repo?.enabled || !approved || !number || !body)
    return void (await refuse(`It may no longer comment on ${step.repo}.`));
  const adapter = services.github.adapter;
  if (!adapter) {
    await lease.commit(failure(row, step, 'GitHub isn’t connected, so it can’t comment.'));
    return;
  }
  try {
    const posted = await githubScope.run({ burrowId: run.burrowId }, () =>
      externalEffect('github.comment', () => adapter.commentOnIssue(step.repo, number, body), {
        refused: githubRefused,
      }),
    );
    await lease.commit({
      op: 'settle',
      idx: row.idx,
      state: 'succeeded',
      output: {
        number,
        commentUrl: posted.url,
        text: `Commented on ${step.repo}#${number}: ${posted.url}`,
      },
      from: ['running'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await lease.commit(
      githubRefused(err)
        ? failure(row, step, message.slice(0, 900))
        : {
            op: 'settle',
            idx: row.idx,
            state: 'uncertain',
            error: `The comment may or may not have reached GitHub (${message.slice(0, 300)}). Check ${step.repo}#${number}, then say what happened.`,
            from: ['running'],
          },
    );
  }
}

/**
 * An `open_pull_request` step that found its pull request already open, with its own body to post on it as one comment
 * (RN-S3d): the authority once more (the publisher, the rooms, the automation's “Comment on pull requests” or “Open
 * pull requests” there), then the comment on GitHub as the burrow's connection, outside any transaction. The step
 * succeeds either way — the pull request is open, which is what it is for —; whether the comment went (`commented`)
 * and GitHub's words when it didn't are kept on the step, and it is never tried twice.
 */
export async function commentOnOpenedPr(
  lease: LeasedRun,
  row: AutomationStepRow,
  step: Extract<AutomationStep, { kind: 'open_pull_request' }>,
): Promise<void> {
  const { services, run } = lease;
  const db = services.db;
  const out = row.output as { prNumber?: unknown; branch?: unknown; comment?: { body?: unknown } | null };
  const number = typeof out.prNumber === 'number' ? out.prNumber : 0;
  const body = typeof out.comment?.body === 'string' ? out.comment.body : '';
  const settle = (output: JsonObject) =>
    lease.commit({
      op: 'settle',
      idx: row.idx,
      state: 'succeeded',
      output: { comment: null, ...output },
      from: ['running'],
    });
  const who = await publisherCheck(db, run.burrowId, run.publishedById);
  const allowed =
    who.ok &&
    (await stepRoomsCheck(db, run, row.idx, who.publisher)).ok &&
    (await mayCommentOnPr(
      db,
      await lease.principal(),
      who.publisher,
      run.burrowId,
      step.repo,
      String(out.branch ?? ''),
    ));
  const adapter = services.github.adapter;
  if (!allowed || !adapter || !number || !body) {
    await settle({ commented: false });
    return;
  }
  try {
    const posted = await githubScope.run({ burrowId: run.burrowId }, () =>
      externalEffect('github.comment', () => adapter.commentOnIssue(step.repo, number, body), {
        refused: githubRefused,
      }),
    );
    await settle({ commented: true, commentUrl: posted.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    services.log.warn(
      { err: message.slice(0, 300), runId: run.id, repo: step.repo, number },
      'automations: the pull request comment failed',
    );
    await settle({ commented: false, commentError: message.slice(0, 300) });
  }
}
