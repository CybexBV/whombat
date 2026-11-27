/**
 * Full-text search over `search_documents` (Postgres FTS). What the viewer may open is part of the query
 * (docs/decisions/search-pagination.md SRP-01, SRP-02): a document gated by a conversation is visible when the
 * conversation is the viewer's burrow's (every one is the person's; the agent misses branch rooms of switched-off
 * repositories); a DECISION also keeps to its approval's own rule. Each row a page returns is checked again with the same rules in code
 * (REFERENCE_NOTES §9). The agent's searches find the person's rooms too: everything is the person's (one-person.md
 * OP-S71). Pages walk a keyset — rank, time, id — with a cursor bound to the search (SRP-03…SRP-06); the chip counts are
 * exact over what the viewer may open (SRP-07).
 */
import { createHash } from 'node:crypto';
import {
  AnswerId,
  type Approval,
  daysAgo,
  formatClock,
  formatDate,
  resolveLanguage,
  type SearchAnswer,
  type SearchCounts,
  type SearchFilter,
  type SearchResponse,
  type SearchResult,
  SearchResultType,
  type SupportedLanguage,
  searchFilterOf,
  zonedInstant,
} from '@whombat/core';
import {
  type AnyColumn,
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  notExists,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import type { BurrowRow } from '../commit/types';
import type { Db } from '../db/client';
import { approvals, messages, principals, searchAnswers, searchDocuments } from '../db/schema/index';
import { UNSEARCHABLE_PROVENANCE } from '../domain/search-index';
import { hiddenConversationIds } from '../github/visibility';
import { tServer } from '../i18n/catalog';
import { ApiError } from '../lib/errors';
import { iso } from '../lib/time';
import type { Logger } from '../services';
import { burrowConversationIds, inBurrow } from './conversations';
import type { PrincipalRow } from './principals';
import { toApproval } from './work';
import { approvalVisible } from './work-views';

/**
 * The search's tsquery (resourceful-agents.md RA-26): English stems and the words as written, the two halves of
 * `search_documents.tsv`. Natural questions match any term (ranked by how many): the English terms, and the words as
 * written except the active language's stopwords (English always, plus Dutch on Dutch burrows so “de/het/een/van”
 * don't match every document without stripping English words like “want/die/was” on English burrows); quotes / `-term` /
 * `or` keep web-search syntax in each half, either half matching. Null when nothing is left to search for.
 */
async function tsQuery(db: Db, q: string, lang: SupportedLanguage = 'en'): Promise<string | null> {
  if (lang === 'nl') {
    // Dutch stopwords go before the English stemmer sees the words: stemmed, “andere” is no longer the stopword.
    const [dutch] = await db.execute<{ stop: string[] | null }>(
      sql`select array_agg(distinct lower(d.token)) as stop from ts_debug('dutch', ${q}) d where d.lexemes = '{}'`,
    );
    const dutchStop = dutch?.stop ?? [];
    const english = withoutStopwords(q, dutchStop);
    const [row] = await db.execute<{ e: string; s: string; stop: string[] | null }>(
      sql`select websearch_to_tsquery('english', ${english})::text as e, websearch_to_tsquery('simple', ${q})::text as s,
        (select array_agg(distinct lower(d.token)) from ts_debug('english', ${q}) d where d.lexemes = '{}') as stop`,
    );
    return combinedTsQuery(q, row?.e ?? '', row?.s ?? '', [...(row?.stop ?? []), ...dutchStop]);
  }
  const [row] = await db.execute<{ e: string; s: string; stop: string[] | null }>(
    sql`select websearch_to_tsquery('english', ${q})::text as e, websearch_to_tsquery('simple', ${q})::text as s,
      (select array_agg(distinct lower(d.token)) from ts_debug('english', ${q}) d where d.lexemes = '{}') as stop`,
  );
  return combinedTsQuery(q, row?.e ?? '', row?.s ?? '', row?.stop ?? []);
}

/**
 * A query without its stopwords (pure, unit-tested): quoted phrases stay whole, `or` keeps its meaning, and an `or`
 * left with nothing on one side goes too. A word with a `-` before it stays even when it is a stopword: the person
 * asked to leave out what has it, and the two halves of the search are either-or, so dropping it from one half would
 * bring those results back through that half.
 */
export function withoutStopwords(q: string, stopwords: readonly string[]): string {
  const stop = new Set(stopwords.map((w) => w.toLowerCase()));
  const parts = q.match(/-?"[^"]*"?|\S+/g) ?? [];
  const kept = parts.filter((p) => {
    if (p.includes('"') || /^or$/i.test(p)) return true;
    if (/^-[\p{L}\p{N}]/u.test(p)) return true;
    // A minus on its own leaves nothing out.
    if (p === '-') return false;
    const word = p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
    return !word || !stop.has(word);
  });
  const out: string[] = [];
  for (const p of kept) {
    const isOr = /^or$/i.test(p);
    if (isOr && (!out.length || /^or$/i.test(out[out.length - 1] ?? ''))) continue;
    out.push(p);
  }
  while (out.length && /^or$/i.test(out[out.length - 1] ?? '')) out.pop();
  return out.join(' ');
}

/** `tsQuery` without the database (pure, unit-tested): the English and the words-as-written halves combined. */
export function combinedTsQuery(
  q: string,
  english: string,
  simple: string,
  stopwords: readonly string[],
): string | null {
  const advanced = /["]|(^|\s)-\S|\sor\s/i.test(q);
  const halves: string[] = [];
  if (advanced) {
    if (english.trim()) halves.push(english);
    if (simple.trim() && simple !== english) halves.push(simple);
  } else {
    const stop = new Set(stopwords);
    const keepTerms = (raw: string) =>
      [...new Set([...raw.matchAll(/'((?:[^']|'')+)'/g)].map((m) => m[1] ?? ''))]
        .filter((w) => w && !stop.has(w.replace(/''/g, "'")))
        .map((w) => `'${w}'`)
        .join(' | ');
    const stemmed = keepTerms(english);
    if (stemmed) halves.push(stemmed);
    const asWritten = keepTerms(simple);
    if (asWritten && asWritten !== halves[0]) halves.push(asWritten);
  }
  if (!halves.length) return null;
  return halves.length === 1 ? (halves[0] as string) : halves.map((h) => `( ${h} )`).join(' | ');
}

function whereOf(
  doc: Pick<typeof searchDocuments.$inferSelect, 'type' | 'createdAt' | 'where'>,
  now: Date,
  timeZone: string,
  lang: SupportedLanguage = 'en',
): string {
  if (doc.type !== 'THREAD' && doc.type !== 'MESSAGE') return doc.where;
  const days = daysAgo(doc.createdAt, now, timeZone);
  const time = formatClock(doc.createdAt, timeZone);
  const when =
    days === 0
      ? tServer(lang, 'search.todayAt', { time })
      : days === 1
        ? tServer(lang, 'search.yesterdayAt', { time })
        : formatDate(doc.createdAt, timeZone, { year: 'always' }, lang);
  return doc.where ? `${doc.where} · ${when}` : when;
}

/**
 * Conversation ids the viewer may see search hits from: every conversation of the burrow, all of them the person's
 * (`rooms`, when already read).
 */
export async function visibleConversations(
  db: Db,
  viewer: PrincipalRow,
  rooms?: ReadonlySet<string>,
): Promise<Set<string>> {
  const ids = new Set(rooms ?? (await burrowConversationIds(db, viewer.burrowId)));
  // Branch rooms (and their PR hits) of repos that are switched off do not exist for agents.
  if (viewer.kind === 'agent')
    for (const id of await hiddenConversationIds(db, viewer.burrowId)) ids.delete(id);
  return ids;
}

/** How long an answer is the answer to the same words asked again (`search.ask`, review-features.md RF-08). */
export const SEARCH_ANSWER_REUSE_MS = 24 * 3_600_000;

/**
 * The same words, case and spacing aside (review-features.md RF-08): how a search finds its answer on record and how
 * asking again finds one to reuse. “Rounding  VAT” and “rounding vat” are one question.
 */
export function sameSearchWords(column: AnyColumn, q: string): SQL {
  return sql`lower(regexp_replace(btrim(${column}), '[[:space:]]+', ' ', 'g')) = lower(regexp_replace(btrim(${q}), '[[:space:]]+', ' ', 'g'))`;
}

/**
 * Answers written in `lang`. An answer from before languages has none and is English. Reuse and the search page keep to
 * the reader's language, so a switch asks again in the new one; an answer stays readable by its id either way.
 */
export function inSearchLanguage(lang: SupportedLanguage): SQL {
  return lang === 'en'
    ? (or(eq(searchAnswers.language, 'en'), isNull(searchAnswers.language)) as SQL)
    : eq(searchAnswers.language, lang);
}

export function toSearchAnswer(row: typeof searchAnswers.$inferSelect): SearchAnswer {
  return {
    id: row.id,
    burrowId: row.burrowId,
    query: row.query,
    agentId: row.agentId,
    status: row.status,
    text: row.text,
    citations: row.citations,
    durationMs: row.durationMs,
    actions: row.actions,
    createdAt: iso(row.createdAt),
  };
}

/** Rows one request reads at most, in batches, before it answers with what it has and a cursor (SRP-05). */
export const SEARCH_SCAN_BUDGET = 1000;
/** Pages `searchResults` follows at most for a reader inside Whombat (SRP-09). */
const FOLLOW_PAGES = 5;

const ZERO_COUNTS: SearchCounts = {
  all: 0,
  threads: 0,
  patches: 0,
  runs: 0,
  canvases: 0,
  plans: 0,
  decisions: 0,
  automations: 0,
};

/** The first instant of a calendar day in a time zone (`after`), or of the day after it (`before`, exclusive). */
export function dayStart(date: string, timeZone: string, nextDay = false): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(year, month - 1, day + (nextDay ? 1 : 0)));
  return zonedInstant(
    { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() },
    '00:00',
    timeZone,
  );
}

/* Cursor (SRP-03, SRP-04) ------------------------------------------------------------------------ */

/** 1 was the offset cursor (`o:<n>`, EC-26). */
const CURSOR_VERSION = 2;

/**
 * A document's time as Postgres keeps it (microseconds, UTC), so a cursor names the exact row: a real calendar
 * instant in the years 0001…9999 (Postgres has no year 0; JavaScript's `Date` does).
 */
const KeyTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine((at) => {
    if (at.startsWith('0000')) return false;
    const ms = Date.parse(`${at.slice(0, 23)}Z`);
    return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 23) === at.slice(0, 23);
  });

