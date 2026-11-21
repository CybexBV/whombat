/**
 * The business kinds as widgets (desk-display-server.md “Every connection's widgets”): Mollie's today against the same
 * day last week; GitHub Actions' builds, what runs and the runners; T3 Code's coding agents, what works and what waits.
 * Pure: the kind's own view builder, laid out as a page, through the widgets' runtime.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { forgeRepos, forgeSnapshot, gitView } from '../../things/kinds/business/git';
import { actionsSnapshot, actionsView, repoOf } from '../../things/kinds/business/github-actions';
import { type MolliePayment, mollieView } from '../../things/kinds/business/mollie';
import { type T3Answers, t3Snapshot, t3View } from '../../things/kinds/business/t3code';
import { as, groupOn, pageOf, panelOn, viewsOn } from './thing-testing';

const TZ = 'Europe/Amsterdam';
// Wednesday 21 October 2026, 21:50 in Amsterdam (the widgets' tests' clock).
const now = new Date('2026-10-21T19:50:00Z');

const paid = (id: string, at: string, value: number): MolliePayment => ({
  id,
  mode: 'live',
  createdAt: new Date(at),
  paidAt: new Date(at),
  failedAt: null,
  status: 'paid',
  amount: { value, currency: 'EUR' },
  settlement: null,
  refunded: 0,
  method: 'ideal',
  description: 'Order',
  customer: 'A. Jansen',
  dashboard: null,
});

function molliePage(payments: MolliePayment[]) {
  const view = mollieView({
    snapshot: { readAt: now, payments, partial: false, refunds: [], chargebacks: [], nextPayout: null },
    now,
    timeZone: TZ,
  });
  return pageOf(view, { catalogId: 'mollie', name: 'Mollie' });
}

describe('Today vs last week', () => {
  it('shows what came in today against last Wednesday by now, private, offered first', async () => {
    const page = molliePage([
      paid('t2', '2026-10-21T17:00:00Z', 240),
      paid('t1', '2026-10-21T08:00:00Z', 1000),
      paid('w2', '2026-10-14T20:30:00Z', 400),
      paid('w1', '2026-10-14T09:00:00Z', 860),
    ]);
    expect((await groupOn(page)).items[1]).toMatchObject({
      name: 'Today vs last week',
      view: 'figures',
      private: true,
      opts: { panel: 'today-vs-week' },
    });
    const got = await panelOn(page, 'today-vs-week');
    const view = as(got, 'figures');
    expect(view.items.map((f) => [f.value, f.label])).toEqual([['€ 1,240', 'Paid today']]);
    expect(view.line).toContain('€ 860 last Wednesday');
    expect(view.spark?.length).toBeGreaterThanOrEqual(2);
    expect(got.private).toBe(true);
  });

  it('isn’t offered without payments to compare', async () => {
    const group = await groupOn(molliePage([]));
    expect(group.items.map((i) => i.opts.panel)).not.toContain('today-vs-week');
  });
});

const actionsFixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../things/kinds/business/fixtures/github_actions', name),
      'utf8',
    ),
  );

/** acme/web at the widgets' clock: Main checks half way, PR checks waiting 10 minutes, main failing. */
function actionsPage() {
  const repo = repoOf(actionsFixture('repo.json'));
  if (!repo) throw new Error('no repo');
  const name = repo.fullName;
  const snapshot = actionsSnapshot(
    {
      repos: [repo],
      unseen: [],
      runs: new Map([[name, actionsFixture('runs.json')]]),
      main: new Map([[name, actionsFixture('main.json')]]),
      workflows: new Map([[name, actionsFixture('workflows.json')]]),
      jobs: new Map([
        [`${name}/9005`, actionsFixture('jobs-running.json')],
        [`${name}/9004`, actionsFixture('jobs-queued.json')],
      ]),
      runners: [{ scope: name, org: null, body: actionsFixture('runners.json') }],
    },
    now,
  );
  return pageOf(actionsView({ snapshot, now, timeZone: TZ }), {
    catalogId: 'github_actions',
    name: 'GitHub Actions',
  });
}

