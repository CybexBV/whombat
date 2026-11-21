import type { DelegationVerification } from '@whombat/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegationRow, DelegationTaskRow } from '../db/schema/delegations';
import { GitHubError } from '../github/adapter';
import { githubScope } from '../managed/providers/github-adapter';
import type { Services } from '../services';
import { type GitHubVerification, verifyPullRequest, verifyRevision } from './github-verification';
import { inputFingerprint } from './verification';
import { verifyFinal } from './verify-final';

vi.mock('./github-verification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./github-verification')>()),
  verifyPullRequest: vi.fn(),
  verifyRevision: vi.fn(),
}));

const repo = 'example/project';
const candidate = `https://github.com/${repo}/pull/99`;
const revision = 'a'.repeat(40);
const base = 'b'.repeat(40);
const sourceHead = 'c'.repeat(40);
const at = new Date('2026-11-07T12:00:00Z');

function success(over: Partial<Extract<GitHubVerification, { ok: true }>> = {}): GitHubVerification {
  return {
    ok: true,
    revision,
    head: revision,
    mergeRevision: null,
    base,
    merged: false,
    expectedContexts: ['ci/check'],
    ...over,
  };
}

function task(id: string, fields: Partial<DelegationTaskRow> = {}): DelegationTaskRow {
  return {
    id,
    delegationId: 'delegation',
    burrowId: 'burrow',
    position: 0,
    createdAt: at,
    kind: 'task',
    state: 'done',
    attempt: 1,
    picked: true,
    afterId: null,
    mergeState: 'waiting',
    checks: 'passing',
    groupId: 'source-group',
    threadId: 'source-thread',
    sendPending: null,
    stopPending: false,
    pr: `https://github.com/${repo}/pull/11`,
    branch: `delegate/${id}`,
    answer: 'Finished the requested changes.',
    checkGeneration: 0,
    checkedGeneration: null,
    checksStuckAt: null,
    checkedInputs: null,
    checkedRevision: null,
    checkedBase: null,
    ...fields,
  } as DelegationTaskRow;
}

function fixture() {
  const source = task('source');
  const final = task('final', {
    kind: 'final',
    position: 99,
    groupId: 'final-group',
    threadId: 'final-thread',
    checkGeneration: 3,
    checkedGeneration: 3,
    checkedRevision: revision,
    checkedBase: base,
    pr: candidate,
  });
  const rows = [source, final];
  const proof: DelegationVerification = {
    revision,
    base,
    inputs: inputFingerprint(rows),
    generation: 3,
    expected: ['ci/check'],
    results: [{ name: 'ci/check', revision, state: 'passing' }],
  };
  final.checkedInputs = proof.inputs;
  const orderBy = vi.fn(async () => rows);
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const db = { select: vi.fn(() => ({ from })) };
  const adapter = {
    getPullRequest: vi.fn(async (_repo: string, _number: number) => ({ headSha: sourceHead })),
    compareStatus: vi.fn(async (_repo: string, _base: string, _head: string) => 'ahead'),
    getRepo: vi.fn(async (_repo: string) => ({ defaultBranch: 'trunk' })),
    commitParent: vi.fn(async (_repo: string, _sha: string): Promise<string | null> => base),
  };
  const github: { adapter: typeof adapter | null } = { adapter };
  const log = { warn: vi.fn() };
  const services = { db, github, log } as unknown as Services;
  const delegation = { id: 'delegation', burrowId: 'burrow', baseBranch: 'main' } as DelegationRow;
  const refreshInputs = () => {
    proof.inputs = inputFingerprint(rows);
    final.checkedInputs = proof.inputs;
  };
  const verify = (pr: string | null = candidate, requireMerged = false) =>
    verifyFinal(services, delegation, final, proof, pr, requireMerged);
  return {
    source,
    final,
    rows,
    proof,
    db,
    adapter,
    github,
    log,
    services,
    delegation,
    refreshInputs,
    verify,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(verifyPullRequest).mockResolvedValue(success());
  vi.mocked(verifyRevision).mockResolvedValue(success({ revision: base, head: base, base }));
});

