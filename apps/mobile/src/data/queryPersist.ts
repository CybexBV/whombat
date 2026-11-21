/**
 * The last-seen burrow, kept between launches (AP-717): the app opens at once with Chat's threads, the Overview, the
 * tab bar's badges, the conversations and the agent it showed last time while the connection comes up, and refreshes
 * them when it is. Only an allowlist of reads is kept (`PERSISTED_ENDPOINTS`): nothing from the Vault, sign-ins, tokens,
 * devices or settings — no secret ever reaches the disk — a conversation keeps its newest page of messages, Chat its
 * newest page of threads and a pinned widget a thinned line. Sealed in the `SecureBox` (encrypted, key in the
 * keystore) under the storage scope (`managed:<org>/<Whombat>`), with the account scope it was saved under: a session
 * that opens as another account (or with other permissions) drops it. A week-old copy isn't shown.
 *
 * Saved when the app goes to the background and otherwise at most once a minute (AP-928): realtime keeps changing the
 * cache, and each save serializes and seals the whole copy on the JS thread. Each read is serialized once (AP-929): the
 * size check adds up the parts, and the copy's JSON is put together from them. A save is skipped when no kept read
 * changed since the last one (a refetch that brought the same answer keeps the same data), and only the conversations
 * on screen and the few most recent are kept: the copy is what the next start decrypts and parses before its first
 * screen (docs/app/decisions/ios-crypto-speed.md).
 */
import { type DehydratedState, dehydrate, hydrate, type Query, type QueryClient } from '@tanstack/query-core';
import { isOptimisticMessage, parseKey } from '@whombat/client/query';
import type { SecureBox } from './secureBox';
import { shortAge } from './syncLog';

/**
 * The reads the app opens with: the tabs' (Chat's threads and what is new in them, the rooms behind the tab bar's
 * badges, the Overview and Needs you) and the conversations'. None carries a secret: titles, the start of messages,
 * counts, what needs the person and the pinned widgets' readings.
 */
export const PERSISTED_ENDPOINTS: ReadonlySet<string> = new Set([
  'me.get',
  'burrows.get',
  'conversations.bootstrap',
  'conversations.list',
  'conversations.get',
  'messages.list',
  'messages.thread',
  'notifications.inbox',
  'agent.get',
  'chats.list',
  'chats.threads',
  'chats.unread',
  'home.overview',
]);

/**
 * The reads kept for today's tabs, in the order they leave a copy too large: they never push out what the copy held
 * before them (the conversations).
 */
const TAB_READS = ['home.overview', 'chats.threads', 'chats.unread', 'chats.list'] as const;

/** A pinned widget's line keeps at most this many readings in the copy, spread over its whole day. */
export const KEPT_WIDGET_POINTS = 96;

/** The file's name in the box. */
export const QUERY_CACHE_NAME = 'queries';
/** Older copies are dropped rather than shown. */
export const MAX_AGE_MS = 7 * 24 * 3600_000;
/**
 * A copy larger than this (JSON characters) keeps none of the tabs' reads, then fewer conversations, then none; a larger
 * one still isn't saved.
 */
export const MAX_CHARS = 400_000;
/** The conversations (and threads) whose newest messages are kept: those on screen first, then the most recent. */
export const KEPT_CONVERSATIONS = 6;

export interface PersistedQueries {
  v: 1;
  savedAt: number;
  /** The account scope (`scopeKey`) the data belongs to; null before the session said. */
  account: string | null;
  state: DehydratedState;
}

/**
 * True for a read on the allowlist with an answer: a successful one, or one whose last refresh failed while live updates
 * kept its data current (the copy holds the data; read back, every read is owed a new one anyway).
 */
export function shouldPersistQuery(query: Pick<Query, 'queryKey' | 'state'>): boolean {
  const key = parseKey(query.queryKey);
  if (!key || !PERSISTED_ENDPOINTS.has(key.endpointId)) return false;
  // The open threads of a room (Chat, Feedback), as its tab opens with: not the settled ones, nor those about one server
  // or connection, read on pages opened on the way.
  if (
    key.endpointId === 'chats.threads' &&
    (key.query.state !== 'open' || key.query.subjectKind !== undefined)
  )
    return false;
  const { status, data } = query.state;
  return status === 'success' || (status === 'error' && data !== undefined);
}

