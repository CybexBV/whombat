/**
 * Unit tests for the GitHub integration's pure parts: check mapping, deploy config, GhCliGitHub over a fake transport
 * (ETags, rate limits, a refused token), the poller's plans (diffing and idempotency) and the fake's ETags.
 */
import { describe, expect, it } from 'vitest';
import type { GhCheckRun, GhPullRequest, GhReview } from './adapter';
import { GitHubNotConnectedError, GitHubRateLimitedError, prBranch } from './adapter';
import { parseDeployWorkflows } from './deploy';
import { GhCliGitHub } from './gh';
import { checksToMirror, type KnownPr, planPulls, reviewsToMirror } from './poll-plan';
import { authorsText } from './sync';

describe('deploy workflows', () => {
  it('is off when unset and refuses malformed entries', () => {
    expect(parseDeployWorkflows(undefined)).toBeNull();
    expect(parseDeployWorkflows('  ')).toBeNull();
    expect(() => parseDeployWorkflows('billing=deploy.yml')).toThrow('owner/repo');
    expect(() => parseDeployWorkflows('*=deploy.sh')).toThrow('workflow file');
  });
});

describe('GhCliGitHub over a fake transport', () => {
  type Handler = (req: {
    method: string;
    path: string;
    query: URLSearchParams;
    headers: Headers;
    body: unknown;
  }) => {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  };

  function transport(handler: Handler) {
    const calls: { method: string; path: string; ifNoneMatch: string | null; auth: string | null }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const headers = new Headers(init?.headers);
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        path: url.pathname,
        ifNoneMatch: headers.get('if-none-match'),
        auth: headers.get('authorization'),
      });
      const res = handler({
        method,
        path: url.pathname,
        query: url.searchParams,
        headers,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(res.status === 304 || res.body === undefined ? null : JSON.stringify(res.body), {
        status: res.status,
        headers: { 'content-type': 'application/json', ...res.headers },
      });
    }) as typeof globalThis.fetch;
    return { calls, fetch };
  }

  function gh(fetch: typeof globalThis.fetch, tokens = ['gho_1', 'gho_2']) {
    let i = 0;
    let invalidated = 0;
    const auth = {
      token: async () => tokens[Math.min(i, tokens.length - 1)] as string,
      invalidate: () => {
        i++;
        invalidated++;
      },
    };
    return {
      adapter: new GhCliGitHub({ fetch, auth, clock: () => 1_000_000 }),
      invalidated: () => invalidated,
    };
  }

  it('reads the account and its scopes as the gh token', async () => {
    const { calls, fetch } = transport(() => ({
      status: 200,
      body: { login: 'acme', id: 7, name: 'Acme Labs' },
      headers: { 'x-oauth-scopes': 'gist, read:org, repo, workflow', 'x-ratelimit-remaining': '4990' },
    }));
    const { adapter } = gh(fetch);
    expect(await adapter.whoami()).toEqual({
      login: 'acme',
      id: 7,
      name: 'Acme Labs',
      scopes: ['gist', 'read:org', 'repo', 'workflow'],
    });
    expect(calls[0]).toMatchObject({ path: '/user', auth: 'Bearer gho_1' });
    expect(adapter.rateLimit().remaining).toBe(4990);
    expect(adapter.remoteUrl('acme/Whombat')).toBe('https://github.com/acme/Whombat.git');
    expect(() => adapter.remoteUrl('../etc/passwd')).toThrow('owner/name');
  });

  it('reads every page of a PR’s reviews and commits, and only the changed pages of reviews again', async () => {
    const review = (id: number) => ({
      id,
      state: 'COMMENTED',
      user: { login: 'joris' },
      body: `r${id}`,
      submitted_at: '2026-09-23T10:00:00Z',
    });
    const commit = (n: number) => ({
      sha: `${n}`.padStart(40, 'c'),
      commit: { message: `c${n}`, author: { name: 'Joris', email: 'joris@example.com', date: '' } },
      author: null,
    });
    // 100 reviews on page 1, then page 2 fills up as reviews come in (oldest first, like GitHub).
    let reviews = Array.from({ length: 100 }, (_, i) => review(i + 1));
    const etagOf = (items: unknown[]) => `W/"${items.length}"`;
    const { calls, fetch } = transport(({ path, query, headers }) => {
      const page = Number(query.get('page') ?? '1');
      const per = Number(query.get('per_page') ?? '30');
      const all = path.endsWith('/commits') ? Array.from({ length: 230 }, (_, i) => commit(i + 1)) : reviews;
      const items = all.slice((page - 1) * per, page * per);
      const more = all.length > page * per;
      const etag = etagOf(items);
      if (headers.get('if-none-match') === etag) return { status: 304 };
      return {
        status: 200,
        headers: { etag, ...(more ? { link: '<https://api.github.com/x?page=2>; rel="next"' } : {}) },
        body: items,
      };
    });
    const { adapter } = gh(fetch);
    const commits = await adapter.listPullRequestCommits('o/r', 1);
    expect(commits).toHaveLength(230);
    expect(commits.at(-1)?.message).toBe('c230');

    // A full first page: the (empty) second page is read too, so its ETag can tell when review 101 lands.
    const first = await adapter.reviews('o/r', 1, []);
    expect(first).toMatchObject({ modified: true, etags: ['W/"100"', 'W/"0"'] });
    if (!first.modified) throw new Error('expected reviews');
    expect(first.data).toHaveLength(100);
    expect(await adapter.reviews('o/r', 1, first.etags)).toEqual({ modified: false });

    reviews = [...reviews, review(101)];
    calls.length = 0;
    const later = await adapter.reviews('o/r', 1, first.etags);
    expect(later).toMatchObject({ modified: true, etags: ['W/"100"', 'W/"1"'] });
    if (later.modified) expect(later.data.map((r) => r.id)).toEqual([101]);
    expect(calls.map((c) => c.ifNoneMatch)).toEqual(['W/"100"', 'W/"0"']);
  });

  it('reads every page of open PRs again when one of them changed', async () => {
    const pr = (number: number) => ({
      number,
      html_url: `https://github.com/o/r/pull/${number}`,
      title: `PR ${number}`,
      state: 'open',
      head: { ref: `feat/${number}`, sha: `${number}`.padEnd(40, 'a') },
      base: { ref: 'main' },
      user: { login: 'joris' },
      requested_reviewers: [],
    });
    let page2 = 'W/"p2a"';
    const { calls, fetch } = transport(({ query, headers }) => {
      const page = query.get('page');
      const etag = page === '1' ? 'W/"p1"' : page2;
      if (headers.get('if-none-match') === etag) return { status: 304 };
      return {
        status: 200,
        headers: { etag, ...(page === '1' ? { link: '<https://api.github.com/x?page=2>; rel="next"' } : {}) },
        body: page === '1' ? [pr(2)] : [pr(1)],
      };
    });
    const { adapter } = gh(fetch);
    const first = await adapter.openPullRequests('o/r', []);
    expect(first).toMatchObject({ modified: true, etags: ['W/"p1"', 'W/"p2a"'] });
    expect((await adapter.openPullRequests('o/r', ['W/"p1"', 'W/"p2a"'])).modified).toBe(false);
    page2 = 'W/"p2b"';
    calls.length = 0;
    const changed = await adapter.openPullRequests('o/r', ['W/"p1"', 'W/"p2a"']);
    expect(changed).toMatchObject({ modified: true, etags: ['W/"p1"', 'W/"p2b"'] });
    if (changed.modified) expect(changed.data.map((p) => p.number)).toEqual([2, 1]);
    // Page 1 answered 304 first, so it was read once more without its ETag.
    expect(calls.map((c) => c.ifNoneMatch)).toEqual(['W/"p1"', 'W/"p2a"', null]);
  });

  it('asks for the token again when GitHub refuses it, and says so when it keeps refusing', async () => {
    const { calls, fetch } = transport(({ headers }) =>
      headers.get('authorization') === 'Bearer gho_2'
        ? { status: 200, body: { login: 'acme', id: 7, name: null } }
        : { status: 401, body: { message: 'Bad credentials' } },
    );
    const { adapter, invalidated } = gh(fetch);
    expect((await adapter.whoami()).login).toBe('acme');
    expect(invalidated()).toBe(1);
    expect(calls.map((c) => c.auth)).toEqual(['Bearer gho_1', 'Bearer gho_2']);

    const refused = transport(() => ({ status: 401, body: { message: 'Bad credentials' } }));
    const err = await gh(refused.fetch)
      .adapter.whoami()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubNotConnectedError);
    expect((err as Error).message).toMatch(/Sign in to GitHub again/);
  });

  it('stops at the rate limit until the window resets (or GitHub’s retry-after)', async () => {
    const reset = 1_000_000 / 1000 + 600;
    const primary = transport(() => ({
      status: 403,
      body: { message: 'API rate limit exceeded for user.' },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
    }));
    const err = await gh(primary.fetch)
      .adapter.reviews('o/r', 1, [])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitedError);
    expect((err as GitHubRateLimitedError).until).toBe(reset * 1000);

    const secondary = transport(() => ({
      status: 429,
      body: { message: 'You have exceeded a secondary rate limit.' },
      headers: { 'retry-after': '30' },
    }));
    const again = await gh(secondary.fetch)
      .adapter.reviews('o/r', 1, [])
      .catch((e: unknown) => e);
    expect((again as GitHubRateLimitedError).until).toBe(1_000_000 + 30_000);
  });

  it('merges with the expected head, and a missing branch is a 404, not an error', async () => {
    const { calls, fetch } = transport(({ method, path, body }) => {
      if (method === 'PUT')
        return { status: 200, body: { merged: true, sha: 'f'.repeat(40), message: 'ok', echo: body } };
      if (path.endsWith('/branches/feat/gone')) return { status: 404, body: { message: 'Branch not found' } };
      return { status: 200, body: { commit: { sha: 'b'.repeat(40) } } };
    });
    const { adapter } = gh(fetch);
    const sha = 'a'.repeat(40);
    const res = await adapter.mergePullRequest({
      repo: 'whombat/billing',
      number: 482,
      method: 'squash',
      sha,
      title: 'Invoice PDF export (#482)',
      message: 'Merged by Mara Okafor in Whombat.',
    });
    expect(res.merged).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/repos/whombat/billing/pulls/482/merge' });
    expect(await adapter.branchExists('whombat/billing', 'feat/gone')).toBe(false);
    expect(await adapter.branchHead('whombat/billing', 'feat/gone', null)).toEqual({
      modified: true,
      etag: null,
      data: null,
    });
    expect(calls.at(-1)?.path).toBe('/repos/whombat/billing/branches/feat/gone');
  });

  it('says how one commit relates to another, and a merged pull request’s commit (report-trackers.md TA-30)', async () => {
    const merged = 'm'.repeat(40);
    const { fetch } = transport(({ path }) => {
      if (path.endsWith(`/compare/${merged}...rev1`)) return { status: 200, body: { status: 'ahead' } };
      if (path.endsWith(`/compare/${merged}...rev2`)) return { status: 200, body: { status: 'behind' } };
      if (path.endsWith(`/compare/${merged}...rev3`)) return { status: 200, body: { status: 'weird' } };
      if (path.endsWith('/pulls/7'))
        return {
          status: 200,
          body: {
            number: 7,
            html_url: 'https://github.com/o/r/pull/7',
            title: 'Fix',
            state: 'closed',
            merged: true,
            merged_at: '2026-10-10T10:00:00Z',
            merge_commit_sha: merged,
            head: { ref: 'feat/x', sha: 'h'.repeat(40), repo: { full_name: 'o/r' } },
            base: { ref: 'main', repo: { full_name: 'o/r' } },
          },
        };
      if (path.endsWith('/pulls/8'))
        return {
          status: 200,
          body: {
            number: 8,
            html_url: 'https://github.com/o/r/pull/8',
            title: 'Open',
            state: 'open',
            merge_commit_sha: 'x'.repeat(40),
            head: { ref: 'feat/y', sha: 'h'.repeat(40), repo: { full_name: 'o/r' } },
            base: { ref: 'main', repo: { full_name: 'o/r' } },
          },
        };
      return { status: 404, body: { message: 'Not Found' } };
    });
    const { adapter } = gh(fetch);
    expect(await adapter.compareStatus('o/r', merged, 'rev1')).toBe('ahead');
    expect(await adapter.compareStatus('o/r', merged, 'rev2')).toBe('behind');
    expect(await adapter.compareStatus('o/r', merged, 'rev3')).toBe('unknown');
    // A revision GitHub doesn't have: nothing to say yet.
    expect(await adapter.compareStatus('o/r', merged, 'nope')).toBe('unknown');
    expect((await adapter.getPullRequest('o/r', 7)).mergeCommitSha).toBe(merged);
    // An open pull request's test merge isn't its merge.
    expect((await adapter.getPullRequest('o/r', 8)).mergeCommitSha).toBeNull();
  });

  it('reads a file raw at a commit (pr-file-view.md PF-04): bytes, none, too large, a directory, a submodule', async () => {
    const seen: { path: string; ref: string | null; accept: string | null }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const headers = new Headers(init?.headers);
      seen.push({ path: url.pathname, ref: url.searchParams.get('ref'), accept: headers.get('accept') });
      const raw = (body: ConstructorParameters<typeof Response>[0], extra: Record<string, string> = {}) =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/vnd.github.raw', ...extra },
        });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.pathname.endsWith('/compare/main...hhh'))
        return json({ merge_base_commit: { sha: 'b'.repeat(40) } });
      if (url.pathname.endsWith('/commits/hhh')) return json({ parents: [{ sha: 'p'.repeat(40) }] });
      if (url.pathname.endsWith('/contents/src/a%20b.ts')) return raw('one\ntwo\n');
      if (url.pathname.endsWith('/contents/big.bin')) return raw('x'.repeat(64), { 'content-length': '64' });
      if (url.pathname.endsWith('/contents/stream.bin'))
        return raw(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(20));
              c.close();
            },
          }),
        );
      if (url.pathname.endsWith('/contents/src')) return json([{ name: 'a b.ts', type: 'file' }]);
      if (url.pathname.endsWith('/contents/vendor/lib'))
        return json({ type: 'submodule', sha: 'c'.repeat(40) });
      return json({ message: 'Not Found' }, 404);
    }) as typeof globalThis.fetch;
    const { adapter } = gh(fetch);
    const text = (v: Awaited<ReturnType<typeof adapter.fileAt>>) =>
      v?.kind === 'file' ? new TextDecoder().decode(v.bytes) : v;
    expect(await adapter.mergeBase('o/r', 'main', 'hhh')).toBe('b'.repeat(40));
    expect(await adapter.mergeBase('o/r', 'gone', 'hhh')).toBeNull();
    expect(await adapter.commitParent('o/r', 'hhh')).toBe('p'.repeat(40));
    expect(await adapter.commitParent('o/r', 'nope')).toBeNull();
    expect(text(await adapter.fileAt('o/r', 'hhh', 'src/a b.ts', 50))).toBe('one\ntwo\n');
    expect(seen.at(-1)).toEqual({
      path: '/repos/o/r/contents/src/a%20b.ts',
      ref: 'hhh',
      accept: 'application/vnd.github.raw+json',
    });
    expect(await adapter.fileAt('o/r', 'hhh', 'missing.ts', 50)).toBeNull();
    expect(await adapter.fileAt('o/r', 'hhh', 'big.bin', 50)).toEqual({ kind: 'too_large', size: 64 });
    expect(await adapter.fileAt('o/r', 'hhh', 'stream.bin', 50)).toEqual({ kind: 'too_large', size: 60 });
    expect(await adapter.fileAt('o/r', 'hhh', 'src', 50)).toBeNull();
    expect(text(await adapter.fileAt('o/r', 'hhh', 'vendor/lib', 50))).toBe(
      `Subproject commit ${'c'.repeat(40)}\n`,
    );
    const asked = seen.length;
    expect(await adapter.fileAt('o/r', 'hhh', 'src/../../secrets', 50)).toBeNull();
    expect(seen.length).toBe(asked);
  });
});

