/**
 * Todoist signed in with Todoist: the page read through its MCP server's tools that only read, from answers shaped as
 * Doist/todoist-ai sends them (`find-tasks-by-date`, `find-completed-tasks`, `find-projects`: structured content, and
 * the same JSON as the first line of the text). A fake pool answers; the tool list says which tools only read.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ThingPagePanel } from '@whombat/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Services } from '../../../services';
import { answerJson } from '../mcp-tools';
import { rowOf } from '../media/testing';
import { slotProblems } from '../slots';
import type { KindCtx } from '../types';
import { TODOIST_KIND, todoistTask } from './todoist';
import { apiTask, TODOIST_TOOLS } from './todoist-mcp';

const fake = vi.hoisted(() => ({
  calls: [] as { tool: string; args: Record<string, unknown> }[],
  tools: [] as { name: string; access: string; inputSchema: null }[],
  /** Answers by tool; `text` sends the JSON only as text, as a server without structured content would. */
  answer: (_tool: string, _args: Record<string, unknown>): unknown => ({}),
  text: false,
}));

vi.mock('../../../commit/scope', () => ({
  externalEffect: (_name: string, run: () => unknown) => run(),
}));
vi.mock('../../../connections/pool', () => ({
  connectionsFor: () => ({
    target: () => ({}),
    pool: {
      call: async (_target: unknown, tool: string, args: Record<string, unknown>) => {
        fake.calls.push({ tool, args });
        const json = fake.answer(tool, args);
        const text = `${JSON.stringify(json)}\nSome words about it.`;
        return fake.text
          ? { text, structured: undefined, isError: false }
          : { text, structured: json, isError: false };
      },
    },
  }),
}));
vi.mock('../../../connections/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../connections/store')>()),
  toolRowsOf: async () => fake.tools,
}));

const recorded = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'todoist-mcp', name), 'utf8'));

const TZ = 'Europe/Amsterdam';
// Tuesday 21 October 2026, 17:00 in Amsterdam: the token page's tests' day.
const now = new Date('2026-10-21T15:00:00Z');
const READS = Object.values(TODOIST_TOOLS);

function answers(tool: string, args: Record<string, unknown>): unknown {
  if (tool === TODOIST_TOOLS.projects) return recorded('find-projects.json');
  if (tool === TODOIST_TOOLS.tasks)
    return recorded(args.daysCount === 7 ? 'find-tasks-by-date-week.json' : 'find-tasks-by-date.json');
  if (tool === TODOIST_TOOLS.done)
    return recorded(
      args.since === args.until ? 'find-completed-tasks.json' : 'find-completed-tasks-weeks.json',
    );
  throw new Error(`not asked: ${tool}`);
}

// Each test reads a connection and a cache of its own.
let n = 0;
function ctx(): KindCtx {
  n += 1;
  return {
    services: { clock: () => now } as unknown as Services,
    row: rowOf('todoist', { id: `con_todoist_mcp_${n}`, signIn: 'mcp_oauth', fields: {}, label: 'Todoist' }),
    entry: {} as KindCtx['entry'],
    now,
    timeZone: TZ,
    machine: null,
    range: '24h',
    burrowId: 'brw_1',
    disk: { pct: [], gb: [] },
  };
}

beforeEach(() => {
  fake.calls = [];
  fake.text = false;
  fake.answer = answers;
  fake.tools = [
    ...READS.map((name) => ({ name, access: 'read', inputSchema: null })),
    { name: 'complete-tasks', access: 'write', inputSchema: null },
  ];
});

describe('Todoist’s tasks as its MCP server gives them', () => {
  it('turns a task into the API’s shape: due day or time, priority, repeating', () => {
    const tasks = (recorded('find-tasks-by-date.json') as { tasks: unknown[] }).tasks.map((t) =>
      todoistTask(apiTask(t), TZ),
    );
    expect(
      tasks.map((t) => [t?.id, t?.day, t?.at?.toISOString() ?? null, t?.priority, t?.recurring]),
    ).toEqual([
      ['6Jf8VQXxpwv56VQ7', '2026-10-21', null, 4, false],
      ['6Jf8VQXxpwv56VQ9', '2026-10-21', '2026-10-21T08:00:00.000Z', 1, true],
      ['6Jf8VQXxpwv56VR1', '2026-10-14', null, 3, false],
      // A floating 16:30 is the burrow's wall clock.
      ['6Jf8VQXxpwv56VR2', '2026-10-20', '2026-10-20T14:30:00.000Z', 1, false],
    ]);
    expect(todoistTask(apiTask({ id: 'x', content: 'No date' }), TZ)).toBeNull();
  });

  it('reads an answer sent only as text, and says so when it was cut', () => {
    expect(answerJson('{"tasks":[]}\nNo tasks today.', 'Todoist')).toEqual({ tasks: [] });
    expect(() => answerJson('{"tasks":[{"id":"1"\n[output cut at 65536 bytes]', 'Todoist')).toThrow(
      /more than Whombat reads/,
    );
    expect(() => answerJson('Nothing to see.', 'Todoist')).toThrow(/can’t read/);
  });
});