/** An infinite list keeps only its newest page (the one a conversation opens at). */
function firstPageOnly(data: unknown): unknown {
  const d = data as { pages?: unknown[]; pageParams?: unknown[] } | undefined;
  if (!d || !Array.isArray(d.pages) || d.pages.length <= 1) return data;
  return { ...d, pages: d.pages.slice(0, 1), pageParams: (d.pageParams ?? []).slice(0, 1) };
}

/** Every `n`th reading of a line, its first and last always: the same day drawn with fewer points. */
function thinned<T>(points: readonly T[], most: number): readonly T[] {
  if (points.length <= most) return points;
  const step = (points.length - 1) / (most - 1);
  return Array.from({ length: most }, (_, i) => points[Math.round(i * step)] as T);
}

/**
 * The Overview with its pinned widgets' lines thinned (`KEPT_WIDGET_POINTS`): a day of readings every minute is
 * thousands of points a widget, while the copy only bridges the moment until the Overview is read again.
 */
function slimOverview(data: unknown): unknown {
  const d = data as { widgets?: { points?: unknown[] }[] } | undefined;
  if (!d || !Array.isArray(d.widgets)) return data;
  if (!d.widgets.some((w) => Array.isArray(w.points) && w.points.length > KEPT_WIDGET_POINTS)) return data;
  return {
    ...d,
    widgets: d.widgets.map((w) =>
      Array.isArray(w.points) && w.points.length > KEPT_WIDGET_POINTS
        ? { ...w, points: thinned(w.points, KEPT_WIDGET_POINTS) }
        : w,
    ),
  };
}

const isOverview = (queryKey: readonly unknown[]) => parseKey(queryKey)?.endpointId === 'home.overview';

const optimistic = (v: unknown) =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as { id?: unknown }).id === 'string' &&
  isOptimisticMessage(v as { id: string });

/**
 * Drops messages still on their way (the optimistic copies, `msg_local-…`): after a restart they would show as sending
 * for ever. Messages waiting to send are the outbox's (`outbox.ts`). Copies only what it changes: without such a message
 * the value itself comes back (AP-929).
 */
function withoutOptimistic(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const v: unknown = value[i];
      const drop = optimistic(v);
      const next = drop ? v : withoutOptimistic(v, depth + 1);
      if (!out && (drop || next !== v)) out = value.slice(0, i);
      if (out && !drop) out.push(next);
    }
    return out ?? value;
  }
  const record = value as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const k of Object.keys(record)) {
    const next = withoutOptimistic(record[k], depth + 1);
    if (next === record[k]) continue;
    out ??= { ...record };
    out[k] = next;
  }
  return out ?? value;
}

const isMessages = (queryKey: readonly unknown[]) => {
  const id = parseKey(queryKey)?.endpointId;
  return id === 'messages.list' || id === 'messages.thread';
};

/**
 * The conversations worth keeping, most important first: on screen now, then the one opened or changed most recently.
 * `opened` is when each was last opened or changed (by query hash) in this run: a live update changes what a read shows
 * without changing when it was read.
 */
function keptConversations(
  queries: readonly Query[],
  opened: ReadonlyMap<string, number>,
): Map<string, number> {
  const recent = (q: Query) => Math.max(opened.get(q.queryHash) ?? 0, q.state.dataUpdatedAt);
  const ranked = queries
    .filter((q) => isMessages(q.queryKey))
    .sort((a, b) => {
      const shown = Number(b.getObserversCount() > 0) - Number(a.getObserversCount() > 0);
      return shown || recent(b) - recent(a);
    })
    .slice(0, KEPT_CONVERSATIONS);
  return new Map(ranked.map((q, i) => [q.queryHash, i]));
}

/**
 * What gets saved now, as the JSON of a `PersistedQueries`: the allowlisted reads, newest pages only, the
 * `KEPT_CONVERSATIONS` most important conversations' messages; the least important of those are left out while that
 * is too large, and nothing is saved when it still is.
 */
