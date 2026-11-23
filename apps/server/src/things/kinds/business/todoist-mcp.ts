/**
 * Todoist's page when it was connected with “Sign in with Todoist” (its own MCP server, https://ai.todoist.net/mcp,
 * source Doist/todoist-ai): the page an API token gives, read through the server's tools that only read.
 * `find-tasks-by-date` gives today and overdue (and the next 7 days), `find-completed-tasks` what was done today and in
 * the last two weeks, `find-projects` the projects' names. Their tasks come in the server's own shape (camelCase,
 * `dueDate`, priority “p1”…“p4”) and are turned into the API's, so the same code builds the page. No Done button: a page
 * never changes anything through these tools. The health pass reads only today and overdue, done today and the
 * projects' names (kept 15 minutes).
 */
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { list, num, rec, str } from '../../words';
import { readToolSchemas, type ToolCall, toolCaller } from '../mcp-tools';
import { cachedRead, latestRead } from '../read';
import type { KindSeen } from '../registry';
import type { KindCtx, KindView } from '../types';
import {
  cannotRead,
  loader,
  localDay,
  optional,
  rarelyRead,
  seenOfView,
  todayStart,
  viewOrProblem,
} from './common';
import {
  COMING_KEEP_MS,
  DONE_KEEP_MS,
  doneOf,
  MCP_ONLY,
  TODOIST_APP,
  type TodoistSnapshot,
  todoistCardView,
  todoistTask,
  todoistView,
} from './todoist';

const NAME = 'Todoist';

/** The server's tools the page reads, each marked read-only in its source. */
export const TODOIST_TOOLS = {
  tasks: 'find-tasks-by-date',
  done: 'find-completed-tasks',
  projects: 'find-projects',
} as const;

/** Tasks per call: Whombat keeps 64 KiB of an answer, and a task with a long description can take a kilobyte. */
const PAGE = 40;
/** Calls per list at most; past them the counts say “+”. */
const PAGES = 3;
const PROJECTS_PAGE = 100;
const DONE_PAGE = 50;
const DONE_DAYS = 14;

/** The server's priorities, “p1” the most urgent, as the API's numbers (4 the most urgent). */
const PRIORITY: Record<string, number> = { p1: 4, p2: 3, p3: 2, p4: 1 };

/**
 * One task of the server's answer in the API's shape, for `todoistTask`: `dueDate` is the API's `due.date` (a day, or a
 * day and time), `recurring` its words or false.
 */
export function apiTask(raw: unknown): Record<string, unknown> {
  const t = rec(raw);
  const due = str(t.dueDate);
  return {
    id: t.id,
    content: t.content,
    project_id: t.projectId,
    ...(due ? { due: { date: due, is_recurring: t.recurring !== false && t.recurring !== undefined } } : {}),
    priority: PRIORITY[str(t.priority) ?? ''] ?? num(t.priority) ?? 1,
    checked: t.checked === true,
    is_deleted: t.isDeleted === true,
  };
}

/** A list tool's items, following its `nextCursor` for at most `pages` calls. */
async function pages(
  call: ToolCall,
  tool: string,
  args: Record<string, unknown>,
  key: 'tasks' | 'projects',
  max: number,
): Promise<{ items: unknown[]; more: boolean }> {
  const items: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < max; page++) {
    const body = await call(tool, { ...args, ...(cursor ? { cursor } : {}) });
    items.push(...list(body[key]));
    cursor = str(body.nextCursor);
    if (!cursor) return { items, more: false };
  }
  return { items, more: true };
}

/** The local day `n` days from today (`-14` two weeks ago); noon steps keep the day right across a change of clocks. */
function dayFrom(now: Date, timeZone: string, n: number): string {
  return localDay(new Date(todayStart(now, timeZone).getTime() + 12 * 3600_000 + n * 86_400_000), timeZone);
}

/** What the page and the health pass share: today and overdue, done today, the projects' names. */
export interface TodoistMcpMain {
  tasks: unknown[];
  more: boolean;
  doneToday: number | null;
  projects: Map<string, string>;
}

export async function readMain(
  services: Services,
  row: CatalogConnectionRow,
  call: ToolCall,
  now: Date,
  timeZone: string,
): Promise<TodoistMcpMain> {
  const today = localDay(now, timeZone);
  const [tasks, projects, done] = await Promise.all([
    pages(
      call,
      TODOIST_TOOLS.tasks,
      // Everyone's tasks, as the API's `today | overdue` filter gives them.
      { startDate: 'today', overdueOption: 'include-overdue', limit: PAGE, responsibleUserFiltering: 'all' },
      'tasks',
      PAGES,
    ),
    rarelyRead(
      services,
      `todoist-mcp-projects:${row.id}`,
      row,
      () => pages(call, TODOIST_TOOLS.projects, { limit: PROJECTS_PAGE }, 'projects', 2),
      { optional: true },
    ),
    optional(
      pages(
        call,
        TODOIST_TOOLS.done,
        { getBy: 'completion', since: today, until: today, limit: DONE_PAGE },
        'tasks',
        1,
      ),
    ),
  ]);
  const names = new Map<string, string>();
  for (const p of (projects?.items ?? []).map(rec)) {
    const id = str(p.id);
    const name = str(p.name);
    if (id && name) names.set(id, name.slice(0, 80));
  }
  return {
    tasks: tasks.items,
    more: tasks.more,
    doneToday: done ? done.items.length : null,
    projects: names,
  };
}

