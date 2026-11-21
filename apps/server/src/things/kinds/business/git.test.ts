/**
 * GitLab's and Forgejo's or Gitea's page (service-dashboards.md SD-64): Forgejo 17 and Gitea from real answers
 * (`fixtures/forgejo`, `fixtures/gitea`, a throwaway server each with a runner and a failing workflow), GitLab from its
 * documented ones — the reviews waiting, failing default branches with Retry where it works, the runners, the notices.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ThingPageButton, ThingPageKpi, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../slots';
import { type ButtonSpec, seenOfView } from './common';
import {
  FORGEJO_KIND,
  forgeHistory,
  forgeRepos,
  forgeRunners,
  forgeSnapshot,
  forgeVersion,
  GIT_CHECKS,
  GITLAB_KIND,
  type GitInput,
  type GitSnapshot,
  gitCardView,
  gitlabHistory,
  gitlabProjects,
  gitlabRunners,
  gitlabSnapshot,
  gitSkipped,
  gitView,
  lastRun,
  runOutcome,
} from './git';

const fixture = (dir: string, name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', dir, name), 'utf8'));

const TZ = 'Europe/Amsterdam';
// Just after the forges were captured (21 October 2026, 19:41 UTC).
const now = new Date('2026-10-21T20:00:00Z');
const HOME = 'https://git.example.com';

function forge(dir: 'forgejo' | 'gitea', over: { runners?: unknown } = {}): GitSnapshot {
  const f = (name: string) => fixture(dir, name);
  return forgeSnapshot(
    {
      version: f('version.json'),
      reviews: { body: f('review-requested.json'), total: 1 },
      repos: forgeRepos(f('user-repos.json'), now),
      runs: new Map([
        ['whombat/site', f('runs-site.json')],
        ['whombat/api', f('runs-api.json')],
      ]),
      runners: 'runners' in over ? over.runners : f('admin-runners.json'),
    },
    now,
    HOME,
  );
}

function gitlab(): GitSnapshot {
  const f = (name: string) => fixture('gitlab', name);
  const projects = gitlabProjects(f('projects.json'), new Date('2026-10-21T15:00:00Z'));
  return gitlabSnapshot(
    {
      metadata: f('metadata.json'),
      reviews: { body: f('merge-requests.json'), total: 2 },
      projects,
      pipelines: new Map<string, unknown>([
        ['101', f('pipelines-101.json')],
        ['102', f('pipelines-102.json')],
        ['103', null],
      ]),
      runners: f('runners.json'),
    },
    new Date('2026-10-21T15:00:00Z'),
    'https://gitlab.example.com',
  );
}

const allowAll = (spec: ButtonSpec): ThingPageButton => ({ ...spec, allowed: true });
const input = (snapshot: GitSnapshot, over: Partial<GitInput> = {}): GitInput => ({
  snapshot,
  now: snapshot.service === 'gitlab' ? new Date('2026-10-21T15:00:00Z') : now,
  timeZone: TZ,
  button: allowAll,
  ...over,
});
const listOf = (view: ReturnType<typeof gitView>, id: string) => {
  const p = view.panels.find((x) => x.id === id);
  if (p?.kind !== 'list') throw new Error(`no list ${id}`);
  return p;
};
const waiting = (view: ReturnType<typeof gitView>) => listOf(view, 'waiting').items;

describe('Forgejo 17 (real answers)', () => {
  it('knows Forgejo from Gitea by its version', () => {
    expect(forgeVersion(fixture('forgejo', 'version.json'))).toEqual({
      product: 'Forgejo',
      version: '17.0.0',
      major: 17,
    });
    expect(forgeVersion(fixture('gitea', 'version.json')).product).toBe('Gitea');
    expect(forgeVersion({})).toEqual({ product: 'Forgejo', version: null, major: null });
  });

  it('finds the default branch’s last finished run, not another branch’s', () => {
    const run = lastRun(fixture('forgejo', 'runs-site.json'), 'main');
    expect(run?.id).toBe(1);
    expect(runOutcome(run ?? {})).toBe('failed');
    expect(
      runOutcome((lastRun(fixture('forgejo', 'runs-api.json'), 'main') ?? {}) as Record<string, unknown>),
    ).toBe('passed');
    expect(runOutcome({ status: 'waiting' })).toBe('running');
    expect(lastRun({ workflow_runs: [{ id: 9, prettyref: 'main', status: 'running' }] }, 'main')).toBeNull();
  });

  it('shows the failing branch with Retry, the review and the runners', () => {
    const s = forge('forgejo');
    expect(s.product).toBe('Forgejo');
    expect(s.checked).toBe(2);
    expect(s.failing?.map((f) => [f.id, f.branch, f.canRetry])).toEqual([['whombat/site/1', 'main', true]]);
    expect(s.reviews?.items.map((r) => [r.title, r.project, r.author])).toEqual([
      ['New header for the home page', 'whombat/site', 'ann'],
    ]);
    expect(s.runners?.map((r) => [r.name, r.online, r.busy])).toEqual([
      ['build-01', true, true],
      ['build-02', false, false],
    ]);
    const view = gitView(input(s));
    expect(slotProblems(view)).toEqual([]);
    const card = gitCardView(input(s));
    expect(card.kpis?.map((k) => [k.key, k.value])).toEqual([
      ['reviews', '1'],
      ['failing', '1'],
      ['runners', '1 of 2'],
      ['version', '17.0.0'],
    ]);
    for (const k of card.kpis ?? []) expect(ThingPageKpi.safeParse(k).success).toBe(true);
    // The failing branch first, with Retry, then the review.
    const [failing, review] = waiting(view);
    expect(failing).toMatchObject({ title: 'whombat/site · main', tone: 'bad' });
    expect(failing?.actions?.[0]).toMatchObject({ action: 'retry', target: 'whombat/site/1' });
    expect(failing?.url).toBe('https://git.example.com/whombat/site/actions/runs/1');
    expect(review?.title).toBe('New header for the home page');
    expect(review?.detail).toContain('ann');
    expect(listOf(view, 'waiting').meta).toBe('1 failing · 1 to review');
    for (const p of view.panels) expect(ThingPagePanel.safeParse(p).success).toBe(true);
  });

  it('puts the failing branch and the offline runner in Worth a look, each about its own item', () => {
    const view = gitView(input(forge('forgejo')));
    expect(view.notices.map((n) => [n.id, n.tone, n.check, n.subject?.id, n.nature])).toEqual([
      ['failing-whombat/site', 'warn', GIT_CHECKS.failing, 'project:whombat/site', 'problem'],
      ['runner-1', 'warn', GIT_CHECKS.runner, 'runner:1', 'problem'],
    ]);
    const [failing, runner] = view.notices;
    // The project, not the run: an Ignore lasts while the branch stays red.
    expect(failing?.ignore?.lifts).toBe('fixed');
    expect(failing?.episode).toBeUndefined();
    expect(failing?.link?.kind).toBe('url');
    // A runner restarting isn't worth the dot: two reads in a row.
    expect(runner).toMatchObject({ confirm: 2, ignore: { lifts: 'fixed' }, link: { kind: 'ask' } });
    expect(view.status?.status).toBe('warn');
    for (const n of view.notices) expect(ThingPageNotice.safeParse(n).success).toBe(true);
  });

  it('says so when no runner is online, and leaves runners out when they can’t be read', () => {
    const none = forge('forgejo', { runners: [{ id: 1, name: 'build-02', status: 'offline' }] });
    const line = gitView(input(none)).notices.find((n) => n.check === GIT_CHECKS.runner);
    expect(line?.tone).toBe('bad');
    expect(line?.badge?.length ?? 0).toBeLessThanOrEqual(40);
    expect(gitSkipped(none)).toEqual([]);
    const hidden = gitView(input(forge('forgejo', { runners: null })));
    expect(gitSkipped(forge('forgejo', { runners: null }))).toEqual([GIT_CHECKS.runner]);
    expect(gitCardView(input(forge('forgejo', { runners: null }))).kpis?.map((k) => k.key)).toEqual([
      'reviews',
      'failing',
      'version',
    ]);
    expect(hidden.panels.map((p) => p.id)).toEqual(['waiting', 'counts']);
    expect(listOf(hidden, 'counts').items.map((i) => i.title)).toEqual(['Your reviews', 'Default branches']);
  });

  it('offers no Retry on a Forgejo before 17', () => {
    const s = forgeSnapshot(
      {
        version: { version: '15.0.10+gitea-1.22.0' },
        reviews: null,
        repos: forgeRepos(fixture('forgejo', 'user-repos.json'), now),
        runs: new Map([['whombat/site', fixture('forgejo', 'runs-site.json')]]),
        runners: null,
      },
      now,
      HOME,
    );
    expect(s.failing?.[0]?.canRetry).toBe(false);
    expect(waiting(gitView(input(s)))[0]?.actions).toBeUndefined();
  });

  it('leaves failing out when no repository’s runs could be read', () => {
    const s = forgeSnapshot(
      {
        version: fixture('forgejo', 'version.json'),
        reviews: null,
        repos: forgeRepos(fixture('forgejo', 'user-repos.json'), now),
        runs: new Map(),
        runners: null,
      },
      now,
      HOME,
    );
    expect(s.failing).toBeNull();
    expect(gitCardView(input(s)).kpis?.map((k) => k.key)).toEqual(['version']);
    // Nothing to wait for and nothing to count: the page has only its version.
    expect(gitView(input(s)).panels).toEqual([]);
    expect(gitSkipped(s)).toEqual([GIT_CHECKS.failing, GIT_CHECKS.runner]);
  });
});

describe('Gitea (real answers)', () => {
  it('reads GitHub-style runs and its runners', () => {
    const s = forge('gitea');
    expect(s.product).toBe('Gitea');
    expect(s.failing?.map((f) => [f.id, f.title, f.canRetry])).toEqual([['whombat/site/1', 'Add CI', true]]);
    expect(forgeRunners(fixture('gitea', 'admin-runners.json'))).toEqual([
      { id: '1', name: 'build-01', online: true, busy: true, paused: false, version: null },
    ]);
    expect(gitCardView(input(s)).kpis?.find((k) => k.key === 'runners')?.value).toBe('1 of 1');
  });
});

describe('GitLab (documented answers)', () => {
  it('checks the default branches of projects active in the last week', () => {
    const projects = gitlabProjects(fixture('gitlab', 'projects.json'), new Date('2026-10-21T15:00:00Z'));
    expect(projects.map((p) => [p.id, p.defaultBranch])).toEqual([
      ['101', 'main'],
      ['102', 'main'],
      ['103', 'trunk'],
    ]);
  });

  it('shows reviews, the failing pipeline, runners and the version', () => {
    const s = gitlab();
    // The docs project's pipelines didn't answer: two branches checked.
    expect(s.checked).toBe(2);
    expect(s.failing?.map((f) => f.id)).toEqual(['101/5501']);
    const view = gitView(input(s));
    expect(slotProblems(view)).toEqual([]);
    expect(gitCardView(input(s)).kpis?.map((k) => [k.key, k.value])).toEqual([
      ['reviews', '2'],
      ['failing', '1'],
      ['runners', '1 of 2'],
      ['version', '18.5.1-ee'],
    ]);
    expect(
      waiting(view)
        .slice(1)
        .map((r) => [r.title, r.detail?.split(' · ')[0], r.right]),
    ).toEqual([
      ['New header for the home page', 'example/site', undefined],
      ['Draft: rate limits', 'example/api', 'Draft'],
    ]);
    // The paused runner isn't counted as offline.
    expect(view.notices.map((n) => n.subject?.id)).toEqual(['project:101', 'runner:8']);
    // The docs project didn't answer: its Ignore doesn't end on this read.
    expect(gitSkipped(s)).toEqual([GIT_CHECKS.failing]);
    const runners = view.panels.find((p) => p.id === 'runners');
    expect(runners?.kind === 'list' && runners.items.map((i) => i.right)).toEqual([
      'Offline',
      'Online',
      'Paused',
    ]);
  });

  it('leaves out runners GitLab calls stale or never connected', () => {
    const runners = gitlabRunners([
      { id: 1, description: 'old', status: 'stale', paused: false },
      { id: 2, description: 'new', status: 'never_contacted', paused: false },
      { id: 3, description: 'build', status: 'online', paused: false },
    ]);
    expect(runners.map((r) => r.gone ?? null)).toEqual(['stale', 'never', null]);
    const view = gitView(input({ ...gitlab(), runners }));
    expect(view.notices.filter((n) => n.check === GIT_CHECKS.runner)).toEqual([]);
    expect(gitCardView(input({ ...gitlab(), runners })).kpis?.find((k) => k.key === 'runners')?.value).toBe(
      '1 of 1',
    );
  });

  it('leaves out a one-job runner between jobs', () => {
    const runners = forgeRunners([
      { id: 4, name: 'job-4', status: 'offline', ephemeral: true },
      { id: 5, name: 'build', status: 'idle', ephemeral: false },
    ]);
    expect(runners.map((r) => r.gone ?? null)).toEqual(['ephemeral', null]);
    expect(gitView(input({ ...forge('forgejo'), runners })).notices.map((n) => n.check)).toEqual([
      GIT_CHECKS.failing,
    ]);
  });

  it('watches failing branches and offline runners', () => {
    for (const kind of [GITLAB_KIND, FORGEJO_KIND])
      expect(kind.checks?.map((c) => [c.check, c.perItem])).toEqual([
        [GIT_CHECKS.failing, true],
        [GIT_CHECKS.runner, true],
      ]);
  });

  it('draws no buttons on the card, and disabled ones when refused', () => {
    expect(JSON.stringify(gitView(input(gitlab(), { button: undefined })))).not.toContain('"action"');
    const member = gitView(
      input(gitlab(), { button: (spec) => ({ ...spec, allowed: false, reason: 'No' }) }),
    );
    expect(waiting(member)[0]?.actions?.[0]?.allowed).toBe(false);
  });
});

/** A pipeline or run a day for the last `days` days at noon UTC, every third one failed. */
const daily = (days: number, at = now) =>
  Array.from({ length: days }, (_, i) => ({
    at: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - i, 12)),
    failed: i % 3 === 0,
  }));