describe('independent final verification', () => {
  it('checks the exact candidate and current source heads in the delegation’s GitHub scope', async () => {
    const f = fixture();
    vi.mocked(verifyPullRequest).mockImplementationOnce(async () => {
      expect(githubScope.getStore()).toEqual({ burrowId: f.delegation.burrowId });
      return success();
    });
    expect(await f.verify()).toEqual({ ok: true, merged: false });
    expect(f.db.select).toHaveBeenCalledOnce();
    expect(verifyPullRequest).toHaveBeenCalledWith(f.adapter, repo, 99, {
      revision,
      base,
      expectedContexts: ['ci/check'],
      peers: [sourceHead],
      requireMerged: false,
    });
    expect(f.adapter.getPullRequest).toHaveBeenCalledWith(repo, 11);
    expect(f.adapter.compareStatus).toHaveBeenCalledWith(repo, sourceHead, revision);
    expect(verifyRevision).not.toHaveBeenCalled();
    expect(githubScope.getStore()).toBeUndefined();
  });

  it.each(['behind', 'diverged', 'unknown'])(
    'rejects a current source head whose relation is %s',
    async (relation) => {
      const f = fixture();
      const movedHead = 'd'.repeat(40);
      f.adapter.getPullRequest.mockResolvedValue({ headSha: movedHead });
      f.adapter.compareStatus.mockResolvedValue(relation);
      expect(await f.verify()).toMatchObject({ ok: false, reason: 'stale' });
      expect(f.adapter.compareStatus).toHaveBeenCalledWith(repo, movedHead, revision);
    },
  );

  it('accepts a source head identical to the checked candidate', async () => {
    const f = fixture();
    f.adapter.getPullRequest.mockResolvedValue({ headSha: revision });
    f.adapter.compareStatus.mockResolvedValue('identical');
    expect(await f.verify()).toMatchObject({ ok: true });
  });

  it('rejects source work from another repository before asking GitHub to certify it', async () => {
    const f = fixture();
    f.source.pr = 'https://github.com/example/another-project/pull/11';
    f.refreshInputs();
    expect(await f.verify()).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(verifyPullRequest).not.toHaveBeenCalled();
    expect(f.adapter.getPullRequest).not.toHaveBeenCalled();
  });

  it('accepts repository names with different letter casing', async () => {
    const f = fixture();
    f.source.pr = 'https://github.com/EXAMPLE/PROJECT/pull/11';
    f.refreshInputs();
    expect(await f.verify()).toMatchObject({ ok: true });
  });

  it('rejects a fingerprint that no longer covers the source work', async () => {
    const f = fixture();
    f.source.answer = 'Changed the work after the combined check.';
    expect(await f.verify()).toMatchObject({ ok: false, reason: 'stale' });
    expect(verifyPullRequest).not.toHaveBeenCalled();
  });

  it.each(['proof-generation', 'saved-generation', 'saved-inputs', 'saved-revision', 'saved-base'] as const)(
    'rejects a mismatched %s',
    async (field) => {
      const f = fixture();
      if (field === 'proof-generation') f.proof.generation--;
      if (field === 'saved-generation') f.final.checkedGeneration = (f.final.checkedGeneration ?? 0) + 1;
      if (field === 'saved-inputs') f.final.checkedInputs = 'd'.repeat(64);
      if (field === 'saved-revision') f.final.checkedRevision = 'd'.repeat(40);
      if (field === 'saved-base') f.final.checkedBase = 'd'.repeat(40);
      expect(await f.verify()).toMatchObject({ ok: false, reason: 'stale' });
      expect(verifyPullRequest).not.toHaveBeenCalled();
    },
  );

  it('allows the first preparation before revision and base are saved', async () => {
    const f = fixture();
    f.final.checkedRevision = null;
    f.final.checkedBase = null;
    expect(await f.verify()).toMatchObject({ ok: true });
  });

  it.each(['checkGeneration', 'groupId', 'threadId'] as const)(
    'rejects a newer database %s even when the passed task snapshot is old',
    async (field) => {
      const f = fixture();
      const current = { ...f.final };
      if (field === 'checkGeneration') current.checkGeneration++;
      else current[field] = 'another-attempt';
      f.rows[1] = current;
      expect(await f.verify()).toMatchObject({ ok: false, reason: 'stale' });
      expect(verifyPullRequest).not.toHaveBeenCalled();
    },
  );

  it('rejects an old task snapshot when the final row was removed', async () => {
    const f = fixture();
    f.rows.splice(1, 1);
    expect(await f.verify()).toMatchObject({ ok: false, reason: 'stale' });
    expect(verifyPullRequest).not.toHaveBeenCalled();
  });

  it('checks the current main revision directly when all work is already merged', async () => {
    const f = fixture();
    f.source.mergeState = 'merged';
    f.final.checkedRevision = base;
    f.proof.revision = base;
    f.proof.results = [{ name: 'ci/check', revision: base, state: 'passing' }];
    expect(await f.verify(null)).toEqual({ ok: true, merged: true });
    expect(verifyRevision).toHaveBeenCalledWith(f.adapter, repo, 'main', {
      revision: base,
      base,
      expectedContexts: ['ci/check'],
    });
    expect(verifyPullRequest).not.toHaveBeenCalled();
    expect(f.adapter.compareStatus).toHaveBeenCalledWith(repo, sourceHead, base);
  });

  it('reads the repository’s default branch when no base branch was saved', async () => {
    const f = fixture();
    f.delegation.baseBranch = null;
    f.source.mergeState = 'merged';
    f.final.checkedRevision = base;
    f.proof.revision = base;
    f.proof.results = [{ name: 'ci/check', revision: base, state: 'passing' }];
    expect(await f.verify(null)).toMatchObject({ ok: true });
    expect(f.adapter.getRepo).toHaveBeenCalledWith(repo);
    expect(verifyRevision).toHaveBeenCalledWith(f.adapter, repo, 'trunk', expect.any(Object));
  });

  it('does not certify work while GitHub is disconnected', async () => {
    const f = fixture();
    f.github.adapter = null;
    expect(await f.verify()).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(verifyPullRequest).not.toHaveBeenCalled();
  });

  it('preserves an independent GitHub check’s waiting or failure result', async () => {
    const f = fixture();
    const unavailable = { ok: false, reason: 'unavailable', message: 'GitHub is unavailable.' } as const;
    vi.mocked(verifyPullRequest).mockResolvedValue(unavailable);
    expect(await f.verify()).toEqual(unavailable);
    expect(f.adapter.compareStatus).not.toHaveBeenCalled();
  });

  it('returns unavailable and logs the cause when a source GitHub read fails', async () => {
    const f = fixture();
    f.adapter.getPullRequest.mockRejectedValue(new Error('GitHub request failed'));
    expect(await f.verify()).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(f.log.warn).toHaveBeenCalledOnce();
  });

  it('keeps the specific access blocker when a source GitHub read is refused', async () => {
    const f = fixture();
    f.adapter.getPullRequest.mockRejectedValue(
      new GitHubError('Resource not accessible by integration', 403),
    );
    expect(await f.verify()).toMatchObject({
      ok: false,
      reason: 'unavailable',
      message: expect.stringContaining('Resource not accessible by integration'),
    });
  });

  it('forwards the merged requirement and reports the verified merge state', async () => {
    const f = fixture();
    vi.mocked(verifyPullRequest).mockResolvedValue(success({ merged: true, mergeRevision: 'd'.repeat(40) }));
    expect(await f.verify(candidate, true)).toEqual({ ok: true, merged: true });
    expect(verifyPullRequest).toHaveBeenCalledWith(
      f.adapter,
      repo,
      99,
      expect.objectContaining({ requireMerged: true }),
    );
  });

  it('accepts multiple grouped task rows sharing the same source pull request', async () => {
    const f = fixture();
    f.rows.push(task('grouped-source', { afterId: f.source.id, position: 1 }));
    f.refreshInputs();
    expect(await f.verify()).toMatchObject({ ok: true });
    expect(f.adapter.getPullRequest.mock.calls.every(([, number]) => number === 11)).toBe(true);
  });
});