export function snapshotJson(
  qc: QueryClient,
  account: string | null,
  now: number,
  opened: ReadonlyMap<string, number> = new Map(),
): string | null {
  return snapshot(qc, account, now, opened).json;
}

/** `snapshotJson`, and the conversations (query hashes) the copy kept. */
function snapshot(
  qc: QueryClient,
  account: string | null,
  now: number,
  opened: ReadonlyMap<string, number>,
): { json: string | null; conversations: Set<string> } {
  const kept = keptConversations(qc.getQueryCache().getAll().filter(shouldPersistQuery), opened);
  const state = dehydrate(qc, {
    shouldDehydrateQuery: (q) => shouldPersistQuery(q) && (!isMessages(q.queryKey) || kept.has(q.queryHash)),
    shouldDehydrateMutation: () => false,
  });
  const parts = state.queries.map((q) => {
    const page = firstPageOnly(q.state.data);
    const data = withoutOptimistic(isOverview(q.queryKey) ? slimOverview(page) : page);
    // A refresh that failed is this run's: the copy keeps the data as an answer, not the failure.
    const failed = q.state.status === 'error';
    const query =
      data === q.state.data && !failed
        ? q
        : {
            ...q,
            state: {
              ...q.state,
              data,
              ...(failed && {
                status: 'success' as const,
                error: null,
                fetchFailureCount: 0,
                fetchFailureReason: null,
              }),
            },
          };
    return {
      json: JSON.stringify(query),
      hash: q.queryHash,
      rank: kept.get(q.queryHash) ?? -1,
      tab: (TAB_READS as readonly string[]).indexOf(parseKey(q.queryKey)?.endpointId ?? ''),
    };
  });
  // The copy around its reads: `{"v":1,…,"state":{"mutations":[],"queries":[` … `]}}`.
  const meta = JSON.stringify({ v: 1, savedAt: now, account } satisfies Omit<PersistedQueries, 'state'>);
  const head = `${meta.slice(0, -1)},"state":{"mutations":${JSON.stringify(state.mutations)},"queries":[`;
  const tail = ']}}';
  let size = parts.reduce((n, p) => n + p.json.length + 1, head.length + tail.length);
  let keep = parts;
  // Too large: the tabs' reads go first, the Overview first of them (the copy then holds what it held before they were
  // kept), then the least important conversation, one at a time.
  const leaving = [
    ...parts.filter((p) => p.tab >= 0).sort((a, b) => a.tab - b.tab),
    ...parts.filter((p) => p.rank >= 0).sort((a, b) => b.rank - a.rank),
  ];
  for (const out of leaving) {
    if (size <= MAX_CHARS) break;
    keep = keep.filter((p) => p !== out);
    size -= out.json.length + 1;
  }
  if (size > MAX_CHARS) return { json: null, conversations: new Set() };
  return {
    json: `${head}${keep.map((p) => p.json).join(',')}${tail}`,
    conversations: new Set(keep.filter((p) => p.rank >= 0).map((p) => p.hash)),
  };
}

/** A saved copy that may be shown: this format, not too old. */
export function usableSnapshot(saved: PersistedQueries | null, now: number): PersistedQueries | null {
  if (saved?.v !== 1 || !saved.state || !Array.isArray(saved.state.queries)) return null;
  if (!(now - saved.savedAt < MAX_AGE_MS)) return null;
  return saved;
}

/** At most this often a change is saved while the app is in the foreground (AP-928). */
export const SAVE_EVERY_MS = 60_000;

export interface QueryPersister {
  /** Puts the saved copy into the cache (before the first screen). The account it was saved for, or null. */
  restore(): Promise<string | null>;
  /** Saves after changes, at most every `throttleMs`; returns the stop function. */
  start(): () => void;
  /** Saves now (going to the background). */
  flush(): Promise<void>;
}

