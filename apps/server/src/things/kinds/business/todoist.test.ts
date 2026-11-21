/**
 * Todoist's page from documented answers (service-dashboards.md SD-65): tasks with dates, times and floating times in
 * the burrow's day, today and overdue apart, done today, and Done on every row.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ThingPageButton, ThingPageKpi, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { list, rec } from '../../words';
import { slotProblems } from '../slots';
import { type ButtonSpec, seenOfView } from './common';
import {
  doneOf,
  plainContent,
  TODOIST_KIND,
  type TodoistInput,
  type TodoistSnapshot,
  todoistCardView,
  todoistLists,
  todoistTask,
  todoistView,
} from './todoist';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'todoist', name), 'utf8'));

const TZ = 'Europe/Amsterdam';
// Tuesday 21 October 2026, 17:00 in Amsterdam.
const now = new Date('2026-10-21T15:00:00Z');

function snapshot(over: Partial<TodoistSnapshot> = {}): TodoistSnapshot {
  return {
    readAt: now,
    tasks: list(rec(fixture('tasks-filter.json')).results)
      .map((t) => todoistTask(t, TZ))
      .filter((t) => t !== null),
    projects: new Map(
      list(rec(fixture('projects.json')).results).map((p) => [String(rec(p).id), String(rec(p).name)]),
    ),
    doneToday: list(rec(fixture('completed.json')).items).length,
    more: false,
    // Tomorrow, the day after and Saturday; today's tasks are in the list too.
    coming: { days: ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'], more: false },
    done: doneOf(list(rec(fixture('completed.json')).items), false),
    ...over,
  };
}

const allowAll = (spec: ButtonSpec): ThingPageButton => ({ ...spec, allowed: true });
const input = (over: Partial<TodoistInput> = {}): TodoistInput => ({
  snapshot: snapshot(),
  now,
  timeZone: TZ,
  button: allowAll,
  ...over,
});

describe('Todoist’s answers', () => {
  it('reads tasks with a date, a fixed time or a floating time in the burrow’s day', () => {
    const tasks = snapshot().tasks;
    expect(tasks.map((t) => [t.id, t.day, t.at?.toISOString() ?? null])).toEqual([
      ['6Jf8VQXxpwv56VQ7', '2026-10-21', null],
      ['6Jf8VQXxpwv56VQ9', '2026-10-21', '2026-10-21T08:00:00.000Z'],
      ['6Jf8VQXxpwv56VR1', '2026-10-14', null],
      // 16:30 on the wall clock in Amsterdam.
      ['6Jf8VQXxpwv56VR2', '2026-10-20', '2026-10-20T14:30:00.000Z'],
    ]);
    expect(tasks[0]?.content).toBe('Pay the VAT return');
    expect(tasks[1]?.recurring).toBe(true);
  });

  it('writes a task’s words plainly', () => {
    expect(plainContent('Send **invoice** to [Acme](https://acme.example)')).toBe('Send invoice to Acme');
    expect(todoistTask({ id: 'x', content: 'No date' }, TZ)).toBeNull();
    expect(todoistTask({ id: 'x', due: { date: 'soon' } }, TZ)).toBeNull();
  });
});

describe('Todoist’s page (SD-65)', () => {
  it('puts overdue first, oldest first, then today by time', () => {
    const { today, overdue } = todoistLists(input());
    expect(overdue.map((t) => t.id)).toEqual(['6Jf8VQXxpwv56VR1', '6Jf8VQXxpwv56VR2']);
    expect(today.map((t) => t.id)).toEqual(['6Jf8VQXxpwv56VQ9', '6Jf8VQXxpwv56VQ7']);
  });

  it('shows today, overdue and done today', () => {
    const view = todoistCardView(input());
    expect(view.kpis?.map((k) => [k.key, k.value])).toEqual([
      ['today', '2'],
      ['overdue', '2'],
      ['done', '2'],
    ]);
    expect(view.kpis?.[1]?.tone).toBe('warn');
    expect(view.kpis?.[1]?.sub).toContain('14 Oct');
    expect(view.notices).toEqual([]);
    expect(view.status?.status).toBe('ok');
    for (const k of view.kpis ?? []) expect(ThingPageKpi.safeParse(k).success).toBe(true);
    const plus = todoistCardView(input({ snapshot: snapshot({ more: true, doneToday: null }) }));
    expect(plus.kpis?.map((k) => k.value)).toEqual(['2+', '2+']);
  });

  it('lists every task with its project, when it was due and Done', () => {
    const view = todoistView(input());
    expect(slotProblems(view)).toEqual([]);
    const tasks = view.panels.find((p) => p.id === 'tasks');
    if (tasks?.kind !== 'list') throw new Error('no list');
    expect(tasks.meta).toBe('2 today · 2 overdue · 2 done');
    expect(tasks.items.map((i) => [i.title, i.detail])).toEqual([
      ['Send invoice to Acme', 'Work · 14 Oct'],
      ['Call the bank', 'Work · Yesterday'],
      ['Water the plants', 'Home · 10:00'],
      ['Pay the VAT return', 'Work · Today'],
    ]);
    expect(tasks.items.map((i) => i.actions?.[0]?.target)).toEqual([
      '6Jf8VQXxpwv56VR1',
      '6Jf8VQXxpwv56VR2',
      '6Jf8VQXxpwv56VQ9',
      '6Jf8VQXxpwv56VQ7',
    ]);
    expect(tasks.items[0]?.tone).toBe('warn');
    expect(tasks.items[3]?.right).toBe('P1');
    for (const p of view.panels) expect(ThingPagePanel.safeParse(p).success).toBe(true);
  });

  it('counts today, overdue, tomorrow and the next 7 days', () => {
    const counts = todoistView(input()).panels.find((p) => p.id === 'coming');
    if (counts?.kind !== 'list') throw new Error('no counts');
    expect(counts.items.map((i) => [i.title, i.figure?.value, i.figure?.note])).toEqual([
      ['Today', '2', '2 done'],
      ['Overdue', '2', 'oldest 14 Oct'],
      ['Tomorrow', '1', undefined],
      ['Next 7 days', '3', undefined],
    ]);
  });

  it('draws the tasks done per day, today’s from the latest read', () => {
    const day = (d: number) => ({ completed_at: `2026-10-${d}T09:00:00Z` });
    const done = doneOf([day(15), day(16), day(16), day(20), day(21)], false);
    const view = todoistView(input({ snapshot: snapshot({ done, doneToday: 3 }) }));
    const week = view.panels.find((p) => p.id === 'week');
    if (week?.kind !== 'chart') throw new Error('no week');
    expect(week.series[0]?.values).toEqual([1, 2, 0, 0, 0, 1, 3]);
    expect(week.figure).toEqual({ value: '7', rest: 'tasks done' });
    expect(todoistView(input({ snapshot: snapshot({ done: null }) })).panels.map((p) => p.id)).toEqual([
      'tasks',
      'coming',
    ]);
  });

  it('keeps the card’s figures', () => {
    const seen = seenOfView(todoistCardView(input({ button: undefined })), ['today', 'overdue']);
    expect(seen.glance.facts?.map((f) => f.value)).toEqual(['2', '2']);
  });

  it('watches nothing: overdue tasks are their owner’s business', () => {
    expect(TODOIST_KIND.checks).toEqual([]);
  });

  it('draws no buttons on the card', () => {
    expect(JSON.stringify(todoistView(input({ button: undefined })))).not.toContain('"action"');
  });
});
