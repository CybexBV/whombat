import { DELEGATION_TASK_NOTE_MAX } from '@whombat/core';
import { type GhCheckRun, type GhCommitStatus, type GitHubAdapter, GitHubError } from '../github/adapter';

export interface RevisionProof {
  revision: string;
  base: string;
  expectedContexts?: readonly string[];
  /** Heads of the pull requests the revision combines: the checks CI ran on them are the ones it runs on pull requests. */
  peers?: readonly string[];
}

export type GitHubVerification =
  | {
      ok: true;
      revision: string;
      head: string;
      mergeRevision: string | null;
      base: string;
      merged: boolean;
      expectedContexts: string[];
    }
  | {
      ok: false;
      reason: 'waiting' | 'stale' | 'failed' | 'unavailable';
      message: string;
      /** While waiting: the checks that haven't started, and since when (null: none reported it yet). */
      queued?: QueuedCheck[];
    };

/** A check that waits to start: GitHub's queued run, or a pending status whose CI says it waits in its queue. */
export interface QueuedCheck {
  name: string;
  since: string | null;
}

type Failure = Extract<GitHubVerification, { ok: false }>;
const fail = (reason: Failure['reason'], message: string): Failure => ({ ok: false, reason, message });

/** Keep GitHub's actionable refusal, bounded for the task's note; arbitrary exceptions stay in server logs. */
export function verificationError(err: unknown): string {
  return err instanceof GitHubError
    ? `GitHub verification is blocked: ${err.message.replace(/\s+/g, ' ').trim()}`.slice(
        0,
        DELEGATION_TASK_NOTE_MAX,
      )
    : 'GitHub could not confirm the required checks and revision.';
}

function validProof(proof: RevisionProof): boolean {
  return (
    /^[a-f0-9]{40}$/.test(proof.revision) &&
    /^[a-f0-9]{40}$/.test(proof.base) &&
    (proof.expectedContexts ?? []).every((name) => Boolean(name.trim()))
  );
}

async function evidence(adapter: GitHubAdapter, repo: string, revision: string) {
  const [runs, statuses] = await Promise.all([
    adapter.checkRuns(repo, revision, null),
    adapter.commitStatuses(repo, revision),
  ]);
  if (!runs.modified) throw new Error('An unconditional check read returned no evidence.');
  if (runs.data.some((run) => run.headSha !== revision || !run.name || !Number.isInteger(run.id)))
    throw new Error('A check run did not identify the requested revision.');
  return { runs: runs.data, statuses };
}

function latest<T extends { id: number }>(items: readonly T[], name: (item: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of items) {
    const key = name(item);
    if (!out.has(key) || (out.get(key)?.id ?? -1) < item.id) out.set(key, item);
  }
  return out;
}

/** A check the final thread ran itself (`local: pnpm check`): its own report, never a name GitHub shows. */
export const isLocalCheck = (name: string) => /^local:/i.test(name.trim());

/** Whether the default branch requires checks on GitHub before a merge (its branch protection or rules). */
export async function ciGate(adapter: GitHubAdapter, repo: string, branch: string): Promise<'ci' | 'local'> {
  return (await adapter.requiredStatusChecks(repo, branch)).length ? 'ci' : 'local';
}

/** CI results GitHub shows that already failed on the revision: those still stop a merge that doesn't wait for CI. */
function failedOn(observed: { runs: GhCheckRun[]; statuses: GhCommitStatus[] }): string | null {
  const runs = latest<GhCheckRun>(observed.runs, (run) => run.name);
  const statuses = latest<GhCommitStatus>(observed.statuses, (status) => status.context);
  for (const [name, run] of runs)
    if (run.status === 'completed' && (run.conclusion === 'failure' || run.conclusion === 'timed_out'))
      return name;
  for (const [name, status] of statuses)
    if (status.state === 'failure' || status.state === 'error') return name;
  return null;
}

