/**
 * Airtable's page in slots (docs/service-pages.md): its bases as a list that opens each one in Airtable, and how many
 * bases and tables there are in Inventory. Only what the bases are, never their records: Airtable's free plan allows
 * 1,000 API calls a month per workspace, and counting records means reading them 100 at a time.
 *
 * One read is the list of bases and the tables of at most five of them: with a token `GET /v0/meta/bases` and
 * `GET /v0/meta/bases/{baseId}/tables`, signed in with Airtable its MCP server's `list_bases` and
 * `list_tables_for_base`. It is read only while the page is open and kept an hour, a failure 5 minutes (Airtable wants
 * 30 seconds' rest after a 429). The health pass never calls Airtable: the card says what the last read found.
 */
import type { ThingLine, ThingPageItem, ThingPageKpi } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { ConnectionGlance } from '../../../home/types';
import type { Services } from '../../../services';
import { clip, line, list, plural, rec, str, thousands } from '../../words';
import { loader, optional, seenOfView, viewOrProblem } from '../business/common';
import { mcpToolRead } from '../mcp-read';
import { type Latest, PAGE_WAIT_MS } from '../read';
import type { KindModule, KindSeen } from '../registry';
import { countLine, inventory, liveList, slotPanels } from '../slots';
import type { KindCtx, KindView } from '../types';
import { apiRead, listIn, propNamed, readTools } from './common';

const NAME = 'Airtable';
export const AIRTABLE_APP = 'https://airtable.com/';
/** The bases whose tables one read counts. */
export const TABLE_BASES = 5;
/** Bases listed on the page. */
const LISTED = 20;
export const AIRTABLE_KEEP_MS = 60 * 60_000;
export const AIRTABLE_FAILED_MS = 5 * 60_000;

export const BASES_TOOL = 'list_bases';
export const TABLES_TOOL = 'list_tables_for_base';

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface AirtableBase {
  id: string;
  name: string;
  /** Airtable's `permissionLevel`: create, edit, comment, read, interfaceOnly… */
  permission: string | null;
  /** How many tables it has; null when they weren't read (past the first five, or refused). */
  tables: number | null;
}

export interface AirtableSnapshot {
  readAt: Date;
  bases: AirtableBase[];
  /** More bases than one answer holds. */
  more: boolean;
}

/** One base of `GET /v0/meta/bases` or `list_bases`; null when it isn't one. */
function baseOf(r: Record<string, unknown>): AirtableBase | null {
  const id = str(r.id) ?? str(r.baseId);
  const name = str(r.name) ?? str(r.baseName);
  if (!id || !/^app[A-Za-z0-9]{3,40}$/.test(id) || !name) return null;
  return { id, name: clip(name, 120), permission: str(r.permissionLevel), tables: null };
}

/** The bases of an answer, and whether Airtable has more (an `offset` for the next page). */
export function airtableBases(body: unknown): { bases: AirtableBase[]; more: boolean } {
  return {
    bases: listIn(body, ['bases'])
      .map(baseOf)
      .filter((b): b is AirtableBase => b !== null),
    more: !!str(rec(body).offset),
  };
}

/** How many tables an answer about one base lists; null when it lists none Whombat can tell. */
export function tableCount(body: unknown): number | null {
  const tables = listIn(body, ['tables']).filter((t) => str(t.id) ?? str(t.name));
  if (tables.length) return tables.length;
  return Array.isArray(rec(body).tables) || Array.isArray(body) ? 0 : null;
}

/** A base whose tables the token or the person may read (not only an interface). */
const readable = (b: AirtableBase) =>
  b.permission === null || ['create', 'edit', 'comment', 'read'].includes(b.permission);