/** A document id as the index writes them: `<prefix>_<body>` (core `idSchema`; the seed's readable bodies too). */
const KeyId = z.string().regex(/^[a-z]{1,8}_[A-Za-z0-9_-]{1,72}$/);

/**
 * Where the next page starts: after the cited result with receipt `n` (`['c', n]`, the answer's receipts come
 * first), or after a ranked row (`['r', rank, time, id]`; `rank` is null for a search without words).
 */
const Position = z.union([
  z.tuple([z.literal('c'), z.number().int().nonnegative()]),
  z.tuple([z.literal('r'), z.number().nullable(), KeyTime, KeyId]),
]);
type Position = z.infer<typeof Position>;
type RankedPosition = Extract<Position, { 0: 'r' }>;

const SearchCursor = z.strictObject({
  v: z.literal(CURSOR_VERSION),
  /** The search it belongs to (`scopeKey`). */
  s: z.string().length(22),
  /** The answer whose receipts this walk puts first (SRP-06), or null. */
  a: AnswerId.nullable(),
  p: Position,
});
type SearchCursor = z.infer<typeof SearchCursor>;

/** A cursor that isn't one of this search's (malformed, from an older server, another search): 400 (SRP-04). */
const notThisSearch = () =>
  new ApiError('validation_failed', 'The request query is not valid.', {
    fields: {
      cursor: ['This cursor belongs to another search, or is out of date. Search again without it.'],
    },
  });

