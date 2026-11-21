/**
 * T3 Code's page (docs/decisions/t3code.md T3-10…T3-13), from answers shaped as a T3 Code 0.1.3 server's MCP tools give
 * them (`fixtures/t3code`: two projects, a thread asking a question, one asking permission, one working, one finishing
 * up, one done and one failed today, AI programs ready, switched off, not installed and not signed in, three scheduled
 * tasks): the figures, what waits with its one-tap answers, what works with Stop, the latest threads, the programs,
 * projects and tasks, the head, Worth a look and what it watches, and which answer a tap sends.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThingPageButton, ThingPageKpi, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../slots';
import { type ButtonSpec, seenOfView } from './common';
import {
  activityOf,
  answerFor,
  oneTap,
  programProblem,
  projectsOf,
  projectsToRead,
  readArgs,
  requestOf,
  STATE,
  scheduleWords,
  T3_CHECK_LIST,
  T3_CHECKS,
  T3_STATUSES,
  type T3Answers,
  T3CODE_KIND,
  type T3Input,
  type T3Snapshot,
  t3CardView,
  t3Skipped,
  t3Snapshot,
  t3View,
  threadsOf,
  threadsToAsk,
  threadsToRead,
  threadUrl,
  waitingFor,
} from './t3code';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 't3code', name), 'utf8'));

const TZ = 'Europe/Amsterdam';
// Wednesday 21 October 2026, 21:50 in Amsterdam: Fix the checkout page has worked 12 minutes.
const now = new Date('2026-10-21T19:50:00Z');
const ADDRESS = 'http://192.168.1.20:3773';
const ENV = '6a1f3c2e-0b7d-4e59-9c84-2d1e5f7a9b30';
const SHOP = 'mcp:0d3b9a51-5c2e-4f7a-8b16-7e4c2a9d1f60';
const GARDEN = 'mcp:9e7c1b24-3a6d-4c8f-a512-6b0d4e8f2c71';
const ASK = 'mcp:7b3e9d10-4c2a-4f8e-9a61-3d5c7e2b8f41';
const APPROVAL = 'mcp:2c8f4a61-9b3d-4e7a-8f15-6c2e9d4b7a30';
const WORKING = 'mcp:5e1d7b93-2a6c-4d8f-b347-9e0c3a5f7d12';
const PHOTOS = 'mcp:9c5e1a38-6b4d-4f72-8e09-3d1f7b5a2c66';

function answers(over: Partial<T3Answers> = {}): T3Answers {
  return {
    environment: fixture('environment.json'),
    capabilities: fixture('capabilities.json'),
    projects: fixture('projects.json'),
    active: new Map([
      [SHOP, fixture('threads-shop-active.json')],
      [GARDEN, fixture('threads-garden-active.json')],
    ]),
    recent: new Map([
      [SHOP, fixture('threads-shop-recent.json')],
      [GARDEN, fixture('threads-garden-recent.json')],
    ]),
    open: new Map([
      [SHOP, fixture('threads-shop-open.json')],
      [GARDEN, fixture('threads-garden-open.json')],
    ]),
    reads: new Map([
      [ASK, fixture('read-ask.json')],
      [APPROVAL, fixture('read-approval.json')],
      [WORKING, fixture('read-working.json')],
      [PHOTOS, fixture('read-finishing.json')],
    ]),
    requests: new Map([[ASK, [fixture('pending-read.json')]]]),
    tasks: fixture('tasks.json'),
    ...over,
  };
}

const allowAll = (spec: ButtonSpec): ThingPageButton => ({ ...spec, allowed: true });
const input = (snapshot: T3Snapshot, over: Partial<T3Input> = {}): T3Input => ({
  snapshot,
  now,
  timeZone: TZ,
  address: ADDRESS,
  signedInUntil: new Date('2026-11-19T19:00:00Z'),
  button: allowAll,
  ...over,
});
const view = (over: Partial<T3Input> = {}, a: Partial<T3Answers> = {}) =>
  t3View(input(t3Snapshot(answers(a), now), over));

const card = (over: Partial<T3Input> = {}, a: Partial<T3Answers> = {}) =>
  t3CardView(input(t3Snapshot(answers(a), now), over));

type Table = Extract<ThingPagePanel, { kind: 'table' }>;
type Gallery = Extract<ThingPagePanel, { kind: 'gallery' }>;
const live = (panels: ThingPagePanel[]) => panel(panels, 'now') as Gallery;
type List = Extract<ThingPagePanel, { kind: 'list' }>;
const panel = (panels: ThingPagePanel[], id: string) => panels.find((p) => p.id === id);
const table = (panels: ThingPagePanel[], id: string) => panel(panels, id) as Table;
const listOf = (panels: ThingPagePanel[], id: string) => panel(panels, id) as List;
const kpi = (kpis: ThingPageKpi[] | undefined, key: string) => kpis?.find((k) => k.key === key);
const lines = (notices: ThingPageNotice[]) => notices.map((n) => [n.id, n.tone, n.check]);
const words = (v: { facts: { text: string }[][] }) => v.facts.map((l) => l.map((p) => p.text).join(''));

describe('reading T3 Code’s answers', () => {
  it('reads the projects changed last, deleted ones left out', () => {
    const projects = projectsOf(fixture('projects.json'));
    expect(projects.map((p) => p.title)).toEqual(['Garden app', 'Shop site']);
    expect(projectsToRead(projects).map((p) => p.title)).toEqual(['Shop site', 'Garden app']);
  });

  it('reads every project with a thread at work, then the ones worked in last, not the ones whose settings changed', () => {
    const projects = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      title: `Project ${i}`,
      // p0 had its settings changed last; nobody changed p10's or p11's in weeks.
      updatedAt: new Date(Date.UTC(2026, 9, 20 - i)),
    }));
    const thread = (projectId: string, status: 'running' | 'completed', minutesAgo: number) => ({
      projectId,
      status,
      updatedAt: new Date(now.getTime() - minutesAgo * 60_000),
    });
    const read = projectsToRead(projects, [
      thread('p11', 'running', 30),
      thread('p10', 'running', 40),
      thread('p9', 'completed', 1),
    ]).map((p) => p.id);
    expect(read.slice(0, 3)).toEqual(['p11', 'p10', 'p9']);
    expect(read).toHaveLength(8);
    // More projects at work than eight: each of them is read.
    const busy = projects.map((p, i) => thread(p.id, 'running', i));
    expect(projectsToRead(projects, busy)).toHaveLength(12);
  });

  it('shows a thread at work from the list across projects when its project’s own lists didn’t answer', () => {
    const across = fixture('threads-shop-active.json');
    const s = t3Snapshot(
      answers({ acrossActive: across, active: new Map(), recent: new Map([[GARDEN, null]]) }),
      now,
    );
    expect(s.threads.map((t) => t.id)).toContain(WORKING);
    expect(s.missed).toEqual(['Shop site', 'Garden app']);
  });

  it('keeps every thread once, the latest first, with its project and AI program', () => {
    const s = t3Snapshot(answers(), now);
    expect(s.threads.map((t) => [t.title, t.status])).toEqual([
      ['Speed up photo loading', 'waiting'],
      ['Fix the checkout page', 'running'],
      ['Add a contact form', 'running'],
      ['Pick a button colour', 'running'],
      ['Write the release notes', 'completed'],
      ['Update the price list', 'failed'],
      ['Plan the winter release', 'interrupted'],
      ['Tidy the readme', 'idle'],
      ['Try the new map view', 'completed'],
    ]);
    expect(s.threads.find((t) => t.id === WORKING)).toMatchObject({
      projectId: SHOP,
      program: 'claudeAgent',
      model: 'claude-opus-5-5',
      items: 14,
    });
    expect(s.open.get(SHOP)).toBe(5);
    expect(s.projectCount).toBe(2);
  });

  it('reads what a thread at work waits for from its latest items', () => {
    expect(activityOf(fixture('read-ask.json'))).toMatchObject({ pending: 1, asks: true, approval: null });
    expect(activityOf(fixture('read-approval.json'))).toMatchObject({
      pending: 1,
      asks: false,
      approval: 'contact.html',
    });
    expect(activityOf(fixture('read-working.json'))).toMatchObject({
      pending: 0,
      startedAt: new Date('2026-10-21T19:38:00.000Z'),
    });
  });

  it('reads a thread’s last items, the running ones first, and asks only those with a question', () => {
    const s = t3Snapshot(answers(), now);
    expect(readArgs({ id: WORKING, items: 14 })).toMatchObject({
      view: 'activity',
      afterPosition: 9,
      limit: 4,
    });
    expect(readArgs({ id: ASK, items: 4 })).not.toHaveProperty('afterPosition');
    expect(threadsToRead(s.threads).map((t) => t.id)).toEqual([ASK, APPROVAL, WORKING, PHOTOS]);
    expect(threadsToAsk(s.threads, s.activity).map((t) => t.id)).toEqual([ASK]);
  });

  it('reads the AI programs: switched off, ready, or what stops them', () => {
    const s = t3Snapshot(answers(), now);
    expect(s.programs?.map((p) => [p.id, p.on, p.problems.length])).toEqual([
      ['codex', true, 0],
      ['claudeAgent', true, 0],
      ['cursor', false, 0],
      ['opencode', true, 1],
      ['pi', true, 2],
      ['grok', false, 0],
    ]);
    expect(programProblem({ problems: ['Provider executable is not installed.'] })?.words).toBe(
      'Not installed',
    );
    expect(programProblem({ problems: ['Provider is not authenticated.'] })?.words).toBe('Not signed in');
    expect(programProblem({ problems: ['No V2 provider adapter is registered.'] })?.words).toContain(
      'can’t run',
    );
    expect(programProblem({ problems: ['Timed out while checking.'] })?.words).toBe('Doesn’t start');
    expect(programProblem({ problems: [] })).toBeNull();
  });

  it('has words and a dot for every state', () => {
    for (const status of T3_STATUSES) expect(STATE[status].text.length).toBeGreaterThan(0);
    expect(STATE.waiting.text).toBe('Finishing up');
    expect(STATE.rolled_back.text).toBe('Undone');
    expect(
      threadsOf({ threads: [{ threadId: 'x', status: 'new_kind', createdAt: now.toISOString() }] }),
    ).toEqual([]);
  });
});

describe('the page', () => {
  it('keeps the figures on the card: working, waiting for you, today, AI programs', () => {
    expect(view().kpis).toEqual([]);
    const v = card();
    expect(seenOfView(v, ['working', 'waiting']).glance.facts?.map((f) => f.value)).toEqual(['2', '2']);
    expect(v.kpis?.map((k) => [k.key, k.value])).toEqual([
      ['working', '2'],
      ['waiting', '2'],
      ['today', '2'],
      ['programs', '2 of 4'],
    ]);
    expect(kpi(v.kpis, 'working')?.sub).toBe('in 2 projects');
    expect(kpi(v.kpis, 'waiting')).toMatchObject({ sub: '1 question · 1 permission request', tone: 'warn' });
    expect(kpi(v.kpis, 'today')).toMatchObject({ rest: 'threads', sub: '1 failed' });
    expect(kpi(v.kpis, 'programs')?.sub).toContain('2 can’t run');
  });

  it('lists what waits, a one-tap question with its options as buttons and a permission request without', () => {
    const v = view();
    expect(slotProblems(v)).toEqual([]);
    const now = live(v.panels);
    expect([now.look, now.shape, now.meta]).toEqual(['rows', 'square', '2 waiting for you · 2 working']);
    const [ask, approval] = now.items;
    // The question leads its row, the thread under it; a permission request says what it is for.
    expect([ask?.badge?.text, approval?.badge?.text]).toEqual(['Question', 'Permission']);
    expect(ask?.title).toContain('Which colour');
    expect(ask?.sub).toBe('Shop site · Pick a button colour');
    expect(approval?.title).toBe('Add a contact form');
    expect(ask?.actions?.map((a) => [a.action, a.target, a.value, a.label])).toEqual([
      ['answer', ASK, 'Blue', 'Blue'],
      ['answer', ASK, 'Green', 'Green'],
      ['answer', ASK, 'Orange', 'Orange'],
    ]);
    expect(approval?.sub).toContain('contact.html');
    expect(approval?.actions).toBeUndefined();
    expect(ask?.url).toBe(`${ADDRESS}/${ENV}/${encodeURIComponent(ASK)}`);
  });

  it('answers in T3 Code what a tap can’t: several choices, more than three options', () => {
    const read = fixture('pending-read.json') as { questions: Record<string, unknown>[] };
    const q = read.questions[0] as Record<string, unknown>;
    const many = { ...read, questions: [{ ...q, multiSelect: true }] };
    const v = view({}, { requests: new Map([[ASK, [many]]]) });
    const ask = live(v.panels).items[0];
    expect(ask?.actions).toBeUndefined();
    expect(ask?.title).toContain('Blue, Green or Orange');
    const options = q.options as unknown[];
    const four = {
      ...read,
      questions: [{ ...q, options: [...options, { label: 'Red', description: null }] }],
    };
    expect(oneTap(requestOf(four, ASK))).toBeNull();
    expect(oneTap(requestOf(read, ASK))?.options.length).toBe(3);
  });

  it('shows what works with its AI program, model and time, Stop only on a turn under way', () => {
    const working = live(view().panels).items.slice(2);
    expect(working.map((i) => [i.id, i.note, i.noteEnd])).toEqual([
      [PHOTOS, 'For 30 min', 'Finishing up'],
      [WORKING, 'For 12 min', 'Working'],
    ]);
    const [photos, fixing] = working;
    expect(fixing).toMatchObject({ title: 'Fix the checkout page', sub: 'Shop site · Claude Opus 5.5' });
    expect(photos?.sub).toBe('Garden app · Codex · gpt-6-astra');
    expect(fixing?.actions?.[0]).toMatchObject({ action: 'stop', target: WORKING, tone: 'danger' });
    expect(fixing?.actions?.[0]?.confirm?.button).toBe('Stop');
    expect(photos?.actions).toBeUndefined();
  });

  it('draws no buttons without a button maker, as the health pass builds it', () => {
    const v = view({ button: undefined });
    expect(live(v.panels).items.some((i) => i.actions)).toBe(false);
  });

  it('counts what finished today, the open threads, the AI programs and the scheduled tasks', () => {
    const counts = listOf(view().panels, 'counts');
    expect(counts.title).toBe('In T3 Code');
    expect(counts.items.map((i) => [i.title, i.figure?.value, i.figure?.note ?? null])).toEqual([
      ['Finished today', '2', '1 failed'],
      ['Open threads', '7', null],
      ['AI programs', '2 of 4', '2 can’t run'],
      ['Scheduled tasks', '3', '1 failed last time'],
    ]);
  });

  it('draws the threads finished per day, and its version and computer in the machine card', () => {
    const v = view();
    const week = panel(v.panels, 'week');
    if (week?.kind === 'chart') {
      expect(week.labels?.at(-1)).toBe('Today');
      expect(week.series[0]?.values.at(-1)).toBe(2);
    } else expect(week).toBeUndefined();
    expect(v.slots?.machine.map((l) => [l.label, l.value])).toEqual([
      ['T3 Code', '0.1.3'],
      ['Computer', 'Linux · workbench'],
    ]);
    expect(v.panels.map((p) => p.id).slice(-4)).toEqual(['recent', 'projects', 'programs', 'tasks']);
  });

  it('lists the latest ten threads with their state in words, a waiting one as waiting for you', () => {
    const recent = table(view().panels, 'recent');
    expect(recent.rows.length).toBe(9);
    const state = (id: string) => recent.rows.find((r) => r.id === id)?.cells.state;
    expect(state(ASK)).toMatchObject({ text: 'Waiting for you', dot: 'warn' });
    expect(recent.rows.map((r) => r.cells.state?.text)).toContain('Failed');
    expect(recent.rows.map((r) => r.cells.state?.text)).toContain('Stopped');
    expect(recent.rows[0]?.cells.when?.text).toBe('Today 21:49');
  });

  it('lists the AI programs switched on, those that can’t run first, and counts the others', () => {
    const programs = listOf(view().panels, 'programs');
    expect(programs.meta).toBe('2 ready · 2 switched off');
    expect(programs.items.map((i) => [i.title, i.right])).toEqual([
      ['OpenCode', 'Not installed'],
      ['Pi', 'Not signed in'],
      ['Codex', 'Ready'],
      ['Claude', 'Ready'],
    ]);
    expect(programs.items[1]?.detail).toContain('pi login');
    expect(programs.items[1]?.detail).not.toContain('`');
    expect(programs.items[3]?.detail).toBe('Claude Opus 5.5, Claude Sonnet 5.5 and 10 more');
  });

  it('lists the projects with their open threads, and the scheduled tasks without their prompts or addresses', () => {
    const v = view();
    expect(listOf(v.panels, 'projects').items.map((i) => [i.title, i.right, i.detail])).toEqual([
      ['Garden app', '2 open', '1 working'],
      ['Shop site', '5 open', '2 waiting for you · 1 working'],
    ]);
    const tasks = listOf(v.panels, 'tasks').items;
    expect(tasks.map((t) => [t.title, t.right])).toEqual([
      ['Check the shop for broken links', 'Went fine'],
      ['Update the dependencies', 'Failed'],
      ['Answer new issues', 'Switched off'],
    ]);
    expect(tasks[0]?.detail).toBe('Weekdays at 07:00 · next tomorrow 07:00');
    expect(tasks[1]?.detail).toContain('Every 7 days');
    expect(JSON.stringify(tasks)).not.toContain('api/hooks');
    expect(JSON.stringify(tasks)).not.toContain('{{body');
    expect(scheduleWords({ type: 'interval', everyMs: 30 * 60_000 })).toBe('Every 30 min');
    expect(scheduleWords({ type: 'fixed_time', time: '09:30', weekdays: null })).toBe('Every day at 09:30');
  });

  it('says the version, the computer, its system and how long Whombat stays signed in; opens T3 Code', () => {
    const v = view();
    expect(words(v)).toEqual(['T3 Code 0.1.3 · workbench · Linux', 'Signed in until 19 Nov']);
    expect(v.facts[0]?.find((p) => p.strong)?.text).toBe('0.1.3');
    expect(v.open).toEqual({ label: 'Open T3 Code', url: `${ADDRESS}/` });
    expect(words(view({ signedInUntil: null }))).toEqual(['T3 Code 0.1.3 · workbench · Linux']);
  });

  it('never shows a raw id or a T3 Code link as words', () => {
    const v = view();
    const shown = JSON.stringify({ k: v.kpis, n: v.notices, f: v.facts, p: v.panels })
      .replace(/"(id|target|url)":"[^"]*"/g, '')
      .replace(/"subject":\{[^}]*\}/g, '');
    expect(shown).not.toContain('mcp:');
    expect(shown).not.toContain('t3-thread://');
    expect(shown).not.toContain('runtime-request');
  });

  it('links a thread to T3 Code itself when the computer’s id isn’t known', () => {
    const s = t3Snapshot(answers({ environment: null }), now);
    expect(threadUrl({ snapshot: s, address: ADDRESS }, ASK)).toBe(`${ADDRESS}/`);
  });
});

describe('Worth a look', () => {
  it('raises the AI program in use that can’t run, each thread waiting, and the thread that failed today', () => {
    const v = view();
    expect(lines(v.notices)).toEqual([
      ['program-opencode', 'warn', T3_CHECKS.program],
      [`waiting-${ASK}`, 'warn', T3_CHECKS.waiting],
      [`waiting-${APPROVAL}`, 'warn', T3_CHECKS.waiting],
      [`failed-mcp:3d9f6b20-5e1a-4c87-9b43-7a2e8c0d6f15`, 'warn', T3_CHECKS.failed],
    ]);
    expect(v.notices[0]?.title).toContain('OpenCode');
    expect(v.notices[0]?.link).toMatchObject({ kind: 'url', url: `${ADDRESS}/settings/providers` });
    expect(v.notices.map((n) => n.title)).not.toContain('Pi can’t run in T3 Code');
    expect(v.status).toMatchObject({ status: 'warn' });
  });

  it('says Whombat’s sign-in ends within five days, and when it has ended', () => {
    const soon = view({ signedInUntil: new Date('2026-10-24T10:00:00Z') });
    const line = soon.notices.find((n) => n.check === T3_CHECKS.signin);
    expect(line).toMatchObject({ tone: 'warn', nature: 'you', link: { kind: 'tab', tab: 'settings' } });
    expect(line?.title).toContain('24 Oct');
    expect(soon.status?.badge).toBe('Sign-in ends soon');
    const ended = view({ signedInUntil: new Date('2026-10-21T08:00:00Z') });
    expect(ended.notices.find((n) => n.check === T3_CHECKS.signin)?.tone).toBe('bad');
    expect(view().notices.some((n) => n.check === T3_CHECKS.signin)).toBe(false);
  });

  it('turns red when no AI program switched on can run', () => {
    const caps = fixture('capabilities.json') as { providers: Record<string, unknown>[] };
    const broken = {
      ...caps,
      providers: caps.providers.map((p) => ({
        ...p,
        constraints: (p.constraints as string[]).length ? p.constraints : ['Provider is not authenticated.'],
      })),
    };
    const v = view({}, { capabilities: broken });
    expect(v.notices.filter((n) => n.check === T3_CHECKS.program).map((n) => n.tone)).toContain('bad');
    expect(kpi(card({}, { capabilities: broken }).kpis, 'programs')).toMatchObject({
      value: '0 of 4',
      tone: 'bad',
    });
  });

  it('says which checks a read couldn’t see whole', () => {
    expect(t3Skipped(t3Snapshot(answers(), now))).toEqual([]);
    expect(t3Skipped(t3Snapshot(answers({ capabilities: null }), now))).toEqual([T3_CHECKS.program]);
    const missed = t3Snapshot(answers({ active: new Map(), recent: new Map([[SHOP, null]]) }), now);
    expect(missed.missed).toEqual(['Shop site', 'Garden app']);
    expect(t3Skipped(missed)).toContain(T3_CHECKS.failed);
  });

  it('declares what it watches: its sign-in and broken AI programs on, waiting and failed threads off', () => {
    expect(T3_CHECK_LIST.map((c) => [c.check, c.startsOn])).toEqual([
      ['t3code.signin_ends', true],
      ['t3code.program_cant_run', true],
      ['t3code.thread_waiting', false],
      ['t3code.thread_failed', false],
    ]);
    expect(T3CODE_KIND.checks).toBe(T3_CHECK_LIST);
    expect(Object.keys(T3CODE_KIND.actions ?? {})).toEqual(['stop', 'answer']);
    expect(T3CODE_KIND.asksFirst).toContain('deleting');
  });
});

describe('a tap’s answer', () => {
  const request = requestOf(fixture('pending-read.json'), ASK);

  it('answers the one single-choice question that offers the label, by its id', () => {
    expect(answerFor(request, 'Green')).toEqual({ 'Which colour should the shop’s buttons be?': 'Green' });
  });

  it('sends nothing for a label it doesn’t offer, or a question that changed', () => {
    expect(answerFor(request, 'Purple')).toBeNull();
    expect(answerFor(null, 'Green')).toBeNull();
    const q = request?.questions[0];
    if (!request || !q) throw new Error('no request');
    expect(answerFor({ ...request, questions: [q, { ...q, id: 'second' }] }, 'Green')).toBeNull();
    expect(answerFor({ ...request, questions: [{ ...q, multiSelect: true }] }, 'Green')).toBeNull();
  });

  it('counts a thread as waiting only while T3 Code says something is pending', () => {
    const s = t3Snapshot(answers(), now);
    expect(waitingFor(s).map((w) => [w.thread.id, w.kind])).toEqual([
      [ASK, 'question'],
      [APPROVAL, 'permission'],
    ]);
  });
});
