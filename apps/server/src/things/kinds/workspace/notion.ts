/**
 * Notion's page in slots (docs/service-pages.md): what changed lately in Live, what Whombat can see in Inventory, the
 * pages changed per day this week as the Trend, and who changes most as People. No checks: what people change in Notion
 * is theirs, and nothing there breaks.
 *
 * With an access token it reads Notion's API: `POST /v1/search` sorted by last edit (one page of 100, never to the
 * end), the pages and databases counted with filtered searches only when more changed than one page holds, members'
 * names from `GET /v1/users` and the workspace's name from `GET /v1/users/me` (both kept 15 minutes, a refusal too: a
 * token without user information may not read them). Signed in with Notion, it reads its MCP server's tools that only
 * read: `notion-search` sorted by last edit when the workspace's plan allows that sort, else what the person opened
 * lately (`notion-list-recent-pages`), and `notion-get-self` for the workspace's name. Kept 5 minutes; the health pass
 * reads only through the token.
 */
import type { ThingLine, ThingPageItem, ThingPageKpi } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { ConnectionGlance } from '../../../home/types';
import type { Services } from '../../../services';
import { clip, dateOf, line, list, plural, rec, str, thousands, when } from '../../words';
import { optional, rarelyRead, seenOfView, viewOrProblem, webUrl } from '../business/common';
import { weekCounts } from '../business/week';
import { mcpToolRead } from '../mcp-read';
import { cachedRead, latestRead, ReadProblem } from '../read';
import type { KindModule, KindSeen } from '../registry';
import { countLine, daysWith, inventory, liveList, people, slotPanels, trend } from '../slots';
import type { KindCtx, KindView } from '../types';
import { apiRead, type Counted, choicesOf, listIn, maxOf, propsOf, readTools, type Schema } from './common';

const NAME = 'Notion';
export const NOTION_APP = 'https://www.notion.so/';
/** One page of Notion's search: the most it answers at once. */
const PAGE = 100;
/** The most `notion-search` answers through MCP. */
const MCP_RESULTS = 50;
/** Rows of Live. */
const ROWS = 10;
export const NOTION_KEEP_MS = 5 * 60_000;

export const SEARCH_TOOL = 'notion-search';
export const RECENT_TOOL = 'notion-list-recent-pages';
export const SELF_TOOL = 'notion-get-self';

/* Reading ------------------------------------------------------------------------------------------------------------ */

export type NotionKind = 'page' | 'database';

export interface NotionItem {
  id: string;
  title: string;
  kind: NotionKind;
  url: string | null;
  /** When it last changed; null when the answer doesn't say. */
  editedAt: Date | null;
  /** Who changed it last, a Notion user id. */
  editorId: string | null;
}

export interface NotionSnapshot {
  readAt: Date;
  via: 'api' | 'mcp';
  /** What changed lately, newest first; null when the sign-in can't tell (a plan that can't sort by last edit). */
  recent: NotionItem[] | null;
  /** More changed than were read. */
  recentMore: boolean;
  /** What the person opened lately, in place of what changed. */
  opened: NotionItem[] | null;
  pages: Counted | null;
  databases: Counted | null;
  /** Members and guests (people, not connections). */
  people: Counted | null;
  /** Names by Notion user id. */
  names: Map<string, string>;
  workspace: string | null;
}