describe('Todoist’s page signed in with Todoist', () => {
  it('shows the token’s page without Done, read only through tools that only read', async () => {
    const view = await TODOIST_KIND.page(ctx());
    expect(view.problem).toBeUndefined();
    expect(slotProblems(view)).toEqual([]);
    const tasks = view.panels.find((p) => p.id === 'tasks');
    if (tasks?.kind !== 'list') throw new Error('no tasks');
    expect(tasks.meta).toBe('2 today · 2 overdue · 2 done');
    expect(tasks.items.map((i) => [i.title, i.detail])).toEqual([
      ['Send invoice to Acme', 'Work · 14 Oct'],
      ['Call the bank', 'Work · Yesterday'],
      ['Water the plants', 'Home · 10:00'],
      ['Pay the VAT return', 'Work · Today'],
    ]);
    expect(tasks.items.some((i) => i.actions?.length)).toBe(false);
    const counts = view.panels.find((p) => p.id === 'coming');
    if (counts?.kind !== 'list') throw new Error('no counts');
    expect(counts.items.map((i) => [i.title, i.figure?.value])).toEqual([
      ['Today', '2'],
      ['Overdue', '2'],
      ['Tomorrow', '1'],
      ['Next 7 days', '3'],
    ]);
    const week = view.panels.find((p) => p.id === 'week');
    if (week?.kind !== 'chart') throw new Error('no week');
    // 15, 16 (two), 20 and today's two; the 9th is before the week.
    expect(week.series[0]?.values).toEqual([1, 2, 0, 0, 0, 1, 2]);
    for (const p of view.panels) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    expect(new Set(fake.calls.map((c) => c.tool))).toEqual(new Set(READS));
    expect(fake.calls.find((c) => c.tool === TODOIST_TOOLS.tasks)?.args).toMatchObject({
      startDate: 'today',
      overdueOption: 'include-overdue',
      responsibleUserFiltering: 'all',
    });
  });

  it('reads the same page when the server sends its JSON only as text', async () => {
    fake.text = true;
    const view = await TODOIST_KIND.page(ctx());
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['tasks', 'coming', 'week']);
  });

  it('gives the card Today and Overdue from today’s read alone', async () => {
    const seen = await TODOIST_KIND.seen?.(ctx().services, ctx().row, now, TZ);
    expect(seen?.glance.facts?.map((f) => [f.label, f.value])).toEqual([
      ['Today', '2'],
      ['Overdue', '2'],
    ]);
    // Nothing of the next 7 days nor of the two weeks done.
    expect(fake.calls.some((c) => c.args.daysCount === 7)).toBe(false);
    expect(fake.calls.filter((c) => c.tool === TODOIST_TOOLS.done).map((c) => c.args.since)).toEqual([
      '2026-10-21',
    ]);
  });

  it('says it needs a token when the server offers no tasks to read', async () => {
    fake.tools = fake.tools.filter((t) => t.name !== TODOIST_TOOLS.tasks);
    const view = await TODOIST_KIND.page(ctx());
    expect(view.problem).toContain('API token');
    expect(fake.calls).toEqual([]);
  });

  it('never calls a tool its server doesn’t mark read-only', async () => {
    fake.tools = fake.tools.map((t) => (t.name === TODOIST_TOOLS.done ? { ...t, access: 'write' } : t));
    const view = await TODOIST_KIND.page(ctx());
    expect(fake.calls.some((c) => c.tool === TODOIST_TOOLS.done)).toBe(false);
    // Today and its counts stay; what was done is left out.
    expect(view.panels.map((p) => p.id)).toEqual(['tasks', 'coming']);
  });

  it('says why when the server answers with an error', async () => {
    fake.answer = () => {
      throw new Error('down');
    };
    const view = await TODOIST_KIND.page(ctx());
    expect(view.problem).toBeTruthy();
    expect(view.panels).toEqual([]);
  });
});