describe('In slots', () => {
  it('counts the reviews, the default branches and the runners, each with what to know', () => {
    const counts = listOf(gitView(input(forge('forgejo'))), 'counts');
    expect(counts.title).toBe('In Forgejo');
    expect(
      counts.items.map((i) => [i.title, i.figure?.value, i.figure?.note, i.figure?.tone ?? null]),
    ).toEqual([
      ['Your reviews', '1', expect.stringMatching(/^oldest /), null],
      ['Default branches', '2', '1 failing', 'bad'],
      ['Runners', '1 of 2', '1 offline', 'warn'],
    ]);
  });

  it('draws the week of pipelines on the default branches, with how many failed', () => {
    const s = { ...gitlab(), history: { runs: daily(14, new Date('2026-10-21T15:00:00Z')), since: null } };
    const week = gitView(input(s)).panels.find((p) => p.id === 'week');
    if (week?.kind !== 'chart') throw new Error('no week');
    expect(week.series[0]?.values).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(week.figure).toEqual({ value: '7', rest: 'pipelines this week' });
    expect(week.labels?.at(-1)).toBe('Today');
    expect(JSON.stringify(week.stats)).toContain('failed');
    // A full page that reaches back only three days: no bars before it, no change on last week.
    const short = gitView(
      input({ ...s, history: { runs: daily(3, s.readAt), since: new Date('2026-10-19T08:00:00Z') } }),
    ).panels.find((p) => p.id === 'week');
    expect(short?.kind === 'chart' && short.series[0]?.values).toEqual([null, null, null, null, null, 1, 1]);
    expect(short?.kind === 'chart' && short.stats?.[0]?.[0]?.text).not.toMatch(/%/);
    // Under two days with a bar: no Trend.
    expect(
      gitView(input({ ...s, history: { runs: [], since: new Date('2026-10-20T08:00:00Z') } })).panels.map(
        (p) => p.id,
      ),
    ).not.toContain('week');
  });

  it('reads each project’s default-branch pipelines and runs for the week', () => {
    expect(gitlabHistory(fixture('gitlab', 'pipelines-101.json')).runs).toEqual([
      { at: new Date('2026-10-21T13:55:00.000Z'), failed: true },
    ]);
    // Forgejo's runs on another branch (and pull requests) aren't the default branch's.
    expect(forgeHistory(fixture('forgejo', 'runs-site.json'), 'main')).toEqual({
      runs: [{ at: new Date('2026-10-21T19:41:38Z'), failed: true }],
      full: null,
    });
  });

  it('puts its version in the machine card only when it runs on the person’s own machine', () => {
    expect(gitView(input(gitlab())).slots?.machine).toEqual([
      { id: 'version', label: 'GitLab', value: '18.5.1-ee', pct: null },
    ]);
    expect(gitView(input({ ...gitlab(), home: 'https://gitlab.com' })).slots?.machine).toEqual([]);
    expect(gitView(input({ ...forge('forgejo'), home: 'https://codeberg.org' })).slots?.machine).toEqual([]);
  });

  it('keeps the card’s figures', () => {
    const seen = seenOfView(gitCardView(input(gitlab(), { button: undefined })), ['reviews', 'failing']);
    expect(seen.glance.facts?.map((f) => f.value)).toEqual(['2', '1']);
  });
});
