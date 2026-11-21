/**
 * GitHub Actions' page (service-dashboards.md “GitHub Actions”), from answers shaped as GitHub's REST API gives them
 * (`fixtures/github_actions`, a repository with a run going, a pull request's job waiting for a runner that is offline,
 * a failing default branch and a switched-off workflow): what runs and how far, what waits, the last results with
 * Retry, the runners, the notices.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThingPageButton, ThingPageKpi, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../slots';
import { type ButtonSpec, seenOfView } from './common';
import {
  ACTIONS_CHECKS,
  type ActionsAnswers,
  type ActionsInput,
  type ActionsSnapshot,
  actionsCardView,
  actionsSkipped,
  actionsSnapshot,
  actionsView,
  autoRepos,
  canTake,
  GITHUB_ACTIONS_KIND,
  historyOf,
  repoList,
  repoOf,
  runnersOf,
  runState,
  waitingTooLong,
} from './github-actions';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'github_actions', name), 'utf8'));

const TZ = 'Europe/Amsterdam';
// Wednesday 21 October 2026, 21:50 in Amsterdam: Main checks has run 20 minutes, PR checks has waited 10.
const now = new Date('2026-10-21T19:50:00Z');
const REPO = 'acme/web';

function answers(over: Partial<ActionsAnswers> = {}): ActionsAnswers {
  const repo = repoOf(fixture('repo.json'));
  if (!repo) throw new Error('no repo');
  return {
    repos: [repo],
    unseen: [],
    runs: new Map([[REPO, fixture('runs.json')]]),
    main: new Map([[REPO, fixture('main.json')]]),
    workflows: new Map([[REPO, fixture('workflows.json')]]),
    jobs: new Map([
      [`${REPO}/9005`, fixture('jobs-running.json')],
      [`${REPO}/9004`, fixture('jobs-queued.json')],
    ]),
    runners: [{ scope: REPO, org: null, body: fixture('runners.json') }],
    ...over,
  };
}

const allowAll = (spec: ButtonSpec): ThingPageButton => ({ ...spec, allowed: true });
const input = (snapshot: ActionsSnapshot, over: Partial<ActionsInput> = {}): ActionsInput => ({
  snapshot,
  now,
  timeZone: TZ,
  button: allowAll,
  ...over,
});

type Table = Extract<ThingPagePanel, { kind: 'table' }>;
type List = Extract<ThingPagePanel, { kind: 'list' }>;
const panel = (panels: ThingPagePanel[], id: string) => panels.find((p) => p.id === id);
const table = (panels: ThingPagePanel[], id: string) => panel(panels, id) as Table;
type Gallery = Extract<ThingPagePanel, { kind: 'gallery' }>;
const live = (panels: ThingPagePanel[]) => panel(panels, 'running') as Gallery;
const kpi = (kpis: ThingPageKpi[] | undefined, key: string) => kpis?.find((k) => k.key === key);
const lines = (notices: ThingPageNotice[]) => notices.map((n) => [n.id, n.tone, n.check]);

describe('reading GitHub’s answers', () => {
  it('names a run by its workflow and keeps what is still going, the oldest first, with its jobs', () => {
    const s = actionsSnapshot(answers(), now);
    expect(s.active.map((a) => [a.runId, a.workflow, a.state])).toEqual([
      ['9005', 'Main checks', 'running'],
      ['9004', 'PR checks', 'queued'],
    ]);
    const [running] = s.active;
    expect(running?.jobs?.[0]).toMatchObject({
      runner: 'ci-main',
      step: 'Fast and integration checks',
      stepsDone: 2,
    });
    // The middle of the last passing runs on main: 36 and 40 minutes.
    expect(running?.usualMs).toBe(40 * 60_000);
    expect(running?.title).toBeNull();
  });

  it('takes each workflow’s last result that passed or failed on the default branch, switched-off ones left out', () => {
    const s = actionsSnapshot(answers(), now);
    expect(s.latest.map((r) => [r.runId, r.workflow, r.state])).toEqual([['9003', 'Main checks', 'failed']]);
    expect(s.recent.map((r) => r.runId)).toEqual(['9003', '9002', '9001', '9000', '8999', '8990']);
  });

  it('keeps runner ids apart per repository or organisation, and its own labels', () => {
    const runners = runnersOf(fixture('runners.json'), REPO, null);
    expect(runners.map((r) => [r.id, r.name, r.online, r.busy, r.custom])).toEqual([
      [`${REPO}/22`, 'ci-main', true, true, ['ci', 'main']],
      [`${REPO}/21`, 'ci-pr', false, false, ['ci', 'pr']],
    ]);
    expect(runnersOf(fixture('runners.json'), 'acme', 'acme')[0]?.id).toBe('acme/22');
  });

  it('reads GitHub’s states', () => {
    expect(runState('completed', 'success')).toBe('passed');
    expect(runState('completed', 'timed_out')).toBe('failed');
    expect(runState('completed', 'cancelled')).toBe('other');
    expect(runState('in_progress', null)).toBe('running');
    expect(runState('pending', null)).toBe('waiting');
  });

  it('reads the connection’s list and the repositories the token sees', () => {
    expect(repoList(' acme/web, acme/api.git ,ACME/WEB,, nope ')).toEqual(['acme/web', 'acme/api']);
    expect(repoList(undefined)).toEqual([]);
    expect(autoRepos(fixture('user-repos.json')).map((r) => [r.fullName, r.defaultBranch, r.org])).toEqual([
      ['acme/web', 'main', true],
      ['mara/notes', 'trunk', false],
    ]);
  });

  it('matches a job’s labels to a runner’s in any case', () => {
    const [main] = runnersOf(fixture('runners.json'), REPO, null);
    if (!main) throw new Error('no runner');
    expect(canTake(main, ['self-hosted', 'CI', 'main'])).toBe(true);
    expect(canTake(main, ['self-hosted', 'ci', 'pr'])).toBe(false);
  });
});

describe('the page', () => {
  it('shows what runs with its runner, step and time left, and what waits', () => {
    const view = actionsView(input(actionsSnapshot(answers(), now)));
    expect(slotProblems(view)).toEqual([]);
    const running = live(view.panels);
    expect([running.look, running.place, running.meta]).toEqual(['rows', 'chart', '1 running · 1 waiting']);
    const [first, second] = running.items;
    expect(first?.sub).toBe('main · ci-main · Fast and integration checks');
    expect(first?.progress).toBe(0.5);
    expect(first?.note).toBe('20 min');
    expect(first?.noteEnd).toContain('20 min');
    expect(first?.badge).toBeUndefined();
    // PR checks waits 10 minutes for the offline runner: no start, its wait at the end, tagged.
    expect(second?.sub).toBe('fix/login');
    expect(second?.note).toBeUndefined();
    expect(second?.noteEnd).toContain('10 min');
    expect(second?.badge).toEqual({ text: 'Waiting', tone: 'bad' });
  });

  it('says a run is taking longer than usual', () => {
    const later = new Date('2026-10-21T20:35:00Z');
    const view = actionsView(input(actionsSnapshot(answers(), later), { now: later }));
    expect(live(view.panels).items[0]).toMatchObject({
      noteEnd: 'Longer than usual',
      badge: { text: 'Late', tone: 'warn' },
    });
  });

  it('lists the last results on main with Retry on a failed one, and the figures', () => {
    const view = actionsView(input(actionsSnapshot(answers(), now)));
    const latest = table(view.panels, 'latest');
    expect(latest.title).toBe('Last runs on main');
    expect(latest.rows[0]?.cells.result).toMatchObject({ text: 'Failed', dot: 'bad' });
    expect(latest.rows[0]?.cells.retry?.action).toMatchObject({ action: 'retry', target: `${REPO}/9003` });
    expect(latest.place).toBe('main');
    const card = actionsCardView(input(actionsSnapshot(answers(), now))).kpis;
    expect(kpi(card, 'running')).toMatchObject({ value: '1', sub: '1 waiting' });
    expect(kpi(card, 'failing')).toMatchObject({ value: '1', tone: 'warn' });
    expect(kpi(card, 'runners')).toMatchObject({ value: '1 of 2', tone: 'warn' });
    // Seven runs started today in Amsterdam: five finished (three passed, two failed) and two still going.
    expect(kpi(card, 'today')).toMatchObject({ value: '7', sub: '3 passed · 2 failed' });
    // The same, counted in Builds.
    const counts = panel(view.panels, 'counts') as List;
    expect(counts.items.map((i) => [i.title, i.figure?.value, i.figure?.note])).toEqual([
      ['Workflows', '1', '1 failing'],
      ['Runs today', '7', '3 passed · 2 failed'],
      ['Runners', '1 of 2', '1 offline'],
    ]);
    expect(view.kpis).toEqual([]);
    expect(view.open?.url).toBe(`https://github.com/${REPO}/actions`);
    // A run that neither passed nor failed says how it ended.
    expect(table(view.panels, 'recent').rows.at(-1)?.cells.result).toMatchObject({
      text: 'Cancelled',
      dot: 'off',
    });
  });

  it('draws no Retry without a button, as the health pass builds it', () => {
    const view = actionsView(input(actionsSnapshot(answers(), now), { button: undefined }));
    expect(table(view.panels, 'latest').rows[0]?.cells.retry).toBeUndefined();
  });

  it('lists the runners, offline first, with what a busy one runs', () => {
    const view = actionsView(input(actionsSnapshot(answers(), now)));
    const runners = panel(view.panels, 'runners') as List;
    expect(runners.meta).toBe('1 of 2 online · 1 busy');
    expect(runners.items.map((i) => [i.title, i.right, i.tone])).toEqual([
      ['ci-pr', 'Offline', 'bad'],
      ['ci-main', 'Busy', 'ok'],
    ]);
    expect(runners.items[1]?.detail).toContain('Main checks');
  });

  it('says what a token without Administration read can’t see', () => {
    const s = actionsSnapshot(answers({ runners: null }), now);
    const view = actionsView(input(s));
    expect(panel(view.panels, 'runners')).toBeUndefined();
    expect(view.facts.flat().map((p) => p.text)).toContain('Administration');
    expect(actionsSkipped(s)).toEqual([ACTIONS_CHECKS.runner]);
  });
});

describe('this week', () => {
  /** Runs made a day apart from 13 days ago to today, every other one failed. */
  const runs = (n: number, total = n) => ({
    total_count: total,
    workflow_runs: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      status: 'completed',
      conclusion: i % 2 ? 'failure' : 'success',
      created_at: new Date(now.getTime() - i * 86_400_000).toISOString(),
    })),
  });

  it('counts the runs per day with how many failed and the change on the week before', () => {
    const view = actionsView(input(actionsSnapshot(answers({ history: new Map([[REPO, runs(14)]]) }), now)));
    expect(slotProblems(view)).toEqual([]);
    const week = panel(view.panels, 'week');
    if (week?.kind !== 'chart') throw new Error('no week');
    expect(week.series[0]?.values).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(week.figure).toEqual({ value: '7', rest: 'runs this week' });
    expect(week.stats?.map((l) => l.map((p) => p.text).join(''))).toEqual(['+0 % on last week', '3 failed']);
  });

  it('leaves out the days a full page may not hold whole, and no Trend without the read', () => {
    const { full } = historyOf(runs(3, 250));
    expect(full).toEqual(new Date(now.getTime() - 2 * 86_400_000));
    const view = actionsView(
      input(actionsSnapshot(answers({ history: new Map([[REPO, runs(3, 250)]]) }), now)),
    );
    const week = panel(view.panels, 'week');
    expect(week?.kind === 'chart' && week.series[0]?.values).toEqual([null, null, null, null, null, 1, 1]);
    expect(panel(actionsView(input(actionsSnapshot(answers(), now))).panels, 'week')).toBeUndefined();
  });

  it('keeps the card’s figures', () => {
    const seen = seenOfView(actionsCardView(input(actionsSnapshot(answers(), now))), ['running', 'failing']);
    expect(seen.glance.facts?.map((f) => f.value)).toEqual(['1', '1']);
  });
});