/**
 * What a cursor is bound to: the viewer, the burrow, the words, the type chip, the filters and the zone the days are
 * in (when there are days). Not a secret: a cursor only says where to go on, every page is
 * authorized again.
 */
function scopeKey(parts: {
  burrowId: string;
  viewerId: string;
  q: string;
  type: SearchFilter;
  from?: string | undefined;
  in?: string | undefined;
  after?: string | undefined;
  before?: string | undefined;
  zone: string;
  lang?: SupportedLanguage | undefined;
  authorId?: string | undefined;
  types?: readonly SearchResultType[] | undefined;
}): string {
  const dated = !!(parts.after || parts.before);
  return createHash('sha256')
    .update(
      JSON.stringify([
        CURSOR_VERSION,
        parts.burrowId,
        parts.viewerId,
        parts.q,
        parts.type,
        parts.from ?? null,
        parts.in ?? null,
        parts.after ?? null,
        parts.before ?? null,
        dated ? parts.zone : null,
        // Older cursors (no `mine`, default English) keep their key.
        ...(parts.authorId || parts.types?.length
          ? [parts.authorId ?? null, [...(parts.types ?? [])].sort()]
          : []),
        ...(parts.lang && parts.lang !== 'en' ? [parts.lang] : []),
      ]),
    )
    .digest('base64url')
    .slice(0, 22);
}

