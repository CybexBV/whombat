/**
 * Running a delegation (docs/decisions/delegate.md): what happens between its commits, where Whombat's server calls T3
 * Code through the connection's own sign-in — starting each task whose turn came in a thread, worktree and branch of its
 * own, sending a task more work, telling the next done task's thread to merge its pull request, and stopping threads. A
 * task's start is committed as `delegation.launched` (which watches it), a start that failed as
 * `delegation.launch_failed`. The watcher's pass (`sweepDelegations`) fails a task whose thread never started, tries
 * stops T3 Code didn't answer again, ends quiet delegations and starts the tasks and merges a restart left waiting. A
 * task has no time limit: it works until its thread ends, someone stops it, or T3 Code no longer has its thread.
 */
import { randomBytes } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { externalEffect } from '../commit/scope';
import type { CommitOptions } from '../commit/types';
import type { CatalogConnectionRow } from '../connections/types';
import {
  hashToken,
  leadName,
  type Place,
  placeArgs,
  threadOver,
  threadUrl,
  UPLOAD_HOURS,
} from '../council/run';
import { councilWays } from '../council/ways';
import {
  catalogConnections,
  councils,
  type DelegationRow,
  type DelegationTaskRow,
  delegations,
  delegationTasks,
  pullRequests,
  t3Watches,
} from '../db/schema/index';
import { GitHubError } from '../github/adapter';
import { githubRefused } from '../github/service';
import { githubScope } from '../managed/providers/github-adapter';
import type { Services } from '../services';
import { launchTitle } from '../t3code/threads';
import { callT3, T3Failure } from '../things/kinds/business/t3code';
import { rec, str } from '../things/words';
import {
  DEPLOY_AFTER_MERGE,
  deployBrief,
  finalBrief,
  mergeBrief,
  sendMessage,
  taskBrief,
  taskTitle,
} from './briefs';
import { DELEGATION_TEXT, inOrder as inOrderOf, itemNumbersOf } from './card';
import {
  awaitFinalVerification,
  busyTasks,
  type ClaimedTask,
  checkedCandidateMerged,
  claimFinalMerge,
  claimTasks,
  cleanupDelegationThreads,
  DELEGATION_QUIET_DAYS,
  ensureFinal,
  expireDelegation,
  finalMergeRefused,
  finishDelegation,
  holdFinal,
  isFinal,
  loadDelegation,
  loadTasks,
  MERGE_CLAIM_MS,
  mergeClaimed,
  mergedElsewhere,
  mergeNext,
  mergeSent,
  mergesWaiting,
  readyTasks,
  releaseFinalMerge,
  type TaskSend,
  taskEnded,
  taskLaunched,
  taskLaunchFailed,
} from './commands';
import { allOver, byPullRequest, eligibleIntegration, onePullRequest } from './state';
import { verificationOf } from './verification';
import { finalGate, githubPr, verifyFinal } from './verify-final';

const opts = (d: Pick<DelegationRow, 'burrowId' | 'agentId'>): CommitOptions => ({
  burrowId: d.burrowId,
  actorId: d.agentId,
});

async function connectionOf(services: Services, d: DelegationRow): Promise<CatalogConnectionRow | null> {
  const [row] = await services.db
    .select()
    .from(catalogConnections)
    .where(and(eq(catalogConnections.id, d.connectionId), eq(catalogConnections.status, 'active')));
  return (row as CatalogConnectionRow | undefined) ?? null;
}

/** A new picture link for a task's brief (DLG-27): only its hash is kept, so each start gets its own. */
async function uploadLink(
  services: Services,
  connection: CatalogConnectionRow,
  taskId: string,
): Promise<{ bases: string[]; token: string } | null> {
  const bases = councilWays(services, connection.baseUrl);
  if (!bases.length) return null;
  const token = randomBytes(32).toString('base64url');
  await services.db
    .update(delegationTasks)
    .set({
      uploadHash: hashToken(token),
      uploadUntil: new Date(services.clock().getTime() + UPLOAD_HOURS * 3_600_000),
    })
    .where(eq(delegationTasks.id, taskId));
  return { bases, token };
}

/** T3 Code refused the worktree's base (none such in the person's checkout): another base may do. */
const baseRefused = (err: unknown) =>
  err instanceof T3Failure && err.code === 'invalid_request' && /no thread was created/i.test(err.said);

/**
 * Where a task starts (DLG-23): after a task not merged, from that one's branch; else from the default branch fresh from
 * the remote once the delegation knows its name, else from the remote's default branch as the computer last fetched it.
 */
function placesOf(d: DelegationRow, branch: string, base: string | null): Place[] {
  const projectId = d.projectId as string;
  if (base) return [{ kind: 'worktree', projectId, branch, baseRef: base }];
  return [
    ...(d.baseBranch
      ? [{ kind: 'worktree' as const, projectId, branch, baseRef: d.baseBranch, fromOrigin: true }]
      : []),
    { kind: 'worktree', projectId, branch, baseRef: 'origin/HEAD' },
    // A checkout without the remote's default branch: as the person has it.
    { kind: 'worktree', projectId, branch },
  ];
}