/** Rich text as plain words. */
function plainText(v: unknown): string {
  return list(v)
    .map((t) => {
      const text = rec(t).plain_text;
      return typeof text === 'string' ? text : '';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A page's title is the property of type `title`; a data source has its own. */
function titleOf(r: Record<string, unknown>): string {
  const own = plainText(r.title);
  if (own) return clip(own, 160);
  for (const p of Object.values(rec(r.properties))) {
    const prop = rec(p);
    if (prop.type !== 'title') continue;
    const t = plainText(prop.title);
    if (t) return clip(t, 160);
  }
  return 'Untitled';
}

/** A link into Notion, only to Notion's own addresses. */
function notionUrl(v: unknown): string | null {
  const url = webUrl(v);
  if (!url?.startsWith('https://')) return null;
  const host = new URL(url).hostname;
  return host === 'notion.so' || host.endsWith('.notion.so') || host.endsWith('.notion.site') ? url : null;
}

/** One result of `POST /v1/search`: a page or a data source; null for anything else or a partial one. */
export function notionItem(raw: unknown): NotionItem | null {
  const r = rec(raw);
  const object = str(r.object);
  const id = str(r.id);
  const editedAt = dateOf(r.last_edited_time);
  if (!id || !editedAt || (object !== 'page' && object !== 'data_source' && object !== 'database'))
    return null;
  if (r.in_trash === true || r.is_archived === true || r.archived === true) return null;
  return {
    id: clip(id, 80),
    title: titleOf(r),
    kind: object === 'page' ? 'page' : 'database',
    url: notionUrl(r.url),
    editedAt,
    editorId: str(rec(r.last_edited_by).id),
  };
}

/** A page of search results. */
export function searchResults(body: unknown): { items: NotionItem[]; more: boolean } {
  const b = rec(body);
  return {
    items: list(b.results)
      .map(notionItem)
      .filter((i): i is NotionItem => i !== null),
    more: b.has_more === true,
  };
}

/** How many a page of answers holds. */
export function countedOf(body: unknown): Counted {
  const b = rec(body);
  return { n: list(b.results).length, more: b.has_more === true };
}

/** `GET /v1/users`: names by id, and how many people (not connections) there are. */
export function notionUsers(body: unknown): { names: Map<string, string>; people: Counted } {
  const b = rec(body);
  const names = new Map<string, string>();
  let persons = 0;
  for (const u of list(b.results).map(rec)) {
    const id = str(u.id);
    const name = str(u.name);
    if (id && name) names.set(id, clip(name, 80));
    if (u.type === 'person') persons++;
  }
  return { names, people: { n: persons, more: b.has_more === true } };
}

/** The workspace's name from `GET /v1/users/me` (the connection's own bot user). */
export const workspaceOfMe = (body: unknown): string | null => str(rec(rec(body).bot).workspace_name);

async function readByApi(services: Services, row: CatalogConnectionRow, now: Date): Promise<NotionSnapshot> {
  const search = (body: unknown) => apiRead(services, row, NAME, '/v1/search', { method: 'POST', body });
  const [recentBody, users, workspace] = await Promise.all([
    search({ sort: { timestamp: 'last_edited_time', direction: 'descending' }, page_size: PAGE }),
    rarelyRead(
      services,
      `notion-users:${row.id}`,
      row,
      async () =>
        notionUsers(await apiRead(services, row, NAME, '/v1/users', { query: { page_size: String(PAGE) } })),
      { optional: true },
    ),
    rarelyRead(
      services,
      `notion-me:${row.id}`,
      row,
      async () => workspaceOfMe(await apiRead(services, row, NAME, '/v1/users/me')),
      { optional: true },
    ),
  ]);
  const recent = searchResults(recentBody);
  const of = (kind: NotionKind): Counted => ({
    n: recent.items.filter((i) => i.kind === kind).length,
    more: false,
  });
  // One page holds everything: count it. Else one filtered page each, never to the end.
  const [pages, databases] = recent.more
    ? await Promise.all([
        optional(search({ filter: { property: 'object', value: 'page' }, page_size: PAGE }).then(countedOf)),
        optional(
          search({ filter: { property: 'object', value: 'data_source' }, page_size: PAGE }).then(countedOf),
        ),
      ])
    : [of('page'), of('database')];
  return {
    readAt: now,
    via: 'api',
    recent: recent.items,
    recentMore: recent.more,
    opened: null,
    pages,
    databases,
    people: users?.people ?? null,
    names: users?.names ?? new Map(),
    workspace,
  };
}

/* Through Notion's MCP server ------------------------------------------------------------------------------------------ */

/**
 * `notion-search`'s arguments for what changed lately, from its input schema: an empty query sorted by last edit and
 * as many results as it gives. Null when the tool offers no such sort. Without a schema, the documented ones.
 */
export function searchArgs(schema: Schema): { args: Record<string, unknown>; size: number | null } | null {
  const props = propsOf(schema);
  if (!Object.keys(props).length) return { args: { query: '', sort: 'last_edited' }, size: null };
  const sort = lastEditedSort(props.sort);
  if (sort === null) return null;
  const args: Record<string, unknown> = { sort };
  if ('query' in props) args.query = '';
  const sizeKey = ['page_size', 'limit', 'max_results'].find((k) => k in props);
  if (!sizeKey) return { args, size: null };
  const size = Math.min(maxOf(props[sizeKey]) ?? MCP_RESULTS, MCP_RESULTS);
  args[sizeKey] = size;
  return { args, size };
}

/** The sort that puts the last changed first, as the schema names it: a word, or a field and a direction. */
function lastEditedSort(prop: Record<string, unknown> | undefined): unknown {
  if (!prop) return null;
  const byEdit = (vs: string[]) => vs.find((v) => /last.?edit/i.test(v));
  const word = byEdit(choicesOf(prop));
  if (word) return word;
  if (prop.type === 'string' && !choicesOf(prop).length) return 'last_edited';
  const fields = propsOf(prop);
  const out: Record<string, string> = {};
  for (const [k, p] of Object.entries(fields)) {
    const vs = choicesOf(p);
    const edit = byEdit(vs);
    const down = vs.find((v) => /^desc/i.test(v));
    if (edit) out[k] = edit;
    else if (down) out[k] = down;
  }
  return Object.values(out).some((v) => /last.?edit/i.test(v)) ? out : null;
}

/** One result of `notion-search` or `notion-list-recent-pages`: a page or a database, never a person. */
export function mcpItem(r: Record<string, unknown>): NotionItem | null {
  const id = str(r.id) ?? str(r.url);
  const type = str(r.type) ?? str(r.object) ?? '';
  if (!id || /user/i.test(type)) return null;
  return {
    id: clip(id, 80),
    title: clip(str(r.title) ?? 'Untitled', 160),
    kind: /database|data.?source|collection/i.test(type) ? 'database' : 'page',
    url: notionUrl(r.url),
    editedAt: dateOf(
      r.timestamp ?? r.last_edited_time ?? r.lastEditedTime ?? r.last_edited_at ?? r.page_last_edited_at,
    ),
    editorId: null,
  };
}

/**
 * `notion-search`'s answer: its results, and whether Notion dropped the sort. A plan without it says so in `notices`;
 * with an empty query that leaves nothing to search by, so no results and a notice say the same.
 */
export function mcpSearch(answer: unknown): { items: NotionItem[]; sortDropped: boolean } {
  const notices = list(rec(answer).notices);
  const items = listIn(answer, ['results', 'pages'])
    .map(mcpItem)
    .filter((i): i is NotionItem => i !== null);
  const aboutSort = notices.some((n) => /sort/i.test(typeof n === 'string' ? n : JSON.stringify(n)));
  return { items, sortDropped: aboutSort || (!items.length && notices.length > 0) };
}

/** `notion-list-recent-pages`' arguments: ten, when it takes a limit. */
export function recentArgs(schema: Schema): Record<string, unknown> {
  const props = propsOf(schema);
  return !Object.keys(props).length || 'limit' in props ? { limit: ROWS } : {};
}

export const NO_TOOLS =
  'Notion’s sign-in offers no tools that only read, so this page can’t show anything. Add an access token to see it.';

async function readByMcp(services: Services, row: CatalogConnectionRow, now: Date): Promise<NotionSnapshot> {
  const tools = await readTools(services, row.id);
  const allowed = new Set(tools.keys());
  const call = (tool: string, args: Record<string, unknown>) =>
    mcpToolRead(services, row, tool, args, allowed);
  const sorted = tools.has(SEARCH_TOOL) ? searchArgs(tools.get(SEARCH_TOOL) ?? null) : null;
  const [found, workspace] = await Promise.all([
    sorted
      ? call(SEARCH_TOOL, sorted.args)
          .then(mcpSearch)
          .catch((err: unknown) => {
            // A refused sign-in is the page's problem; anything else falls back to what was opened.
            if (err instanceof ReadProblem && err.refused) throw err;
            return null;
          })
      : Promise.resolve(null),
    tools.has(SELF_TOOL)
      ? rarelyRead(
          services,
          `notion-self:${row.id}`,
          row,
          async () => str(rec(rec(await call(SELF_TOOL, {})).workspace).name),
          { optional: true },
        )
      : Promise.resolve(null),
  ]);
  const recent = found && !found.sortDropped ? found.items : null;
  const opened =
    recent === null && tools.has(RECENT_TOOL)
      ? listIn(await call(RECENT_TOOL, recentArgs(tools.get(RECENT_TOOL) ?? null)), ['results', 'pages'])
          .map(mcpItem)
          .filter((i): i is NotionItem => i !== null)
          .slice(0, ROWS)
      : null;
  if (recent === null && opened === null) throw new ReadProblem(NO_TOOLS);
  // Only what changed lately is counted: a full answer, or one of a size the tool doesn't say, is “at least”.
  const size = sorted?.size ?? null;
  const more = !!recent?.length && (size === null || recent.length >= size);
  const of = (kind: NotionKind): Counted | null =>
    recent ? { n: recent.filter((i) => i.kind === kind).length, more } : null;
  return {
    readAt: now,
    via: 'mcp',
    recent,
    recentMore: more,
    opened,
    pages: of('page'),
    databases: of('database'),
    people: null,
    names: new Map(),
    workspace,
  };
}

/* The read ------------------------------------------------------------------------------------------------------------ */

const viaMcp = (row: Pick<CatalogConnectionRow, 'signIn'>) => row.signIn === 'mcp_oauth';

function notionLoad(services: Services, row: CatalogConnectionRow, now: Date) {
  return () => (viaMcp(row) ? readByMcp(services, row, now) : readByApi(services, row, now));
}

/** Notion's read for its page (kept 5 minutes). */
export function notionLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, `notion:${row.id}`, row, notionLoad(services, row, now), {
    ttlMs: NOTION_KEEP_MS,
  });
}

/* What it shows ------------------------------------------------------------------------------------------------------- */

export interface NotionInput {
  snapshot: NotionSnapshot;
  now: Date;
  timeZone: string;
}

const KIND_WORDS: Record<NotionKind, string> = { page: 'Page', database: 'Database' };
const DAY = 86_400_000;

/** A row of Live: its title, what it is and who changed it, when on the right. */
function itemRow(i: NotionItem, input: NotionInput): ThingPageItem {
  const editor = i.editorId ? input.snapshot.names.get(i.editorId) : undefined;
  return {
    id: i.id,
    title: i.title,
    icon: i.kind === 'database' ? 'database' : 'log',
    detail: [KIND_WORDS[i.kind], editor].filter(Boolean).join(' · '),
    ...(i.editedAt ? { right: when(i.editedAt, input.now, input.timeZone) } : {}),
    ...(i.url ? { url: i.url } : {}),
  };
}

/** What changed today, in the burrow's day. */
function changedToday(input: NotionInput): number {
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: input.timeZone }).format(d);
  const today = day(input.now);
  return (input.snapshot.recent ?? []).filter((i) => i.editedAt && day(i.editedAt) === today).length;
}