/**
 * A Postgres data error (SQLSTATE class 22: a value out of range, bytes it won't take) from a query that carries the
 * cursor's values: whatever the schema let through, a cursor Postgres can't read is not this search's (400, not 500).
 */
function isDataError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^22[0-9A-Z]{3}$/.test(code)) return true;
  }
  return false;
}

function encodeCursor(scope: string, answerId: string | null, p: Position): string {
  const cursor: SearchCursor = { v: CURSOR_VERSION, s: scope, a: answerId, p };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, scope: string, ranked: boolean): SearchCursor {
  let value: unknown = null;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {}
  const parsed = SearchCursor.safeParse(value);
  if (!parsed.success || parsed.data.s !== scope) throw notThisSearch();
  const p = parsed.data.p;
  if (p[0] === 'r' && (p[1] !== null) !== ranked) throw notThisSearch();
  return parsed.data;
}

/* Authorization in SQL (SRP-01, SRP-02) ----------------------------------------------------------- */

/** An approval's person condition: the first `person_approves` (core `privateApprovers`, `canDecide`). */
const PERSON_CONDITION = 'strict $[*] ? (@.kind == "person_approves")';

/** The lateral join's name and its person-condition column: distinctive, so no table's column can shadow them. */
const DECISION = 'search_decision';
const PERSON = 'search_person_condition';

/**
 * A DECISION's approval, joined laterally (a join, not a subplan per row: the planner keeps its parallel scan), with
 * its person condition.
 */
function decisionApproval(db: Db) {
  return db
    .select({
      id: approvals.id,
      requesterId: approvals.requesterId,
      conversationId: approvals.conversationId,
      pc: sql`jsonb_path_query_first(${approvals.conditions}, ${PERSON_CONDITION}::jsonpath, '{}', true)`.as(
        PERSON,
      ),
    })
    .from(approvals)
    .where(and(eq(approvals.id, searchDocuments.id), eq(searchDocuments.type, 'DECISION')))
    .as(DECISION);
}
type DecisionApproval = ReturnType<typeof decisionApproval>;

/**
 * `approvalVisible` for the viewer, over a DECISION's approval, so pages and counts need no second pass. Every row a page returns is checked again with those functions;
 * `search-pagination.int.test.ts` holds both to the same answers.
 */
function decisionReadable(a: DecisionApproval, viewer: PrincipalRow, rooms: ReadonlySet<string>): SQL {
  // The person condition, qualified by the join's name (drizzle writes an aliased subquery field bare).
  const pc = sql`${sql.identifier(DECISION)}.${sql.identifier(PERSON)}`;
  // `person?.private`, truthy as JavaScript reads the JSON value, and `approverIds.includes(id)`.
  const isPrivate = sql`coalesce((${pc} -> 'private') not in ('false', 'null', '0', '""'), false)`;
  const approver = (id: SQL) => sql`coalesce((${pc} -> 'approverIds') @> jsonb_build_array(${id}), false)`;
  const me = sql`${viewer.id}::text`;
  const privateOk = sql`(not ${isPrivate} or ${a.requesterId} = ${me} or ${approver(me)})`;
  const decides = viewer.kind !== 'person' ? sql`false` : sql`(not ${isPrivate} or ${approver(me)})`;
  const inRoom = sql`${a.conversationId} = any(${sql.param([...rooms])}::text[])`;
  return sql`(${a.id} is not null and (${a.requesterId} = ${me} or (${privateOk} and (${decides} or ${inRoom}))))`;
}

interface Scope {
  /** Every document of this search the viewer may open, of every type (over `search_documents` ⟕ `decision`). */
  where: SQL;
  decision: DecisionApproval;
  /** `ts_rank` as float8 (a cursor carries it exactly); null for a search without words (newest first). */
  rank: SQL | null;
  /** Conversations hits may come from. */
  visible: ReadonlySet<string>;
}