/** Starts one claimed task's thread with its brief; its id, title and worktree as T3 Code keeps them. */
async function launchTask(
  services: Services,
  connection: CatalogConnectionRow,
  d: DelegationRow,
  { task, base, with: mates }: ClaimedTask,
  lead: string,
): Promise<{ threadId: string; title: string; worktree: string | null }> {
  const places: Place[] = d.projectId && task.branch ? placesOf(d, task.branch, base) : [{ kind: 'scratch' }];
  // A thread that leads several items is named for the job.
  const title = launchTitle(
    lead,
    taskTitle(mates.length ? `${d.title} (${mates.length + 1} items)` : task.title),
  );
  const final = isFinal(task) && !!d.projectId && !!task.branch;
  const upload =
    d.projectId && task.branch && !final ? await uploadLink(services, connection, task.id) : null;
  const tasks = await loadTasks(services.db, d.id);
  // Each item by the number it had on the card when it was claimed (`item`): its thread reports on it by that number.
  const items = itemNumbersOf(tasks);
  const group = [task, ...mates];
  const ids = new Set(group.map((t) => t.id));
  const one = final && d.integrationMode === 'batch' ? onePullRequest(tasks) : null;
  const rules = d.rules;
  const message = final
    ? finalBrief({
        lead,
        goal: d.title,
        branch: task.branch as string,
        single: one && one.pr === task.pr ? one : null,
        again:
          !(one && one.pr === task.pr) && task.pr && task.attempt > 1
            ? { pr: task.pr, branch: task.branch as string }
            : null,
        merged: tasks.filter((t) => !isFinal(t) && t.mergeState === 'merged').map((t) => t.title),
        candidates: byPullRequest(eligibleIntegration(tasks)),
        inputs: task.checkedInputs ?? '',
        generation: task.checkGeneration,
        rules,
        gate: await finalGate(services, d, tasks),
      })
    : taskBrief({
        lead,
        goal: d.title,
        items: group.map((t) => ({
          n: items.get(t.id) ?? 1,
          title: t.title,
          brief: t.brief,
          after: t.afterId && ids.has(t.afterId) ? (items.get(t.afterId) ?? null) : null,
        })),
        branch: d.projectId ? task.branch : null,
        base,
        pullRequest: d.pullRequests,
        merge: d.merge,
        batch: d.integrationMode === 'batch' && d.merge,
        rules,
        upload,
        atOnce: d.atOnce,
        // Work of this list in other threads (another AI was chosen for it), now or still to come.
        others: tasks.some(
          (t) => !isFinal(t) && !ids.has(t.id) && (t.state === 'working' || t.state === 'queued'),
        ),
      });
  // The AI chosen for it (the person's, or a council's builder seat with its effort), else the one the person chose for
  // every task on the checklist, else T3 Code's own default.
  const model =
    task.provider && task.model
      ? { modelSelection: { instanceId: task.provider, model: task.model, options: task.options ?? [] } }
      : d.aiProvider && d.aiModel
        ? { modelSelection: { instanceId: d.aiProvider, model: d.aiModel, options: d.aiOptions ?? [] } }
        : {};
  let body: unknown;
  for (const [i, place] of places.entries()) {
    try {
      body = await callT3(
        services,
        connection,
        't3_thread_launch',
        { ...placeArgs(place), title, message, ...model },
        'things.action',
      );
      break;
    } catch (err) {
      if (i === places.length - 1 || !baseRefused(err)) throw err;
    }
  }
  const threadId = str(rec(body).threadId);
  if (!threadId) throw new T3Failure('no_thread', 'T3 Code answered without a thread.');
  return { threadId, title, worktree: str(rec(rec(body).thread).worktreePath) ?? null };
}

/** More work for a task that waited for a place (DLG-25): sent to its own thread, whose watch was armed again. */
async function resumeTask(
  services: Services,
  connection: CatalogConnectionRow,
  task: DelegationTaskRow,
  message: string,
  lead: string,
): Promise<void> {
  if (!task.threadId) throw new T3Failure('no_thread', 'No thread to send it to.');
  await callT3(
    services,
    connection,
    't3_thread_send',
    { threadId: task.threadId, message: await followUp(services, task, message, lead), mode: 'auto' },
    'things.action',
  );
}

/** Putting what Whombat merged on DEV again: the deploy brief alone (nothing merged, pushed or changed). */
function deployAgain(task: DelegationTaskRow, lead: string): string {
  return deployBrief({
    lead,
    pr: task.pr ?? '',
    revision: task.checkedRevision ?? '',
    after: DEPLOY_AFTER_MERGE,
  });
}

/** More work for a task's thread, with the lines its end gives for each item it does (`sendMessage`). */
async function followUp(
  services: Services,
  task: DelegationTaskRow,
  message: string,
  lead: string,
): Promise<string> {
  const tasks = await loadTasks(services.db, task.delegationId);
  const numbers = itemNumbersOf(tasks);
  const mine = inOrderOf(tasks.filter((t) => !isFinal(t) && t.threadId && t.threadId === task.threadId));
  return sendMessage({
    lead,
    message,
    items: mine.map((t) => numbers.get(t.id) ?? 1),
    checks: !isFinal(task) && !!task.pr,
  });
}