/** Edited lately (Live), or Opened lately when the sign-in can't tell what changed. */
function live(input: NotionInput) {
  const { snapshot: s } = input;
  const link = { kind: 'url' as const, label: 'Open Notion', url: NOTION_APP };
  if (s.recent) {
    const today = changedToday(input);
    return liveList({
      id: 'recent',
      title: 'Edited lately',
      ...(s.recent.length ? { meta: today ? `${today} changed today` : 'Nothing changed today' } : {}),
      link,
      items: s.recent.slice(0, ROWS).map((i) => itemRow(i, input)),
      empty:
        s.via === 'api'
          ? 'Nothing is shared with Whombat yet. In Notion, share pages with its connection.'
          : 'Nothing changed lately.',
    });
  }
  if (s.opened)
    return liveList({
      id: 'recent',
      title: 'Opened lately',
      meta: 'Your Notion plan shows Whombat what you opened, not what changed',
      link,
      items: s.opened.map((i) => itemRow(i, input)),
      empty: 'Nothing opened lately.',
    });
  return null;
}

/** “100+”, “12”. */
const countWords = (c: Counted) => `${thousands(c.n)}${c.more ? '+' : ''}`;

/** What of one kind changed in the last 7 days, “at least” when the read stops inside them. */
function weekNote(input: NotionInput, kind: NotionKind) {
  const { snapshot: s, now } = input;
  if (!s.recent) return {};
  const since = now.getTime() - 7 * DAY;
  const n = s.recent.filter((i) => i.kind === kind && i.editedAt && i.editedAt.getTime() > since).length;
  const oldest = s.recent[s.recent.length - 1]?.editedAt;
  const cut = s.recentMore && oldest && oldest.getTime() > since;
  if (!n) return { note: 'None changed this week' };
  return { note: `${thousands(n)}${cut ? '+' : ''} changed this week`, noteTone: 'ok' as const };
}

