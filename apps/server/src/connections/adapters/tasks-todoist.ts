/**
 * Todoist's `tasks_*` and `projects_list` (docs/decisions/connections-catalog.md CX-34, CX-56) over the unified API v1
 * at `/api/v1/` (REST v2 is gone, CT-268): `GET /tasks` (`project_id`), `GET /tasks/filter?query=…`, `POST /tasks`,
 * `POST /tasks/<id>` (changes), `POST /tasks/<id>/close`, `GET /projects`. Lists answer `{results, next_cursor}`; ids are
 * strings. A project may be named instead of its id: it is looked up in the project list.
 */
import { ConnectionArgumentError } from '../request';
import { type Adapter, type AdapterContext, errorOutput, jsonOutput, optStr, parseJson, str } from './types';

/** Items a list asks for (Todoist's page maximum). */
const PAGE = 200;
/** Project pages read when looking up a name. */
const PROJECT_PAGES = 5;

interface TodoistTask {
  id?: string;
  content?: string;
  description?: string;
  project_id?: string;
  section_id?: string | null;
  priority?: number;
  labels?: string[];
  due?: { date?: string; string?: string; datetime?: string | null; is_recurring?: boolean } | null;
  checked?: boolean;
}

interface TodoistProject {
  id?: string;
  name?: string;
  inbox_project?: boolean;
}

/** A task as the tools answer it. */
export function todoistTask(t: TodoistTask) {
  return {
    id: String(t.id ?? ''),
    content: t.content ?? '',
    ...(t.description ? { description: t.description } : {}),
    ...(t.project_id ? { projectId: String(t.project_id) } : {}),
    priority: t.priority ?? 1,
    ...(t.labels?.length ? { labels: t.labels } : {}),
    ...(t.due
      ? {
          due: {
            ...(t.due.datetime ? { datetime: t.due.datetime } : t.due.date ? { date: t.due.date } : {}),
            ...(t.due.string ? { text: t.due.string } : {}),
            ...(t.due.is_recurring ? { recurring: true } : {}),
          },
        }
      : {}),
  };
}

/** The items of a list answer (`{results}`; a bare array from older shapes). */
function itemsOf<T>(json: unknown): { items: T[]; next: string | null } {
  if (Array.isArray(json)) return { items: json as T[], next: null };
  const page = json as { results?: T[]; next_cursor?: string | null } | null;
  return { items: page?.results ?? [], next: page?.next_cursor ?? null };
}

function api(ctx: AdapterContext, path: string, query: Record<string, string> = {}): string {
  const search = new URLSearchParams(query).toString();
  return `${ctx.baseUrl}/api/v1${path}${search ? `?${search}` : ''}`;
}

async function getJson(ctx: AdapterContext, path: string, query: Record<string, string> = {}) {
  const res = await ctx.send({ method: 'GET', url: api(ctx, path, query) });
  return { res, json: res.status < 300 ? parseJson(res.body) : null };
}