/**
 * Starts the tasks whose turn came, as many as may work at once, side by side; a task that couldn't start frees its
 * place for the next. How many started.
 */
export async function startReady(
  services: Services,
  delegationId: string,
  burrowId: string,
): Promise<number> {
  let started = 0;
  // A start that fails frees its place: claim again, a few times at most.
  for (let round = 0; round < 4; round++) {
    const [d] = await services.db.select().from(delegations).where(eq(delegations.id, delegationId));
    if (d?.stage !== 'working' || d.burrowId !== burrowId) return started;
    const res = await services.pipeline.commit(claimTasks, { delegationId }, opts(d));
    if (res.status !== 'ok' || !res.result.claimed.length) return started;
    const connection = await connectionOf(services, d);
    const lead = await leadName(services.db, d.agentId);
    const results = await Promise.all(
      res.result.claimed.map(async (claimed) => {
        try {
          if (!connection) throw new T3Failure('no_connection', 'The T3 Code connection is gone.');
          if (claimed.send) {
            await resumeTask(services, connection, claimed.task, claimed.send, lead);
            return 'started' as const;
          }
          const { threadId, title, worktree } = await launchTask(services, connection, d, claimed, lead);
          const url = await threadUrl(services, connection, threadId).catch(() => null);
          const kept = await services.pipeline.commit(
            taskLaunched,
            {
              delegationId,
              taskId: claimed.task.id,
              withIds: claimed.with.map((t) => t.id),
              threadId,
              title: title.slice(0, 160),
              url,
              worktree,
            },
            opts(d),
          );
          // Stopped while it started: stop the new thread too.
          if (kept.status === 'ok' && kept.result.cancelled) {
            await stopTaskThreads(services, d, [{ id: claimed.task.id, threadId }], 'The task was stopped.');
            return 'stopped' as const;
          }
          return 'started' as const;
        } catch (err) {
          services.log.warn(
            { err: err instanceof Error ? err.message : String(err), delegationId },
            'delegation: a task could not start',
          );
          if (claimed.send && claimed.task.threadId)
            await services.pipeline
              .commit(
                taskEnded,
                {
                  delegationId,
                  threadId: claimed.task.threadId,
                  state: 'failed',
                  answer: null,
                  pr: null,
                  merged: null,
                },
                opts(d),
              )
              .catch(warnFailed(services, delegationId, 'delegation: ending a task that could not start'));
          else
            await services.pipeline
              .commit(
                taskLaunchFailed,
                { delegationId, taskId: claimed.task.id, withIds: claimed.with.map((t) => t.id) },
                opts(d),
              )
              .catch(warnFailed(services, delegationId, 'delegation: marking a task that could not start'));
          return 'failed' as const;
        }
      }),
    );
    started += results.filter((r) => r === 'started').length;
    if (!results.includes('failed')) return started;
  }
  return started;
}

/**
 * The next done task's pull request is merged, when none is being merged now. A combined check's candidate is merged by
 * Whombat itself on GitHub, only at the commit that was checked and only while the base is the one it was checked on,
 * under a claim that holds back changes to the list meanwhile (`claimFinalMerge`); GitHub's own record of the merge then
 * finishes it (`checkedCandidateMerged`), so a restart in between loses nothing. When the repository wants it put live
 * after, its row works on in its thread, which is given only that, and its end finishes it. Without a combined check,
 * the next task's thread is told it is its turn to merge; one T3 Code refuses ends as not merged (and wakes the agent),
 * and the one after it gets its turn. Whether one merged or started.
 */