async function readAirtable(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<AirtableSnapshot> {
  let listed: { bases: AirtableBase[]; more: boolean };
  let tablesOf: (id: string) => Promise<number | null>;
  if (row.signIn === 'mcp_oauth') {
    const tools = await readTools(services, row.id);
    const allowed = new Set(tools.keys());
    listed = airtableBases(await mcpToolRead(services, row, BASES_TOOL, {}, allowed));
    const baseKey = propNamed(tools.get(TABLES_TOOL), /^base_?id$/i) ?? 'baseId';
    tablesOf = async (id) =>
      allowed.has(TABLES_TOOL)
        ? tableCount(await mcpToolRead(services, row, TABLES_TOOL, { [baseKey]: id }, allowed))
        : null;
  } else {
    listed = airtableBases(await apiRead(services, row, NAME, '/v0/meta/bases'));
    tablesOf = async (id) =>
      tableCount(await apiRead(services, row, NAME, `/v0/meta/bases/${encodeURIComponent(id)}/tables`));
  }
  const counted = listed.bases.filter(readable).slice(0, TABLE_BASES);
  const tables = await Promise.all(counted.map((b) => optional(tablesOf(b.id))));
  const byId = new Map(counted.map((b, i) => [b.id, tables[i] ?? null]));
  return {
    readAt: now,
    bases: listed.bases.map((b) => ({ ...b, tables: byId.get(b.id) ?? null })),
    more: listed.more,
  };
}

/* Kept an hour ------------------------------------------------------------------------------------------------------ */

interface Kept {
  version: string;
  value: AirtableSnapshot | null;
  at: number;
  failure: { at: number; error: unknown } | null;
  reading: Promise<void> | null;
}

// The kinds' shared cache keeps nothing past 15 minutes; this keeps the last read for its hour and the card.
const keeps = new WeakMap<Services, Map<string, Kept>>();

function keptOf(services: Services, row: CatalogConnectionRow): Kept {
  let all = keeps.get(services);
  if (!all) {
    all = new Map();
    keeps.set(services, all);
  }
  const version = `${row.credentialVersion}:${row.updatedAt.getTime()}`;
  let k = all.get(row.id);
  if (k?.version !== version) {
    k = { version, value: null, at: 0, failure: null, reading: null };
    all.set(row.id, k);
  }
  return k;
}

function outcome(k: Kept, refreshing: boolean): Latest<AirtableSnapshot> {
  if (k.value) return { ok: true, value: k.value, at: new Date(k.at), refreshing };
  return { ok: false, error: k.failure?.error, at: new Date(k.failure?.at ?? Date.now()), refreshing };
}

/**
 * Airtable's read for its page: the last one while it is younger than an hour (a failure for 5 minutes); else a new
 * one, waited for briefly when there is an older one to show meanwhile.
 */
export async function airtableLatest(
  services: Services,
  row: CatalogConnectionRow,
  now = services.clock(),
): Promise<Latest<AirtableSnapshot>> {
  const k = keptOf(services, row);
  const t = Date.now();
  if (k.value && t - k.at <= AIRTABLE_KEEP_MS) return outcome(k, false);
  if (k.failure && t - k.failure.at <= AIRTABLE_FAILED_MS) return outcome(k, false);
  if (!k.reading) {
    const load = loader(NAME, () => readAirtable(services, row, now));
    k.reading = load().then(
      (value) => {
        k.value = value;
        k.at = Date.now();
        k.failure = null;
        k.reading = null;
      },
      (error: unknown) => {
        k.failure = { at: Date.now(), error };
        k.reading = null;
      },
    );
  }
  const reading = k.reading;
  if (!k.value) {
    await reading;
    return outcome(k, false);
  }
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), PAGE_WAIT_MS);
    timer.unref?.();
  });
  try {
    return outcome(k, (await Promise.race([reading, late])) === 'late');
  } finally {
    clearTimeout(timer);
  }
}

/** The last read, whatever its age: the card's, without calling Airtable. */
export function airtableKept(services: Services, row: CatalogConnectionRow): AirtableSnapshot | null {
  return keptOf(services, row).value;
}

/** Tests: forget every kept read. */
export function forgetAirtable(services: Services): void {
  keeps.delete(services);
}

/* What it shows ------------------------------------------------------------------------------------------------------- */

export interface AirtableInput {
  snapshot: AirtableSnapshot;
  via: 'api' | 'mcp';
}

const PERMISSION_WORDS: Record<string, string> = {
  create: 'Creator',
  edit: 'Editor',
  comment: 'Commenter',
  read: 'Read only',
  interfaceOnly: 'Interface only',
  permissionSetOnly: 'Limited access',
};

/** “14”, “14+” when some bases' tables weren't counted. */
function tableTotal(s: AirtableSnapshot): { value: string; counted: number; partial: boolean } {
  const counted = s.bases.filter((b) => b.tables !== null);
  const total = counted.reduce((a, b) => a + (b.tables ?? 0), 0);
  const partial = s.more || counted.length < s.bases.length;
  return { value: `${thousands(total)}${partial ? '+' : ''}`, counted: counted.length, partial };
}

const basesValue = (s: AirtableSnapshot) => `${thousands(s.bases.length)}${s.more ? '+' : ''}`;

