/** Independent GitHub reads keep a thread's completion text from certifying untested or changed work. */

import type { DelegationVerification } from '@whombat/core';
import type { DelegationRow, DelegationTaskRow } from '../db/schema/delegations';
import { githubScope } from '../managed/providers/github-adapter';
import type { Services } from '../services';
import { loadTasks } from './commands';
import {
  ciGate,
  type QueuedCheck,
  verificationError,
  verifyPullRequest,
  verifyRevision,
} from './github-verification';
import { eligibleIntegration, isFinal } from './state';
import { inputFingerprint, verificationPassed } from './verification';

export function githubPr(url: string | null): { repo: string; number: number } | null {
  const match = url?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/i);
  return match ? { repo: match[1] as string, number: Number(match[2]) } : null;
}

/**
 * How the final check is done: `ci` waits for the checks the default branch requires on GitHub; `local` (it requires
 * none) runs the repository's fast tests or quick checks in the thread and doesn't wait for CI. When GitHub can't say,
 * it waits.
 */
export async function finalGate(
  services: Services,
  d: DelegationRow,
  tasks: readonly DelegationTaskRow[],
): Promise<'ci' | 'local'> {
  const adapter = services.github.adapter;
  const repo = tasks.map((t) => githubPr(t.pr)).find(Boolean)?.repo;
  if (!adapter || !repo) return 'ci';
  try {
    return await githubScope.run({ burrowId: d.burrowId }, async () =>
      ciGate(adapter, repo, d.baseBranch ?? (await adapter.getRepo(repo)).defaultBranch),
    );
  } catch (err) {
    services.log.warn({ err, delegationId: d.id }, 'delegation: could not read the required checks');
    return 'ci';
  }
}

export async function verifyFinal(
  services: Services,
  d: DelegationRow,
  task: DelegationTaskRow,
  proof: DelegationVerification | null,
  pr: string | null,
  requireMerged = false,
): Promise<{ ok: boolean; reason?: string; message?: string; merged?: boolean; queued?: QueuedCheck[] }> {
  const tasks = await loadTasks(services.db, d.id);
  const current = tasks.find((t) => t.id === task.id);
  if (!current || current.groupId !== task.groupId || current.threadId !== task.threadId)
    return { ok: false, reason: 'stale', message: 'This combined check has been replaced.' };
  task = current;
  if (
    !verificationPassed(proof, inputFingerprint(tasks), task.checkGeneration) ||
    proof?.inputs !== task.checkedInputs ||
    proof?.generation !== task.checkedGeneration
  )
    return { ok: false, reason: 'stale', message: 'The combined check does not cover the current work.' };
  if (!proof) return { ok: false, reason: 'failed' };
  const adapter = services.github.adapter;
  if (!adapter)
    return { ok: false, reason: 'unavailable', message: 'Connect GitHub to confirm the combined check.' };
  const candidate = githubPr(pr);
  const sources = [
    ...eligibleIntegration(tasks),
    ...tasks.filter((t) => !isFinal(t) && t.mergeState === 'merged'),
  ];
  const sourcePrs = [
    ...new Map(
      sources.flatMap((t) => {
        const parsed = githubPr(t.pr);
        return parsed ? [[`${parsed.repo.toLowerCase()}/${parsed.number}`, parsed] as const] : [];
      }),
    ).values(),
  ];
  const repo = candidate?.repo ?? sourcePrs[0]?.repo;
  if (!repo || sourcePrs.some((p) => p.repo.toLowerCase() !== repo.toLowerCase()))
    return {
      ok: false,
      reason: 'unavailable',
      message: 'The combined work could not be matched to one GitHub repository.',
    };
  if (
    proof &&
    ((task.checkedRevision && task.checkedRevision !== proof.revision) ||
      (task.checkedBase && task.checkedBase !== proof.base))
  )
    return { ok: false, reason: 'stale', message: 'The saved combined check covers a different revision.' };
  const expected = proof.expected;
  try {
    return await githubScope.run({ burrowId: d.burrowId }, async () => {
      // What CI ran on the work before it was combined: the source heads, and the revision's own first parent unless
      // that is the default branch (a pull request brought up to date has its previous head there).
      const heads = await Promise.all(
        sourcePrs.map(async (source) => (await adapter.getPullRequest(repo, source.number)).headSha),
      );
      const parent = await adapter.commitParent(repo, proof.revision).catch(() => null);
      const peers = [...heads, ...(parent && parent !== proof.base ? [parent] : [])];
      const checked = candidate
        ? await verifyPullRequest(adapter, repo, candidate.number, {
            revision: proof.revision,
            base: proof.base,
            expectedContexts: expected,
            peers,
            requireMerged,
          })
        : await verifyRevision(adapter, repo, d.baseBranch ?? (await adapter.getRepo(repo)).defaultBranch, {
            revision: proof.revision,
            base: proof.base,
            expectedContexts: expected,
          });
      if (!checked.ok) return checked;
      // Source branches may have changed outside this card while the integration thread was running.
      for (const source of sourcePrs) {
        const head = (await adapter.getPullRequest(repo, source.number)).headSha;
        const status = await adapter.compareStatus(repo, head, proof.revision);
        if (status !== 'ahead' && status !== 'identical')
          return {
            ok: false,
            reason: 'stale',
            message: 'A task changed after the combined candidate was prepared.',
          };
      }
      return { ok: true, merged: candidate ? checked.merged : true };
    });
  } catch (err) {
    services.log.warn({ err, delegationId: d.id }, 'delegation: could not confirm combined checks');
    return {
      ok: false,
      reason: 'unavailable',
      message: verificationError(err),
    };
  }
}