export async function mergeReady(
  services: Services,
  delegationId: string,
  burrowId: string,
): Promise<boolean> {
  // Whombat merged the candidate in an earlier round: GitHub's record of it is read.
  let merged = false;
  // Someone merged it while GitHub was read: read once more as merged before it is checked again.
  let reread = false;
  for (let round = 0; round < 4; round++) {
    const [d] = await services.db.select().from(delegations).where(eq(delegations.id, delegationId));
    if (d?.stage !== 'working' || d.burrowId !== burrowId) return false;
    // Once it is merged, its thread puts it on DEV the way the repository's own instructions say.
    const after = DEPLOY_AFTER_MERGE;
    let verifiedRevision: string | null = null;
    // Whombat merged the candidate (now, or on an earlier pass: its claim says so): its thread only puts it live.
    let ours = merged;
    if (d.integrationMode === 'batch') {
      const final = (await loadTasks(services.db, d.id)).find(
        (t) => isFinal(t) && t.state === 'done' && t.mergeState === 'waiting',
      );
      if (!final) return merged;
      // Another merge of it is going on, or its answer was lost: only whether it merged is read until that is over.
      if (
        !merged &&
        mergeClaimed(final, services.clock()) &&
        !(await mergedAtCheckedHead(services, d, final))
      )
        return false;
      const proof = verificationOf(final.answer);
      const verified = await verifyFinal(services, d, final, proof, final.pr);
      if (!verified.ok) {
        // Merged by Whombat a moment ago and GitHub doesn't show it yet: read again next pass, never checked again.
        if (merged) return true;
        // Merged by someone while GitHub was read: read again as merged; only what landed differently is checked again.
        if (verified.reason === 'stale' && !reread && (await mergedAtCheckedHead(services, d, final))) {
          reread = true;
          continue;
        }
        if (verified.reason === 'stale')
          await services.pipeline.commit(ensureFinal, { delegationId, invalidate: true }, opts(d));
        else if ((verified.reason === 'waiting' || verified.reason === 'unavailable') && final.threadId)
          await services.pipeline.commit(
            awaitFinalVerification,
            {
              delegationId,
              taskId: final.id,
              threadId: final.threadId,
              answer: final.answer,
              pr: final.pr,
              message: verified.message ?? 'Waiting for GitHub verification.',
              blocked: verified.reason === 'unavailable',
            },
            opts(d),
          );
        else
          await services.pipeline.commit(
            holdFinal,
            {
              delegationId,
              taskId: final.id,
              revision: final.checkedRevision ?? '',
              waiting: verified.reason === 'waiting',
              message: verified.message,
            },
            opts(d),
          );
        return false;
      }
      verifiedRevision = proof?.revision ?? null;
      if (!verifiedRevision) return false;
      if (verified.merged) {
        // Merged (by Whombat, or by someone): recorded now, unless Whombat merged it (its claim says so, also on a
        // later pass) and the repository deploys after.
        ours = merged || !!final.mergeClaimedAt;
        if (!(ours && after)) {
          await services.pipeline.commit(
            checkedCandidateMerged,
            { delegationId, taskId: final.id, revision: verifiedRevision },
            opts(d),
          );
          return merged;
        }
      } else {
        // Whombat merged it a moment ago and GitHub doesn't show it yet: the next pass reads it again.
        if (merged) return false;
        // The list once more, right before the merge: a stop since then wins.
        const latest = await loadDelegation(services.db, burrowId, d.id);
        if (latest?.stage !== 'working') return false;
        // Claimed in the commit pipeline: still the current checked candidate, and changes wait while it merges.
        const claim = await services.pipeline.commit(
          claimFinalMerge,
          { delegationId, taskId: final.id, revision: verifiedRevision },
          opts(d),
        );
        if (claim.status !== 'ok' || !claim.result.claimed || !claim.result.at) return false;
        const at = claim.result.at;
        const outcome = await mergeChecked(services, d, final);
        if (outcome.outcome === 'refused') {
          await services.pipeline.commit(
            finalMergeRefused,
            { delegationId, taskId: final.id, revision: verifiedRevision, message: outcome.message },
            opts(d),
          );
          return false;
        }
        // GitHub's answer was lost: the claim stays until the next pass reads whether it merged (or it runs out).
        if (outcome.outcome === 'unknown') return false;
        // Merged: the claim stays, saying Whombat merged it, until the merge is recorded or handed on to put live.
        if (outcome.outcome === 'merged') {
          merged = true;
          continue;
        }
        await services.pipeline.commit(releaseFinalMerge, { delegationId, taskId: final.id, at }, opts(d));
        if (outcome.outcome === 'stale')
          await services.pipeline.commit(ensureFinal, { delegationId, invalidate: true }, opts(d));
        return false;
      }
    }
    // Its row works on while its thread merges it (without a combined check) or puts what Whombat merged live.
    const res = await services.pipeline.commit(mergeNext, { delegationId, verifiedRevision }, opts(d));
    if (res.status !== 'ok' || !res.result.task) return merged;
    const { task } = res.result;
    try {
      const connection = await connectionOf(services, d);
      if (!connection || !task.threadId) throw new T3Failure('no_connection', 'No thread to merge it in.');
      const lead = await leadName(services.db, d.agentId);
      const latest = await loadDelegation(services.db, burrowId, d.id);
      if (!ours && latest?.stage !== 'working') return false;
      await callT3(
        services,
        connection,
        't3_thread_send',
        {
          threadId: task.threadId,
          message:
            ours && after
              ? deployBrief({ lead, pr: task.pr ?? '', revision: task.checkedRevision ?? '', after })
              : mergeBrief({ lead, pr: task.pr ?? '', branch: task.branch, after }),
          mode: 'auto',
        },
        'things.action',
      );
      const kept = await services.pipeline.commit(mergeSent, { delegationId, taskId: task.id }, opts(d));
      // Stopped while it was told: stop the merge too.
      if (kept.status === 'ok' && kept.result.cancelled)
        await stopTaskThreads(services, d, [task], 'The task was stopped.');
      return true;
    } catch (err) {
      services.log.warn(
        { err: err instanceof Error ? err.message : String(err), delegationId },
        'delegation: a pull request could not be handed for merging',
      );
      if (!task.threadId) return merged;
      // What Whombat merged stays merged: only its deploy didn't go to its thread.
      if (ours) {
        await recordWhombatMerge(services, d, task, NOT_HANDED_ON);
        return true;
      }
      await services.pipeline
        .commit(
          taskEnded,
          { delegationId, threadId: task.threadId, state: 'failed', answer: null, pr: null, merged: null },
          opts(d),
        )
        .catch(
          warnFailed(services, delegationId, 'delegation: ending a task whose merge could not be handed on'),
        );
    }
  }
  return merged;
}

