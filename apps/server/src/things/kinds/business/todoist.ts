/**
 * Todoist's page (service-dashboards.md SD-65, SD-S18): what is due today, what is overdue and what was done today;
 * today's and overdue tasks with their project and **Done** (an everyday button, SD-08). Read with the connection's API
 * token through Todoist's API v1 (REST v2 and Sync v9 are gone): `tasks/filter?query=today | overdue`, the projects'
 * names (kept 15 minutes) and `tasks/completed/by_completion_date` for today (left out when it doesn't answer); kept 30
 * seconds, read again after Done. No Worth a look: a to-do list's overdue tasks are its owner's business, not a dot;
 * so nothing to watch either (quiet-notices.md QN-15: What Whombat watches is empty). Signed in with Todoist, the same
 * page is read through its MCP server's tools that only read (`todoist-mcp.ts`), without Done.
 */
import type { ThingLine, ThingPageItem, ThingPageKpi } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { clip, clock, dateOf, dayMonth, line, list, num, plural, rec, str, thousands } from '../../words';
import { actAs } from '../act';
import { cachedRead, latestRead } from '../read';
import type { KindAction, KindModule } from '../registry';
import { countLine, inventory, liveList, slotPanels, trend } from '../slots';
import type { KindCtx, KindView } from '../types';
import {
  bumpGeneration,
  buttonsFor,
  daysBetween,
  dayWords,
  generationOf,
  loader,
  localDay,
  type MakeButton,
  optional,
  quoted,
  rarelyRead,
  readJson,
  seenOfView,
  stale,
  startOfDay,
  todayStart,
  viewOrProblem,
} from './common';
import { todoistMcpLatest, todoistMcpPage, todoistMcpSeen } from './todoist-mcp';
import { weekCounts } from './week';

const NAME = 'Todoist';
const PAGE = 200;
/** Rows of Today and overdue. */
const ROWS = 20;
/** What is coming this week is read apart, kept 5 minutes; what was done the last two weeks, 10. */
export const COMING_KEEP_MS = 5 * 60_000;
export const DONE_KEEP_MS = 10 * 60_000;
const DONE_DAYS = 14;
export const TODOIST_APP = 'https://app.todoist.com/app/today';

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface TodoistTask {
  id: string;
  content: string;
  projectId: string | null;
  /** The local day it is due (“2026-10-21”). */
  day: string;
  /** Its time, when it has one. */
  at: Date | null;
  recurring: boolean;
  /** Todoist's 4 (urgent) … 1 (normal). */
  priority: number;
}

export interface TodoistSnapshot {
  readAt: Date;
  tasks: TodoistTask[];
  /** By project id. */
  projects: Map<string, string>;
  /** Tasks completed today; null when Todoist didn't answer that. */
  doneToday: number | null;
  /** More tasks than Whombat reads. */
  more: boolean;
  /** The days of the tasks due in the next 7 days (Todoist's `7 days`); null when it didn't answer. */
  coming?: { days: string[]; more: boolean } | null;
  /** When each task of the last two weeks was done, whole from `since`; null when it didn't answer. */
  done?: { at: Date[]; since: Date | null } | null;
}

