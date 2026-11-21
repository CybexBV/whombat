import { describe, expect, it, vi } from 'vitest';
import { GitHubError } from '../github/adapter';
import { FakeGitHub } from '../github/fake';
import { ciGate, verifyPullRequest, verifyRevision } from './github-verification';

const repo = 'test/delegation-proof';

async function fixture() {
  const github = new FakeGitHub();
  const state = await github.addRepo({ fullName: repo });
  const base = state.branches.get('main') as string;
  const number = await github.simulateOpenPullRequest({ repo, head: 'task', title: 'Change', login: 'john' });
  const pr = await github.getPullRequest(repo, number);
  const proof = { revision: pr.headSha, base };
  state.requiredChecks.set('main', ['ci/check']);
  state.statuses.set(pr.headSha, [
    { id: 1, context: 'ci/check', state: 'success', createdAt: null, updatedAt: null, url: null },
  ]);
  const verify = () => verifyPullRequest(github, repo, number, proof);
  return { github, state, number, proof, verify };
}

describe('authoritative delegation checks', () => {
  it('preserves an actionable GitHub refusal for both candidate and base verification', async () => {
    const f = await fixture();
    vi.spyOn(f.github, 'requiredStatusChecks').mockRejectedValue(
      new GitHubError('Resource not accessible by integration', 403),
    );
    for (const result of [
      await f.verify(),
      await verifyRevision(f.github, repo, 'main', { revision: f.proof.base, base: f.proof.base }),
    ]) {
      expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
      expect(!result.ok && result.message).toContain('Resource not accessible by integration');
    }
  });
  it('accepts a successful commit status on the exact PR head', async () => {
    const f = await fixture();
    expect(await f.verify()).toMatchObject({
      ok: true,
      head: f.proof.revision,
      merged: false,
      expectedContexts: ['ci/check'],
    });
  });

  it.each(['pending', 'failure', 'error'] as const)('does not accept a %s commit status', async (state) => {
    const f = await fixture();
    const status = f.state.statuses.get(f.proof.revision)?.[0];
    if (status) status.state = state;
    expect(await f.verify()).toMatchObject({ ok: false, reason: state === 'pending' ? 'waiting' : 'failed' });
  });

  it('says which checks haven’t started yet, apart from ones that run', async () => {
    const f = await fixture();
    f.state.requiredChecks.set('main', ['ci/check', 'ci/app', 'ci/package', 'ci/lint']);
    f.state.statuses.set(f.proof.revision, [
      // Our CI while it waits in its queue, and once it runs.
      {
        id: 1,
        context: 'ci/check',
        state: 'pending',
        description: 'Waiting in the CI queue',
        createdAt: '2026-11-07T12:59:32Z',
        updatedAt: null,
        url: null,
      },
      {
        id: 2,
        context: 'ci/app',
        state: 'pending',
        description: 'Shared CI verification.',
        createdAt: '2026-11-07T13:00:40Z',
        updatedAt: null,
        url: null,
      },
    ]);
    await f.github.simulateCheckRun({ repo, sha: f.proof.revision, name: 'ci/lint', status: 'queued' });
    const waiting = await f.verify();
    expect(waiting).toMatchObject({ ok: false, reason: 'waiting' });
    const queued = !waiting.ok ? (waiting.queued ?? []) : [];
    expect(queued.map((q) => q.name).sort()).toEqual(['ci/check', 'ci/lint', 'ci/package']);
    expect(queued.find((q) => q.name === 'ci/check')?.since).toBe('2026-11-07T12:59:32Z');
    // Never reported at all: since when isn't known here.
    expect(queued.find((q) => q.name === 'ci/package')?.since).toBeNull();
  });

  it('waits for every required name, even when an early check is green', async () => {
    const f = await fixture();
    f.state.requiredChecks.set('main', ['ci/check', 'ci/package']);
    expect(await f.verify()).toMatchObject({ ok: false, reason: 'waiting' });
  });

  it('without required checks, merges on the thread’s own check and doesn’t wait for CI', async () => {
    const f = await fixture();
    f.state.requiredChecks.clear();
    expect(await ciGate(f.github, repo, 'main')).toBe('local');
    const local = { ...f.proof, expectedContexts: ['local: pnpm check'] };
    // CI still queued or never reported: not waited for.
    const status = f.state.statuses.get(f.proof.revision)?.[0];
    if (status) status.state = 'pending';
    expect(await verifyPullRequest(f.github, repo, f.number, local)).toMatchObject({
      ok: true,
      expectedContexts: [],
    });
    f.state.statuses.delete(f.proof.revision);
    expect(await verifyPullRequest(f.github, repo, f.number, local)).toMatchObject({ ok: true });
    expect(
      await verifyRevision(f.github, repo, 'main', { revision: f.proof.base, base: f.proof.base }),
    ).toMatchObject({ ok: true });
  });

  it('without required checks, a CI result that already failed still stops the merge', async () => {
    const f = await fixture();
    f.state.requiredChecks.clear();
    const status = f.state.statuses.get(f.proof.revision)?.[0];
    if (status) status.state = 'failure';
    expect(await f.verify()).toMatchObject({ ok: false, reason: 'failed' });
    if (status) status.state = 'success';
    await f.github.simulateCheckRun({ repo, sha: f.proof.revision, name: 'ci/app', conclusion: 'failure' });
    expect(await f.verify()).toMatchObject({
      ok: false,
      reason: 'failed',
      message: expect.stringContaining('ci/app'),
    });
  });

  it('with required checks, a thread’s own local check never stands in for them', async () => {
    const f = await fixture();
    expect(await ciGate(f.github, repo, 'main')).toBe('ci');
    const local = { ...f.proof, expectedContexts: ['local: pnpm check'] };
    expect(await verifyPullRequest(f.github, repo, f.number, local)).toMatchObject({
      ok: true,
      expectedContexts: ['ci/check'],
    });
    f.state.statuses.delete(f.proof.revision);
    expect(await verifyPullRequest(f.github, repo, f.number, local)).toMatchObject({
      ok: false,
      reason: 'waiting',
    });
  });

  it('counts a pass on a commit with exactly the same files, but never over a failure of its own', async () => {
    const f = await fixture();
    f.state.requiredChecks.set('main', ['ci/check', 'ci/app']);
    const other = await f.github.simulateOpenPullRequest({
      repo,
      head: 'source',
      title: 'Source',
      login: 'john',
    });
    const source = (await f.github.getPullRequest(repo, other)).headSha;
    const files = { 'settings.txt': 'Readable names' };
    await f.github.simulateFiles({ repo, sha: f.proof.revision, files });
    await f.github.simulateFiles({ repo, sha: source, files });
    f.state.statuses.set(source, [
      { id: 7, context: 'ci/check', state: 'success', createdAt: null, updatedAt: null, url: null },
      { id: 8, context: 'ci/app', state: 'success', createdAt: null, updatedAt: null, url: null },
    ]);
    // ci/app hasn't run on the candidate (ci/check passed there): the same files passed it on the source.
    const verify = () => verifyPullRequest(f.github, repo, f.number, { ...f.proof, peers: [source] });
    expect(await verify()).toMatchObject({ ok: true });
    // Different files: it waits for its own.
    await f.github.simulateFiles({ repo, sha: source, files: { 'settings.txt': 'Other names' } });
    expect(await verify()).toMatchObject({ ok: false, reason: 'waiting' });
    // The same files again, but its own ci/check failed: that stands.
    await f.github.simulateFiles({ repo, sha: source, files });
    const own = f.state.statuses.get(f.proof.revision)?.[0];
    if (own) own.state = 'failure';
    expect(await verify()).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('checks caller expectations as well as branch policy', async () => {
    const f = await fixture();
    expect(
      await verifyPullRequest(f.github, repo, f.number, { ...f.proof, expectedContexts: ['security'] }),
    ).toMatchObject({ ok: false, reason: 'waiting' });
  });

  it('rejects a moved PR head and moved base', async () => {
    const f = await fixture();
    const pr = f.state.prs.get(f.number);
    if (pr) pr.headSha = 'a'.repeat(40);
    expect(await f.verify()).toMatchObject({ ok: false, reason: 'stale' });
    if (pr) pr.headSha = f.proof.revision;
    await f.github.simulateCommitOn({ repo, branch: 'main' });
    expect(await f.verify()).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('does not let an old green rerun hide a newer failure', async () => {
    const f = await fixture();
    await f.github.simulateCheckRun({ repo, sha: f.proof.revision, name: 'ci/check', conclusion: 'success' });
    const runs = f.state.checks.get(f.proof.revision) ?? [];
    const run = runs[0];
    if (run) runs.push({ ...run, id: run.id + 1, conclusion: 'failure' });
    expect(await f.verify()).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('refuses check runs for another commit', async () => {
    const f = await fixture();
    await f.github.simulateCheckRun({ repo, sha: f.proof.revision, name: 'ci/check', conclusion: 'success' });
    const run = f.state.checks.get(f.proof.revision)?.[0];
    if (run) run.headSha = f.proof.base;
    expect(await f.verify()).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('detects the base moving while checks are being read', async () => {
    const f = await fixture();
    const original = f.github.commitStatuses.bind(f.github);
    vi.spyOn(f.github, 'commitStatuses').mockImplementation(async (...args) => {
      await f.github.simulateCommitOn({ repo, branch: 'main' });
      return original(...args);
    });
    expect(await f.verify()).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('requires successful checks rather than skipped or neutral checks', async () => {
    const f = await fixture();
    await f.github.simulateCheckRun({ repo, sha: f.proof.revision, name: 'ci/check', conclusion: 'skipped' });
    expect(await f.verify()).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('checks a merged head against the merged tree and original base', async () => {
    const f = await fixture();
    const files = new Map([['a.txt', new TextEncoder().encode('checked')]]);
    f.state.files.set(f.proof.revision, files);
    await f.github.simulateClose({ repo, number: f.number, login: 'john', merged: true });
    const merged = await f.github.getPullRequest(repo, f.number);
    const mergeSha = merged.mergeCommitSha as string;
    f.state.files.set(mergeSha, files);
    expect(
      await verifyPullRequest(f.github, repo, f.number, { ...f.proof, requireMerged: true }),
    ).toMatchObject({ ok: true, merged: true, mergeRevision: mergeSha });
    f.state.files.set(mergeSha, new Map([['a.txt', new TextEncoder().encode('different')]]));
    expect(await f.verify()).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('accepts checks on the exact merged commit', async () => {
    const f = await fixture();
    await f.github.simulateClose({ repo, number: f.number, login: 'john', merged: true });
    const mergeSha = (await f.github.getPullRequest(repo, f.number)).mergeCommitSha as string;
    f.state.statuses.set(mergeSha, f.state.statuses.get(f.proof.revision) ?? []);
    expect(
      await verifyPullRequest(f.github, repo, f.number, {
        ...f.proof,
        revision: mergeSha,
        requireMerged: true,
      }),
    ).toMatchObject({ ok: true, revision: mergeSha });
  });

  it('checks a final main revision without requiring an empty pull request', async () => {
    const f = await fixture();
    f.state.statuses.set(f.proof.base, f.state.statuses.get(f.proof.revision) ?? []);
    expect(
      await verifyRevision(f.github, repo, 'main', { revision: f.proof.base, base: f.proof.base }),
    ).toMatchObject({ ok: true, head: f.proof.base });
    expect(await verifyRevision(f.github, repo, 'main', f.proof)).toMatchObject({
      ok: false,
      reason: 'stale',
    });
  });
});