describe('poll plans', () => {
  const gh = (number: number, over: Partial<GhPullRequest> = {}): GhPullRequest => ({
    number,
    url: `https://github.com/o/r/pull/${number}`,
    title: `PR ${number}`,
    body: null,
    headRef: `feat/${number}`,
    fork: null,
    headSha: `${number}`.padEnd(40, 'a'),
    baseRef: 'main',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergedBy: null,
    mergeCommitSha: null,
    draft: false,
    author: 'joris',
    authorBot: false,
    authorAssociation: 'MEMBER',
    assignees: [],
    requestedReviewers: [],
    createdAt: '2026-09-20T09:00:00Z',
    updatedAt: '2026-09-23T09:00:00Z',
    additions: null,
    deletions: null,
    changedFiles: null,
    ...over,
  });
  const known = (p: GhPullRequest, over: Partial<KnownPr> = {}): KnownPr => ({
    number: p.number,
    state: 'open',
    headSha: p.headSha,
    title: p.title,
    branch: prBranch(p),
    baseBranch: p.baseRef,
    reviewerLogins: p.requestedReviewers,
    localOnly: false,
    commits: 1,
    ...over,
  });
  const since = Date.parse('2026-09-10T00:00:00Z');
  const linkedLogins = new Set(['mara', 'joris']);

  it('asks for no edit when the only new reviewer is a login nobody linked (it can never be applied)', () => {
    const open = [gh(1, { requestedReviewers: ['octocat', 'Mara'] })];
    // Mara is linked and already a reviewer; octocat is nobody in the burrow.
    const plan = planPulls([known(gh(1), { reviewerLogins: ['mara'] })], open, {
      since,
      maxOpened: 20,
      linkedLogins,
    });
    expect(plan.edited).toEqual([]);
    const asked = planPulls([known(gh(1))], open, { since, maxOpened: 20, linkedLogins });
    expect(asked.edited.map((p) => p.number)).toEqual([1]);
  });

  it('leaves PRs only Whombat has alone, and GitHub’s PRs with their numbers', () => {
    // #7 was opened in Whombat before the burrow was connected; GitHub has another #7 now.
    const plan = planPulls(
      [known(gh(7, { headSha: 'abc1234' }), { localOnly: true }), known(gh(8), { localOnly: true })],
      [gh(7)],
      { since, maxOpened: 20, linkedLogins },
    );
    expect(plan).toMatchObject({ opened: [], headMoved: [], edited: [], vanished: [], collisions: [7] });
  });

  it('opens a limited number per poll, lowest first', () => {
    const open = Array.from({ length: 5 }, (_, i) => gh(10 - i));
    const plan = planPulls([], open, { since, maxOpened: 2, linkedLogins });
    expect(plan.opened.map((p) => p.number)).toEqual([6, 7]);
    expect(plan.truncated).toBe(true);
  });

  it('mirrors only checks that changed, the latest run per name', () => {
    const run = (id: number, name: string, over: Partial<GhCheckRun> = {}): GhCheckRun => ({
      id,
      name,
      headSha: 'a'.repeat(40),
      status: 'completed',
      conclusion: 'success',
      startedAt: null,
      completedAt: null,
      url: null,
      outputTitle: null,
      outputSummary: null,
      ...over,
    });
    const runs = [
      run(3, 'unit', { conclusion: 'failure', outputTitle: '38 of 41 passed' }),
      run(1, 'lint'),
      run(2, 'unit'),
    ];
    const first = checksToMirror([], runs);
    expect(first.map((c) => [c.check.name, c.check.state, c.check.note])).toEqual([
      ['lint', 'passed', 'passed'],
      ['unit', 'failed', '38/41'],
    ]);
    expect(
      checksToMirror(
        first.map((c) => c.check),
        runs,
      ),
    ).toEqual([]);
  });

  it('mirrors each review once; older reviews of known PRs are history', () => {
    const review = (id: number, state: string, at: string): GhReview => ({
      id,
      state,
      author: 'joris',
      body: '',
      submittedAt: at,
    });
    const reviews = [
      review(3, 'approved', '2026-09-23T12:00:00Z'),
      review(1, 'commented', '2026-09-22T12:00:00Z'),
      review(2, 'pending', '2026-09-23T11:00:00Z'),
      review(4, 'dismissed', '2026-09-23T13:00:00Z'),
    ];
    expect(reviewsToMirror(reviews, new Set(), null).mirror.map((r) => r.id)).toEqual([1, 3]);
    expect(reviewsToMirror(reviews, new Set([1]), null).mirror.map((r) => r.id)).toEqual([3]);
    const split = reviewsToMirror(reviews, new Set(), Date.parse('2026-09-23T00:00:00Z'));
    expect(split.history.map((r) => r.id)).toEqual([1]);
    expect(split.mirror.map((r) => r.id)).toEqual([3]);
  });

  it('says whose commits a push brought, as git says (text, never a signer)', () => {
    const c = (authorName: string | null, authorEmail: string | null = null) => ({
      sha: 'a'.repeat(40),
      message: 'm',
      authorName,
      authorEmail,
      authorLogin: null,
      at: '',
    });
    expect(authorsText([])).toBeNull();
    expect(authorsText([c(null)])).toBeNull();
    expect(authorsText([c('Joris Visser'), c('Joris Visser')])).toBe('Joris Visser');
    expect(authorsText([c('Joris Visser'), c(null, 'mara@burrowhq.example')])).toBe(
      'Joris Visser and mara@burrowhq.example',
    );
    expect(authorsText([c('A'), c('B\n  C'), c('D')])).toBe('A and 2 others');
  });

  it('keys a fork’s PR on its owner:ref label, never on one of the repo’s branches', () => {
    expect(prBranch({ headRef: 'feat/x', fork: null })).toBe('feat/x');
    expect(prBranch({ headRef: 'feat/x', fork: 'stranger/billing' })).toBe('stranger:feat/x');
  });
});
