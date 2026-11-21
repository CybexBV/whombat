/**
 * Search completeness and paging (docs/decisions/search-pagination.md): every match the viewer may open is reachable
 * however many they may not open rank above it; pages walk a stable keyset (rank, time, id) without duplicates or
 * omissions; the cursor is bound to its search; permissions are checked again on every page; a page that ran out of
 * work still says where to go on; the chip counts are exact and count only what the viewer may open.
 */
import {
  api,
  buildPath,
  type LinkRef,
  newId,
  type SearchFilter,
  type SearchResponse,
  type SearchResultType,
  searchFilterOf,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadBurrowRow } from '../commit/pipeline';
import { loadConfig } from '../config';
import { createDb, type Db } from '../db/client';
import * as schema from '../db/schema/index';
import { approvals, grants, searchAnswers, searchDocuments } from '../db/schema/index';
import { indexApproval } from '../domain/search-index';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { makeRoom } from '../test/rooms';
import { sessionFor } from '../test/tokens';
import { burrowConversationIds } from './conversations';
import { loadPrincipalRow } from './principals';
import { search, searchResults, visibleConversations } from './search';
import { toApproval } from './work';
import * as workViews from './work-views';
import { approvalVisible } from './work-views';

const t = useTestServer({ seed: true, app: true });
let cookie = '';
/** Mara's room. */
let open = '';

const LINK: LinkRef = { type: 'pr', number: 482 };
const day = (d: number, minute = 0) => new Date(Date.UTC(2026, 7, d, 9, minute));

function doc(
  id: string,
  conversationId: string | null,
  text: string,
  createdAt: Date,
  type: SearchResultType = 'MESSAGE',
) {
  return {
    id,
    burrowId: t.burrowId,
    type,
    conversationId,
    where: '#pages',
    authorId: IDS.mara,
    text,
    link: LINK,
    createdAt,
    status: null,
  };
}

async function insert(rows: ReturnType<typeof doc>[]) {
  for (let i = 0; i < rows.length; i += 400)
    await t.services.db.insert(searchDocuments).values(rows.slice(i, i + 400));
}

const words = (word: string, n: number) => Array.from({ length: n }, () => word).join(' ');

async function room(name: string) {
  return makeRoom(t.services, t.burrowId, name);
}

async function as(id: string) {
  const row = await loadPrincipalRow(t.services.db, id);
  if (!row) throw new Error(id);
  return row;
}

type Input = Parameters<typeof search>[3];

async function page(who: string, input: Partial<Input> & { q: string }, db: Db = t.services.db) {
  const burrow = await loadBurrowRow(t.services.db, t.burrowId);
  if (!burrow) throw new Error('burrow');
  return search(db, await as(who), burrow, { type: 'all', limit: 30, ...input }, t.services.clock());
}

/** Every page of a search, in order, following `next` (bounded so a broken cursor can't loop forever). */
async function walk(who: string, input: Partial<Input> & { q: string }, db: Db = t.services.db) {
  const pages: SearchResponse[] = [];
  let cursor: string | undefined = input.cursor;
  for (let i = 0; i < 500; i++) {
    const res = await page(who, { ...input, ...(cursor ? { cursor } : {}) }, db);
    pages.push(res);
    if (!res.next) break;
    cursor = res.next;
  }
  return { pages, ids: pages.flatMap((p) => p.results.map((r) => r.id)) };
}

async function get(query: Record<string, string | number>) {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  return t.api.inject({
    method: 'GET',
    url: `${api.search.query.base}${buildPath(api.search.query.path, { burrow: 'burrow-hq' })}?${qs}`,
    headers: { cookie },
  });
}