/** The snapshot the token's page is built from, out of the server's answers. */
export function snapshotOf(
  main: TodoistMcpMain,
  now: Date,
  timeZone: string,
  coming: { items: unknown[]; more: boolean } | null = null,
  done: { items: unknown[]; more: boolean } | null = null,
): TodoistSnapshot {
  const task = (raw: unknown) => todoistTask(apiTask(raw), timeZone);
  return {
    readAt: now,
    tasks: main.tasks.map(task).filter((t) => t !== null),
    projects: main.projects,
    doneToday: main.doneToday,
    more: main.more,
    coming: coming
      ? {
          days: coming.items.map((t) => task(t)?.day).filter((d): d is string => !!d),
          more: coming.more,
        }
      : null,
    done: done
      ? doneOf(
          done.items.map((t) => ({ completed_at: rec(t).completedAt })),
          done.more,
        )
      : null,
  };
}

/** The tools the page needs, or null when the connection's server doesn't offer today's tasks as a read. */
async function callerFor(services: Services, row: CatalogConnectionRow): Promise<ToolCall | null> {
  const tools = await readToolSchemas(services, row.id);
  return tools.has(TODOIST_TOOLS.tasks) ? toolCaller(services, row, new Set(tools.keys())) : null;
}

const mainKey = (row: CatalogConnectionRow, timeZone: string) => `todoist-mcp-main:${row.id}:${timeZone}`;

function mainRead(
  services: Services,
  row: CatalogConnectionRow,
  call: ToolCall,
  now: Date,
  timeZone: string,
) {
  return cachedRead(
    services,
    mainKey(row, timeZone),
    row,
    loader(NAME, () => readMain(services, row, call, now, timeZone)),
  );
}

async function readAll(
  services: Services,
  row: CatalogConnectionRow,
  call: ToolCall,
  now: Date,
  timeZone: string,
): Promise<TodoistSnapshot> {
  const today = localDay(now, timeZone);
  const [main, coming, done] = await Promise.all([
    mainRead(services, row, call, now, timeZone),
    optional(
      cachedRead(
        services,
        `todoist-mcp-coming:${row.id}:${timeZone}`,
        row,
        () =>
          pages(
            call,
            TODOIST_TOOLS.tasks,
            {
              startDate: 'today',
              overdueOption: 'exclude-overdue',
              daysCount: 7,
              limit: PAGE,
              responsibleUserFiltering: 'all',
            },
            'tasks',
            PAGES,
          ),
        COMING_KEEP_MS,
      ),
    ),
    optional(
      cachedRead(
        services,
        `todoist-mcp-done:${row.id}:${timeZone}`,
        row,
        () =>
          pages(
            call,
            TODOIST_TOOLS.done,
            {
              getBy: 'completion',
              since: dayFrom(now, timeZone, -DONE_DAYS),
              until: today,
              limit: DONE_PAGE,
            },
            'tasks',
            2,
          ),
        DONE_KEEP_MS,
      ),
    ),
  ]);
  return snapshotOf(main, now, timeZone, coming, done);
}

/** Todoist's read for its page through the MCP server (PS-01): null when the server offers no tasks to read. */
export async function todoistMcpLatest(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
  timeZone = 'UTC',
) {
  const call = await callerFor(services, row);
  if (!call) return null;
  return latestRead(
    services,
    `todoist-mcp:${row.id}:${timeZone}`,
    row,
    loader(NAME, () => readAll(services, row, call, now, timeZone)),
  );
}

/** The page signed in with Todoist: the token's page without Done, or why there is none. */
export async function todoistMcpPage(ctx: KindCtx): Promise<KindView> {
  const open = { label: 'Open Todoist', url: TODOIST_APP };
  const read = await todoistMcpLatest(ctx.services, ctx.row, ctx.now, ctx.timeZone);
  if (!read) return cannotRead(MCP_ONLY, open);
  return viewOrProblem(read, NAME, open, (snapshot) =>
    todoistView({ snapshot, now: ctx.now, timeZone: ctx.timeZone }),
  );
}

/** The health pass signed in with Todoist: the card's Today and Overdue from today's read only. */
export async function todoistMcpSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  const call = await callerFor(services, row);
  if (!call) return { glance: { facts: [] }, points: {}, notices: [] };
  const main = await mainRead(services, row, call, now, timeZone);
  return seenOfView(todoistCardView({ snapshot: snapshotOf(main, now, timeZone), now, timeZone }), [
    'today',
    'overdue',
  ]);
}