/**
 * A candidate Whombat merged whose row still works but whose thread wasn't given its deploy (the send failed, or a
 * restart came between): GitHub's record of the merge, read independently, finishes the row as its thread's end would.
 * Nothing happens while GitHub doesn't confirm it; the next pass tries again.
 */
export async function recordWhombatMerge(
  services: Services,
  d: DelegationRow,
  final: DelegationTaskRow,
  note: string,
): Promise<void> {
  if (!final.threadId) return;
  const verified = await verifyFinal(services, d, final, verificationOf(final.answer), final.pr, true);
  if (!verified.ok || !verified.merged) return;
  await services.pipeline
    .commit(
      taskEnded,
      {
        delegationId: d.id,
        threadId: final.threadId,
        // Not done: the agent hears that it wasn't put live.
        state: 'failed',
        answer: null,
        pr: null,
        merged: true,
        verified: true,
        note,
      },
      opts(d),
    )
    .catch(warnFailed(services, d.id, 'delegation: recording a merge'));
}

/** The final row's line when what Whombat merged couldn't be given to its thread to put live. */
const NOT_HANDED_ON = 'It is merged, but it couldn’t be handed over to be put live.';

/** Whether GitHub says the candidate's pull request was merged at the head that was checked. */
async function mergedAtCheckedHead(
  services: Services,
  d: DelegationRow,
  final: DelegationTaskRow,
): Promise<boolean> {
  const adapter = services.github.adapter;
  const pr = githubPr(final.pr);
  if (!adapter || !pr || !final.checkedRevision) return false;
  return githubScope
    .run({ burrowId: d.burrowId }, () => adapter.getPullRequest(pr.repo, pr.number))
    .then((open) => open.merged && open.headSha === final.checkedRevision)
    .catch(() => false);
}

/**
 * Merges a combined check's candidate on GitHub, at the checked commit (GitHub refuses when the head moved) and only
 * while the base is still the checked one and its claimed row still waits. Its own merge commit keeps the source
 * branches, so their pull requests show as merged. `merged` also when GitHub already has it merged at that head;
 * `stale` when the head or base moved (it needs a fresh combined check); `refused` with GitHub's reason; `notSent` when
 * nothing reached GitHub's merge (a read failed, or the list changed meanwhile); `unknown` when its answer was lost.
 */
async function mergeChecked(
  services: Services,
  d: DelegationRow,
  final: DelegationTaskRow,
): Promise<
  { outcome: 'merged' | 'stale' | 'notSent' | 'unknown' } | { outcome: 'refused'; message: string }
> {
  const adapter = services.github.adapter;
  const pr = githubPr(final.pr);
  const revision = final.checkedRevision;
  if (!adapter || !pr || !revision || !final.checkedBase) return { outcome: 'stale' };
  return githubScope.run({ burrowId: d.burrowId }, async () => {
    let title: string;
    try {
      const open = await adapter.getPullRequest(pr.repo, pr.number);
      // Merged already at the checked head (by someone, or by Whombat whose answer was lost): GitHub's record finishes it.
      if (open.merged)
        return { outcome: open.headSha === revision ? ('merged' as const) : ('stale' as const) };
      const base = await adapter.branchHead(pr.repo, open.baseRef, null);
      if (open.headSha !== revision || !base.modified || base.data !== final.checkedBase)
        return { outcome: 'stale' as const };
      title = open.title;
    } catch {
      return { outcome: 'notSent' as const };
    }
    // The row once more, right before the merge: still the claimed waiting candidate of a working list.
    const [row] = await services.db
      .select({ task: delegationTasks, stage: delegations.stage })
      .from(delegationTasks)
      .innerJoin(delegations, eq(delegations.id, delegationTasks.delegationId))
      .where(eq(delegationTasks.id, final.id));
    if (
      row?.stage !== 'working' ||
      row.task.state !== 'done' ||
      row.task.mergeState !== 'waiting' ||
      row.task.stopPending ||
      !row.task.mergeClaimedAt ||
      row.task.checkedRevision !== revision
    )
      return { outcome: 'notSent' as const };
    try {
      const res = await externalEffect(
        'github.merge',
        () =>
          adapter.mergePullRequest({
            repo: pr.repo,
            number: pr.number,
            method: 'merge',
            sha: revision,
            title: `${title} (#${pr.number})`,
            message: 'Checked together and merged in Whombat.',
          }),
        { refused: githubRefused },
      );
      return res.merged
        ? { outcome: 'merged' as const }
        : { outcome: 'refused' as const, message: res.message };
    } catch (err) {
      // GitHub's own head guard: the pull request moved after its check.
      if (err instanceof GitHubError && err.status === 409) return { outcome: 'stale' as const };
      if (githubRefused(err))
        return { outcome: 'refused' as const, message: err instanceof Error ? err.message : String(err) };
      services.log.warn(
        { err: err instanceof Error ? err.message : String(err), delegationId: d.id },
        'delegation: GitHub did not answer the merge',
      );
      return { outcome: 'unknown' as const };
    }
  });
}