/** A cursor's contents (it is base64url JSON; tests may look inside and craft one). */
const decode = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/** An approval (a copy of the seeded one) and its DECISION document: `title` is what a search finds. */
async function decision(
  title: string,
  fields: Partial<typeof approvals.$inferInsert> & { conversationId: string; requesterId: string },
) {
  const [seed] = await t.services.db.select().from(approvals).where(eq(approvals.id, 'apr_staging-482'));
  if (!seed) throw new Error('seed');
  const id = newId('approval');
  const [next] = await t.services.sql<
    { n: number }[]
  >`select coalesce(max(number), 0)::int + 1 as n from approvals`;
  await t.services.db.insert(approvals).values({
    ...seed,
    conditions: [],
    ...fields,
    id,
    number: next?.n ?? 1,
    title,
    question: 'Go ahead?',
    messageId: null,
    eventId: null,
    actionHash: null,
  });
  await indexApproval(t.services.db, id);
  return id;
}

/** What Postgres itself says the order is, over the documents Mara may open (independent of `search`). */
async function expectedOrder(word: string, conversationIds: readonly string[]) {
  const rows = await t.services.sql<{ id: string }[]>`
    select id from search_documents
    where burrow_id = ${t.burrowId}
      and tsv @@ to_tsquery('english', ${word})
      and (conversation_id is null or conversation_id = any(${conversationIds as string[]}))
    order by ts_rank(tsv, to_tsquery('english', ${word})) desc, created_at desc, id collate "C" desc`;
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  open = await room('pages-open');
});

describe('search reaches every match the viewer may open', () => {
  it('counts and pages every type exactly', async () => {
    const W = 'quolltypes';
    const types: SearchResultType[] = ['THREAD', 'MESSAGE', 'PATCH', 'RUN', 'CANVAS', 'PLAN', 'AUTOMATION'];
    const rows: ReturnType<typeof doc>[] = [];
    for (const [i, type] of types.entries())
      for (let k = 0; k < 3; k++) {
        // Burrow-wide kinds without a room, the rest in Mara's room.
        const room = ['PATCH', 'RUN', 'CANVAS'].includes(type) && k < 2 ? null : open;
        rows.push(doc(`doc_types-${type}-${k}`, room, words(W, 1 + k), day(14, i * 3 + k), type));
      }
    await insert(rows);

    const first = await page(IDS.mara, { q: W, limit: 5 });
    expect(first.counts).toEqual({
      all: 21,
      threads: 6,
      patches: 3,
      runs: 3,
      canvases: 3,
      plans: 3,
      decisions: 0,
      automations: 3,
    });
    const mine = (filter: SearchFilter) =>
      rows
        .filter((r) => filter === 'all' || searchFilterOf(r.type) === filter)
        .map((r) => r.id)
        .sort();
    for (const filter of ['all', 'threads', 'patches', 'runs', 'canvases', 'plans', 'automations'] as const) {
      const got = await walk(IDS.mara, { q: W, type: filter, limit: 2 });
      expect([filter, [...got.ids].sort()]).toEqual([filter, mine(filter)]);
      expect(new Set(got.ids).size).toBe(got.ids.length);
    }
  });
});