async function postJson(ctx: AdapterContext, path: string, body?: unknown) {
  const res = await ctx.send({
    method: 'POST',
    url: api(ctx, path),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { res, json: res.status < 300 && res.body.length ? parseJson(res.body) : null };
}

/** A project's id from its id or name (case-insensitive); throws when there is no such project. */
async function projectId(ctx: AdapterContext, nameOrId: string): Promise<string> {
  let cursor: string | null = null;
  const wanted = nameOrId.trim().replace(/^#/, '').toLowerCase();
  for (let page = 0; page < PROJECT_PAGES; page++) {
    const { res, json } = await getJson(ctx, '/projects', {
      limit: String(PAGE),
      ...(cursor ? { cursor } : {}),
    });
    if (res.status >= 300) break;
    const { items, next } = itemsOf<TodoistProject>(json);
    const found = items.find((p) => String(p.id) === nameOrId.trim() || p.name?.toLowerCase() === wanted);
    if (found?.id) return String(found.id);
    if (!next) break;
    cursor = next;
  }
  throw new ConnectionArgumentError(
    `project: there is no project called “${nameOrId}”. projects_list lists them.`,
  );
}

/** Todoist's due fields from the tool's `due`: a date as `due_date`, words as `due_string` (“no date” removes it). */
export function dueFields(due: string | null): Record<string, string> {
  if (due === null) return {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(due.trim())) return { due_date: due.trim() };
  return { due_string: due };
}

function priorityOf(args: Readonly<Record<string, unknown>>): Record<string, number> {
  const p = args.priority;
  if (p === undefined || p === null) return {};
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 4)
    throw new ConnectionArgumentError('priority: 1 (normal) to 4 (urgent).');
  return { priority: p };
}

function labelsOf(args: Readonly<Record<string, unknown>>): Record<string, string[]> {
  const l = args.labels;
  if (l === undefined || l === null) return {};
  if (!Array.isArray(l) || !l.every((x) => typeof x === 'string'))
    throw new ConnectionArgumentError('labels: a list of label names.');
  return { labels: l as string[] };
}

function taskId(args: Readonly<Record<string, unknown>>): string {
  const id = str(args, 'id').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ConnectionArgumentError('id: a task id from tasks_list.');
  return id;
}

export const TODOIST_TASKS: Adapter = {
  async tasks_list(ctx, args) {
    const filter = optStr(args, 'filter');
    const project = optStr(args, 'project');
    const pid = project ? await projectId(ctx, project) : null;
    const { res, json } = filter
      ? await getJson(ctx, '/tasks/filter', { query: filter, limit: String(PAGE) })
      : await getJson(ctx, '/tasks', { limit: String(PAGE), ...(pid ? { project_id: pid } : {}) });
    if (res.status >= 300) return errorOutput('Todoist', res);
    const { items, next } = itemsOf<TodoistTask>(json);
    const tasks = items.filter((t) => !pid || String(t.project_id) === pid).map(todoistTask);
    return jsonOutput({ tasks, more: next !== null }, res);
  },

  async tasks_add(ctx, args) {
    const content = str(args, 'content');
    const description = optStr(args, 'description');
    const project = optStr(args, 'project');
    const body = {
      content,
      ...(description ? { description } : {}),
      ...dueFields(optStr(args, 'due')),
      ...(project ? { project_id: await projectId(ctx, project) } : {}),
      ...priorityOf(args),
      ...labelsOf(args),
    };
    const { res, json } = await postJson(ctx, '/tasks', body);
    if (res.status >= 300) return errorOutput('Todoist', res);
    return jsonOutput({ added: todoistTask((json ?? {}) as TodoistTask) }, res);
  },

  async tasks_update(ctx, args) {
    const id = taskId(args);
    const content = optStr(args, 'content');
    const description = args.description;
    if (description !== undefined && typeof description !== 'string')
      throw new ConnectionArgumentError('description: text.');
    const body = {
      ...(content ? { content } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      ...dueFields(optStr(args, 'due')),
      ...priorityOf(args),
      ...labelsOf(args),
    };
    if (Object.keys(body).length === 0)
      throw new ConnectionArgumentError('Say what changes: content, description, due, priority or labels.');
    const { res, json } = await postJson(ctx, `/tasks/${encodeURIComponent(id)}`, body);
    if (res.status >= 300) return errorOutput('Todoist', res);
    return jsonOutput({ updated: todoistTask((json ?? { id }) as TodoistTask) }, res);
  },

  async tasks_complete(ctx, args) {
    const id = taskId(args);
    const { res } = await postJson(ctx, `/tasks/${encodeURIComponent(id)}/close`);
    if (res.status >= 300) return errorOutput('Todoist', res);
    return jsonOutput({ completed: { id } }, res);
  },

  async projects_list(ctx) {
    const { res, json } = await getJson(ctx, '/projects', { limit: String(PAGE) });
    if (res.status >= 300) return errorOutput('Todoist', res);
    const { items, next } = itemsOf<TodoistProject>(json);
    const projects = items.map((p) => ({
      id: String(p.id ?? ''),
      name: p.name ?? '',
      ...(p.inbox_project ? { inbox: true } : {}),
    }));
    return jsonOutput({ projects, more: next !== null }, res);
  },
};