describe('GitHub Actions', () => {
  it('offers Builds first after the figures, then what runs, the last results and the runners, none private', async () => {
    const group = await groupOn(actionsPage());
    expect(group.items.map((i) => i.opts.panel ?? i.type).slice(0, 6)).toEqual([
      'figures',
      'builds',
      'running',
      'latest',
      'runners',
      'recent',
    ]);
    expect(group.items.some((i) => i.private)).toBe(false);
  });

  it('draws Builds: each run with its bar and time left, then the failing workflow, under one big line', async () => {
    const got = await panelOn(actionsPage(), 'builds');
    const view = as(got, 'list');
    expect(view.head).toBe('Main checks failing · 1 running · 1 waiting');
    expect(view.rows.map((r) => [r.title, r.tone ?? null])).toEqual([
      ['Main checks', null],
      ['PR checks', null],
      ['Main checks', 'bad'],
    ]);
    const [running, waiting, failed] = view.rows;
    expect(running).toMatchObject({ progress: 50, detail: 'main · ci-main · Fast and integration checks' });
    expect(running?.meta).toContain('20 min');
    expect(waiting).toMatchObject({ detail: 'fix/login' });
    expect(waiting?.meta).toContain('10 min');
    expect(failed?.detail).toContain('Failed today');
    expect(got.private).toBe(false);
  });

  it('leads its figures with the runs today', async () => {
    const got = await viewsOn(actionsPage(), [{ id: 'w_fig', type: 'figures', opts: {} }]);
    const view = as(got.get('w_fig'), 'figures');
    expect(view.items[0]).toMatchObject({ label: 'Runs today', value: '7' });
  });

  it('draws Running now and the runners with their own big lines', async () => {
    const page = actionsPage();
    const running = as(await panelOn(page, 'running'), 'list');
    expect(running.head).toBe('1 running · 1 waiting');
    expect(running.rows[0]).toMatchObject({ title: 'Main checks', progress: 50 });
    const runners = as(await panelOn(page, 'runners'), 'list');
    expect(runners.head).toBe('1 of 2 online · 1 busy');
    expect(runners.rows.map((r) => [r.title, r.meta, r.tone])).toEqual([
      ['ci-pr', 'Offline', 'bad'],
      ['ci-main', 'Busy', 'ok'],
    ]);
  });
});

const t3Fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '../../things/kinds/business/fixtures/t3code', name), 'utf8'),
  );

const SHOP = 'mcp:0d3b9a51-5c2e-4f7a-8b16-7e4c2a9d1f60';
const GARDEN = 'mcp:9e7c1b24-3a6d-4c8f-a512-6b0d4e8f2c71';

/** Two projects at the widgets' clock: a question and a permission request wait, two threads work, two finished. */
function t3Page(over: Partial<T3Answers> = {}) {
  const snapshot = t3Snapshot(
    {
      environment: t3Fixture('environment.json'),
      capabilities: t3Fixture('capabilities.json'),
      projects: t3Fixture('projects.json'),
      active: new Map([
        [SHOP, t3Fixture('threads-shop-active.json')],
        [GARDEN, t3Fixture('threads-garden-active.json')],
      ]),
      recent: new Map([
        [SHOP, t3Fixture('threads-shop-recent.json')],
        [GARDEN, t3Fixture('threads-garden-recent.json')],
      ]),
      open: new Map([
        [SHOP, t3Fixture('threads-shop-open.json')],
        [GARDEN, t3Fixture('threads-garden-open.json')],
      ]),
      reads: new Map([
        ['mcp:7b3e9d10-4c2a-4f8e-9a61-3d5c7e2b8f41', t3Fixture('read-ask.json')],
        ['mcp:2c8f4a61-9b3d-4e7a-8f15-6c2e9d4b7a30', t3Fixture('read-approval.json')],
        ['mcp:5e1d7b93-2a6c-4d8f-b347-9e0c3a5f7d12', t3Fixture('read-working.json')],
        ['mcp:9c5e1a38-6b4d-4f72-8e09-3d1f7b5a2c66', t3Fixture('read-finishing.json')],
      ]),
      requests: new Map([['mcp:7b3e9d10-4c2a-4f8e-9a61-3d5c7e2b8f41', [t3Fixture('pending-read.json')]]]),
      tasks: t3Fixture('tasks.json'),
      ...over,
    },
    now,
  );
  return pageOf(
    t3View({ snapshot, now, timeZone: TZ, address: 'http://192.168.1.20:3773', signedInUntil: null }),
    { catalogId: 't3code', name: 'T3 Code' },
  );
}

