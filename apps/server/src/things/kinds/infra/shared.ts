/**
 * What the infra kinds share (service-dashboards.md SD-40…SD-46, SD-S05, SD-S16): one snapshot reader per kind (the
 * page's `latestRead` and the health pass's `cachedRead` of the same entry, one deadline, failures in plain words), an
 * answer that keeps its status (a part a version doesn't have answers 404/405 and is left out), the view of a kind that
 * couldn't be read, the card from chosen figures and the small words every page uses. Buttons are `buttons.ts`'s and
 * their calls `act.ts`'s.
 */
import { externalEffect } from '../../../commit/scope';
import { signedConnectionFetch } from '../../../connections/http';
import type { CatalogConnectionRow } from '../../../connections/types';
import { type ApiError, badRequest } from '../../../lib/errors';
import type { Services } from '../../../services';
import { ITEM_LINES_MAX, moreSubject, shortHash, splitItems } from '../../quiet/items';
import { defaultNature, type KindNotice, type LooseNotice, type NoticeNature } from '../../quiet/types';
import { clip, span } from '../../words';
import {
  cachedRead,
  KIND_DEADLINE_MS,
  KIND_MAX_BYTES,
  type Latest,
  latestRead,
  problemOf,
  ReadProblem,
  withDeadline,
} from '../read';
import { type KindSeen, seenFromView } from '../registry';
import type { KindCtx, KindView } from '../types';

export type Reader<T> = (services: Services, row: CatalogConnectionRow, now: Date) => Promise<T>;

/** A kind's snapshot: `latest` for its page (PS-01), `cached` for the health pass and its buttons; one entry. */
export function snapshotReader<T>(name: string, key: string, read: Reader<T>) {
  const load = (services: Services, row: CatalogConnectionRow, now: Date) => async (): Promise<T> => {
    try {
      return await withDeadline(read(services, row, now), KIND_DEADLINE_MS, `${name} didn’t answer in time.`);
    } catch (err) {
      throw problemOf(err, name);
    }
  };
  return {
    latest: (services: Services, row: CatalogConnectionRow, now = services.clock()): Promise<Latest<T>> =>
      latestRead(services, `${key}:${row.id}`, row, load(services, row, now)),
    cached: (services: Services, row: CatalogConnectionRow, now = services.clock()): Promise<T> =>
      cachedRead(services, `${key}:${row.id}`, row, load(services, row, now)),
  };
}

/** An optional part: null when this version doesn't have it or it fails (SD-S05: its panel is left out). */
export const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** An answer with its status: JSON when it parses, else null. */
export interface Answer {
  status: number;
  json: unknown;
}

function urlOf(row: Pick<CatalogConnectionRow, 'baseUrl'>, path: string, query: Record<string, string> = {}) {
  const search = new URLSearchParams(query).toString();
  return `${row.baseUrl.replace(/\/+$/, '')}${path}${search ? `?${search}` : ''}`;
}

/**
 * A GET (or a read-only POST such as GraphQL) as the connection that keeps the status: for parts whose 4xx says
 * something (Grafana's health of a plugin without one, Portainer's image status). A refusal of the credential, the
 * network or the deadline is a `ReadProblem`.
 */