async function searchScope(
  db: Db,
  viewer: PrincipalRow,
  burrow: BurrowRow,
  input: {
    from?: string;
    in?: string;
    after?: string;
    before?: string;
    authorId?: string;
    types?: readonly SearchResultType[];
  },
  tsq: string | null,
  zone: string,
): Promise<Scope> {
  const where: SQL[] = [
    eq(searchDocuments.burrowId, burrow.id),
    // Documents of messages indexed before they stopped being indexed: an assessor's output (FB-F3-03), what an
    // outsiders' run posted.
    notExists(
      db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.id, searchDocuments.id),
            or(inArray(messages.provenance, [...UNSEARCHABLE_PROVENANCE]), eq(messages.outsidersRun, true)),
          ),
        ),
    ),
  ];
  if (tsq) where.push(sql`${searchDocuments.tsv} @@ ${tsq}::tsquery`);
  if (input.from) {
    // Someone nobody in the burrow is called: nothing matches.
    const [author] = await db
      .select({ id: principals.id })
      .from(principals)
      .where(and(eq(principals.burrowId, burrow.id), eq(principals.handle, input.from)));
    where.push(eq(searchDocuments.authorId, author?.id ?? ''));
  }
  if (input.authorId) where.push(eq(searchDocuments.authorId, input.authorId));
  if (input.types?.length) where.push(inArray(searchDocuments.type, [...input.types]));
  if (input.in) where.push(eq(searchDocuments.conversationId, input.in));
  if (input.after) where.push(gte(searchDocuments.createdAt, dayStart(input.after, zone)));
  if (input.before) where.push(lt(searchDocuments.createdAt, dayStart(input.before, zone, true)));

  const rooms = new Set(await burrowConversationIds(db, burrow.id));
  const visible = await visibleConversations(db, viewer, rooms);
  // With `in` the gate is one question, answered here: whether that conversation is visible. Kept out of the query,
  // the planner estimates the room's size right (an index for a small room, a parallel scan to count a big one).
  if (input.in) {
    if (!visible.has(input.in)) where.push(sql`false`);
  } else {
    where.push(
      sql`(${searchDocuments.conversationId} is null or ${searchDocuments.conversationId} = any(${sql.param([...visible])}::text[]))`,
    );
  }
  // A DECISION also keeps to its approval's own rule (WS-22, WS-34).
  const decision = decisionApproval(db);
  where.push(sql`(${searchDocuments.type} <> 'DECISION' or ${decisionReadable(decision, viewer, rooms)})`);
  return {
    where: and(...where) as SQL,
    decision,
    rank: tsq ? sql`ts_rank(${searchDocuments.tsv}, ${tsq}::tsquery)::float8` : null,
    visible,
  };
}

/** The result types a chip shows (core's `searchFilterOf`). */
const typesOf = (filter: Exclude<SearchFilter, 'all'>) =>
  SearchResultType.options.filter((type) => searchFilterOf(type) === filter);

/** Exact chip counts over everything the viewer may open (SRP-07). */
async function countsOf(db: Db, scope: Scope): Promise<SearchCounts> {
  const rows = await db
    .select({ type: searchDocuments.type, n: sql<number>`count(*)::int` })
    .from(searchDocuments)
    .leftJoinLateral(scope.decision, sql`true`)
    .where(scope.where)
    .groupBy(searchDocuments.type);
  const counts = { ...ZERO_COUNTS };
  for (const r of rows) {
    counts.all += r.n;
    counts[searchFilterOf(r.type)] += r.n;
  }
  return counts;
}

/* Pages (SRP-03, SRP-05, SRP-06) ------------------------------------------------------------------- */