/** Sends tasks more work in their own threads; one T3 Code refuses ends as failed (and wakes the agent). */
export async function sendToTasks(
  services: Services,
  d: DelegationRow,
  sends: readonly TaskSend[],
): Promise<number> {
  if (!sends.length) return 0;
  const connection = await connectionOf(services, d);
  const lead = await leadName(services.db, d.agentId);
  const sent = await Promise.all(
    sends.map(async ({ task, message, deploy }) => {
      try {
        if (!connection || !task.threadId) throw new T3Failure('no_connection', 'No thread to send it to.');
        await callT3(
          services,
          connection,
          't3_thread_send',
          {
            threadId: task.threadId,
            message: deploy ? deployAgain(task, lead) : await followUp(services, task, message, lead),
            mode: 'auto',
          },
          'things.action',
        );
        return true;
      } catch {
        // Merged work that couldn't be given to its thread stays merged, and its row says why it isn't live.
        if (task.threadId)
          await services.pipeline
            .commit(
              taskEnded,
              {
                delegationId: d.id,
                threadId: task.threadId,
                state: 'failed',
                answer: null,
                pr: null,
                merged: deploy ? true : null,
              },
              opts(d),
            )
            .catch(
              warnFailed(services, d.id, 'delegation: ending a task its thread could not be told about'),
            );
        return false;
      }
    }),
  );
  return sent.filter(Boolean).length;
}

/** Stops tasks' threads that still work. A refusal leaves them to be tried again (`retryTaskStops`). */
export async function stopTaskThreads(
  services: Services,
  d: Pick<DelegationRow, 'id' | 'connectionId'>,
  tasks: readonly { id: string; threadId: string | null; stopTries?: number }[],
  reason: string,
): Promise<void> {
  const threads = [
    ...new Map(
      tasks
        .filter((t): t is { id: string; threadId: string; stopTries?: number } => !!t.threadId)
        .map((t) => [t.threadId, t]),
    ).values(),
  ];
  if (!threads.length) return;
  const [connection] = await services.db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, d.connectionId));
  // No connection any more: nothing can stop them, and nothing to try again.
  if (!connection)
    return stopsDone(
      services,
      threads.map((t) => t.id),
    );
  const row = connection as CatalogConnectionRow;
  await Promise.all(
    threads.map(async (t) => {
      const members = await services.db
        .select({ id: delegationTasks.id })
        .from(delegationTasks)
        .where(and(eq(delegationTasks.delegationId, d.id), eq(delegationTasks.threadId, t.threadId)));
      const ids = members.map((m) => m.id);
      try {
        await callT3(services, row, 't3_thread_interrupt', { threadId: t.threadId, reason }, 'things.action');
        await stopsDone(services, ids);
      } catch (err) {
        if (await threadOver(services, row, t.threadId, err)) return stopsDone(services, ids);
        services.log.warn(
          {
            err: err instanceof T3Failure ? err.code : err instanceof Error ? err.message : String(err),
            delegationId: d.id,
          },
          'delegation: a thread could not be stopped yet',
        );
        await stopLater(services, t.id, t.stopTries ?? 0);
      }
    }),
  );
}

/** T3 Code answered the stop: bookkeeping, nobody's change. */
async function stopsDone(services: Services, taskIds: readonly string[]): Promise<void> {
  if (!taskIds.length) return;
  await services.db
    .update(delegationTasks)
    .set({ stopPending: false, stopTries: 0, stopNextAt: null })
    .where(inArray(delegationTasks.id, [...taskIds]));
}

const STOP_RETRY_MS = 15_000;
const STOP_RETRY_MAX_MS = 15 * 60_000;

async function stopLater(services: Services, taskId: string, tries: number): Promise<void> {
  const wait = Math.min(STOP_RETRY_MS * 2 ** Math.min(tries, 10), STOP_RETRY_MAX_MS);
  await services.db
    .update(delegationTasks)
    .set({ stopPending: true, stopTries: tries + 1, stopNextAt: new Date(services.clock().getTime() + wait) })
    .where(eq(delegationTasks.id, taskId));
}

/** Threads still to be stopped: tried again on every pass, the ones never tried again first. */
async function retryTaskStops(services: Services): Promise<void> {
  const now = services.clock();
  const pending = await services.db
    .select({ task: delegationTasks, d: delegations })
    .from(delegationTasks)
    .innerJoin(delegations, eq(delegations.id, delegationTasks.delegationId))
    .where(
      and(
        eq(delegationTasks.stopPending, true),
        isNotNull(delegationTasks.threadId),
        or(isNull(delegationTasks.stopNextAt), lte(delegationTasks.stopNextAt, now)),
      ),
    )
    .orderBy(sql`${delegationTasks.stopNextAt} asc nulls first`)
    .limit(20);
  await Promise.all(
    pending.map(({ task, d }) => stopTaskThreads(services, d, [task], 'The task was stopped.')),
  );
}

/**
 * A thread T3 Code hasn't answered the start of for this long counts as not started (a crash between the commits), as
 * does one T3 Code has that still hasn't begun its first run.
 */
export const START_GRACE_MS = 10 * 60_000;