describe('paging', () => {
  const W = 'quollwalk';
  let expected: string[] = [];

  beforeAll(async () => {
    const rows: ReturnType<typeof doc>[] = [];
    // Mara's room: groups of six with the same words and the same time (equal sort values), three ranks.
    for (let g = 0; g < 10; g++)
      for (let k = 0; k < 6; k++)
        rows.push(doc(`msg_walk-open-${g}-${k}`, open, words(W, 1 + (g % 3)), day(5, g)));
    // Burrow-wide patches, some sorting exactly like documents of Mara's room.
    for (let k = 0; k < 15; k++)
      rows.push(doc(`pr_walk-${k}`, null, words(W, 1 + (k % 3)), day(5, k % 10), 'PATCH'));
    await insert(rows);
    expected = await expectedOrder(W, await burrowConversationIds(t.services.db, t.burrowId));
    expect(expected).toHaveLength(75);
  });

  it('walks every page in order, without duplicates or omissions', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const res = await get({ q: W, limit: 7, ...(cursor ? { cursor } : {}) });
      expect(res.statusCode).toBe(200);
      const body = res.json() as SearchResponse;
      expect(body.results.length).toBeLessThanOrEqual(7);
      expect(body.counts.all).toBe(75);
      seen.push(...body.results.map((r) => r.id));
      if (!body.next) break;
      cursor = body.next;
    }
    expect(seen).toEqual(expected);
  });

  it('pages the type filter too', async () => {
    const patches = await walk(IDS.mara, { q: W, type: 'patches', limit: 4 });
    expect(patches.ids).toEqual(expected.filter((id) => id.startsWith('pr_')));
    const threads = await walk(IDS.mara, { q: W, type: 'threads', limit: 11 });
    expect(threads.ids).toEqual(expected.filter((id) => id.startsWith('msg_')));
    expect(threads.pages[0]?.counts).toMatchObject({ all: 75, threads: 60, patches: 15 });
  });

  it('pages a search without words (a filter only), newest first', async () => {
    const all = await walk(IDS.mara, { q: '', in: open, limit: 8 });
    const rows = await t.services.sql<{ id: string }[]>`
      select id from search_documents where conversation_id = ${open}
      order by created_at desc, id collate "C" desc`;
    expect(all.ids).toEqual(rows.map((r) => r.id));
  });

  it('stops at its work budget with a cursor that goes on from there', async () => {
    const res = await walk(IDS.mara, { q: W, limit: 10, scanBudget: 3 });
    expect(res.pages.length).toBeGreaterThan(20);
    for (const p of res.pages) expect(p.results.length).toBeLessThanOrEqual(3);
    // A page cut short by the budget still has a next page.
    expect(res.pages[0]?.results.length).toBeLessThan(10);
    expect(res.pages[0]?.next).toBeTruthy();
    expect(res.ids).toEqual(expected);
    // Readers inside Whombat (the agent `search` tool, answer mode) follow such pages to a full list.
    const burrow = await loadBurrowRow(t.services.db, t.burrowId);
    const list = await searchResults(
      t.services.db,
      await as(IDS.mara),
      burrow as NonNullable<typeof burrow>,
      { q: W, type: 'all', limit: 10, scanBudget: 3 },
      t.services.clock(),
    );
    expect(list.map((r) => r.id)).toEqual(expected.slice(0, 10));
  });

  it('refuses a cursor that is malformed, from before, or from another search', async () => {
    const first = await get({ q: W, limit: 3 });
    const next = (first.json() as SearchResponse).next as string;
    expect(next).toBeTruthy();
    expect(next.length).toBeLessThanOrEqual(512);
    expect((await get({ q: W, limit: 3, cursor: next })).statusCode).toBe(200);
    // Another limit is the same search.
    expect((await get({ q: W, limit: 9, cursor: next })).statusCode).toBe(200);
    const refused = [
      await get({ q: W, cursor: 'zzz' }),
      await get({ q: W, cursor: Buffer.from('o:3').toString('base64url') }),
      await get({ q: W, cursor: Buffer.from('{"v":2}').toString('base64url') }),
      await get({ q: `${W} more`, cursor: next }),
      await get({ q: W, type: 'patches', cursor: next }),
      await get({ q: W, from: 'dusty', cursor: next }),
      await get({ q: W, after: '2026-08-01', cursor: next }),
    ];
    for (const res of refused) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_failed');
    }
  });
});

describe('cited results first', () => {
  it('puts an answer’s receipts first, then the rest by rank, and keeps to that answer for the whole walk', async () => {
    const W = 'quollcited';
    const rows = Array.from({ length: 20 }, (_, i) =>
      doc(`msg_cited-${String(i).padStart(2, '0')}`, open, words(W, 1 + (i % 4)), day(12, i)),
    );
    await insert(rows);
    const answer = (n: number, citations: { n: number; resultId: string }[]) => ({
      id: newId('answer'),
      burrowId: t.burrowId,
      query: W,
      agentId: IDS.dusty,
      askedById: IDS.mara,
      status: 'ready' as const,
      text: 'See [1].',
      citations,
      actions: [],
      durationMs: 1000,
      createdAt: day(13, n),
    });
    await t.services.db.insert(searchAnswers).values(
      answer(0, [
        { n: 1, resultId: 'msg_cited-12' },
        { n: 3, resultId: 'msg_cited-01' },
      ]),
    );
    const first = await page(IDS.mara, { q: W, limit: 4 });
    expect(first.results.slice(0, 2).map((r) => [r.id, r.citedAs])).toEqual([
      ['msg_cited-12', 1],
      ['msg_cited-01', 3],
    ]);
    // A newer answer arrives mid-walk: the walk keeps to the answer it started with.
    await t.services.db.insert(searchAnswers).values(answer(1, [{ n: 1, resultId: 'msg_cited-07' }]));
    const rest = await walk(IDS.mara, { q: W, limit: 4, cursor: first.next as string });
    expect(rest.pages[0]?.answer?.citations).toEqual([{ n: 1, resultId: 'msg_cited-07' }]);
    const ids = [...first.results.map((r) => r.id), ...rest.ids];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(rows.filter((r) => r.conversationId === open).map((r) => r.id));
    // A cited result that doesn't pass the type filter stays out.
    expect((await page(IDS.mara, { q: W, type: 'patches' })).results).toEqual([]);
  });
});

