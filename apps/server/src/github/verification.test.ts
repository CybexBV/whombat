import { describe, expect, it } from 'vitest';
import { GhCliGitHub } from './gh';

type Answer = { status?: number; body?: unknown; next?: boolean };
function client(handler: (path: string, page: number) => Answer) {
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    const answer = handler(url.pathname, Number(url.searchParams.get('page') ?? 1));
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: answer.next ? { link: '<https://api.github.com/x?page=2>; rel="next"' } : {},
    });
  }) as typeof globalThis.fetch;
  return new GhCliGitHub({ fetch, auth: { token: async () => 'test-token', invalidate: () => {} } });
}

const sha = 'a'.repeat(40);

describe('GitHub final verification transport', () => {
  it('combines classic required checks with active repository rules', async () => {
    const adapter = client((path) => ({
      body: path.endsWith('/required_status_checks')
        ? { contexts: ['legacy-ci'], checks: [{ context: 'build' }] }
        : path.includes('/rules/')
          ? [
              {
                type: 'required_status_checks',
                parameters: { required_status_checks: [{ context: 'security' }] },
              },
            ]
          : { protected: true },
    }));
    expect(await adapter.requiredStatusChecks('owner/repo', 'main')).toEqual([
      'build',
      'legacy-ci',
      'security',
    ]);
  });

  it('does not treat unreadable policy as no required checks', async () => {
    const adapter = client((path) =>
      path.endsWith('/main')
        ? { body: { protected: true } }
        : { status: 403, body: { message: 'Forbidden' } },
    );
    await expect(adapter.requiredStatusChecks('owner/repo', 'main')).rejects.toThrow('Forbidden');
  });

  const planMessage = 'Upgrade to GitHub Pro or make this repository public to enable this feature.';

  it('accepts GitHub’s plan restriction only for an explicitly unprotected branch', async () => {
    const adapter = client((path) =>
      path.includes('/rules/')
        ? { status: 403, body: { message: planMessage } }
        : {
            body: { protected: false, protection: { required_status_checks: { contexts: [], checks: [] } } },
          },
    );
    expect(await adapter.requiredStatusChecks('owner/repo', 'main')).toEqual([]);
  });

  it.each([
    { protected: true, protection: { required_status_checks: null } },
    { protection: { required_status_checks: null } },
    { protected: false, protection: { required_status_checks: { contexts: ['ci/check'] } } },
  ])(
    'keeps the plan restriction blocking when the branch policy is ambiguous or protected: %j',
    async (info) => {
      const adapter = client((path) =>
        path.includes('/rules/') || path.endsWith('/required_status_checks')
          ? { status: 403, body: { message: planMessage } }
          : { body: info },
      );
      await expect(adapter.requiredStatusChecks('owner/repo', 'main')).rejects.toThrow();
    },
  );

  it.each(['Resource not accessible by integration', 'API rate limit exceeded', 'Not Found'])(
    'refuses an unreadable rules policy even on an unprotected branch: %s',
    async (message) => {
      const adapter = client((path) =>
        path.includes('/rules/') ? { status: 403, body: { message } } : { body: { protected: false } },
      );
      await expect(adapter.requiredStatusChecks('owner/repo', 'main')).rejects.toThrow();
    },
  );

  it('does not discard rules already reported before a later page fails with the plan restriction', async () => {
    const adapter = client((path, page) =>
      !path.includes('/rules/')
        ? { body: { protected: false } }
        : page === 1
          ? {
              next: true,
              body: [
                {
                  type: 'required_status_checks',
                  parameters: { required_status_checks: [{ context: 'ci/check' }] },
                },
              ],
            }
          : { status: 403, body: { message: planMessage } },
    );
    await expect(adapter.requiredStatusChecks('owner/repo', 'main')).rejects.toThrow(planMessage);
  });

  it('refuses ambiguous protection 404s but accepts an explicit branch policy', async () => {
    const ambiguous = client((path) =>
      path.endsWith('/main')
        ? { body: { protected: true } }
        : { status: 404, body: { message: 'Not Found' } },
    );
    await expect(ambiguous.requiredStatusChecks('owner/repo', 'main')).rejects.toThrow();
    const explicit = client((path) =>
      path.includes('/rules/')
        ? { body: [] }
        : path.endsWith('/required_status_checks')
          ? { status: 404 }
          : { body: { protected: true, protection: { required_status_checks: null } } },
    );
    expect(await explicit.requiredStatusChecks('owner/repo', 'main')).toEqual([]);
  });

  it('reads every page of statuses and checks for the requested revision', async () => {
    const adapter = client((path, page) => ({
      next: page === 1,
      body: path.endsWith('/status')
        ? { sha, total_count: 2, statuses: [{ id: page, context: `ci/${page}`, state: 'success' }] }
        : {
            total_count: 2,
            check_runs: [
              { id: page, name: `check/${page}`, head_sha: sha, status: 'completed', conclusion: 'success' },
            ],
          },
    }));
    expect((await adapter.commitStatuses('owner/repo', sha)).map((status) => status.context)).toEqual([
      'ci/1',
      'ci/2',
    ]);
    expect(await adapter.checkRuns('owner/repo', sha, null)).toMatchObject({
      modified: true,
      etag: null,
      data: [{ name: 'check/1' }, { name: 'check/2' }],
    });
  });

  it('rejects statuses for a different commit and truncated evidence', async () => {
    await expect(
      client(() => ({ body: { sha: 'b'.repeat(40), total_count: 0, statuses: [] } })).commitStatuses(
        'owner/repo',
        sha,
      ),
    ).rejects.toThrow('requested revision');
    await expect(
      client(() => ({ body: { sha, total_count: 1, statuses: [] } })).commitStatuses('owner/repo', sha),
    ).rejects.toThrow('truncated');
    await expect(
      client(() => ({ body: { total_count: 1, check_runs: [] } })).checkRuns('owner/repo', sha, null),
    ).rejects.toThrow('truncated');
  });

  it('refuses more pages than can be verified completely', async () => {
    const adapter = client(() => ({ next: true, body: { sha, total_count: 0, statuses: [] } }));
    await expect(adapter.commitStatuses('owner/repo', sha)).rejects.toThrow('Too many pages');
  });

  it('reads a tree only when the returned commit identity matches', async () => {
    expect(
      await client(() => ({ body: { sha, commit: { tree: { sha: 'tree' } } } })).commitTree(
        'owner/repo',
        sha,
      ),
    ).toBe('tree');
    await expect(
      client(() => ({ body: { sha: 'other', commit: { tree: { sha: 'tree' } } } })).commitTree(
        'owner/repo',
        sha,
      ),
    ).rejects.toThrow('requested revision');
  });
});