export async function readAnswer(
  services: Services,
  row: CatalogConnectionRow,
  name: string,
  path: string,
  {
    query,
    method = 'GET',
    body,
    maxBytes = KIND_MAX_BYTES,
  }: { query?: Record<string, string>; method?: 'GET' | 'POST'; body?: unknown; maxBytes?: number } = {},
): Promise<Answer> {
  let res: Awaited<ReturnType<typeof signedConnectionFetch>>;
  try {
    res = await externalEffect(
      'things.read',
      () =>
        signedConnectionFetch(
          services,
          row,
          {
            method,
            url: urlOf(row, path, query),
            headers: {
              Accept: 'application/json',
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          },
          { maxBytes, deadlineMs: KIND_DEADLINE_MS },
        ),
      { idempotent: true },
    );
  } catch (err) {
    throw problemOf(err, name);
  }
  if (res.status === 401) throw new ReadProblem(`${name} refused Whombat’s sign-in.`, true);
  let json: unknown = null;
  try {
    json = JSON.parse(res.body.toString('utf8'));
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** The JSON of a 2xx answer; anything else is a `ReadProblem` (as `getJson`). */
export function okJson(a: Answer, name: string): unknown {
  if (a.status === 403) throw new ReadProblem(`${name} refused Whombat’s sign-in.`);
  if (a.status >= 400) throw new ReadProblem(`${name} answered with an error.`);
  if (a.json === null) throw new ReadProblem(`${name} answered with something Whombat can’t read.`);
  return a.json;
}

/** The view of a kind that couldn't be read: its own page link, the reason, nothing else (SD-S05). */
export function unreadView(
  read: Pick<Latest<unknown>, 'refreshing'> & { ok: boolean; error?: unknown },
  name: string,
  open: KindView['open'] | undefined,
  charts?: KindView['charts'],
): KindView {
  return {
    notices: [],
    panels: [],
    tabs: [],
    facts: [],
    ...(open ? { open } : {}),
    ...(charts ? { charts } : {}),
    actions: [],
    readAt: null,
    suggestions: [],
    ...(read.ok ? {} : { problem: problemOf(read.error, name).message }),
    refreshing: read.refreshing,
  };
}

/* Buttons (SD-07, SD-S04) ------------------------------------------------------------------------------------------- */

/** The connection, for a page's buttons (`pageButton`: allowed on Manage, else disabled with why). */
export type ButtonCtx = Pick<KindCtx, 'row'>;

/** A button's target that the page doesn't offer (any more): refused in plain words. */
export function notOffered(what: string): ApiError {
  return badRequest(`${what} isn’t on the page any more. Read the page again and try once more.`);
}

/* Words ----------------------------------------------------------------------------------------------------------------- */

/** “now”, “4 min ago”, “3 days ago”. */
export function ago(at: Date, now: Date): string {
  const ms = now.getTime() - at.getTime();
  return ms < 60_000 ? 'now' : `${span(ms)} ago`;
}

/** “in 12 days”, “in 3 h”, “today”; past is “ago”. */
export function inTime(at: Date, now: Date): string {
  const ms = at.getTime() - now.getTime();
  if (ms <= 0) return ago(at, now);
  return ms < 60_000 ? 'now' : `in ${span(ms)}`;
}

/** Days from `now` until `at`, rounded as `span` rounds them (negative once past). */
export function daysUntil(at: Date, now: Date): number {
  return Math.round((at.getTime() - now.getTime()) / 86_400_000);
}

/** A page link to the service's own page: the connection's address without a trailing slash. */
export function serviceUrl(row: Pick<CatalogConnectionRow, 'fields' | 'baseUrl'>): string {
  return (row.fields.url ?? row.baseUrl).replace(/\/+$/, '');
}

/** Keeps the first of each notice id (a page may not repeat one). */
export function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}

/** A notice or row id from free text: lower case, `[a-z0-9_-]`, at most `n` characters. */
export function idOf(prefix: string, raw: string, n = 120): string {
  return `${prefix}-${raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`.slice(0, n);
}

/* Lines (quiet-notices.md QN-01…QN-04, QN-S30…QN-S39) ----------------------------------------------------------------- */

const TONE_RANK = { info: 0, warn: 1, bad: 2 } as const;
const NATURE_RANK: Record<NoticeNature, number> = { fyi: 0, you: 1, problem: 2 };

/** The lines that may colour the dot: every line that isn't a heads-up (QN-02). */
export function dotLines<T extends LooseNotice>(notices: readonly T[]): T[] {
  return notices.filter((n) => (n.nature ?? defaultNature(n)) !== 'fyi');
}

/** Worst tone first, the kind's own order otherwise. */
export function worstFirst<T extends Pick<LooseNotice, 'tone'>>(lines: readonly T[]): T[] {
  return [...lines].sort((a, b) => TONE_RANK[b.tone] - TONE_RANK[a.tone]);
}

/**
 * One line per item (QN-03), at most three lines: the first as they are, the rest as one “and N more” line of the same check whose
 * subject is `MORE_SUBJECT` and whose episode names the rest (`shortHash`), so its Ignore lasts while the rest is the
 * same items. `more` words that line (its id and title, a detail); its tone and nature are the worst of the rest.
 */
export function itemLines(
  lines: readonly KindNotice[],
  more: (rest: readonly KindNotice[]) => Pick<KindNotice, 'id' | 'title'> & Partial<KindNotice>,
  max = ITEM_LINES_MAX,
): KindNotice[] {
  const { each, rest } = splitItems(lines, max);
  const first = rest[0];
  if (!first) return each;
  const tone = rest.reduce<KindNotice['tone']>(
    (t, n) => (TONE_RANK[n.tone] > TONE_RANK[t] ? n.tone : t),
    'info',
  );
  const nature = rest.reduce<NoticeNature>(
    (t, n) => (NATURE_RANK[n.nature] > NATURE_RANK[t] ? n.nature : t),
    'fyi',
  );
  return [
    ...each,
    {
      icon: first.icon,
      tone,
      nature,
      check: first.check,
      subject: moreSubject(rest.length),
      episode: shortHash(rest.map((n) => n.subject?.id ?? n.id)),
      ignore: { lifts: 'newer', words: 'Until the list changes.' },
      ...more(rest),
    },
  ];
}

/** A line's `badge` (the head and the card's reason when its title is too long): at most 40 characters. */
export const badgeOf = (words: string): string => clip(words, 40);

/** The head when nothing is worth a look (QN-S30: the lines decide anything else). */
export const okStatus = (badge: string): NonNullable<KindView['status']> => ({
  status: 'ok',
  badge: clip(badge, 60),
});

/** What the health pass keeps of the lines (QN-11): every line as the page shows it, and the checks not read. */
export function linesSeen(
  view: Pick<KindView, 'notices'>,
  skipped: readonly string[],
): Pick<KindSeen, 'notices' | 'skipped'> {
  const unread = [...new Set(skipped)];
  return { notices: view.notices, ...(unread.length ? { skipped: unread } : {}) };
}

/**
 * The card's glance (SD-05) from chosen figures (“Card: Sites, Ending soon”): those figures in that order, the dot from
 * Worth a look as `seenFromView` makes it (heads-ups left out).
 */
export function cardOf(
  view: Pick<KindView, 'kpis' | 'notices'>,
  keys: readonly string[],
  line?: string,
): KindSeen['glance'] {
  const kpis = keys.flatMap((k) => (view.kpis ?? []).filter((x) => x.key === k));
  return seenFromView({ kpis, notices: view.notices }, { figures: keys.length, ...(line ? { line } : {}) });
}