/** In Airtable (Inventory): bases, and tables of the bases read. */
function counts(input: AirtableInput) {
  const { snapshot: s } = input;
  const t = tableTotal(s);
  const lines: ThingPageItem[] = [
    countLine({ id: 'bases', title: 'Bases', icon: 'database', value: basesValue(s) }),
  ];
  if (t.counted)
    lines.push(
      countLine({
        id: 'tables',
        title: 'Tables',
        icon: 'log',
        ...(t.partial ? { detail: `In the first ${plural(t.counted, 'base')}` } : {}),
        value: t.value,
      }),
    );
  return inventory({
    id: 'counts',
    title: 'In Airtable',
    meta: input.via === 'api' ? 'The bases the token may read' : 'The bases you can open',
    items: lines,
  });
}

/**
 * Your bases (in Live's place, beside the counts): each opens in Airtable, with its tables and what the connection may
 * do there. They are what a person comes to the page for, and nothing in Airtable is “happening now” without reading
 * records.
 */
function basesList(input: AirtableInput) {
  const { snapshot: s, via } = input;
  return liveList({
    id: 'bases',
    title: 'Your bases',
    ...(s.bases.length > LISTED ? { meta: `The first ${LISTED} of ${basesValue(s)}` } : {}),
    link: { kind: 'url', label: 'Open Airtable', url: AIRTABLE_APP },
    items: s.bases.slice(0, LISTED).map(
      (b): ThingPageItem => ({
        id: b.id,
        title: b.name,
        icon: 'database',
        ...(b.tables !== null ? { detail: plural(b.tables, 'table') } : {}),
        ...(b.permission && PERMISSION_WORDS[b.permission] ? { right: PERMISSION_WORDS[b.permission] } : {}),
        url: `${AIRTABLE_APP}${b.id}`,
      }),
    ),
    empty:
      via === 'api'
        ? 'The token may read no bases yet. Add bases to it in Airtable’s Builder Hub.'
        : 'No bases yet.',
  });
}

function figures(s: AirtableSnapshot): ThingPageKpi[] {
  const t = tableTotal(s);
  return [
    { key: 'bases', label: 'Bases', value: basesValue(s) },
    ...(t.counted ? [{ key: 'tables', label: 'Tables', value: t.value }] : []),
  ];
}

/** The page's Airtable part, from what was read; pure. No machine card: it runs at Airtable. */
export function airtableView(input: AirtableInput): KindView {
  const { snapshot: s } = input;
  const t = tableTotal(s);
  const facts: ThingLine[] = [
    line(
      t.counted
        ? `**${basesValue(s)}** ${s.bases.length === 1 && !s.more ? 'base' : 'bases'} · **${t.value}** tables`
        : `**${basesValue(s)}** ${s.bases.length === 1 && !s.more ? 'base' : 'bases'}`,
    ),
  ];
  return {
    kpis: [],
    charts: [],
    machine: 'after',
    notices: [],
    ...slotPanels({ live: basesList(input), inventory: counts(input) }),
    tabs: [],
    facts,
    status: { status: 'ok', badge: s.bases.length ? plural(s.bases.length, 'base') : 'No bases yet' },
    open: { label: 'Open Airtable', url: AIRTABLE_APP },
    actions: [],
    readAt: s.readAt,
    suggestions: ['What’s in each base', 'Find a record', 'Add a record'],
  };
}

/* The page ------------------------------------------------------------------------------------------------------------ */

const viaOf = (row: Pick<CatalogConnectionRow, 'signIn'>) => (row.signIn === 'mcp_oauth' ? 'mcp' : 'api');

export async function airtablePage(ctx: KindCtx): Promise<KindView> {
  const read = await airtableLatest(ctx.services, ctx.row, ctx.now);
  return viewOrProblem(read, NAME, { label: 'Open Airtable', url: AIRTABLE_APP }, (snapshot) =>
    airtableView({ snapshot, via: viaOf(ctx.row) }),
  );
}

/** The health pass: what the last read found, never a call to Airtable; nothing read yet keeps the card as it was. */
export function airtableSeen(services: Services, row: CatalogConnectionRow): KindSeen {
  const s = airtableKept(services, row);
  if (!s)
    return {
      glance: { facts: list((row.glance as ConnectionGlance | null)?.facts) as ConnectionGlance['facts'] },
      points: {},
      notices: [],
    };
  return seenOfView({ ...airtableView({ snapshot: s, via: viaOf(row) }), kpis: figures(s) }, [
    'bases',
    'tables',
  ]);
}

export const AIRTABLE_KIND: KindModule = {
  page: airtablePage,
  checks: [],
  seen: async (services, row) => airtableSeen(services, row),
};