/**
 * Part of the T3 Code watcher's pass: stops tried again; a task whose thread never started failed; quiet delegations
 * ended; and tasks a restart left waiting started. Work is never stopped for taking long: the person sees how it goes
 * and can stop it.
 */
export async function sweepDelegations(services: Services): Promise<void> {
  const now = services.clock();
  await retryTaskStops(services);
  const quiet = await services.db
    .select({ id: delegations.id, burrowId: delegations.burrowId, agentId: delegations.agentId })
    .from(delegations)
    .where(
      and(
        inArray(delegations.stage, ['offer', 'working']),
        lt(delegations.updatedAt, new Date(now.getTime() - DELEGATION_QUIET_DAYS * 86_400_000)),
        // Expiring leaves a delegation with a task still working as it is: without this, those would fill every pass.
        sql`not exists (select 1 from ${delegationTasks} where ${delegationTasks.delegationId} = ${delegations.id} and ${delegationTasks.state} = 'working')`,
      ),
    )
    .orderBy(asc(delegations.updatedAt))
    .limit(10);
  for (const q of quiet)
    await services.pipeline
      .commit(expireDelegation, { delegationId: q.id }, opts(q))
      .catch(warnFailed(services, q.id, 'delegation sweep: expiring a quiet delegation'));
  // A candidate Whombat merged whose thread a restart never gave its deploy (no watch reads it): GitHub's record of the
  // merge finishes it.
  const unsent = await services.db
    .select({ task: delegationTasks, d: delegations })
    .from(delegationTasks)
    .innerJoin(delegations, eq(delegations.id, delegationTasks.delegationId))
    .where(
      and(
        eq(delegations.stage, 'working'),
        eq(delegations.integrationMode, 'batch'),
        eq(delegationTasks.kind, 'final'),
        eq(delegationTasks.state, 'working'),
        eq(delegationTasks.mergeState, 'merging'),
        lt(delegationTasks.mergeClaimedAt, new Date(now.getTime() - MERGE_CLAIM_MS)),
        sql`not exists (select 1 from ${t3Watches} where ${t3Watches.connectionId} = ${delegations.connectionId} and ${t3Watches.threadId} = ${delegationTasks.threadId} and ${t3Watches.state} = 'watching')`,
      ),
    )
    .limit(10);
  for (const { task, d } of unsent)
    await recordWhombatMerge(services, d, task, NOT_HANDED_ON).catch(
      warnFailed(services, d.id, 'delegation sweep: recording a merge'),
    );
  // A council that ended takes its checklist with it (its finish, its Stop): one a restart left live between the two
  // ends here, and what still works stops.
  const orphaned = await services.db
    .select({ d: delegations, council: councils.state })
    .from(delegations)
    .innerJoin(councils, eq(councils.id, delegations.councilId))
    .where(and(inArray(delegations.stage, ['offer', 'working']), ne(councils.state, 'active')))
    .limit(10);
  for (const { d, council } of orphaned) {
    try {
      // As the council's finish or Stop ends it: stopped while work was left or the council was stopped, else done.
      const tasks = await loadTasks(services.db, d.id);
      const stopped =
        council === 'stopped' || d.stage === 'offer' || !allOver(tasks, d.integrationMode === 'batch');
      const ended = await services.pipeline.commit(
        finishDelegation,
        {
          delegationId: d.id,
          summary: stopped ? DELEGATION_TEXT.withCouncilStopped : DELEGATION_TEXT.withCouncil,
          stopped,
          next: [],
          status: true,
        },
        opts(d),
      );
      if (ended.status === 'ok')
        await stopTaskThreads(services, d, ended.result.working, 'The council finished.');
    } catch (err) {
      warnFailed(services, d.id, 'delegation sweep: ending a delegation its council left')(err);
    }
  }
  const unstarted = await services.db
    .select({ task: delegationTasks, d: delegations })
    .from(delegationTasks)
    .innerJoin(delegations, eq(delegations.id, delegationTasks.delegationId))
    .where(
      and(
        eq(delegationTasks.state, 'working'),
        eq(delegations.stage, 'working'),
        isNull(delegationTasks.threadId),
        lt(delegationTasks.startedAt, new Date(now.getTime() - START_GRACE_MS)),
      ),
    )
    .limit(20);
  for (const { task, d } of unstarted)
    await services.pipeline
      .commit(taskLaunchFailed, { delegationId: d.id, taskId: task.id }, opts(d))
      .catch(warnFailed(services, d.id, 'delegation sweep: failing a task that never started'));
  // Pull requests merged another way while their tasks waited or after their threads gave up: the card says merged.
  const since = new Date(now.getTime() - DELEGATION_QUIET_DAYS * 86_400_000);
  const cleanup = await services.db
    .selectDistinct({ id: delegations.id, burrowId: delegations.burrowId, agentId: delegations.agentId })
    .from(t3Watches)
    .innerJoin(delegationTasks, eq(delegationTasks.id, t3Watches.delegationTaskId))
    .innerJoin(delegations, eq(delegations.id, delegationTasks.delegationId))
    .where(
      and(
        inArray(delegations.stage, ['done', 'stopped']),
        gt(delegations.endedAt, since),
        eq(t3Watches.state, 'idle'),
        inArray(t3Watches.status, ['completed', 'idle']),
        or(isNull(t3Watches.checkedAt), lt(t3Watches.checkedAt, delegations.endedAt)),
        eq(delegationTasks.stopPending, false),
      ),
    )
    .limit(10);
  for (const d of cleanup)
    await services.pipeline
      .commit(cleanupDelegationThreads, { delegationId: d.id }, opts(d))
      .catch(warnFailed(services, d.id, 'delegation sweep: cleaning up threads'));
  const elsewhere = await services.db
    .selectDistinct({ id: delegations.id, burrowId: delegations.burrowId, agentId: delegations.agentId })
    .from(delegationTasks)
    .innerJoin(delegations, eq(delegations.id, delegationTasks.delegationId))
    .innerJoin(
      pullRequests,
      and(
        eq(pullRequests.burrowId, delegations.burrowId),
        eq(pullRequests.state, 'merged'),
        sql`lower(${pullRequests.url}) = lower(${delegationTasks.pr})`,
      ),
    )
    .where(
      and(
        eq(delegationTasks.state, 'done'),
        sql`${delegationTasks.mergeState} is distinct from 'merged'`,
        or(
          eq(delegations.stage, 'working'),
          and(eq(delegations.stage, 'done'), gt(delegations.endedAt, since)),
        ),
      ),
    )
    .limit(10);
  for (const e of elsewhere)
    await services.pipeline
      .commit(mergedElsewhere, { delegationId: e.id }, opts(e))
      .catch(warnFailed(services, e.id, 'delegation sweep: marking a merge made elsewhere'));
  // Tasks whose turn came while nobody started them, and pull requests waiting while none merges (a restart between an
  // end and the next start).
  for (const d of await workingPage(services)) {
    try {
      let tasks = await services.db
        .select()
        .from(delegationTasks)
        .where(eq(delegationTasks.delegationId, d.id));
      if (d.merge && d.pullRequests && d.projectId && !tasks.some(isFinal)) {
        await services.pipeline.commit(ensureFinal, { delegationId: d.id }, opts(d));
        tasks = await loadTasks(services.db, d.id);
      }
      const legacyFinal = tasks.find((t) => isFinal(t) && t.state === 'done' && !t.checkedRevision);
      if (d.merge && legacyFinal) {
        await services.pipeline.commit(ensureFinal, { delegationId: d.id, invalidate: true }, opts(d));
        tasks = await loadTasks(services.db, d.id);
      }
      // Waiting for checks holds no place.
      if (busyTasks(tasks).length < d.atOnce && readyTasks(tasks, d.integrationMode === 'batch').length)
        await startReady(services, d.id, d.burrowId);
      const merging = tasks.some((t) => t.state === 'working' && t.mergeState === 'merging');
      if (!merging && mergesWaiting(tasks).length) await mergeReady(services, d.id, d.burrowId);
    } catch (err) {
      warnFailed(services, d.id, 'delegation sweep: moving a working delegation on')(err);
    }
  }
}