async function verifyChecks(
  adapter: GitHubAdapter,
  repo: string,
  branch: string,
  proof: RevisionProof,
): Promise<{ ok: true; expectedContexts: string[] } | Failure> {
  const [required, observed] = await Promise.all([
    adapter.requiredStatusChecks(repo, branch),
    evidence(adapter, repo, proof.revision),
  ]);
  // A repository that requires nothing on GitHub before merging is merged like a person merges it: once its fast
  // tests or quick checks passed on this revision (the final thread's report). Its CI still runs, but isn't waited for;
  // a CI result that already failed here still stops it (docs/decisions/fast-testing.md).
  if (!required.length) {
    const failed = failedOn(observed);
    return failed
      ? fail('failed', `${failed} did not pass on the checked revision.`)
      : { ok: true, expectedContexts: [] };
  }
  const names = new Set([
    ...required,
    ...(proof.expectedContexts ?? []).filter((name) => !isLocalCheck(name)),
  ]);
  const peers = [...new Set(proof.peers ?? [])].filter((sha) => sha !== proof.revision);
  const runs = latest<GhCheckRun>(observed.runs, (run) => run.name);
  const statuses = latest<GhCommitStatus>(observed.statuses, (status) => status.context);
  // Reported checks also have to finish: a required green job must not hide another failing job.
  for (const name of runs.keys()) names.add(name);
  for (const name of statuses.keys()) names.add(name);
  const twins = await sameFiles(adapter, repo, proof.revision, peers);
  const queued: QueuedCheck[] = [];
  let problem: Failure | null = null;
  for (const name of [...names].sort()) {
    const run = runs.get(name);
    const status = statuses.get(name);
    // CI checks files: one that passed on exactly these files elsewhere needn't run again here. A result of its own
    // that failed still counts.
    const ownFailed =
      (run?.status === 'completed' && run.conclusion !== 'success') ||
      (!!status && status.state !== 'success' && status.state !== 'pending');
    if (!ownFailed && twins.some((twin) => passed(twin, name))) continue;
    if (!run && !status) {
      queued.push({ name, since: null });
      problem ??= fail('waiting', `Waiting for ${name} to report on the checked revision.`);
      continue;
    }
    if ((run && run.status !== 'completed') || status?.state === 'pending') {
      const since = queuedSince(run, status);
      if (since !== undefined) queued.push({ name, since });
      problem ??= fail('waiting', `${name} is still running on the checked revision.`);
      continue;
    }
    if ((run && run.conclusion !== 'success') || (status && status.state !== 'success'))
      problem ??= fail('failed', `${name} did not pass on the checked revision.`);
  }
  // The first problem in name order decides, as before; while it waits, say what hasn't started.
  if (problem) return problem.reason === 'waiting' ? { ...problem, queued } : problem;
  return { ok: true, expectedContexts: [...names].sort() };
}

interface Reports {
  runs: Map<string, GhCheckRun>;
  statuses: Map<string, GhCommitStatus>;
}

/** The reports on those of the commits with exactly the revision's files. */
async function sameFiles(
  adapter: GitHubAdapter,
  repo: string,
  revision: string,
  peers: readonly string[],
): Promise<Reports[]> {
  if (!peers.length) return [];
  const tree = await adapter.commitTree(repo, revision).catch(() => null);
  if (!tree) return [];
  const out: Reports[] = [];
  for (const peer of peers) {
    if ((await adapter.commitTree(repo, peer).catch(() => null)) !== tree) continue;
    const seen = await evidence(adapter, repo, peer).catch(() => null);
    if (seen)
      out.push({
        runs: latest<GhCheckRun>(seen.runs, (run) => run.name),
        statuses: latest<GhCommitStatus>(seen.statuses, (status) => status.context),
      });
  }
  return out;
}

function passed(reports: Reports, name: string): boolean {
  const run = reports.runs.get(name);
  const status = reports.statuses.get(name);
  return (
    (!!run || !!status) &&
    (!run || (run.status === 'completed' && run.conclusion === 'success')) &&
    (!status || status.state === 'success')
  );
}

const QUEUED_RUN = new Set(['queued', 'waiting', 'pending', 'requested']);
const QUEUE_WORDS = /\b(queue|queued|waiting|not started|scheduled)\b/i;

/**
 * Since when a check that hasn't finished waits to start: a run GitHub still has queued, or a pending status whose
 * description says it waits (our CI posts “Waiting in the CI queue”, then “Shared CI verification.” once it runs).
 * Undefined: it is running.
 */
function queuedSince(
  run: GhCheckRun | undefined,
  status: GhCommitStatus | undefined,
): string | null | undefined {
  if (run && run.status !== 'completed') return QUEUED_RUN.has(run.status) ? run.startedAt : undefined;
  if (status?.state === 'pending' && QUEUE_WORDS.test(status.description ?? '')) return status.createdAt;
  return undefined;
}