describe('Worth a look', () => {
  it('raises the job nothing online can take, the failing workflow and the offline runner', () => {
    const view = actionsView(input(actionsSnapshot(answers(), now)));
    expect(lines(view.notices)).toEqual([
      [`waiting-${REPO}/9004/7002`, 'bad', ACTIONS_CHECKS.waiting],
      [`failing-${REPO}/101`, 'warn', ACTIONS_CHECKS.failing],
      [`runner-${REPO}/21`, 'warn', ACTIONS_CHECKS.runner],
    ]);
    const waiting = view.notices[0];
    expect(waiting?.detail).toContain('ci, pr');
    expect(waiting?.subject?.id).toBe(`job:${REPO}/9004/7002`);
    expect(view.status).toMatchObject({ status: 'bad' });
  });

  it('waits half an hour before a job every runner that could take is busy with', () => {
    const runners = fixture('runners.json') as { runners: { status: string; busy: boolean }[] };
    const busy = { runners: runners.runners.map((r) => ({ ...r, status: 'online', busy: true })) };
    const s = actionsSnapshot(answers({ runners: [{ scope: REPO, org: null, body: busy }] }), now);
    expect(waitingTooLong(s, now)).toEqual([]);
    const later = new Date('2026-10-21T20:15:00Z');
    expect(waitingTooLong(s, later).map((w) => w.why)).toEqual(['busy']);
  });

  it('waits half an hour for GitHub’s own runners', () => {
    const queued = fixture('jobs-queued.json') as { jobs: Record<string, unknown>[] };
    const hosted = { jobs: queued.jobs.map((j) => ({ ...j, labels: ['ubuntu-latest'] })) };
    const s = actionsSnapshot(answers({ jobs: new Map([[`${REPO}/9004`, hosted]]) }), now);
    expect(waitingTooLong(s, now)).toEqual([]);
    expect(waitingTooLong(s, new Date('2026-10-21T20:15:00Z')).map((w) => w.why)).toEqual(['github']);
  });

  it('says which checks a read couldn’t see whole', () => {
    const s = actionsSnapshot(answers({ runs: new Map([[REPO, null]]) }), now);
    expect(s.missed).toEqual([REPO]);
    expect(actionsSkipped(s)).toEqual([ACTIONS_CHECKS.failing, ACTIONS_CHECKS.waiting]);
  });

  it('declares what it watches and what asks first', () => {
    expect(GITHUB_ACTIONS_KIND.checks?.map((c) => c.check)).toEqual([
      ACTIONS_CHECKS.failing,
      ACTIONS_CHECKS.runner,
      ACTIONS_CHECKS.waiting,
    ]);
    expect(Object.keys(GITHUB_ACTIONS_KIND.actions ?? {})).toEqual(['retry']);
  });
});