export function createQueryPersister(input: {
  qc: QueryClient;
  box: SecureBox;
  /** The storage scope: `managed:<org>/<Whombat>`. */
  scope: string;
  /** The account scope now (`scopeKey` of the session's scope); null while it isn't known. */
  account: () => string | null;
  now?: () => number;
  throttleMs?: number;
  /** Notes what was read back at start (this phone's sync log). */
  log?: (text: string) => void;
}): QueryPersister {
  const { qc, box, scope } = input;
  const now = input.now ?? Date.now;
  const throttleMs = input.throttleMs ?? SAVE_EVERY_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Each kept read's data as last saved (or restored), by query hash: a refetch that brought the same answer keeps
  // the same data (structural sharing), so only a real change makes the copy out of date.
  let saved = new Map<string, unknown>();
  // Nothing saved yet in this run (and nothing restored): the first save writes.
  let dirty = true;
  // The conversations kept in the last copy, and when each conversation was last opened or changed in this run.
  let keptLast = new Set<string>();
  const opened = new Map<string, number>();

  const remember = () => {
    saved = new Map(
      qc
        .getQueryCache()
        .getAll()
        .filter(shouldPersistQuery)
        .map((q) => [q.queryHash, q.state.data]),
    );
  };

  const save = async () => {
    timer = null;
    if (stopped || !dirty) return;
    // Nothing is saved before the session said whose data it is.
    const account = input.account();
    if (!account) return;
    dirty = false;
    const { json, conversations } = snapshot(qc, account, now(), opened);
    remember();
    keptLast = conversations;
    // Too large to keep: the copy on the phone goes too, else every start opens with it however old it gets.
    if (json) await box.saveJson(scope, QUERY_CACHE_NAME, json).catch(() => {});
    else await box.remove(scope, QUERY_CACHE_NAME).catch(() => {});
  };
  const later = () => {
    timer ??= setTimeout(() => void save(), throttleMs);
  };

  return {
    async restore() {
      const loaded = await box.load<PersistedQueries>(scope, QUERY_CACHE_NAME).catch(() => null);
      const saved = usableSnapshot(loaded, now());
      if (!saved) {
        if (loaded) input.log?.('copy not read back: too old or of another format');
        return null;
      }
      // Read back after the first screen (it lost the race against its timeout): a read that was answered or failed
      // meanwhile keeps its answer or its error. The copy over an error would look like an answer, and nothing would
      // ask again. A read still on its way gets the copy until its answer comes.
      const cache = qc.getQueryCache();
      const queries = saved.state.queries.filter((q) => {
        const now = cache.get(q.queryHash);
        return !now || now.state.status === 'pending';
      });
      try {
        hydrate(qc, { ...saved.state, queries });
      } catch {
        return null;
      }
      // The copy is what the phone showed when it was saved, however recently it was read then (live updates kept
      // changing it after): each of its reads is owed a new one. A screen showing it asks as it opens or comes into
      // view, and the connection asks for those on screen as it opens (`refetchOwedReads`).
      for (const q of queries) cache.get(q.queryHash)?.invalidate();
      input.log?.(`copy read back: ${queries.length} reads, saved ${shortAge(now() - saved.savedAt)} ago`);
      // What was just read back is what the copy holds.
      remember();
      keptLast = new Set(queries.filter((q) => isMessages(q.queryKey)).map((q) => q.queryHash));
      dirty = false;
      return saved.account;
    },
    start() {
      stopped = false;
      const off = qc.getQueryCache().subscribe((event) => {
        const q = event.query;
        if (event.type === 'observerAdded' && isMessages(q.queryKey)) {
          opened.set(q.queryHash, now());
          // A conversation the copy left out is now among the ones it keeps.
          if (q.state.status === 'success' && !keptLast.has(q.queryHash)) {
            dirty = true;
            later();
          }
          return;
        }
        if (event.type !== 'updated' || event.action.type !== 'success' || !shouldPersistQuery(q)) return;
        if (saved.has(q.queryHash) && saved.get(q.queryHash) === q.state.data) return;
        if (isMessages(q.queryKey)) opened.set(q.queryHash, now());
        dirty = true;
        // The Overview changes every minute (its time, the widgets' readings): it goes with the next other change, or
        // when the app goes to the background, rather than sealing the whole copy again each time.
        if (!isOverview(q.queryKey)) later();
      });
      return () => {
        stopped = true;
        off();
        if (timer) clearTimeout(timer);
        timer = null;
      };
    },
    async flush() {
      if (timer) clearTimeout(timer);
      await save();
    },
  };
}