/** `[the text](https://…)` and `**bold**` as plain words. */
export function plainContent(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One task of `tasks/filter`; null when it isn't one or has no due date. */
export function todoistTask(raw: unknown, timeZone: string): TodoistTask | null {
  const t = rec(raw);
  const id = str(t.id) ?? (typeof t.id === 'number' ? String(t.id) : null);
  const due = rec(t.due);
  const date = str(due.date);
  if (!id || !date || t.checked === true || t.is_deleted === true) return null;
  let day = date.slice(0, 10);
  let at: Date | null = null;
  if (date.length > 10) {
    // A fixed time ends in Z; a floating one is the burrow's wall clock.
    const stamp = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(date) ? date : `${date}Z`);
    if (Number.isFinite(stamp)) {
      at = /Z$|[+-]\d\d:\d\d$/.test(date)
        ? new Date(stamp)
        : new Date(startOfDay(day, timeZone).getTime() + (stamp - Date.parse(`${day}T00:00:00Z`)));
      day = localDay(at, timeZone);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return {
    id: id.slice(0, 60),
    content: clip(plainContent(str(t.content) ?? 'A task') || 'A task', 200),
    projectId: str(t.project_id) ?? (typeof t.project_id === 'number' ? String(t.project_id) : null),
    day,
    at,
    recurring: due.is_recurring === true,
    priority: num(t.priority) ?? 1,
  };
}

async function readPages(
  services: Services,
  row: CatalogConnectionRow,
  path: string,
  query: Record<string, string>,
  key: 'results' | 'items',
  pages: number,
): Promise<{ items: unknown[]; more: boolean }> {
  const items: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < pages; page++) {
    const body = rec(
      await readJson(services, row, NAME, path, {
        query: { ...query, limit: String(PAGE), ...(cursor ? { cursor } : {}) },
      }),
    );
    items.push(...list(body[key]));
    cursor = str(body.next_cursor);
    if (!cursor) return { items, more: false };
  }
  return { items, more: true };
}

async function readTodoist(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<TodoistSnapshot> {
  const [tasks, projects, done] = await Promise.all([
    readPages(services, row, '/api/v1/tasks/filter', { query: 'today | overdue' }, 'results', 2),
    rarelyRead(
      services,
      `todoist-projects:${row.id}`,
      row,
      () => readPages(services, row, '/api/v1/projects', {}, 'results', 2),
      { optional: true },
    ),
    optional(
      readPages(
        services,
        row,
        '/api/v1/tasks/completed/by_completion_date',
        {
          since: todayStart(now, timeZone)
            .toISOString()
            .replace(/\.\d{3}Z$/, 'Z'),
          until: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        },
        'items',
        1,
      ),
    ),
  ]);
  const generation = generationOf(row.id);
  const [coming, history] = await Promise.all([
    optional(
      cachedRead(
        services,
        `todoist-coming:${row.id}:${timeZone}:${generation}`,
        row,
        () => readPages(services, row, '/api/v1/tasks/filter', { query: '7 days' }, 'results', 2),
        COMING_KEEP_MS,
      ),
    ),
    optional(
      cachedRead(
        services,
        `todoist-done:${row.id}:${timeZone}:${generation}`,
        row,
        () =>
          readPages(
            services,
            row,
            '/api/v1/tasks/completed/by_completion_date',
            {
              since: startOfDay(localDayBefore(now, timeZone, DONE_DAYS), timeZone)
                .toISOString()
                .replace(/\.\d{3}Z$/, 'Z'),
              until: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
            },
            'items',
            2,
          ),
        DONE_KEEP_MS,
      ),
    ),
  ]);
  const names = new Map<string, string>();
  for (const p of (projects?.items ?? []).map(rec)) {
    const id = str(p.id) ?? (typeof p.id === 'number' ? String(p.id) : null);
    const name = str(p.name);
    if (id && name) names.set(id, name.slice(0, 80));
  }
  return {
    readAt: now,
    tasks: tasks.items.map((t) => todoistTask(t, timeZone)).filter((t): t is TodoistTask => t !== null),
    projects: names,
    doneToday: done ? done.items.length : null,
    more: tasks.more,
    coming: coming
      ? {
          days: coming.items.map((t) => todoistTask(t, timeZone)?.day).filter((d): d is string => !!d),
          more: coming.more,
        }
      : null,
    done: history ? doneOf(history.items, history.more) : null,
  };
}

/** The local day `n` days before today. */
function localDayBefore(now: Date, timeZone: string, n: number): string {
  return localDay(new Date(todayStart(now, timeZone).getTime() - n * 86_400_000 + 12 * 3600_000), timeZone);
}

/** When each completed task was done; with more than were read, the oldest read is where they stop being whole. */
export function doneOf(items: readonly unknown[], more: boolean): { at: Date[]; since: Date | null } {
  const at = items.map((i) => dateOf(str(rec(i).completed_at))).filter((d): d is Date => !!d);
  const oldest = at.reduce<Date | null>((m, d) => (!m || d < m ? d : m), null);
  return { at, since: more ? oldest : null };
}

const keyOf = (row: CatalogConnectionRow, timeZone: string) =>
  `todoist:${row.id}:${timeZone}:${generationOf(row.id)}`;

function todoistLoad(services: Services, row: CatalogConnectionRow, now: Date, timeZone: string) {
  return loader(NAME, () => readTodoist(services, row, now, timeZone));
}

/** Todoist's read for its page (PS-01), read again after Done. */
export function todoistLatest(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
  timeZone = 'UTC',
) {
  return latestRead(services, keyOf(row, timeZone), row, todoistLoad(services, row, now, timeZone));
}

/* What it shows ------------------------------------------------------------------------------------------------------ */

export interface TodoistInput {
  snapshot: TodoistSnapshot;
  now: Date;
  timeZone: string;
  button?: MakeButton;
}

/** Today's and overdue tasks: overdue first (oldest first), then today's by time and priority. */
export function todoistLists(input: Pick<TodoistInput, 'snapshot' | 'now' | 'timeZone'>) {
  const today = localDay(input.now, input.timeZone);
  const overdue = input.snapshot.tasks.filter((t) => t.day < today);
  const due = input.snapshot.tasks.filter((t) => t.day === today);
  overdue.sort((a, b) => a.day.localeCompare(b.day) || b.priority - a.priority);
  due.sort(
    (a, b) =>
      (a.at?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.at?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
      b.priority - a.priority,
  );
  return { today: due, overdue };
}

const PRIORITY: Record<number, string> = { 4: 'P1', 3: 'P2', 2: 'P3' };

function dueWords(t: TodoistTask, input: Pick<TodoistInput, 'now' | 'timeZone'>): string {
  const { now, timeZone } = input;
  const days = daysBetween(startOfDay(t.day, timeZone), todayStart(now, timeZone));
  if (days === 0) return t.at ? clock(t.at, timeZone) : 'Today';
  if (days === 1) return 'Yesterday';
  return days < 7 ? `${dayWords(days)} ago` : dayMonth(startOfDay(t.day, timeZone), timeZone);
}

/** Today (Live): overdue first, then today's by time; each with its project, when it was due, and Done. */
export function taskItems(input: TodoistInput): ThingPageItem[] {
  const { snapshot, button } = input;
  const { today, overdue } = todoistLists(input);
  return [...overdue, ...today].slice(0, ROWS).map((t) => {
    const late = overdue.includes(t);
    const project = t.projectId ? snapshot.projects.get(t.projectId) : undefined;
    const right = PRIORITY[t.priority] ?? (t.recurring ? 'Repeats' : undefined);
    return {
      id: t.id,
      title: t.content,
      detail: [project, dueWords(t, input)].filter(Boolean).join(' · '),
      ...(late ? { tone: 'warn' as const } : {}),
      ...(right ? { right } : {}),
      ...(button
        ? { actions: [button({ action: 'done', target: t.id, label: 'Done', icon: 'check' })] }
        : {}),
    };
  });
}

/** The card's figures: due today, overdue with the oldest's day. */
function figures(input: TodoistInput): ThingPageKpi[] {
  const { snapshot } = input;
  const { today, overdue } = todoistLists(input);
  const plus = snapshot.more ? '+' : '';
  const kpis: ThingPageKpi[] = [
    {
      key: 'today',
      label: 'Today',
      value: `${today.length}${plus}`,
      sub: today.length ? (today.length === 1 ? 'task' : 'tasks') : 'Nothing due',
    },
    {
      key: 'overdue',
      label: 'Overdue',
      value: `${overdue.length}${plus}`,
      sub: overdue.length ? `Oldest from ${oldestWords(overdue, input.timeZone)}` : 'Nothing overdue',
      ...(overdue.length ? { tone: 'warn' as const } : {}),
    },
  ];
  if (snapshot.doneToday !== null)
    kpis.push({ key: 'done', label: 'Done today', value: String(snapshot.doneToday), color: 'green' });
  return kpis;
}

const oldestWords = (overdue: readonly TodoistTask[], timeZone: string) =>
  dayMonth(startOfDay((overdue[0] as TodoistTask).day, timeZone), timeZone);

/** Your tasks (Inventory): today with what is done, overdue with the oldest's day, tomorrow and the next 7 days. */
export function taskCounts(input: TodoistInput) {
  const { snapshot, now, timeZone } = input;
  const { today, overdue } = todoistLists(input);
  const plus = snapshot.more ? '+' : '';
  const lines: ThingPageItem[] = [
    countLine({
      id: 'today',
      icon: 'clock',
      title: 'Today',
      value: `${today.length}${plus}`,
      ...(snapshot.doneToday
        ? { note: `${snapshot.doneToday} done`, noteTone: 'ok' as const }
        : { note: today.length ? 'None done yet' : 'Nothing due' }),
    }),
    countLine({
      id: 'overdue',
      icon: 'warn',
      title: 'Overdue',
      value: `${overdue.length}${plus}`,
      ...(overdue.length
        ? { note: `oldest ${oldestWords(overdue, timeZone)}`, noteTone: 'warn' as const }
        : { note: 'Nothing overdue' }),
    }),
  ];
  if (snapshot.coming) {
    const day = localDay(now, timeZone);
    const tomorrow = localDayBefore(now, timeZone, -1);
    const after = snapshot.coming.days.filter((d) => d > day);
    const more = snapshot.coming.more ? '+' : '';
    lines.push(
      countLine({
        id: 'tomorrow',
        icon: 'clock',
        title: 'Tomorrow',
        value: `${after.filter((d) => d === tomorrow).length}${more}`,
      }),
      countLine({
        id: 'week',
        icon: 'clock',
        title: 'Next 7 days',
        detail: 'After today',
        value: `${after.length}${more}`,
      }),
    );
  }
  return inventory({ id: 'coming', title: 'Your tasks', items: lines });
}

/** Done this week (Trend): tasks done per day, today's from the latest read, with the change on the week before. */
export function doneWeek(input: TodoistInput) {
  const { snapshot, now, timeZone } = input;
  if (!snapshot.done) return null;
  const today = localDay(now, timeZone);
  // Today's count is the 30-second read's: the two weeks' read is kept 10 minutes.
  const at =
    snapshot.doneToday === null
      ? snapshot.done.at
      : [
          ...snapshot.done.at.filter((d) => localDay(d, timeZone) !== today),
          ...Array.from({ length: snapshot.doneToday }, () => now),
        ];
  const w = weekCounts(
    at.map((d) => ({ at: d })),
    now,
    timeZone,
    snapshot.done.since,
  );
  if (w.values.filter((v) => v !== null).length < 2) return null;
  return trend({
    id: 'week',
    title: 'Done this week',
    meta: 'Tasks done per day',
    days: w.days,
    values: w.values,
    label: 'Done',
    figure: { value: thousands(w.total), rest: w.total === 1 ? 'task done' : 'tasks done' },
    change: w.change,
    color: 'green',
  });
}

/**
 * The page's Todoist part, from what was read; pure. Its Summary in slots (docs/service-pages.md): today's and overdue
 * tasks with Done beside the counts, then the tasks done this week. No machine card: it runs at Todoist.
 */
export function todoistView(input: TodoistInput): KindView {
  const { snapshot } = input;
  const { today, overdue } = todoistLists(input);
  const done = snapshot.doneToday;
  const facts: ThingLine[] = [line(`**${today.length}** due today`)];
  if (done) facts.push(line(`**${done}** done`));
  return {
    // In slots its figures are in Your tasks; the card keeps them (`todoistCardView`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices: [],
    ...slotPanels({
      live: liveList({
        id: 'tasks',
        title: 'Today',
        meta: [`${today.length} today`, `${overdue.length} overdue`, done !== null ? `${done} done` : '']
          .filter(Boolean)
          .join(' · '),
        link: { kind: 'url', label: 'Open Todoist', url: TODOIST_APP },
        items: taskItems(input),
        empty: 'Nothing due today.',
      }),
      inventory: taskCounts(input),
      trend: doneWeek(input),
    }),
    tabs: [],
    facts,
    status: {
      status: 'ok',
      badge: today.length ? `${plural(today.length, 'task')} today` : 'Nothing due today',
    },
    open: { label: 'Open Todoist', url: TODOIST_APP },
    actions: [],
    readAt: snapshot.readAt,
    suggestions: ['What’s due this week', 'Tasks without a date', 'Done this week'],
  };
}

/** The page's part as the card reads it: the card keeps Today and Overdue. */
export function todoistCardView(input: TodoistInput): KindView {
  return { ...todoistView(input), kpis: figures(input) };
}

/* The page and Done ------------------------------------------------------------------------------------------------- */

/**
 * Signed in with Todoist (its MCP server), its token isn't for the API this page reads: the page reads its server's
 * tools instead (`todoist-mcp.ts`), and says this when the server offers no tasks to read.
 */
export const MCP_ONLY = 'This page needs Todoist connected with an API token.';

export async function todoistPage(ctx: KindCtx): Promise<KindView> {
  const open = { label: 'Open Todoist', url: TODOIST_APP };
  if (ctx.row.signIn === 'mcp_oauth') return todoistMcpPage(ctx);
  const read = await todoistLatest(ctx.services, ctx.row, ctx.now, ctx.timeZone);
  return viewOrProblem(read, NAME, open, (snapshot) =>
    todoistView({ snapshot, now: ctx.now, timeZone: ctx.timeZone, button: buttonsFor(ctx) }),
  );
}

/** **Done** on a task the page shows (SD-65): closes it (a repeating one moves to its next day); everyday (SD-08). */
const done: KindAction = async (ctx, input) => {
  // Signed in with Todoist the page offers no Done: its server's tools are only read for a page.
  if (ctx.row.signIn === 'mcp_oauth') throw stale(NAME);
  const target = typeof input.target === 'string' ? input.target : '';
  const snapshot = await cachedRead(
    ctx.services,
    keyOf(ctx.row, ctx.timeZone),
    ctx.row,
    todoistLoad(ctx.services, ctx.row, ctx.now, ctx.timeZone),
  );
  const task = snapshot.tasks.find((t) => t.id === target);
  if (!task) throw stale(NAME);
  await actAs(ctx.services, ctx.row, NAME, {
    method: 'POST',
    path: `/api/v1/tasks/${encodeURIComponent(task.id)}/close`,
  });
  bumpGeneration(ctx.row.id);
  return {
    message: task.recurring ? 'Done. It’s back on its next day.' : 'Done.',
    title: `Marked ${quoted(task.content)} done`,
    everyday: true,
  };
};

export const TODOIST_KIND: KindModule = {
  page: todoistPage,
  checks: [],
  prefetch: (services, row, now, timeZone) =>
    row.signIn === 'mcp_oauth'
      ? todoistMcpLatest(services, row, now, timeZone)
      : todoistLatest(services, row, now, timeZone),
  seen: async (services, row, now, timeZone) => {
    if (row.signIn === 'mcp_oauth') return todoistMcpSeen(services, row, now, timeZone);
    const snapshot = await cachedRead(
      services,
      keyOf(row, timeZone),
      row,
      todoistLoad(services, row, now, timeZone),
    );
    return seenOfView(todoistCardView({ snapshot, now, timeZone }), ['today', 'overdue']);
  },
  actions: { done },
};