/** In Notion (Inventory): pages, databases and people Whombat can see. */
function counts(input: NotionInput) {
  const { snapshot: s } = input;
  const lines: ThingPageItem[] = [];
  if (s.pages)
    lines.push(
      countLine({
        id: 'pages',
        title: 'Pages',
        icon: 'log',
        value: countWords(s.pages),
        ...weekNote(input, 'page'),
      }),
    );
  if (s.databases)
    lines.push(
      countLine({
        id: 'databases',
        title: 'Databases',
        icon: 'database',
        value: countWords(s.databases),
        ...weekNote(input, 'database'),
      }),
    );
  if (s.people)
    lines.push(
      countLine({
        id: 'people',
        title: 'People',
        icon: 'key',
        detail: 'Members and guests',
        value: countWords(s.people),
      }),
    );
  return lines.length
    ? inventory({
        id: 'counts',
        title: 'In Notion',
        ...(s.via === 'api' ? { meta: 'What is shared with Whombat' } : {}),
        items: lines,
      })
    : null;
}

/** Edits this week (Trend): pages and databases changed per day, no bar for a day older than the read reaches. */
function editsWeek(input: NotionInput) {
  const { snapshot: s, now, timeZone } = input;
  const dated = (s.recent ?? []).filter((i): i is NotionItem & { editedAt: Date } => i.editedAt !== null);
  if (!dated.length) return null;
  const oldest = dated[dated.length - 1]?.editedAt ?? null;
  const w = weekCounts(
    dated.map((i) => ({ at: i.editedAt })),
    now,
    timeZone,
    s.recentMore ? oldest : null,
  );
  if (daysWith(w.values) < 2) return null;
  const partial = w.values.some((v) => v === null);
  return trend({
    id: 'week',
    title: 'Edits this week',
    meta: 'Pages and databases changed per day',
    days: w.days,
    values: w.values,
    label: 'Changed',
    figure: {
      value: `${thousands(w.total)}${partial ? '+' : ''}`,
      rest: w.total === 1 && !partial ? 'page changed' : 'pages changed',
    },
    change: w.change,
    color: 'blue',
  });
}