/** How many working delegations one pass moves on. */
const WORKING_PER_PASS = 20;
/** Per server, the last working delegation a pass looked at: the next pass goes on after it. */
const workingCursor = new WeakMap<Services, string>();

/**
 * The working delegations this pass looks at: the next `limit` after where the last pass stopped, by id, and from the
 * start again after the last page. Every one gets its turn, however many there are and whether or not a pass changes
 * them (a pass that changes nothing leaves their age as it was, so the oldest first would always be the same ones).
 */
export async function workingPage(services: Services, limit = WORKING_PER_PASS): Promise<DelegationRow[]> {
  const after = workingCursor.get(services);
  const page = await services.db
    .select()
    .from(delegations)
    .where(and(eq(delegations.stage, 'working'), after ? gt(delegations.id, after) : undefined))
    .orderBy(asc(delegations.id))
    .limit(limit);
  const last = page.at(-1);
  if (page.length < limit || !last) workingCursor.delete(services);
  else workingCursor.set(services, last.id);
  return page;
}

/** A delegation's step failed: say so in the log and go on; the next pass or event tries it again. */
function warnFailed(services: Services, delegationId: string, what: string): (err: unknown) => void {
  return (err) => services.log.warn({ err: String(err), delegationId }, `${what} failed`);
}

/** The person's Stop of one task or of all: its threads stop, and the next tasks may start. */
export async function afterPersonsStop(
  services: Services,
  d: DelegationRow,
  working: readonly DelegationTaskRow[],
): Promise<void> {
  await stopTaskThreads(services, d, working, 'The person stopped it.');
  if (d.stage === 'working') {
    await startReady(services, d.id, d.burrowId);
    await mergeReady(services, d.id, d.burrowId);
  }
}

/** A watch whose thread belongs to a task, for the watcher. */
export async function taskOfWatch(services: Services, delegationTaskId: string) {
  const [row] = await services.db
    .select({ task: delegationTasks, d: delegations })
    .from(delegationTasks)
    .innerJoin(delegations, eq(delegations.id, delegationTasks.delegationId))
    .where(eq(delegationTasks.id, delegationTaskId));
  return row ?? null;
}