function columns(scope: Scope) {
  return {
    id: searchDocuments.id,
    type: searchDocuments.type,
    conversationId: searchDocuments.conversationId,
    where: searchDocuments.where,
    authorId: searchDocuments.authorId,
    snippet: sql<string>`left(${searchDocuments.text}, 1000)`,
    link: searchDocuments.link,
    createdAt: searchDocuments.createdAt,
    status: searchDocuments.status,
    rank: scope.rank ? sql<number | null>`${scope.rank}` : sql<number | null>`null::float8`,
    at: sql<string>`to_char(${searchDocuments.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  };
}
type Row = Pick<
  typeof searchDocuments.$inferSelect,
  'id' | 'type' | 'conversationId' | 'where' | 'authorId' | 'link' | 'createdAt' | 'status'
> & { snippet: string; rank: number | null; at: string };

/** Rank, then time, then id (a unique tie-breaker, bytewise), all descending. */
function orderOf(scope: Scope): SQL[] {
  const id = sql`${searchDocuments.id} collate "C" desc`;
  const time = sql`${searchDocuments.createdAt} desc`;
  return scope.rank ? [sql`${scope.rank} desc`, time, id] : [time, id];
}

function after(scope: Scope, p: RankedPosition): SQL {
  const [, rank, at, id] = p;
  return scope.rank
    ? sql`(${scope.rank}, ${searchDocuments.createdAt}, ${searchDocuments.id} collate "C") < (${rank}::float8, ${at}::timestamptz, ${id} collate "C")`
    : sql`(${searchDocuments.createdAt}, ${searchDocuments.id} collate "C") < (${at}::timestamptz, ${id} collate "C")`;
}

/** The same rules again, in code, for each row a page returns (REFERENCE_NOTES §9; WS-22, WS-34). */
async function readable(
  db: Db,
  viewer: PrincipalRow,
  scope: Scope,
  rows: readonly Row[],
): Promise<Set<string>> {
  const decisions = await approvalsOf(
    db,
    rows.filter((r) => r.type === 'DECISION').map((r) => r.id),
  );
  const ok = new Set<string>();
  for (const r of rows) {
    if (r.conversationId && !scope.visible.has(r.conversationId)) continue;
    if (r.type === 'DECISION') {
      const approval = decisions.get(r.id);
      if (!approval || !(await approvalVisible(db, viewer, approval))) continue;
    }
    ok.add(r.id);
  }
  return ok;
}

/**
 * One page: the answer's receipts first (in receipt order, before the ranked rows start), then ranked rows after the
 * cursor, read in batches until the page is full, nothing is left, or the work budget is spent. `next` is null only
 * when nothing is left; a page cut short by the budget may hold fewer than `limit` results, even none.
 */
async function pageOf(
  db: Db,
  viewer: PrincipalRow,
  scope: Scope,
  opts: {
    type: SearchFilter;
    limit: number;
    position: Position | null;
    cited: ReadonlyMap<string, number>;
    budget: number;
    log: Pick<Logger, 'error'>;
  },
): Promise<{ rows: Row[]; next: Position | null }> {
  const page = await readPage(db, viewer, scope, opts);
  if (page.refused.length)
    // The query and the code check disagree (SRP-02): ids and types only, never the documents' words.
    opts.log.error(
      { viewerId: viewer.id, documents: page.refused.map((r) => ({ id: r.id, type: r.type })) },
      'search: the query allowed documents the code check refused',
    );
  return { rows: page.rows, next: page.next };
}

async function readPage(
  db: Db,
  viewer: PrincipalRow,
  scope: Scope,
  opts: {
    type: SearchFilter;
    limit: number;
    position: Position | null;
    cited: ReadonlyMap<string, number>;
    budget: number;
  },
): Promise<{ rows: Row[]; next: Position | null; refused: Row[] }> {
  const cols = columns(scope);
  const refused: Row[] = [];
  const typed = opts.type === 'all' ? undefined : inArray(searchDocuments.type, typesOf(opts.type));
  const rows: Row[] = [];
  const ranked: RankedPosition | null = opts.position?.[0] === 'r' ? opts.position : null;
  let citedAfter = opts.position?.[0] === 'c' ? opts.position[1] : 0;
  const citedIds = [...opts.cited.keys()];

  if (!ranked && citedIds.length) {
    const found = await db
      .select(cols)
      .from(searchDocuments)
      .leftJoinLateral(scope.decision, sql`true`)
      .where(and(scope.where, typed, inArray(searchDocuments.id, citedIds)));
    const ok = await readable(db, viewer, scope, found);
    refused.push(...found.filter((r) => !ok.has(r.id)));
    const receipts = found
      .filter((r) => ok.has(r.id))
      .map((r) => ({ r, n: opts.cited.get(r.id) as number }))
      .filter((x) => x.n > citedAfter)
      .sort((a, b) => a.n - b.n);
    for (const { r, n } of receipts) {
      if (rows.length === opts.limit) return { rows, next: ['c', citedAfter], refused };
      rows.push(r);
      citedAfter = n;
    }
  }

  let budget = Math.max(1, opts.budget);
  let last: Row | null = null;
  let more = false;
  let exhausted = false;
  for (let batchNo = 0; !exhausted && !more && budget > 0; batchNo++) {
    const need = opts.limit - rows.length;
    // One row past the page says whether there is more; later batches (after refused rows) read further ahead.
    const size = Math.min(budget, batchNo === 0 ? need + 1 : Math.max(need + 1, 100));
    const from: RankedPosition | null = last ? ['r', last.rank, last.at, last.id] : ranked;
    const batch: Row[] = await db
      .select(cols)
      .from(searchDocuments)
      .leftJoinLateral(scope.decision, sql`true`)
      .where(
        and(
          scope.where,
          typed,
          citedIds.length ? sql`${searchDocuments.id} <> all(${sql.param(citedIds)}::text[])` : undefined,
          from ? after(scope, from) : undefined,
        ),
      )
      .orderBy(...orderOf(scope))
      .limit(size);
    budget -= batch.length;
    exhausted = batch.length < size;
    const ok = await readable(db, viewer, scope, batch);
    for (const r of batch) {
      if (rows.length === opts.limit) {
        more = true;
        break;
      }
      // A refused row still moves the position on (so a walk always ends): its key is in `next` (SRP-02).
      last = r;
      if (ok.has(r.id)) rows.push(r);
      else refused.push(r);
    }
    // Full exactly at the end of a full batch: there may be more.
    if (rows.length === opts.limit && !exhausted) more = true;
  }
  if (exhausted && !more) return { rows, next: null, refused };
  return { rows, next: last ? ['r', last.rank, last.at, last.id] : (ranked ?? ['c', citedAfter]), refused };
}

/** Receipts of the answer a walk started with; gone (or not the viewer's) means the cursor is stale. */
async function citationsOf(
  db: Db,
  answerId: string,
  viewer: PrincipalRow,
  burrow: BurrowRow,
  q: string,
): Promise<SearchAnswer['citations']> {
  const [row] = await db
    .select({ citations: searchAnswers.citations })
    .from(searchAnswers)
    .where(
      and(
        eq(searchAnswers.id, answerId),
        eq(searchAnswers.burrowId, burrow.id),
        eq(searchAnswers.askedById, viewer.id),
        sameSearchWords(searchAnswers.query, q),
      ),
    );
  if (!row) throw notThisSearch();
  return row.citations;
}

export interface SearchInput {
  q: string;
  type: SearchFilter;
  limit: number;
  /** Filters (CT-180, EC-25): by whom (a handle), where (a conversation), and calendar days, inclusive. */
  from?: string;
  /**
   * Only what this principal wrote, of these types (the agent `search` tool's `mine`: its own messages and runs,
   * resourceful-agents.md RA-26). Not a client filter: set by the server.
   */
  authorId?: string;
  types?: readonly SearchResultType[];
  in?: string;
  after?: string;
  before?: string;
  cursor?: string;
  /** The zone `after` / `before` days are in: the viewer's, else the burrow's. */
  timeZone?: string;
  /** The viewer's preferred language tag (controls stopword filtering and date labels). */
  locale?: string;
  /** Rows this request may read (default `SEARCH_SCAN_BUDGET`; tests set less). */
  scanBudget?: number;
  /** Leave the chip counts out (all zero): readers that only want results (SRP-09). */
  counts?: false;
  /** Where a disagreement between the query and the code check is reported (SRP-02); default the console. */
  log?: Pick<Logger, 'error'>;
}

const consoleErrors: Pick<Logger, 'error'> = { error: (obj, msg) => console.error(msg ?? '', obj) };

export async function search(
  db: Db,
  viewer: PrincipalRow,
  burrow: BurrowRow,
  input: SearchInput,
  now: Date,
): Promise<SearchResponse> {
  const q = input.q.trim();
  const filtered = !!(input.from || input.in || input.after || input.before || input.authorId);
  if (!q && !filtered) return { query: q, results: [], counts: { ...ZERO_COUNTS }, answer: null, next: null };

  const lang = resolveLanguage(input.locale);
  const [answerRow] = q
    ? await db
        .select()
        .from(searchAnswers)
        .where(
          and(
            eq(searchAnswers.burrowId, burrow.id),
            eq(searchAnswers.askedById, viewer.id),
            sameSearchWords(searchAnswers.query, q),
            inSearchLanguage(lang),
          ),
        )
        .orderBy(desc(searchAnswers.createdAt))
        .limit(1)
    : [];
  const answer = answerRow ? toSearchAnswer(answerRow) : null;

  const tsq = q ? await tsQuery(db, q, lang) : null;
  if (q && !tsq) return { query: q, results: [], counts: { ...ZERO_COUNTS }, answer, next: null };
  const zone = input.timeZone ?? burrow.timeZone;
  const key = scopeKey({ ...input, burrowId: burrow.id, viewerId: viewer.id, q, zone, lang });
  const cursor = input.cursor ? decodeCursor(input.cursor, key, !!tsq) : null;
  // Queries that carry the cursor's values: a value Postgres can't read is a cursor that isn't this search's (SRP-04).
  const withCursor = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      if (cursor && isDataError(err)) throw notThisSearch();
      throw err;
    }
  };
  // A walk keeps to the receipts of the answer it started with (SRP-06); an answer with receipts never changes.
  const pinned = cursor ? cursor.a : answer?.citations.length ? answer.id : null;
  const citations = !pinned
    ? []
    : cursor
      ? await withCursor(() => citationsOf(db, pinned, viewer, burrow, q))
      : (answer?.citations ?? []);
  const cited = new Map(citations.map((c) => [c.resultId, c.n]));

  const scope = await searchScope(db, viewer, burrow, input, tsq, zone);
  // Two scans of the matches: side by side on the pool (a transaction runs them one after the other).
  const [counts, page] = await Promise.all([
    input.counts === false ? { ...ZERO_COUNTS } : countsOf(db, scope),
    withCursor(() =>
      pageOf(db, viewer, scope, {
        type: input.type,
        limit: input.limit,
        position: cursor?.p ?? null,
        cited,
        budget: input.scanBudget ?? SEARCH_SCAN_BUDGET,
        log: input.log ?? consoleErrors,
      }),
    ),
  ]);
  const results: SearchResult[] = page.rows.map((doc) => ({
    id: doc.id,
    type: doc.type,
    where: whereOf(doc, now, burrow.timeZone, lang).slice(0, 200),
    authorId: doc.authorId,
    snippet: doc.snippet.slice(0, 1000),
    citedAs: cited.get(doc.id) ?? null,
    link: doc.link,
    createdAt: iso(doc.createdAt),
    status: doc.status ?? null,
  }));
  return {
    query: q,
    results,
    counts,
    answer,
    next: page.next ? encodeCursor(key, pinned, page.next) : null,
  };
}

/**
 * The first `limit` results, for readers inside Whombat that take one list (the agent `search` tool, answer mode):
 * follows `next` past pages the work budget cut short, at most `FOLLOW_PAGES` of them (SRP-09).
 */
export async function searchResults(
  db: Db,
  viewer: PrincipalRow,
  burrow: BurrowRow,
  input: Omit<SearchInput, 'cursor' | 'counts'>,
  now: Date,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < FOLLOW_PAGES && results.length < input.limit; i++) {
    const page = await search(
      db,
      viewer,
      burrow,
      { ...input, limit: input.limit - results.length, counts: false, ...(cursor ? { cursor } : {}) },
      now,
    );
    results.push(...page.results);
    if (!page.next) break;
    cursor = page.next;
  }
  return results;
}

async function approvalsOf(db: Db, ids: readonly string[]): Promise<Map<string, Approval>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select()
    .from(approvals)
    .where(inArray(approvals.id, [...ids]));
  return new Map(rows.map((r) => [r.id, toApproval(r)]));
}

type DocRef = Pick<typeof searchDocuments.$inferSelect, 'id' | 'type' | 'conversationId'>;

/**
 * Whether `reader` may open a search document now (receipts, `post_answer`; WS-22): its conversation is one of the
 * reader's burrow, and for a DECISION the approval's own visibility.
 */
export async function docReadableBy(db: Db, reader: PrincipalRow, doc: DocRef): Promise<boolean> {
  if (doc.conversationId && !(await inBurrow(db, reader.burrowId, doc.conversationId))) return false;
  if (doc.type !== 'DECISION') return true;
  const approval = (await approvalsOf(db, [doc.id])).get(doc.id);
  return !!approval && (await approvalVisible(db, reader, approval));
}