/** Who edits most (People): who last changed each page read, when there are two or more. */
function editors(input: NotionInput) {
  const { snapshot: s } = input;
  const by = new Map<string, number>();
  for (const i of s.recent ?? []) {
    const name = i.editorId ? s.names.get(i.editorId) : undefined;
    if (name) by.set(name, (by.get(name) ?? 0) + 1);
  }
  if (by.size < 2) return null;
  return people({
    title: 'Who edits most',
    meta: 'Who last changed each page',
    items: [...by.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
    unit: ['page', 'pages'],
  });
}

/** The card's figures (the page has none of its own in slots): changed today, and the pages. */
function figures(input: NotionInput): ThingPageKpi[] {
  const { snapshot: s } = input;
  const out: ThingPageKpi[] = [];
  if (s.recent) out.push({ key: 'today', label: 'Changed today', value: String(changedToday(input)) });
  if (s.pages) out.push({ key: 'pages', label: 'Pages', value: countWords(s.pages) });
  return out;
}

/** The page's Notion part, from what was read; pure. No machine card: it runs at Notion. */
export function notionView(input: NotionInput): KindView {
  const { snapshot: s } = input;
  const facts: ThingLine[] = [];
  if (s.workspace) facts.push(line(`**${clip(s.workspace, 80)}**`));
  const today = s.recent ? changedToday(input) : null;
  if (today !== null) facts.push(line(`**${today}** changed today`));
  return {
    kpis: [],
    charts: [],
    machine: 'after',
    notices: [],
    ...slotPanels({
      live: live(input),
      inventory: counts(input),
      trend: editsWeek(input),
      people: editors(input),
    }),
    tabs: [],
    facts,
    status: {
      status: 'ok',
      badge:
        today === null
          ? 'Signed in with Notion'
          : today
            ? `${plural(today, 'page')} changed today`
            : 'Nothing changed today',
    },
    open: { label: 'Open Notion', url: NOTION_APP },
    actions: [],
    readAt: s.readAt,
    suggestions: ['What changed this week', 'Pages nobody touched in a year', 'Find a page'],
  };
}

/** The page's part as the card reads it. */
export const notionCardView = (input: NotionInput): KindView => ({
  ...notionView(input),
  kpis: figures(input),
});

/* The page ------------------------------------------------------------------------------------------------------------ */

export async function notionPage(ctx: KindCtx): Promise<KindView> {
  const read = await notionLatest(ctx.services, ctx.row, ctx.now);
  return viewOrProblem(read, NAME, { label: 'Open Notion', url: NOTION_APP }, (snapshot) =>
    notionView({ snapshot, now: ctx.now, timeZone: ctx.timeZone }),
  );
}

/** The health pass: through the token only (its tools are for people's questions); the card keeps what it had. */
async function notionSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<KindSeen> {
  if (viaMcp(row))
    return {
      glance: { facts: (row.glance as ConnectionGlance | null)?.facts ?? [] },
      points: {},
      notices: [],
    };
  const snapshot = await cachedRead(
    services,
    `notion:${row.id}`,
    row,
    notionLoad(services, row, now),
    NOTION_KEEP_MS,
  );
  return seenOfView(notionCardView({ snapshot, now, timeZone }), ['today', 'pages']);
}

export const NOTION_KIND: KindModule = {
  page: notionPage,
  checks: [],
  prefetch: (services, row, now) => notionLatest(services, row, now),
  seen: notionSeen,
};
