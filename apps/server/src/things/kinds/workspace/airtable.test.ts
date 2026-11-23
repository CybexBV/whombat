/**
 * Airtable's page from recorded answers: `GET /v0/meta/bases` and `GET /v0/meta/bases/{baseId}/tables` as documented
 * (airtable.com/developers/web/api/list-bases, get-base-schema; their examples), and its MCP server's `list_bases` and
 * `list_tables_for_base` by their published names (airtable.com/developers/agents/mcp/tools). How rarely it reads:
 * an hour per read, nothing in the health pass.
 */
import { readFileSync } from 'node:fs';
import { ThingPagePanel } from '@whombat/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { rowOf } from '../media/testing';
import { slotProblems } from '../slots';
import type { KindCtx } from '../types';
import {
  AIRTABLE_KIND,
  type AirtableSnapshot,
  airtableBases,
  airtablePage,
  airtableView,
  BASES_TOOL,
  forgetAirtable,
  TABLES_TOOL,
  tableCount,
} from './airtable';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/airtable/${name}`, import.meta.url), 'utf8'));

const io = vi.hoisted(() => ({
  calls: [] as string[],
  tools: [] as { name: string; access: 'read' | 'write'; inputSchema: Record<string, unknown> | null }[],
  mcp: [] as { tool: string; args: Record<string, unknown> }[],
  mcpAnswers: new Map<string, unknown>(),
}));

vi.mock('../../../connections/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../connections/http')>();
  return {
    ...real,
    signedConnectionFetch: async (_s: unknown, _r: unknown, req: { url: string }) => {
      const path = new URL(req.url).pathname;
      io.calls.push(path);
      const json =
        path === '/v0/meta/bases'
          ? JSON.parse(readFileSync(new URL('./fixtures/airtable/bases.json', import.meta.url), 'utf8'))
          : path.endsWith('/tables')
            ? JSON.parse(readFileSync(new URL('./fixtures/airtable/tables.json', import.meta.url), 'utf8'))
            : null;
      return json
        ? { status: 200, headers: {}, body: Buffer.from(JSON.stringify(json)) }
        : { status: 404, headers: {}, body: Buffer.from('{}') };
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
    return io.mcpAnswers.get(tool);
  },
}));

const now = new Date('2026-10-21T15:00:00Z');

function snapshot(): AirtableSnapshot {
  const { bases, more } = airtableBases(fixture('bases.json'));
  return {
    readAt: now,
    bases: bases.map((b, i) => ({ ...b, tables: i < 3 ? ([2, 5, 1][i] ?? null) : null })),
    more,
  };
}

describe('Airtable’s answers', () => {
  it('reads bases with their access, never something that isn’t a base', () => {
    const { bases, more } = airtableBases(fixture('bases.json'));
    expect(more).toBe(false);
    expect(bases.map((b) => [b.id, b.name, b.permission])).toEqual([
      ['appLkNDICXNqxSDhG', 'Apartment Hunting', 'create'],
      ['appSW9R5uCNmRmfl6', 'Project Tracker', 'edit'],
      ['appQ8v2nRtP4mKx1a', 'Content calendar', 'read'],
      ['appZ7kD3wHs9LpQ2b', 'Team portal', 'interfaceOnly'],
    ]);
    expect(airtableBases({ bases: [], offset: 'itr23sEjsdfEr3282/appSW9R5uCNmRmfl6' }).more).toBe(true);
  });

  it('counts a base’s tables, and says nothing when the answer lists none it can tell', () => {
    expect(tableCount(fixture('tables.json'))).toBe(2);
    expect(tableCount({ tables: [] })).toBe(0);
    expect(tableCount('Something went wrong')).toBeNull();
  });
});

describe('Airtable’s page', () => {
  it('counts bases and tables and lists the bases that open in Airtable', () => {
    const view = airtableView({ snapshot: snapshot(), via: 'api' });
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['bases', 'counts']);
    for (const p of view.panels) expect(ThingPagePanel.safeParse(p).success).toBe(true);
    const counts = view.panels[1];
    if (counts?.kind !== 'list') throw new Error('no counts');
    expect(counts.title).toBe('In Airtable');
    expect(counts.items.map((i) => [i.title, i.figure?.value, i.detail])).toEqual([
      ['Bases', '4', undefined],
      ['Tables', '8+', 'In the first 3 bases'],
    ]);
    const bases = view.panels[0];
    if (bases?.kind !== 'list') throw new Error('no bases');
    expect(bases.items.map((i) => [i.title, i.detail, i.right, i.url])).toEqual([
      ['Apartment Hunting', '2 tables', 'Creator', 'https://airtable.com/appLkNDICXNqxSDhG'],
      ['Project Tracker', '5 tables', 'Editor', 'https://airtable.com/appSW9R5uCNmRmfl6'],
      ['Content calendar', '1 table', 'Read only', 'https://airtable.com/appQ8v2nRtP4mKx1a'],
      ['Team portal', undefined, 'Interface only', 'https://airtable.com/appZ7kD3wHs9LpQ2b'],
    ]);
    expect(view.facts[0]?.map((p) => p.text).join('')).toBe('4 bases · 8+ tables');
  });
});

describe('Reading Airtable', () => {
  const services = { clock: () => now } as unknown as Services;
  const ctx = (row: CatalogConnectionRow): KindCtx =>
    ({ services, row, now, timeZone: 'UTC' }) as unknown as KindCtx;

  beforeEach(() => {
    forgetAirtable(services);
    io.calls.length = 0;
    io.mcp.length = 0;
    io.mcpAnswers.clear();
    io.tools = [];
  });

  it('reads the bases and the tables of those it may read, once an hour, and the health pass never calls', async () => {
    const row = rowOf('airtable', {
      id: 'con_airtable_api',
      baseUrl: 'https://api.airtable.com',
      signIn: 'token',
      glance: null,
    });
    // Before any page was open the card keeps what it had, and Airtable isn't called.
    expect((await AIRTABLE_KIND.seen?.(services, row, now, 'UTC'))?.glance.facts).toEqual([]);
    expect(io.calls).toEqual([]);
    const view = await airtablePage(ctx(row));
    expect(view.problem).toBeUndefined();
    expect(io.calls).toEqual([
      '/v0/meta/bases',
      '/v0/meta/bases/appLkNDICXNqxSDhG/tables',
      '/v0/meta/bases/appSW9R5uCNmRmfl6/tables',
      '/v0/meta/bases/appQ8v2nRtP4mKx1a/tables',
    ]);
    await airtablePage(ctx(row));
    const seen = await AIRTABLE_KIND.seen?.(services, row, now, 'UTC');
    expect(io.calls).toHaveLength(4);
    expect(seen?.glance.facts.map((f) => [f.label, f.value])).toEqual([
      ['Bases', '4'],
      ['Tables', '6+'],
    ]);
  });

  it('reads through its MCP tools when signed in with Airtable', async () => {
    io.tools = [
      { name: BASES_TOOL, access: 'read', inputSchema: { properties: {} } },
      {
        name: TABLES_TOOL,
        access: 'read',
        inputSchema: { properties: { baseId: { type: 'string' } }, required: ['baseId'] },
      },
    ];
    io.mcpAnswers.set(BASES_TOOL, fixture('bases.json'));
    io.mcpAnswers.set(TABLES_TOOL, fixture('tables.json'));
    const row = rowOf('airtable', { id: 'con_airtable_mcp', signIn: 'mcp_oauth' });
    const view = await airtablePage(ctx(row));
    expect(io.calls).toEqual([]);
    expect(io.mcp.map((c) => [c.tool, c.args])).toEqual([
      [BASES_TOOL, {}],
      [TABLES_TOOL, { baseId: 'appLkNDICXNqxSDhG' }],
      [TABLES_TOOL, { baseId: 'appSW9R5uCNmRmfl6' }],
      [TABLES_TOOL, { baseId: 'appQ8v2nRtP4mKx1a' }],
    ]);
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['bases', 'counts']);
  });
});
