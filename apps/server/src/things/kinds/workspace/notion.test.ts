/**
 * Notion's page from recorded answers: the API's search, users and bot user as documented for Notion-Version
 * 2026-03-11 (developers.notion.com/reference/post-search, get-users, get-self), and its MCP server's tools by their
 * published names (developers.notion.com/guides/mcp/tools-search-reference). The MCP answers' shapes aren't published:
 * the recorded ones hold the fields the reference names (id, title, url, type, a timestamp, `notices`).
 */
import { readFileSync } from 'node:fs';
import { ThingPagePanel } from '@whombat/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { rowOf } from '../media/testing';
import { forgetKindReads } from '../read';
import { slotProblems } from '../slots';
import type { KindCtx } from '../types';
import {
  mcpSearch,
  NOTION_KIND,
  type NotionInput,
  type NotionSnapshot,
  notionItem,
  notionPage,
  notionUsers,
  notionView,
  RECENT_TOOL,
  recentArgs,
  SEARCH_TOOL,
  SELF_TOOL,
  searchArgs,
  searchResults,
  workspaceOfMe,
} from './notion';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/notion/${name}`, import.meta.url), 'utf8'));

const io = vi.hoisted(() => ({
  calls: [] as { method: string; path: string; body: unknown; headers: Record<string, string> }[],
  answers: new Map<string, unknown>(),
  tools: [] as { name: string; access: 'read' | 'write'; inputSchema: Record<string, unknown> | null }[],
  mcp: [] as { tool: string; args: Record<string, unknown> }[],
  mcpAnswers: new Map<string, unknown>(),
}));

vi.mock('../../../connections/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../connections/http')>();
  return {
    ...real,
    signedConnectionFetch: async (
      _s: unknown,
      _r: unknown,
      req: { method: string; url: string; body?: string; headers?: Record<string, string> },
    ) => {
      const url = new URL(req.url);
      const body = req.body ? JSON.parse(req.body) : undefined;
      io.calls.push({ method: req.method, path: url.pathname, body, headers: req.headers ?? {} });
      const filter = (body as { filter?: { value?: string } } | undefined)?.filter?.value;
      const json = io.answers.get(filter ? `${url.pathname}?${filter}` : url.pathname);
      if (json === undefined) return { status: 404, headers: {}, body: Buffer.from('{}') };
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(json)) };
    },
  };
});

vi.mock('../../../connections/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../connections/store')>();
  return { ...real, toolRowsOf: async () => io.tools };
});

vi.mock('../mcp-read', () => ({
  mcpToolRead: async (_s: unknown, _r: unknown, tool: string, args: Record<string, unknown>) => {
    io.mcp.push({ tool, args });
    if (!io.mcpAnswers.has(tool)) throw new Error(`no answer for ${tool}`);
    return io.mcpAnswers.get(tool);
  },
}));

const TZ = 'Europe/Amsterdam';
// Tuesday 21 October 2026, 17:00 in Amsterdam.
const now = new Date('2026-10-21T15:00:00Z');

function snapshot(over: Partial<NotionSnapshot> = {}): NotionSnapshot {
  const recent = searchResults(fixture('search-recent.json'));
  const users = notionUsers(fixture('users.json'));
  return {
    readAt: now,
    via: 'api',
    recent: recent.items,
    recentMore: recent.more,
    opened: null,
    pages: { n: 4, more: false },
    databases: { n: 2, more: false },
    people: users.people,
    names: users.names,
    workspace: 'Acme',
    ...over,
  };
}

const input = (over: Partial<NotionSnapshot> = {}): NotionInput => ({
  snapshot: snapshot(over),
  now,
  timeZone: TZ,
});

const panel = (view: ReturnType<typeof notionView>, id: string) => view.panels.find((p) => p.id === id);

describe('Notion’s answers', () => {
  it('reads pages and data sources with their title, last edit and editor; leaves out thrown away and partial ones', () => {
    const { items, more } = searchResults(fixture('search-recent.json'));
    expect(more).toBe(false);
    expect(items.map((i) => [i.title, i.kind, i.editorId])).toEqual([
      ['Launch plan', 'page', 'u-anna'],
      ['Tasks', 'database', 'u-sam'],
      ['Meeting notes 20 Oct', 'page', 'u-anna'],
      ['Hiring', 'page', 'u-lena'],
      ['Roadmap', 'database', 'u-anna'],
      ['Untitled', 'page', 'b-whombat'],
    ]);
    expect(items[0]?.url).toBe('https://www.notion.so/Launch-plan-2a1b6c3d4e5f4a6b8c7d1e2f3a4b5c01');
    expect(notionItem({ object: 'page', id: 'x', last_edited_time: 'soon' })).toBeNull();
    expect(notionItem({ object: 'block', id: 'x', last_edited_time: '2026-10-21T10:00:00Z' })).toBeNull();
    expect(
      notionItem({
        object: 'page',
        id: 'x',
        last_edited_time: '2026-10-21T10:00:00Z',
        url: 'https://evil.example/',
      })?.url,
    ).toBeNull();
  });

  it('counts people, not connections, and knows every name', () => {
    const { names, people } = notionUsers(fixture('users.json'));
    expect(people).toEqual({ n: 3, more: false });
    expect(names.get('u-sam')).toBe('Sam Okafor');
    expect(names.get('b-whombat')).toBe('Whombat');
    expect(workspaceOfMe(fixture('me.json'))).toBe('Acme');
  });
});

describe('Notion’s page', () => {
  it('fills Live, Inventory, Trend and People in their slots', () => {
    const view = notionView(input());
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['recent', 'counts', 'week', 'people']);
    for (const p of view.panels) expect(ThingPagePanel.safeParse(p).success).toBe(true);
  });

  it('shows what was edited lately, newest first, with who and when', () => {
    const recent = panel(notionView(input()), 'recent');
    if (recent?.kind !== 'list') throw new Error('no list');
    expect(recent.title).toBe('Edited lately');
    expect(recent.meta).toBe('2 changed today');
    expect(recent.items.map((i) => [i.title, i.detail, i.right])).toEqual([
      ['Launch plan', 'Page · Anna de Vries', 'Today 15:40'],
      ['Tasks', 'Database · Sam Okafor', 'Today 11:05'],
      ['Meeting notes 20 Oct', 'Page · Anna de Vries', 'Yesterday 18:00'],
      ['Hiring', 'Page · Lena Hoffmann', '19 Oct'],
      ['Roadmap', 'Database · Anna de Vries', '17 Oct'],
      ['Untitled', 'Page · Whombat', '1 Aug'],
    ]);
    expect(recent.items[1]?.icon).toBe('database');
  });

  it('counts pages, databases and people with what changed this week', () => {
    const counts = panel(notionView(input()), 'counts');
    if (counts?.kind !== 'list') throw new Error('no counts');
    expect(counts.title).toBe('In Notion');
    expect(counts.items.map((i) => [i.title, i.figure?.value, i.figure?.note])).toEqual([
      ['Pages', '4', '3 changed this week'],
      ['Databases', '2', '2 changed this week'],
      ['People', '3', undefined],
    ]);
    const more = notionView(input({ pages: { n: 100, more: true } }));
    const line = panel(more, 'counts');
    if (line?.kind !== 'list') throw new Error('no counts');
    expect(line.items[0]?.figure?.value).toBe('100+');
  });

  it('draws the pages changed per day, and no bar before the oldest one read when there were more', () => {
    const week = panel(notionView(input()), 'week');
    if (week?.kind !== 'chart') throw new Error('no week');
    expect(week.title).toBe('Edits this week');
    expect(week.series[0]?.values).toEqual([0, 0, 1, 0, 1, 1, 2]);
    expect(week.figure).toEqual({ value: '5', rest: 'pages changed' });
    // Only the four newest read, more waiting: the read reaches back into Sunday, which may lack some.
    const cut = snapshot().recent?.slice(0, 4) ?? [];
    const partial = panel(notionView(input({ recent: cut, recentMore: true })), 'week');
    if (partial?.kind !== 'chart') throw new Error('no week');
    expect(partial.series[0]?.values).toEqual([null, null, null, null, null, 1, 2]);
    expect(partial.figure).toEqual({ value: '3+', rest: 'pages changed' });
  });

  it('says who edits most, and leaves People out with one editor', () => {
    const who = panel(notionView(input()), 'people');
    if (who?.kind !== 'bars') throw new Error('no people');
    expect(who.title).toBe('Who edits most');
    expect(who.items.map((i) => [i.label, i.value])).toEqual([
      ['Anna de Vries', '3 pages'],
      ['Sam Okafor', '1 page'],
      ['Lena Hoffmann', '1 page'],
      ['Whombat', '1 page'],
    ]);
    const alone = snapshot().recent?.filter((i) => i.editorId === 'u-anna') ?? [];
    expect(panel(notionView(input({ recent: alone })), 'people')).toBeUndefined();
  });

  it('puts the workspace and today’s changes in the head', () => {
    const view = notionView(input());
    expect(view.facts.map((f) => f.map((p) => p.text).join(''))).toEqual(['Acme', '2 changed today']);
    expect(view.status).toEqual({ status: 'ok', badge: '2 pages changed today' });
    expect(view.open?.url).toBe('https://www.notion.so/');
  });

  it('shows what was opened lately when the sign-in can’t tell what changed', () => {
    const opened = mcpSearch(fixture('mcp-search.json')).items.slice(0, 2);
    const view = notionView(
      input({
        via: 'mcp',
        recent: null,
        opened,
        pages: null,
        databases: null,
        people: null,
        names: new Map(),
      }),
    );
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['recent']);
    const recent = panel(view, 'recent');
    if (recent?.kind !== 'list') throw new Error('no list');
    expect(recent.title).toBe('Opened lately');
    expect(recent.items.map((i) => i.title)).toEqual(['Launch plan', 'Tasks']);
  });
});

describe('Notion’s MCP tools', () => {
  it('reads search results, never a person, and sees when Notion dropped the sort', () => {
    const found = mcpSearch(fixture('mcp-search.json'));
    expect(found.sortDropped).toBe(false);
    expect(found.items.map((i) => [i.title, i.kind, i.editedAt?.toISOString()])).toEqual([
      ['Launch plan', 'page', '2026-10-21T13:40:00.000Z'],
      ['Tasks', 'database', '2026-10-21T09:05:00.000Z'],
      ['Meeting notes 20 Oct', 'page', '2026-10-20T16:00:00.000Z'],
    ]);
    expect(mcpSearch(fixture('mcp-search-sort-dropped.json'))).toEqual({ items: [], sortDropped: true });
    expect(mcpSearch('Couldn’t search')).toEqual({ items: [], sortDropped: false });
    // Nothing left to search by: no results, and a notice that doesn't name the sort.
    expect(mcpSearch({ results: [], notices: ['Give a query or a filter.'] }).sortDropped).toBe(true);
  });

  it('asks for the last edited first in the words its schema offers', () => {
    expect(searchArgs(null)).toEqual({ args: { query: '', sort: 'last_edited' }, size: null });
    expect(
      searchArgs({
        type: 'object',
        properties: {
          query: { type: 'string' },
          sort: { type: 'string', enum: ['relevance', 'last_edited'] },
          page_size: { type: 'number', maximum: 25 },
        },
      }),
    ).toEqual({ args: { sort: 'last_edited', query: '', page_size: 25 }, size: 25 });
    expect(
      searchArgs({
        properties: {
          query: { type: 'string' },
          sort: {
            type: 'object',
            properties: {
              timestamp: { enum: ['created_time', 'last_edited_time'] },
              direction: { enum: ['ascending', 'descending'] },
            },
          },
        },
      })?.args.sort,
    ).toEqual({ timestamp: 'last_edited_time', direction: 'descending' });
    expect(searchArgs({ properties: { query: { type: 'string' } } })).toBeNull();
    expect(recentArgs({ properties: { limit: { type: 'number' } } })).toEqual({ limit: 10 });
    expect(recentArgs({ properties: { cursor: { type: 'string' } } })).toEqual({});
  });
});

describe('Reading Notion', () => {
  const services = { clock: () => now } as unknown as Services;
  const ctx = (row: CatalogConnectionRow): KindCtx =>
    ({ services, row, now, timeZone: TZ }) as unknown as KindCtx;

  beforeEach(() => {
    forgetKindReads(services);
    io.calls.length = 0;
    io.mcp.length = 0;
    io.answers.clear();
    io.mcpAnswers.clear();
    io.tools = [];
  });

  it('reads the API with Notion’s version, sorted by last edit, one page and never more', async () => {
    io.answers.set('/v1/search', fixture('search-recent.json'));
    io.answers.set('/v1/users', fixture('users.json'));
    io.answers.set('/v1/users/me', fixture('me.json'));
    const row = rowOf('notion', { id: 'con_notion_api', baseUrl: 'https://api.notion.com', signIn: 'token' });
    const view = await notionPage(ctx(row));
    expect(view.problem).toBeUndefined();
    expect(slotProblems(view)).toEqual([]);
    const searches = io.calls.filter((c) => c.path === '/v1/search');
    // Everything fits one page: no filtered counts.
    expect(searches).toHaveLength(1);
    expect(searches[0]?.method).toBe('POST');
    expect(searches[0]?.body).toMatchObject({
      sort: { timestamp: 'last_edited_time', direction: 'descending' },
      page_size: 100,
    });
    expect(searches[0]?.headers['Notion-Version']).toBe('2026-03-11');
    expect(view.facts[0]?.[0]?.text).toBe('Acme');
  });

  it('counts pages and databases with one filtered page each when more changed than one page holds', async () => {
    io.answers.set('/v1/search', { ...(fixture('search-recent.json') as object), has_more: true });
    io.answers.set('/v1/search?page', { results: new Array(100).fill({}), has_more: true });
    io.answers.set('/v1/search?data_source', { results: new Array(7).fill({}), has_more: false });
    const row = rowOf('notion', {
      id: 'con_notion_more',
      baseUrl: 'https://api.notion.com',
      signIn: 'token',
    });
    const view = await notionPage(ctx(row));
    const counts = panel(view, 'counts');
    if (counts?.kind !== 'list') throw new Error('no counts');
    expect(counts.items.map((i) => [i.title, i.figure?.value])).toEqual([
      ['Pages', '100+'],
      ['Databases', '7'],
    ]);
    expect(io.calls.filter((c) => c.path === '/v1/search')).toHaveLength(3);
  });

  it('reads through its MCP tools when signed in with Notion, and never calls the API', async () => {
    io.tools = [
      {
        name: SEARCH_TOOL,
        access: 'read',
        inputSchema: {
          properties: { query: { type: 'string' }, sort: { enum: ['relevance', 'last_edited'] } },
        },
      },
      { name: SELF_TOOL, access: 'read', inputSchema: { properties: {} } },
      { name: 'notion-create-pages', access: 'write', inputSchema: null },
    ];
    io.mcpAnswers.set(SEARCH_TOOL, fixture('mcp-search.json'));
    io.mcpAnswers.set(SELF_TOOL, fixture('mcp-self.json'));
    const row = rowOf('notion', { id: 'con_notion_mcp', signIn: 'mcp_oauth' });
    const view = await notionPage(ctx(row));
    expect(io.calls).toEqual([]);
    expect(io.mcp.map((c) => c.tool).sort()).toEqual([SELF_TOOL, SEARCH_TOOL].sort());
    expect(io.mcp.find((c) => c.tool === SEARCH_TOOL)?.args).toEqual({ sort: 'last_edited', query: '' });
    expect(slotProblems(view)).toEqual([]);
    const recent = panel(view, 'recent');
    if (recent?.kind !== 'list') throw new Error('no list');
    expect(recent.items.map((i) => i.title)).toEqual(['Launch plan', 'Tasks', 'Meeting notes 20 Oct']);
    expect(view.facts[0]?.[0]?.text).toBe('Acme');
    // The health pass doesn't read through the sign-in's tools.
    const seen = await NOTION_KIND.seen?.(services, row, now, TZ);
    expect(seen?.points).toEqual({});
    expect(io.mcp).toHaveLength(2);
  });

  it('falls back to what was opened lately when the plan can’t sort by date', async () => {
    io.tools = [
      { name: SEARCH_TOOL, access: 'read', inputSchema: null },
      { name: RECENT_TOOL, access: 'read', inputSchema: { properties: { limit: { type: 'number' } } } },
    ];
    io.mcpAnswers.set(SEARCH_TOOL, fixture('mcp-search-sort-dropped.json'));
    io.mcpAnswers.set(RECENT_TOOL, fixture('mcp-recent.json'));
    const row = rowOf('notion', { id: 'con_notion_free', signIn: 'mcp_oauth' });
    const view = await notionPage(ctx(row));
    const recent = panel(view, 'recent');
    if (recent?.kind !== 'list') throw new Error('no list');
    expect(recent.title).toBe('Opened lately');
    expect(recent.items.map((i) => i.title)).toEqual(['Launch plan', 'Tasks']);
    expect(io.mcp.find((c) => c.tool === RECENT_TOOL)?.args).toEqual({ limit: 10 });
  });

  it('says why in one line when the sign-in has no tools that only read', async () => {
    io.tools = [{ name: SEARCH_TOOL, access: 'write', inputSchema: null }];
    const row = rowOf('notion', { id: 'con_notion_none', signIn: 'mcp_oauth' });
    const view = await notionPage(ctx(row));
    expect(view.problem).toContain('access token');
    expect(view.panels).toEqual([]);
  });
});