/** Checks the PR and CI against the exact revision the final worker says it tested. */
export async function verifyPullRequest(
  adapter: GitHubAdapter,
  repo: string,
  number: number,
  proof: RevisionProof & { requireMerged?: boolean },
): Promise<GitHubVerification> {
  if (!validProof(proof))
    return fail('stale', 'The checked revision and base must identify complete commits.');
  try {
    const pr = await adapter.getPullRequest(repo, number);
    if (pr.draft) return fail('stale', 'The pull request is still a draft.');
    if (!pr.merged && pr.state !== 'open')
      return fail('stale', 'The pull request was closed without merging.');
    if (proof.requireMerged && !pr.merged) return fail('waiting', 'The pull request has not merged yet.');
    const branch = await adapter.branchHead(repo, pr.baseRef, null);
    if (!branch.modified || !branch.data)
      return fail('unavailable', 'GitHub could not confirm the base branch.');
    if (!pr.merged) {
      if (pr.headSha !== proof.revision || branch.data !== proof.base)
        return fail('stale', 'The pull request or its base changed after the final checks.');
    } else {
      if (!pr.mergeCommitSha || (proof.revision !== pr.headSha && proof.revision !== pr.mergeCommitSha))
        return fail('stale', 'The checked revision does not match the merged pull request.');
      const relation = await adapter.compareStatus(repo, pr.mergeCommitSha, branch.data);
      if (relation !== 'ahead' && relation !== 'identical')
        return fail('stale', 'The merged revision is no longer in the base branch.');
      if (proof.revision !== pr.mergeCommitSha) {
        const [headTree, mergeTree, parent] = await Promise.all([
          adapter.commitTree(repo, pr.headSha),
          adapter.commitTree(repo, pr.mergeCommitSha),
          adapter.commitParent(repo, pr.mergeCommitSha),
        ]);
        if (!headTree || headTree !== mergeTree || parent !== proof.base)
          return fail('stale', 'The merged files or base differ from what received the final checks.');
      } else {
        const baseRelation = await adapter.compareStatus(repo, proof.base, proof.revision);
        if (baseRelation !== 'ahead' && baseRelation !== 'identical')
          return fail('stale', 'The checked merge does not include the checked base.');
      }
    }
    const checks = await verifyChecks(adapter, repo, pr.baseRef, proof);
    if (!checks.ok) return checks;
    const [currentPr, currentBranch] = await Promise.all([
      adapter.getPullRequest(repo, number),
      adapter.branchHead(repo, pr.baseRef, null),
    ]);
    if (
      currentPr.headSha !== pr.headSha ||
      currentPr.baseRef !== pr.baseRef ||
      currentPr.merged !== pr.merged ||
      currentPr.mergeCommitSha !== pr.mergeCommitSha ||
      currentPr.state !== pr.state ||
      currentPr.draft ||
      !currentBranch.modified ||
      currentBranch.data !== branch.data
    )
      return fail('stale', 'The pull request or base changed while GitHub was being checked.');
    return {
      ok: true,
      revision: proof.revision,
      head: pr.headSha,
      mergeRevision: pr.mergeCommitSha,
      base: proof.base,
      merged: pr.merged,
      expectedContexts: checks.expectedContexts,
    };
  } catch (err) {
    return fail('unavailable', verificationError(err));
  }
}

/** Confirms a final checked main revision when all source work is already merged. */
export async function verifyRevision(
  adapter: GitHubAdapter,
  repo: string,
  branch: string,
  proof: RevisionProof,
): Promise<GitHubVerification> {
  if (!validProof(proof) || proof.revision !== proof.base)
    return fail('stale', 'The final checks must cover the current base revision.');
  try {
    const before = await adapter.branchHead(repo, branch, null);
    if (!before.modified || before.data !== proof.revision)
      return fail('stale', 'The base branch changed after the final checks.');
    const checks = await verifyChecks(adapter, repo, branch, proof);
    if (!checks.ok) return checks;
    const after = await adapter.branchHead(repo, branch, null);
    if (!after.modified || after.data !== proof.revision)
      return fail('stale', 'The base branch changed while GitHub was being checked.');
    return {
      ok: true,
      revision: proof.revision,
      head: proof.revision,
      mergeRevision: null,
      base: proof.base,
      merged: false,
      expectedContexts: checks.expectedContexts,
    };
  } catch (err) {
    return fail('unavailable', verificationError(err));
  }
}