describe('T3 Code', () => {
  it('offers Coding agents first after the figures; thread titles private, projects and programs not', async () => {
    const group = await groupOn(t3Page());
    const offered = group.items.map((i) => [i.opts.panel ?? i.type, !!i.private]);
    expect(offered.slice(0, 7)).toEqual([
      ['figures', false],
      ['agents', false],
      ['now', true],
      ['working', true],
      ['waiting', true],
      ['programs', false],
      ['projects', false],
    ]);
    expect(offered).toContainEqual(['recent', true]);
    expect(offered).toContainEqual(['tasks', true]);
    expect(group.items.find((i) => i.opts.panel === 'agents')?.name).toBe('Coding agents');
  });

  it('draws Coding agents: the counts as its big line, each busy project without a thread’s title', async () => {
    const got = await panelOn(t3Page(), 'agents');
    const view = as(got, 'list');
    expect(view.head).toBe('2 waiting for you · 2 working · 2 done today · 1 failed');
    expect(view.rows.map((r) => [r.title, r.meta, r.tone ?? null])).toEqual([
      ['Garden app', '1 working', 'ok'],
      ['Shop site', '2 waiting for you', 'warn'],
    ]);
    expect(view.rows[1]?.detail).toBe('1 working');
    expect(JSON.stringify(view)).not.toContain('Pick a button colour');
    expect(got.private).toBe(false);
  });

  it('draws Working now and Waiting for you with their own lines, private', async () => {
    const page = t3Page();
    const working = await panelOn(page, 'working');
    expect(as(working, 'list').head).toBe('2 working');
    expect(as(working, 'list').rows[1]).toMatchObject({ title: 'Fix the checkout page', meta: '12 min' });
    expect(working.private).toBe(true);
    const waiting = await panelOn(page, 'waiting');
    expect(as(waiting, 'list').head).toBe('2 threads');
    expect(as(waiting, 'list').rows.map((r) => r.meta)).toEqual(['Question', 'Permission']);
    expect(waiting.private).toBe(true);
  });

  it('lists Your coding agents, what waits first, and leads its figures with what finished today', async () => {
    const page = t3Page();
    const now = as(await panelOn(page, 'now'), 'list');
    expect(now.head).toBe('2 waiting for you · 2 working');
    expect(now.rows.map((r) => r.meta).slice(0, 2)).toEqual([
      'Shop site · Pick a button colour',
      expect.stringContaining('Asks permission'),
    ]);
    const got = await viewsOn(page, [{ id: 'w_fig', type: 'figures', opts: {} }]);
    expect(as(got.get('w_fig'), 'figures').items[0]).toMatchObject({ label: 'Finished today', value: '2' });
  });

  it('counts every thread at work, also past the ten rows Your coding agents shows', async () => {
    const busy = {
      projectId: SHOP,
      threads: Array.from({ length: 12 }, (_, i) => ({
        threadId: `mcp:busy-${i}`,
        projectId: SHOP,
        title: `Busy thread ${i}`,
        status: 'running',
        providerInstanceId: 'claudeAgent',
        model: 'claude-opus-5-5',
        parentThreadId: null,
        itemCount: 3,
        createdAt: '2026-10-21T19:30:00.000Z',
        updatedAt: '2026-10-21T19:45:00.000Z',
      })),
    };
    const page = t3Page({ acrossActive: busy });
    const working = as(await panelOn(page, 'working'), 'list');
    expect(working.head).toBe('14 working');
    const agents = as(await panelOn(page, 'agents'), 'list');
    expect(agents.head).toContain('14 working');
  });

  it('says nothing works or waits on a quiet day', async () => {
    const done = (name: string) => {
      const body = t3Fixture(name) as { threads: { status: string }[] };
      return { ...body, threads: body.threads.filter((t) => !['running', 'waiting'].includes(t.status)) };
    };
    const page = t3Page({
      active: new Map(),
      recent: new Map([
        [SHOP, done('threads-shop-recent.json')],
        [GARDEN, done('threads-garden-recent.json')],
      ]),
      reads: new Map(),
      requests: new Map(),
    });
    const agents = as(await panelOn(page, 'agents'), 'list');
    expect(agents.head).toBe('2 done today · 1 failed');
    expect(agents.rows).toEqual([]);
    expect(as(await panelOn(page, 'waiting'), 'list').rows).toEqual([]);
  });
});

const forgeFixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '../../things/kinds/business/fixtures/forgejo', name), 'utf8'),
  );

/** Forgejo 17 at the widgets' clock: whombat/site's main failing, one pull request waiting for a review. */
function forgejoPage() {
  const snapshot = forgeSnapshot(
    {
      version: forgeFixture('version.json'),
      reviews: { body: forgeFixture('review-requested.json'), total: 1 },
      repos: forgeRepos(forgeFixture('user-repos.json'), new Date('2026-10-21T20:00:00Z')),
      runs: new Map([
        ['whombat/site', forgeFixture('runs-site.json')],
        ['whombat/api', forgeFixture('runs-api.json')],
      ]),
      runners: forgeFixture('admin-runners.json'),
    },
    now,
    'https://git.example.com',
  );
  return pageOf(gitView({ snapshot, now, timeZone: TZ }), { catalogId: 'forgejo', name: 'Forgejo' });
}

describe('GitLab and Forgejo', () => {
  it('offers Waiting for you and the reviews alone, both private', async () => {
    const group = await groupOn(forgejoPage());
    const offered = group.items.map((i) => [i.opts.panel ?? i.type, !!i.private]);
    expect(offered.slice(0, 4)).toEqual([
      ['figures', false],
      ['waiting', true],
      ['reviews', true],
      ['runners', false],
    ]);
  });

  it('draws the failing branch before the review, and the review alone', async () => {
    const page = forgejoPage();
    const waiting = as(await panelOn(page, 'waiting'), 'list');
    expect(waiting.head).toBe('1 failing · 1 to review');
    expect(waiting.rows.map((r) => [r.title, r.tone ?? null])).toEqual([
      ['whombat/site · main', 'bad'],
      ['New header for the home page', null],
    ]);
    const reviews = as(await panelOn(page, 'reviews'), 'list');
    expect(reviews.head).toBe('1 to review');
    expect(reviews.rows.map((r) => r.title)).toEqual(['New header for the home page']);
  });

  it('leads its figures with the reviews and the default branches', async () => {
    const got = await viewsOn(forgejoPage(), [{ id: 'w_fig', type: 'figures', opts: {} }]);
    expect(as(got.get('w_fig'), 'figures').items.map((k) => [k.label, k.value])).toEqual([
      ['Your reviews', '1'],
      ['Default branches', '2'],
      ['Runners', '1 of 2'],
    ]);
  });
});
