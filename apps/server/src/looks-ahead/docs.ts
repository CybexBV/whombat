/**
 * Strictly read-only document search for Looks ahead (docs/decisions/looks-ahead.md): lets a check look for tickets,
 * reservations, receipts or meeting notes in connected Paperless-ngx and Notion workspaces without opening general
 * `connection_call` tools. Every returned document id is recorded in `seen.docs` so Whombat names the source itself.
 *
 * Tests may inject a fake searcher via `useAheadDocsForTests` (refused outside `NODE_ENV=test`).
 */
import type { AheadDocHit } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db } from '../db/client';
import { catalogConnections } from '../db/schema/index';
import type { Services } from '../services';
import { mcpToolRead } from '../things/kinds/mcp-read';
import { getJson } from '../things/kinds/read';
import { apiRead, listIn, propsOf, readTools } from '../things/kinds/workspace/common';
import { mcpItem, SEARCH_TOOL as NOTION_SEARCH_TOOL, notionItem } from '../things/kinds/workspace/notion';
import { list, rec, str } from '../things/words';

const DOC_CATALOG_IDS = ['paperless', 'notion'] as const;
const MAX_HITS_PER_CONNECTION = 5;
const MAX_TOTAL_HITS = 8;
const EXCERPT_MAX = 4000;

export type AheadDocsReader = (burrowId: string, query: string) => Promise<AheadDocHit[]>;
const overrides = new WeakMap<Services, AheadDocsReader>();

/** Tests only: replaces Paperless/Notion document search. Refused outside `NODE_ENV=test`. */
export function useAheadDocsForTests(services: Services, reader: AheadDocsReader | null): void {
  if (services.config.NODE_ENV !== 'test') throw new Error('The Looks ahead docs seam is for tests only.');
  if (reader) overrides.set(services, reader);
  else overrides.delete(services);
}

/** Active Paperless-ngx and Notion connections in this burrow. */
async function activeDocConnections(db: Db, burrowId: string): Promise<CatalogConnectionRow[]> {
  return db
    .select()
    .from(catalogConnections)
    .where(
      and(
        eq(catalogConnections.burrowId, burrowId),
        eq(catalogConnections.status, 'active'),
        inArray(catalogConnections.catalogId, [...DOC_CATALOG_IDS]),
      ),
    );
}

/** Human-readable names of active read-only document sources in this burrow (e.g. `['Paperless', 'Notion']`). */
export async function aheadDocSources(db: Db, burrowId: string): Promise<string[]> {
  const rows = await activeDocConnections(db, burrowId);
  const names = new Set<string>();
  for (const r of rows) {
    if (r.catalogId === 'paperless') names.add('Paperless');
    else if (r.catalogId === 'notion') names.add('Notion');
  }
  return [...names];
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

async function searchPaperless(
  services: Services,
  row: CatalogConnectionRow,
  query: string,
): Promise<AheadDocHit[]> {
  const body = await getJson(services, row, 'Paperless-ngx', '/api/documents/', {
    query,
    page_size: String(MAX_HITS_PER_CONNECTION),
  });
  const results = list(rec(body).results);
  const hits: AheadDocHit[] = [];
  for (const item of results.slice(0, MAX_HITS_PER_CONNECTION)) {
    const r = rec(item);
    const id = r.id;
    if (typeof id !== 'number' && typeof id !== 'string') continue;
    const title = str(r.title) ?? 'Untitled document';
    const content = str(r.content) ?? '';
    const date = str(r.created_date) ?? str(r.created) ?? str(r.added) ?? undefined;
    hits.push({
      docId: `paperless:${row.id}:${id}`,
      source: 'Paperless',
      title: clip(title, 300),
      ...(date ? { date: date.slice(0, 64) } : {}),
      excerpt: clip(content || title, EXCERPT_MAX),
    });
  }
  return hits;
}

async function searchNotion(
  services: Services,
  row: CatalogConnectionRow,
  query: string,
): Promise<AheadDocHit[]> {
  if (row.signIn === 'mcp_oauth') {
    const tools = await readTools(services, row.id);
    if (!tools.has(NOTION_SEARCH_TOOL)) return [];
    const schema = tools.get(NOTION_SEARCH_TOOL) ?? null;
    const props = propsOf(schema);
    const args: Record<string, unknown> = { query };
    const sizeKey = ['page_size', 'limit', 'max_results'].find((k) => k in props);
    if (sizeKey) args[sizeKey] = MAX_HITS_PER_CONNECTION;
    const answer = await mcpToolRead(services, row, NOTION_SEARCH_TOOL, args, new Set(tools.keys()));
    const items = listIn(answer, ['results', 'pages'])
      .map(mcpItem)
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .slice(0, MAX_HITS_PER_CONNECTION);
    return items.map((item) => ({
      docId: `notion:${row.id}:${item.id}`,
      source: 'Notion',
      title: clip(item.title, 300),
      ...(item.editedAt ? { date: item.editedAt.toISOString() } : {}),
      excerpt: clip(`${item.kind}: ${item.title}`, EXCERPT_MAX),
    }));
  }
  const body = await apiRead(services, row, 'Notion', '/v1/search', {
    method: 'POST',
    body: { query, page_size: MAX_HITS_PER_CONNECTION },
  });
  const results = list(rec(body).results);
  const hits: AheadDocHit[] = [];
  for (const raw of results.slice(0, MAX_HITS_PER_CONNECTION)) {
    const item = notionItem(raw);
    if (!item) continue;
    hits.push({
      docId: `notion:${row.id}:${item.id}`,
      source: 'Notion',
      title: clip(item.title, 300),
      ...(item.editedAt ? { date: item.editedAt.toISOString() } : {}),
      excerpt: clip(`${item.kind}: ${item.title}`, EXCERPT_MAX),
    });
  }
  return hits;
}

/** Searches every active Paperless-ngx and Notion connection in this burrow (read-only, best effort per connection). */
export async function searchAheadDocs(
  services: Services,
  burrowId: string,
  query: string,
): Promise<AheadDocHit[]> {
  const testReader = overrides.get(services);
  if (testReader) return (await testReader(burrowId, query)).slice(0, MAX_TOTAL_HITS);
  const rows = await activeDocConnections(services.db, burrowId);
  if (!rows.length) return [];
  const all: AheadDocHit[] = [];
  for (const row of rows) {
    try {
      const hits =
        row.catalogId === 'paperless'
          ? await searchPaperless(services, row, query)
          : await searchNotion(services, row, query);
      all.push(...hits);
    } catch (err) {
      services.log.warn(
        { err: String(err), connectionId: row.id, catalogId: row.catalogId },
        'looks ahead: doc search failed',
      );
    }
    if (all.length >= MAX_TOTAL_HITS) break;
  }
  return all.slice(0, MAX_TOTAL_HITS);
}