describe('decisions keep to their approval’s rule', () => {
  it('finds and counts exactly what the approval rules allow', async () => {
    const W = 'quolldecision';
    const [seed] = await t.services.db.select().from(approvals).where(eq(approvals.id, 'apr_staging-482'));
    if (!seed) throw new Error('seed');
    const person = (approverIds: string[], isPrivate?: boolean) => ({
      id: 'person',
      kind: 'person_approves' as const,
      label: 'A person says yes',
      met: false,
      approverIds,
      ...(isPrivate === undefined ? {} : { private: isPrivate }),
    });
    const variants = [
      { conversationId: IDS.general, requesterId: IDS.dusty, conditions: [] },
      { conversationId: IDS.general, requesterId: IDS.dusty, conditions: [person([IDS.mara])] },
      { conversationId: IDS.general, requesterId: IDS.dusty, conditions: [person([IDS.mara], true)] },
      { conversationId: IDS.billing, requesterId: IDS.dusty, conditions: [person([IDS.mara])] },
      { conversationId: IDS.billing, requesterId: IDS.dusty, conditions: [] },
    ];
    const ids: string[] = [];
    for (const [i, v] of variants.entries()) {
      const id = newId('approval');
      await t.services.db.insert(approvals).values({
        ...seed,
        ...v,
        id,
        number: 800 + i,
        title: `Deploy the ${W} change ${i}`,
        question: `Deploy the ${W} change?`,
        messageId: null,
        eventId: null,
        actionHash: null,
      });
      await indexApproval(t.services.db, id);
      ids.push(id);
    }
    await t.services.db
      .insert(grants)
      .values({ agentId: IDS.dusty, burrowId: t.burrowId, keyId: 'messages.search', tier: 'can' })
      .onConflictDoUpdate({ target: [grants.agentId, grants.keyId], set: { tier: 'can' } });

    const rows = await t.services.db.select().from(approvals);
    const byId = new Map(rows.filter((r) => ids.includes(r.id)).map((r) => [r.id, toApproval(r)]));
    const viewers = [IDS.mara, IDS.dusty];
    let checked = 0;
    for (const who of viewers) {
      const viewer = await as(who);
      // What the rules say, with the rules' own code: the conversation gate and `approvalVisible`.
      const gate = await visibleConversations(t.services.db, viewer);
      const expected: string[] = [];
      for (const id of ids) {
        const a = byId.get(id);
        if (!a || !gate.has(a.conversationId)) continue;
        if (!(await approvalVisible(t.services.db, viewer, a))) continue;
        expected.push(id);
      }
      const got = await walk(who, { q: W, type: 'decisions' as SearchFilter, limit: 2 });
      expect([who, got.ids.sort()]).toEqual([who, expected.sort()]);
      expect([who, got.pages[0]?.counts.decisions]).toEqual([who, expected.length]);
      expect(got.pages[0]?.counts.all).toBe(expected.length);
      checked += expected.length;
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });
});

describe('crafted cursors', () => {
  const W = 'quollcraft';

  beforeAll(async () => {
    await insert(
      Array.from({ length: 12 }, (_, i) => doc(`msg_craft-${i}`, open, words(W, 1 + (i % 3)), day(4, i))),
    );
  });

  it('answers a crafted cursor with 400 or a page, never a 500', async () => {
    const first = await get({ q: W, limit: 3 });
    const c = decode((first.json() as SearchResponse).next as string);
    const at = (time: string) => ({ ...c, p: ['r', c.p[1], time, c.p[3]] });
    const id = (value: string) => ({ ...c, p: ['r', c.p[1], c.p[2], value] });
    const rank = (value: number | null) => ({ ...c, p: ['r', value, c.p[2], c.p[3]] });
    const cases: [string, string, 200 | 400][] = [
      // Postgres has no year 0 (JavaScript's Date does), nor 30 February.
      ['year 0', encode(at('0000-01-01T00:00:00.000000Z')), 400],
      ['30 February', encode(at('2026-02-30T00:00:00.000000Z')), 400],
      ['year 1', encode(at('0001-01-01T00:00:00.000000Z')), 200],
      ['year 9999', encode(at('9999-12-31T23:59:59.999999Z')), 200],
      // Postgres takes no NUL in text; ids are `<prefix>_<body>`.
      ['NUL in the id', encode(id('msg_\u0000x')), 400],
      ['a quote in the id', encode(id("msg_x'--")), 400],
      ['an id too long', encode(id(`msg_${'x'.repeat(80)}`)), 400],
      ['NUL in the answer', encode({ ...c, a: 'ans_\u0000x' }), 400],
      ['not an answer id', encode({ ...c, a: 'msg_x' }), 400],
      ['an answer that isn’t there', encode({ ...c, a: 'ans_nope' }), 400],
      ['a huge rank', encode(rank(1e308)), 200],
      ['a negative rank', encode(rank(-1)), 200],
      ['no rank on a search with words', encode(rank(null)), 400],
      [
        'an infinite rank',
        Buffer.from(JSON.stringify(rank(0)).replace('"r",0,', '"r",1e400,')).toString('base64url'),
        400,
      ],
      ['a receipt position', encode({ ...c, p: ['c', 5] }), 200],
    ];
    for (const [name, cursor, status] of cases) {
      const res = await get({ q: W, limit: 3, cursor });
      expect([name, res.statusCode]).toEqual([name, status]);
      if (status === 400) expect([name, res.json().error.fields]).toHaveProperty('1.cursor');
    }
  });

  it('turns a data error from a query carrying the cursor into the cursor’s 400', async () => {
    // Defence in depth: whatever the schema let through, a value Postgres can't read is not this search's cursor.
    const D = 'quollcraftdecision';
    for (let i = 0; i < 3; i++)
      await decision(`${D} ${i}`, { conversationId: IDS.general, requesterId: IDS.dusty });
    const first = await get({ q: D, limit: 1 });
    const cursor = (first.json() as SearchResponse).next as string;
    expect(cursor).toBeTruthy();
    const refused = Object.assign(new Error('date/time field value out of range'), { code: '22008' });
    const spy = vi.spyOn(workViews, 'approvalVisible').mockRejectedValue(refused);
    try {
      const res = await get({ q: D, limit: 1, cursor });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.fields).toHaveProperty('cursor');
      // Without a cursor it is what it is: a server error.
      await expect(page(IDS.mara, { q: D, limit: 1 })).rejects.toBe(refused);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the rank in a cursor', () => {
  it('walks the same when the database prints floats with fewer digits (extra_float_digits = 0)', async () => {
    const W = 'quollfloat';
    const rows: ReturnType<typeof doc>[] = [];
    // Five of each: the same words and the same time (equal sort values), at three ranks.
    for (let g = 0; g < 6; g++)
      for (let k = 0; k < 5; k++)
        rows.push(doc(`msg_float-${g}-${k}`, open, words(W, 1 + (g % 3)), day(6, g)));
    await insert(rows);
    const expected = await expectedOrder(W, [open]);
    expect(expected).toHaveLength(30);

    const [current] = await t.services.sql<{ name: string }[]>`select current_database() as name`;
    const name = current?.name as string;
    await t.services.sql.unsafe(`alter database "${name}" set extra_float_digits = 0`);
    const url = new URL(loadConfig().DATABASE_URL);
    url.pathname = `/${name}`;
    const plain = postgres(url.toString(), { max: 1, onnotice: () => {} });
    const pool = createDb(url.toString(), { max: 2 });
    try {
      // A new connection of anyone else prints floats rounded to 15 digits now…
      const [setting] = await plain<{ v: string }[]>`select current_setting('extra_float_digits') as v`;
      expect(setting?.v).toBe('0');
      // …and Whombat's pool walks every row once, ties included.
      const got = await walk(IDS.mara, { q: W, limit: 4 }, pool.db);
      expect(got.ids).toEqual(expected);
    } finally {
      await plain.end({ timeout: 5 });
      await pool.sql.end({ timeout: 5 });
      await t.services.sql.unsafe(`alter database "${name}" reset extra_float_digits`);
    }
  });
});

describe('when the query and the code check disagree', () => {
  it('never returns a refused row, logs it by id only, and the walk still ends', async () => {
    const W = 'quolldrift';
    // Three decisions ranked above five messages, all Mara's to see — but the code check is made to refuse the
    // decisions (a drift between the two rule sets, SRP-02).
    const refused = new Set<string>();
    for (let i = 0; i < 3; i++)
      refused.add(await decision(words(W, 8), { conversationId: IDS.general, requesterId: IDS.dusty }));
    const messages = Array.from({ length: 5 }, (_, i) => doc(`msg_drift-${i}`, open, W, day(7, i)));
    await insert(messages);
    const real = workViews.approvalVisible;
    const spy = vi
      .spyOn(workViews, 'approvalVisible')
      .mockImplementation(async (db, viewer, a) => (refused.has(a.id) ? false : real(db, viewer, a)));
    const log = { error: vi.fn() };
    const mine = messages.map((m) => m.id).sort();
    try {
      // The first batch (limit + 1 rows) is all refused decisions: the page reads on in a second batch.
      const got = await walk(IDS.mara, { q: W, limit: 2, log });
      expect([...got.ids].sort()).toEqual(mine);
      expect(new Set(got.ids).size).toBe(got.ids.length);
      expect(got.pages.at(-1)?.next).toBeNull();
      // What a drift exposes: the query counts what it allowed…
      expect(got.pages[0]?.counts).toMatchObject({ all: 8, decisions: 3, threads: 5 });
      // …and it is logged, by id and type, never with the documents' words.
      const logged = log.error.mock.calls.flatMap(
        ([obj]) => (obj as { documents: { id: string; type: string }[] }).documents,
      );
      expect(new Set(logged.map((d) => d.id))).toEqual(refused);
      expect(logged.every((d) => d.type === 'DECISION')).toBe(true);
      expect(JSON.stringify(log.error.mock.calls)).not.toContain(W);

      // The work budget spent on refused rows: an empty page that still goes on — with the refused row's key in its
      // cursor (SRP-02) — and the walk from there reaches the rest.
      const short = await page(IDS.mara, { q: W, limit: 2, scanBudget: 2, log });
      expect(short.results).toEqual([]);
      expect(short.next).toBeTruthy();
      expect(refused.has(decode(short.next as string).p[3])).toBe(true);
      const rest = await walk(IDS.mara, { q: W, limit: 2, scanBudget: 2, log, cursor: short.next as string });
      expect([...rest.ids].sort()).toEqual(mine);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('receipts across pages', () => {
  const W = 'quollreceipt';
  let other = '';

  beforeAll(async () => {
    other = await room('receipt-other');
    await insert(
      Array.from({ length: 10 }, (_, i) =>
        doc(`msg_receipt-${i}`, i === 3 ? other : open, words(W, 1 + (i % 2)), day(8, i)),
      ),
    );
    await t.services.db.insert(searchAnswers).values({
      id: newId('answer'),
      burrowId: t.burrowId,
      query: W,
      agentId: IDS.dusty,
      askedById: IDS.mara,
      status: 'ready',
      text: 'See [1], [2], [4] and [7].',
      citations: [
        { n: 1, resultId: 'msg_receipt-8' },
        { n: 2, resultId: 'msg_receipt-3' },
        { n: 4, resultId: 'msg_receipt-0' },
        { n: 7, resultId: 'msg_receipt-5' },
      ],
      actions: [],
      durationMs: 1000,
      createdAt: day(9),
    });
  });

  it('walks every result once at every page size, receipts first in order, across pages', async () => {
    for (const limit of [1, 2, 3, 4, 5, 10, 11]) {
      const got = await walk(IDS.mara, { q: W, limit });
      expect([limit, got.ids.length, new Set(got.ids).size]).toEqual([limit, 10, 10]);
      expect([limit, got.ids.slice(0, 4)]).toEqual([
        limit,
        ['msg_receipt-8', 'msg_receipt-3', 'msg_receipt-0', 'msg_receipt-5'],
      ]);
      // Receipts that fill whole pages leave off inside them (`['c', n]`).
      const phases = got.pages.map((p) => (p.next ? decode(p.next).p[0] : '-')).join('');
      if (limit <= 4) expect([limit, phases.startsWith('c')]).toEqual([limit, true]);
    }
  });

  it('binds the time zone to a cursor only when a day filter is set', async () => {
    const dated = await page(IDS.mara, { q: W, limit: 2, after: '2026-08-01' });
    expect(dated.next).toBeTruthy();
    await expect(
      page(IDS.mara, {
        q: W,
        limit: 2,
        after: '2026-08-01',
        timeZone: 'Asia/Tokyo',
        cursor: dated.next as string,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const plain = await page(IDS.mara, { q: W, limit: 2 });
    const later = await page(IDS.mara, {
      q: W,
      limit: 2,
      timeZone: 'Asia/Tokyo',
      cursor: plain.next as string,
    });
    const same = await page(IDS.mara, { q: W, limit: 2, cursor: plain.next as string });
    expect(later.results.map((r) => r.id)).toEqual(same.results.map((r) => r.id));
    expect(later.results).toHaveLength(2);
  });
});

describe('a search in one conversation', () => {
  it('reads that conversation by its index, not the whole table (SRP-10)', async () => {
    // 30 000 documents in 300 other rooms, so the planner has a table to avoid reading.
    await t.services.sql.unsafe(`
      insert into search_documents (id, burrow_id, type, conversation_id, "where", author_id, text, link, created_at)
      select 'msg_room-' || g, '${t.burrowId}', 'MESSAGE', 'cnv_room-' || (g % 300), '#x', '${IDS.mara}',
        'words ' || g, '{"type":"channel","channel":"general"}'::jsonb, timestamptz '2026-01-01' + (g || ' minutes')::interval
      from generate_series(1, 30000) g`);
    await insert(
      Array.from({ length: 10 }, (_, i) => doc(`msg_room-open-${i}`, open, 'in the room', day(20, i))),
    );
    await t.services.sql.unsafe('analyze search_documents');
    const queries: { query: string; params: unknown[] }[] = [];
    const logged = drizzle(t.services.sql, {
      schema,
      logger: { logQuery: (query, params) => queries.push({ query, params }) },
    });
    for (const filters of [{ in: open }, { in: open, after: '2026-08-01', before: '2026-08-31' }]) {
      queries.length = 0;
      const res = await page(IDS.mara, { q: '', limit: 5, ...filters }, logged as unknown as Db);
      expect(res.results.length).toBeGreaterThan(0);
      const read = queries.filter((c) => c.query.includes('lateral'));
      expect(read.length).toBeGreaterThanOrEqual(2);
      for (const c of read) {
        const plan = await t.services.sql.unsafe(`explain ${c.query}`, c.params as never[]);
        const text = plan.map((p) => String((p as Record<string, unknown>)['QUERY PLAN'])).join('\n');
        expect([filters, text]).toEqual([
          filters,
          expect.stringContaining('search_documents_conversation_idx'),
        ]);
      }
    }
  });
});
