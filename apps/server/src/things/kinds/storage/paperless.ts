/**
 * Paperless-ngx's page (service-dashboards.md SD-56, SD-S17), in slots (service-slots.md): what waits in the inbox (Live),
 * how many documents, correspondents and tags it holds (Inventory), what was filed lately (Shelf), documents added per
 * day (Trend), who sends the most (People), its version, disk and database in the machine card, and below them imports
 * that failed and Paperless's own checks (database, Redis, the worker, the search index, the classifier, the sanity
 * check). Read with the connection's token through `/api/statistics/`, `/api/documents/?is_in_inbox=true`,
 * `/api/tasks/?status=failure&acknowledged=false`, and where the account may (SystemMonitoring) `/api/status/` and
 * `/api/remote_version/`; the page also reads, kept 5 minutes, the newest filed documents (`is_in_inbox=false`), what
 * was added in the last 15 days (`added__date__gt`) and the correspondents with the most documents. Buttons: **Mark seen** on a failed import (`POST /api/tasks/acknowledge/`) and **Run sanity
 * check** (`POST /api/tasks/run/`), both everyday (SD-08). Never deletes and never empties the trash (SD-02).
 *
 * API 10 (Paperless-ngx 3) answers tasks paged with lower-case states (`failure`), `task_type` and `input_data`; API 9
 * and older a list with `FAILURE`, `task_name` and `task_file_name`: both are read (fixtures from a real 3.3.3).
 */
import type {
  ThingGalleryItem,
  ThingLine,
  ThingPageBar,
  ThingPageButton,
  ThingPageItem,
  ThingPageKpi,
  ThingPagePanel,
  ThingPageRow,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import { ApiError, badRequest } from '../../../lib/errors';
import type { Services } from '../../../services';
import { MORE_SUBJECT, moreSubject, splitItems } from '../../quiet/items';
import type { KindCheck } from '../../quiet/types';
import {
  bytes,
  clip,
  dateOf,
  dayMonth,
  line,
  list,
  num,
  plural,
  rec,
  str,
  thousands,
  when,
} from '../../words';
import { actAs } from '../act';
import { cachedRead, KIND_DEADLINE_MS, latestRead, problemOf, withDeadline } from '../read';
import type { KindAction, KindModule } from '../registry';
import {
  addedNote,
  countByDay,
  countLine,
  dayKey,
  inventory,
  lastDays,
  liveRows,
  people,
  shelf,
  slotPanels,
  trend,
  weekChange,
} from '../slots';
import type { KindCtx, KindView } from '../types';
import { fixed, fullness, itemLines, type KindNotice, lookInto, newer, UNTIL } from './lines';
import { optional, readJson, StatusProblem } from './net';
import {
  ago,
  type ButtonCtx,
  bareVersion,
  button,
  cardOf,
  fullTone,
  noPictures,
  type Picture,
  picturesOf,
  seenOf,
  serviceUrl,
  statusOf,
  unreadView,
  usedOf,
  worstFirst,
} from './shared';

const NAME = 'Paperless-ngx';
/** Inbox documents on the page (SD-01: a dozen, newest first). */
export const INBOX_MAX = 12;
/** Failed imports read at once. */
const FAILED_MAX = 25;
/** In the inbox on the page: the newest four, as tall as In Paperless beside them; the rest a click away. */
const LIVE_MAX = 4;
/** Filed lately: the newest documents out of the inbox. */
export const FILED_MAX = 12;
/** Who sends the most: the correspondents with the most documents. */
const SENDERS_MAX = 5;
/** Documents added in the last 15 days, at most this many read (a busy week's import shows as “500+”). */
export const ADDED_MAX = 500;
/** The page's slower reads (filed lately, the days, who sends) are read again after 5 minutes. */
const MORE_KEEP_MS = 300_000;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface PaperlessDoc {
  id: number;
  title: string;
  correspondent: string | null;
  added: Date | null;
}

export interface PaperlessFailed {
  id: number;
  file: string;
  /** Paperless's own words for why, as it said them. */
  error: string | null;
  at: Date | null;
}

export type CheckKey = 'database' | 'redis' | 'celery' | 'index' | 'classifier' | 'sanity';

export interface PaperlessCheck {
  key: CheckKey;
  /** `OK`, `WARNING`, `ERROR` (anything else as it came, upper case). */
  status: string;
  error: string | null;
  /** When it last ran or changed (index, classifier, sanity check). */
  at: Date | null;
}

/** What `/api/statistics/` counts besides documents: correspondents, tags, document types, storage paths. */
export interface PaperlessCounts {
  correspondents: number | null;
  tags: number | null;
  types: number | null;
  paths: number | null;
}

export interface PaperlessSnapshot {
  readAt: Date;
  version: string | null;
  total: number | null;
  inboxCount: number | null;
  /** Absent in older recordings: none counted. */
  counts?: PaperlessCounts;
  /** Its database (“SQLite”, “PostgreSQL”) and the tasks waiting to run (`/api/status/`); absent without it. */
  database?: string | null;
  pending?: number | null;
  inbox: PaperlessDoc[];
  failed: PaperlessFailed[];
  failedCount: number | null;
  /** `/api/status/` (SystemMonitoring): the disk and the checks; null when the account may not read it. */
  storage: { total: number; available: number } | null;
  checks: PaperlessCheck[] | null;
  update: { available: boolean; version: string | null } | null;
}

/** `/api/statistics/`. */
export function parseStatistics(body: unknown): {
  total: number | null;
  inbox: number | null;
  counts: PaperlessCounts;
} {
  const b = rec(body);
  return {
    total: num(b.documents_total),
    inbox: num(b.documents_inbox),
    counts: {
      correspondents: num(b.correspondent_count),
      tags: num(b.tag_count),
      types: num(b.document_type_count),
      paths: num(b.storage_path_count),
    },
  };
}

/** A paged answer's results and count, or a plain list's (API 9 and older). */
export function pageOf(body: unknown): { results: unknown[]; count: number | null } {
  if (Array.isArray(body)) return { results: body, count: body.length };
  const b = rec(body);
  return { results: list(b.results), count: num(b.count) };
}

/** `/api/documents/?is_in_inbox=true…`: the documents, correspondents by their ids for now. */
export function parseInbox(body: unknown): {
  docs: (PaperlessDoc & { correspondentId: number | null })[];
  count: number | null;
} {
  const { results, count } = pageOf(body);
  const docs = results.slice(0, INBOX_MAX).flatMap((raw) => {
    const d = rec(raw);
    const id = num(d.id);
    if (id === null) return [];
    return [
      {
        id,
        title: clip(str(d.title) ?? `Document ${id}`, 120),
        correspondent: null,
        correspondentId: num(d.correspondent),
        added: dateOf(d.added),
      },
    ];
  });
  return { docs, count };
}

/** `/api/correspondents/?id__in=…`: names by id. */
export function parseNames(body: unknown): Map<number, string> {
  const out = new Map<number, string>();
  for (const raw of pageOf(body).results) {
    const c = rec(raw);
    const id = num(c.id);
    const name = str(c.name);
    if (id !== null && name) out.set(id, clip(name, 60));
  }
  return out;
}

const CONSUME = new Set(['consume_file', 'documents.tasks.consume_file']);

/** Failed tasks that were imports (API 10's `task_type`/`input_data`, API 9's `task_name`/`task_file_name`). */
export function parseFailed(body: unknown): {
  failed: PaperlessFailed[];
  count: number | null;
  all: number | null;
} {
  const { results, count } = pageOf(body);
  const failed = results.flatMap((raw) => {
    const t = rec(raw);
    const id = num(t.id);
    const kind = str(t.task_type) ?? str(t.task_name);
    if (id === null || (kind && !CONSUME.has(kind))) return [];
    const file = str(rec(t.input_data).filename) ?? str(t.task_file_name) ?? `Import ${id}`;
    const error = str(rec(t.result_data).error_message) ?? str(t.result);
    return [{ id, file: clip(file, 120), error, at: dateOf(t.date_done) ?? dateOf(t.date_created) }];
  });
  // A page of only imports keeps Paperless's count; otherwise the imports on this page are what is known.
  const allImports = failed.length === results.length;
  return {
    failed: failed.slice(0, FAILED_MAX),
    count: allImports ? (count ?? failed.length) : failed.length,
    all: count,
  };
}

const CHECKS: { key: CheckKey; status: string; error: string; at?: string }[] = [
  { key: 'database', status: 'status', error: 'error' },
  { key: 'redis', status: 'redis_status', error: 'redis_error' },
  { key: 'celery', status: 'celery_status', error: 'celery_error' },
  { key: 'index', status: 'index_status', error: 'index_error', at: 'index_last_modified' },
  {
    key: 'classifier',
    status: 'classifier_status',
    error: 'classifier_error',
    at: 'classifier_last_trained',
  },
  { key: 'sanity', status: 'sanity_check_status', error: 'sanity_check_error', at: 'sanity_check_last_run' },
];

const DB_NAMES: Record<string, string> = {
  sqlite: 'SQLite',
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
};

/** `/api/status/`: the version, the disk, the database, the tasks waiting, and the checks. */
export function parseStatus(
  body: unknown,
): Pick<PaperlessSnapshot, 'version' | 'storage' | 'checks' | 'database' | 'pending'> {
  const b = rec(body);
  const storage = rec(b.storage);
  const total = num(storage.total);
  const available = num(storage.available);
  const tasks = rec(b.tasks);
  const db = rec(b.database);
  const checks = CHECKS.flatMap((c) => {
    const from = c.key === 'database' ? db : tasks;
    const status = str(from[c.status])?.toUpperCase();
    if (!status || status === 'DISABLED') return [];
    return [
      {
        key: c.key,
        status: status.slice(0, 20),
        error: str(from[c.error]),
        at: c.at ? dateOf(from[c.at]) : null,
      },
    ];
  });
  const dbType = str(db.type);
  return {
    version: bareVersion(str(b.pngx_version)),
    storage: total !== null && available !== null && total > 0 ? { total, available } : null,
    checks,
    database: dbType ? clip(DB_NAMES[dbType.toLowerCase()] ?? dbType, 30) : null,
    pending: num(rec(tasks.summary).pending_count),
  };
}

/** `/api/remote_version/`: “0.0.0” when update checks are off. */
export function parseRemote(body: unknown): PaperlessSnapshot['update'] {
  const b = rec(body);
  const version = bareVersion(str(b.version));
  if (!version || version === '0.0.0') return null;
  return { available: b.update_available === true, version };
}

async function readFailed(services: Services, row: CatalogConnectionRow) {
  const get = (status: string) =>
    readJson(services, row, NAME, {
      path: '/api/tasks/',
      query: { status, acknowledged: 'false', page_size: String(FAILED_MAX) },
    });
  try {
    return parseFailed(await get('failure'));
  } catch (err) {
    // Paperless-ngx 2 knows the states in capitals only.
    if (err instanceof StatusProblem && err.status === 400) return parseFailed(await get('FAILURE'));
    throw err;
  }
}

export async function readPaperless(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<PaperlessSnapshot> {
  const get = (path: string, query?: Record<string, string>) =>
    readJson(services, row, NAME, { path, ...(query ? { query } : {}) });
  const [stats, inbox, failed, status, remote] = await Promise.all([
    get('/api/statistics/'),
    optional(
      get('/api/documents/', {
        is_in_inbox: 'true',
        ordering: '-added',
        page_size: String(INBOX_MAX),
        fields: 'id,title,correspondent,added',
      }),
    ),
    optional(readFailed(services, row)),
    optional(get('/api/status/')),
    optional(get('/api/remote_version/')),
  ]);
  const s = parseStatistics(stats);
  const docs = inbox ? parseInbox(inbox) : null;
  const ids = [
    ...new Set((docs?.docs ?? []).map((d) => d.correspondentId).filter((x): x is number => x !== null)),
  ];
  const names = ids.length
    ? await optional(
        get('/api/correspondents/', {
          id__in: ids.join(','),
          page_size: String(ids.length),
          fields: 'id,name',
        }).then(parseNames),
      )
    : null;
  const st = status ? parseStatus(status) : null;
  // Without SystemMonitoring the version comes from the UI's settings.
  const ui = st ? null : await optional(get('/api/ui_settings/'));
  return {
    readAt: now,
    version: st?.version ?? bareVersion(str(rec(rec(ui).settings).version)),
    total: s.total,
    inboxCount: s.inbox ?? docs?.count ?? null,
    counts: s.counts,
    database: st?.database ?? null,
    pending: st?.pending ?? null,
    inbox: (docs?.docs ?? []).map(({ correspondentId, ...d }) => ({
      ...d,
      correspondent: correspondentId !== null ? (names?.get(correspondentId) ?? null) : null,
    })),
    failed: failed?.failed ?? [],
    failedCount: failed?.count ?? null,
    storage: st?.storage ?? null,
    checks: st?.checks ?? null,
    update: remote ? parseRemote(remote) : null,
  };
}

/** One of the correspondents with the most documents: how many, and the date of their newest. */
export interface PaperlessSender {
  name: string;
  documents: number;
  last: Date | null;
}

/** The page's slower part: what was filed lately, when documents came in, who sends the most. Null: not read. */
export interface PaperlessMore {
  filed: PaperlessDoc[] | null;
  /** When each document of the last 15 days was added, newest first; `complete` false when more came than were read. */
  added: { at: Date[]; complete: boolean } | null;
  senders: PaperlessSender[] | null;
}

/** `/api/documents/?added__date__gt=…&fields=id,added`: when each was added. */
export function parseAdded(body: unknown): NonNullable<PaperlessMore['added']> {
  const { results, count } = pageOf(body);
  const at = results.flatMap((raw) => {
    const d = dateOf(rec(raw).added);
    return d ? [d] : [];
  });
  return { at, complete: count === null || count <= results.length };
}

/** `/api/correspondents/?ordering=-document_count&last_correspondence=true`: the busiest first. */
export function parseSenders(body: unknown): PaperlessSender[] {
  return pageOf(body)
    .results.flatMap((raw) => {
      const c = rec(raw);
      const name = str(c.name);
      const documents = num(c.document_count);
      if (!name || !documents) return [];
      return [{ name: clip(name, 80), documents, last: dateOf(c.last_correspondence) }];
    })
    .sort((a, b) => b.documents - a.documents)
    .slice(0, SENDERS_MAX);
}

/** The page's slower part (5 minutes): each call on its own, a failed one leaves its slot out. */
export async function readPaperlessMore(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<PaperlessMore> {
  const get = (path: string, query: Record<string, string>) => readJson(services, row, NAME, { path, query });
  // Paperless compares the day where it runs; a day more than the two weeks covers the difference.
  const since = dayKey(new Date(now.getTime() - 15 * 86_400_000), timeZone);
  const [filed, added, senders] = await Promise.all([
    optional(
      get('/api/documents/', {
        is_in_inbox: 'false',
        ordering: '-added',
        page_size: String(FILED_MAX),
        fields: 'id,title,correspondent,added',
      }).then(parseInbox),
    ),
    optional(
      get('/api/documents/', {
        added__date__gt: since,
        ordering: '-added',
        page_size: String(ADDED_MAX),
        fields: 'id,added',
      }).then(parseAdded),
    ),
    optional(
      get('/api/correspondents/', {
        ordering: '-document_count',
        page_size: String(SENDERS_MAX),
        last_correspondence: 'true',
      }).then(parseSenders),
    ),
  ]);
  const ids = [
    ...new Set((filed?.docs ?? []).map((d) => d.correspondentId).filter((x): x is number => x !== null)),
  ];
  const names = ids.length
    ? await optional(
        get('/api/correspondents/', {
          id__in: ids.join(','),
          page_size: String(ids.length),
          fields: 'id,name',
        }).then(parseNames),
      )
    : null;
  return {
    filed: filed
      ? filed.docs.map(({ correspondentId, ...d }) => ({
          ...d,
          correspondent: correspondentId !== null ? (names?.get(correspondentId) ?? null) : null,
        }))
      : null,
    added,
    senders,
  };
}

/** The page's slower part, kept 5 minutes. */
export function paperlessMore(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  timeZone: string,
): Promise<PaperlessMore | null> {
  return optional(
    cachedRead(
      services,
      `paperless-more:${row.id}`,
      row,
      () => readPaperlessMore(services, row, now, timeZone),
      MORE_KEEP_MS,
    ),
  );
}

function load(services: Services, row: CatalogConnectionRow, now: Date) {
  return async () => {
    try {
      return await withDeadline(
        readPaperless(services, row, now),
        KIND_DEADLINE_MS,
        `${NAME} didn’t answer in time.`,
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

/** Paperless's read for its page: the last one when a new one is slow (page-speed.md PS-01). */
export function paperlessLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, `paperless:${row.id}`, row, load(services, row, now));
}

/** Paperless's read for the health pass and the buttons: fresh within 30 seconds. */
export function paperlessSnapshot(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return cachedRead(services, `paperless:${row.id}`, row, load(services, row, now));
}

/* Words -------------------------------------------------------------------------------------------------------------- */

/** Why an import failed, short: Paperless's message without the file's name in front, the usual ones in plain words. */
export function whyWords(error: string | null, file: string): string {
  if (!error) return 'Paperless didn’t say why';
  const e = error.replace(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*`), '').trim();
  if (/duplicate/i.test(e)) return 'It’s already in Paperless';
  if (/InputFileError|not a valid|corrupt|damaged|can(?:no|')t (?:be )?(?:read|open)/i.test(e))
    return 'The file can’t be read';
  if (/unsupported|mime ?type|file type/i.test(e)) return 'Paperless can’t read this kind of file';
  if (/password|encrypted/i.test(e)) return 'The file is protected with a password';
  return clip(e, 120) || 'Paperless didn’t say why';
}

const CHECK_LABEL: Record<CheckKey, string> = {
  database: 'Database',
  redis: 'Redis',
  celery: 'Worker',
  index: 'Search index',
  classifier: 'Classifier',
  sanity: 'Sanity check',
};

/** A Paperless check as the subject of its line (QN-03): Redis and the worker are one, the worker. */
const healthSubject = (key: Exclude<CheckKey, 'classifier'>) =>
  key === 'redis' || key === 'celery'
    ? { id: 'worker', name: 'Worker' }
    : { id: key, name: CHECK_LABEL[key] };

/**
 * Paperless's own checks as Worth a look lines (only errors: a warning is “never ran yet”): one line for the worker when
 * Redis, the worker or both fail (QN-04: no two lines with one title), the classifier a heads-up (it only matches tags
 * by itself, and small libraries can't train it).
 */
function checkNotices(checks: readonly PaperlessCheck[], url: string, sanity: ThingPageButton): KindNotice[] {
  const out: KindNotice[] = [];
  const failed = checks.filter((c) => c.status === 'ERROR');
  const detailOf = (c: PaperlessCheck) => (c.error ? { detail: clip(c.error, 200) } : {});
  const base = (key: Exclude<CheckKey, 'classifier'>) => ({
    id: `check-${key === 'redis' || key === 'celery' ? 'worker' : key}`,
    check: 'paperless.health',
    subject: healthSubject(key),
    nature: 'problem' as const,
  });
  for (const c of failed)
    switch (c.key) {
      case 'database':
        out.push({
          ...base('database'),
          ...detailOf(c),
          tone: 'bad',
          icon: 'database',
          title: 'Paperless can’t use its database',
          link: lookInto('Why can’t Paperless-ngx use its database?'),
          ignore: fixed(UNTIL.fixed),
        });
        break;
      case 'redis':
      case 'celery':
        if (out.some((n) => n.id === 'check-worker')) break;
        out.push({
          ...base(c.key),
          tone: 'bad',
          icon: 'warn',
          title: 'Paperless’s worker isn’t running',
          badge: 'Worker isn’t running',
          detail: 'New documents aren’t imported until it runs again.',
          link: lookInto(
            `Why isn’t Paperless-ngx’s worker running?${c.error ? ` It says: ${clip(c.error, 200)}` : ''}`,
          ),
          ignore: fixed(UNTIL.running),
        });
        break;
      case 'index':
        out.push({
          ...base('index'),
          ...detailOf(c),
          tone: 'warn',
          icon: 'warn',
          title: 'Paperless’s search index has a problem',
          badge: 'Search index has a problem',
          link: { kind: 'url', label: 'Open Paperless-ngx', url },
          ignore: fixed(UNTIL.fixed),
        });
        break;
      case 'classifier':
        out.push({
          id: 'check-classifier',
          ...detailOf(c),
          tone: 'info',
          icon: 'warn',
          title: 'Paperless couldn’t train its classifier',
          badge: 'Classifier didn’t train',
          nature: 'fyi',
          check: 'paperless.classifier',
          ignore: fixed('Until it trains again.'),
        });
        break;
      case 'sanity':
        out.push({
          ...base('sanity'),
          ...detailOf(c),
          tone: 'warn',
          icon: 'warn',
          title: 'Paperless’s sanity check found problems',
          badge: 'Sanity check found problems',
          action: sanity,
          // The next run is news, fixed or not.
          ignore: newer('Until the next sanity check.'),
          ...(c.at ? { episode: c.at.toISOString() } : {}),
        });
        break;
    }
  return out;
}

/** Every check Paperless-ngx's lines can raise (QN-15). */
export const PAPERLESS_CHECKS: readonly KindCheck[] = [
  {
    check: 'paperless.import_failed',
    name: 'Imports failing',
    nature: 'you',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'paperless.health',
    name: 'Paperless’s own checks',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'paperless.classifier',
    name: 'The classifier not training',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'paperless.disk_full',
    name: 'Disk filling up',
    nature: 'problem',
    perItem: false,
    startsOn: true,
  },
  {
    check: 'paperless.update',
    name: 'Paperless-ngx updates',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
];

/** The checks this read couldn't see whole (QN-11): imports past the 25 read, parts the account may not read. */
export function paperlessSkipped(s: PaperlessSnapshot): string[] {
  const out: string[] = [];
  if (s.failedCount === null || s.failedCount > s.failed.length) out.push('paperless.import_failed');
  if (!s.checks) out.push('paperless.health', 'paperless.classifier');
  if (!s.storage) out.push('paperless.disk_full');
  if (!s.update) out.push('paperless.update');
  return out;
}

/* What it shows ------------------------------------------------------------------------------------------------------ */

export interface PaperlessInput {
  snapshot: PaperlessSnapshot;
  now: Date;
  timeZone: string;
  url: string;
  /** Who looks: their buttons are allowed or say why not. */
  buttons: ButtonCtx;
  picture: Picture;
  /** The page's slower part; absent or null: not read. */
  more?: PaperlessMore | null;
}

/** Run sanity check (SD-56): on its Worth a look line and on Paperless’s checks. */
function sanityButton(ctx: ButtonCtx): ThingPageButton {
  return button(ctx, { action: 'sanity', label: 'Run sanity check', icon: 'check' });
}

/** The card's figures (Inbox and Failed imports are its two). */
export function figures(s: PaperlessSnapshot, now: Date): ThingPageKpi[] {
  const out: ThingPageKpi[] = [];
  if (s.total !== null) out.push({ key: 'documents', label: 'Documents', value: thousands(s.total) });
  if (s.inboxCount !== null) {
    const newest = s.inbox[0]?.added ?? null;
    out.push({
      key: 'inbox',
      label: 'Inbox',
      value: thousands(s.inboxCount),
      ...(s.inboxCount > 0 && newest ? { sub: `Newest ${ago(newest, now)}` } : { sub: 'Nothing waiting' }),
    });
  }
  if (s.failedCount !== null)
    out.push({
      key: 'failed',
      label: 'Failed imports',
      value: thousands(s.failedCount),
      sub: s.failedCount ? `Newest ${ago(s.failed[0]?.at ?? now, now)}` : 'None',
      ...(s.failedCount ? { tone: 'warn' as const } : {}),
    });
  if (s.storage) {
    const used = s.storage.total - s.storage.available;
    const tone = fullTone((used / s.storage.total) * 100);
    out.push({
      key: 'free',
      label: 'Free space',
      value: bytes(s.storage.available),
      sub: `${usedOf(used, s.storage.total)} used`,
      meter: Math.min(1, Math.max(0, used / s.storage.total)),
      ...(tone ? { tone } : { color: 'blue' as const }),
    });
  }
  return out;
}

function notices(input: PaperlessInput): KindNotice[] {
  const { snapshot: s, now, timeZone, url } = input;
  const out: KindNotice[] = [];
  // One line per failed import (QN-03): a person decides what to do with the file; one already in Paperless is a
  // heads-up (Paperless working as it should).
  const imports = itemLines(
    [...s.failed].sort((a, b) => Number(duplicate(a)) - Number(duplicate(b))),
    (f) => {
      const title = clip(`${f.file} didn’t import`, 120);
      return {
        id: `failed-${f.id}`,
        icon: 'warn',
        title,
        ...(title.length > 40 ? { badge: 'An import failed' } : {}),
        detail: clip(`${whyWords(f.error, f.file)}.${f.at ? ` ${when(f.at, now, timeZone)}.` : ''}`, 200),
        link: { kind: 'url', label: 'Show them', url: `${url}/tasks` },
        action: button(input.buttons, {
          action: 'seen',
          target: String(f.id),
          label: 'Mark seen',
          icon: 'check',
        }),
        ...(duplicate(f)
          ? { tone: 'info' as const, nature: 'fyi' as const }
          : { tone: 'warn' as const, nature: 'you' as const }),
        check: 'paperless.import_failed',
        subject: { id: `import:${f.id}`, name: clip(f.file, 80) },
        ignore: fixed('Until it’s marked seen.'),
      };
    },
    (f) => `import:${f.id}`,
    (rest) => ({
      id: 'failed-more',
      ...(rest.every(duplicate)
        ? { tone: 'info' as const, nature: 'fyi' as const }
        : { tone: 'warn' as const, nature: 'you' as const }),
      icon: 'warn',
      title: `${thousands((s.failedCount ?? s.failed.length) - splitItems(s.failed).each.length)} more imports failed`,
      link: { kind: 'url', label: 'Show them', url: `${url}/tasks` },
      check: 'paperless.import_failed',
    }),
  ).map((n) =>
    // The rest counts those past the 25 read too.
    n.subject?.id === MORE_SUBJECT && s.failedCount
      ? { ...n, subject: moreSubject(s.failedCount - splitItems(s.failed).each.length) }
      : n,
  );
  out.push(...imports);
  out.push(...checkNotices(s.checks ?? [], url, sanityButton(input.buttons)));
  if (s.storage) {
    const used = s.storage.total - s.storage.available;
    const p = (used / s.storage.total) * 100;
    const f = fullness(p, s.storage.available);
    if (f)
      out.push({
        id: 'storage',
        ...f,
        icon: 'disk',
        title: `Only ${bytes(s.storage.available)} free for documents`,
        detail: `${usedOf(used, s.storage.total)} used.`,
        check: 'paperless.disk_full',
        ignore: fixed(UNTIL.fuller),
        ...(f.nature === 'problem'
          ? { link: lookInto('What takes the space on Paperless-ngx’s disk, and what can go?') }
          : {}),
      });
  }
  if (s.update?.available && s.update.version)
    out.push({
      id: 'update',
      tone: 'info',
      icon: 'update',
      title: 'Paperless-ngx has an update',
      detail: s.version
        ? `Version ${s.update.version}; this one runs ${s.version}.`
        : `Version ${s.update.version}.`,
      link: {
        kind: 'url',
        label: 'What’s new',
        url: 'https://github.com/paperless-ngx/paperless-ngx/releases',
      },
      nature: 'fyi',
      check: 'paperless.update',
      ignore: newer(UNTIL.version),
      episode: s.update.version,
    });
  return worstFirst(out);
}

/** An import that failed because the document is already in Paperless. */
const duplicate = (f: PaperlessFailed) => whyWords(f.error, f.file) === 'It’s already in Paperless';

/** Documents newest first (SD-56): each one's thumbnail, its correspondent and when it came; opens in Paperless. */
function docItems(input: PaperlessInput, docs: readonly PaperlessDoc[]): ThingGalleryItem[] {
  const { now, timeZone, url, picture } = input;
  return docs.map((d) => {
    const image = picture(`/api/documents/${d.id}/thumb/`, d.title, 'poster');
    const added = d.added
      ? when(d.added, now, timeZone).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase())
      : null;
    const sub = [d.correspondent, added ? `added ${added}` : null].filter(Boolean).join(' · ');
    return {
      id: `doc-${d.id}`,
      title: d.title,
      ...(sub ? { sub: clip(sub, 120) } : {}),
      ...(image ? { image } : {}),
      ...(d.added ? { at: d.added.toISOString() } : {}),
      url: `${url}/documents/${d.id}/details`,
    };
  });
}

function failedRows(input: PaperlessInput): ThingPageRow[] {
  const { snapshot: s, now, timeZone } = input;
  return s.failed.map((f) => ({
    id: String(f.id),
    cells: {
      file: { text: f.file, mono: true },
      why: { text: whyWords(f.error, f.file) },
      when: f.at ? { text: when(f.at, now, timeZone) } : { text: '—', tone: 'muted' as const },
      seen: {
        text: 'Mark seen',
        action: button(input.buttons, {
          action: 'seen',
          target: String(f.id),
          label: 'Mark seen',
          icon: 'check',
        }),
      },
    },
  }));
}

/** A check in words: “OK · Updated 2 h ago”, “Not yet · Never ran”, Paperless's error. */
export function checkItem(c: PaperlessCheck, now: Date): ThingPageItem {
  const ok = c.status === 'OK';
  const bad = c.status === 'ERROR';
  const runs = c.key === 'index' || c.key === 'classifier' || c.key === 'sanity';
  const verb = c.key === 'index' ? 'Updated' : c.key === 'classifier' ? 'Trained' : 'Ran';
  const detail =
    bad && c.error ? clip(c.error, 200) : runs ? (c.at ? `${verb} ${ago(c.at, now)}` : 'Never ran') : '';
  const right = ok
    ? 'OK'
    : bad
      ? 'Problem'
      : c.status === 'WARNING'
        ? 'Not yet'
        : clip(c.status.toLowerCase(), 40);
  return {
    id: c.key,
    title: CHECK_LABEL[c.key],
    ...(detail ? { detail } : {}),
    right,
    tone: ok ? 'ok' : bad ? 'bad' : 'info',
  };
}

/** In the inbox (Live): what waits for the person to sort, newest first, with how many and what is importing. */
function inboxLive(input: PaperlessInput) {
  const { snapshot: s, url, now } = input;
  if (s.inboxCount === null && !s.inbox.length) return null;
  const n = s.inboxCount ?? s.inbox.length;
  const oldest = n > 0 && n <= s.inbox.length ? s.inbox[s.inbox.length - 1]?.added : null;
  const meta = [
    n ? `${thousands(n)} waiting` : null,
    oldest ? `oldest ${ago(oldest, now)}` : null,
    s.pending ? `${thousands(s.pending)} importing` : null,
  ].filter(Boolean);
  return liveRows({
    id: 'inbox',
    title: 'In the inbox',
    ...(meta.length ? { meta: meta.join(' · ') } : {}),
    // Small thumbnails: a document's page says little at a row's size.
    shape: 'square',
    link: { kind: 'url', label: 'Open the inbox', url: `${url}/documents?sort=added&reverse=1` },
    items: docItems(input, s.inbox.slice(0, LIVE_MAX)),
    ...(n > Math.min(LIVE_MAX, s.inbox.length) ? { total: n } : {}),
    empty: 'Nothing waits in the inbox.',
  });
}

/** In Paperless (Inventory): documents with what came in this week, correspondents, tags, types and paths. */
function holdings(input: PaperlessInput, week: number | null) {
  const { snapshot: s, url } = input;
  const c = s.counts;
  const items: ThingPageItem[] = [];
  if (s.total !== null) {
    const added = week !== null ? addedNote(week) : null;
    items.push(
      countLine({
        id: 'documents',
        title: 'Documents',
        icon: 'log',
        value: thousands(s.total),
        ...(added ?? {}),
        url: `${url}/documents`,
      }),
    );
  }
  const more: [keyof PaperlessCounts, string, string, boolean, ThingPageItem['icon']][] = [
    ['correspondents', 'Correspondents', 'correspondents', true, 'door'],
    ['tags', 'Tags', 'tags', true, 'key'],
    ['types', 'Document types', 'documenttypes', false, 'media'],
    ['paths', 'Storage paths', 'storagepaths', false, 'disk'],
  ];
  for (const [key, title, path, always, icon] of more) {
    const n = c?.[key];
    if (n == null || (!always && n === 0)) continue;
    items.push(countLine({ id: key, title, icon, value: thousands(n), url: `${url}/${path}` }));
  }
  if (!items.length) return null;
  return inventory({ id: 'library', title: 'In Paperless', items });
}

/** Documents added per day this week, from what was added in the last 15 days; the change once both weeks were read. */
function addedWeek(input: PaperlessInput) {
  const added = input.more?.added;
  if (!added) return { trend: null, week: null };
  const { now, timeZone } = input;
  const days = lastDays(now, timeZone, 14);
  const perDay = countByDay(added.at, days.keys, timeZone);
  const values = perDay.slice(7);
  const week = values.reduce((a, b) => a + b, 0);
  const before = perDay.slice(0, 7).reduce((a, b) => a + b, 0);
  const shown = { at: days.at.slice(7), labels: days.labels.slice(7) };
  const total = added.complete ? thousands(week) : `${thousands(week)}+`;
  return {
    week: added.complete ? week : null,
    trend: trend({
      id: 'week',
      title: 'This week',
      meta: 'Documents added per day',
      days: shown,
      values,
      label: 'Added',
      figure: week ? { value: total, rest: 'added this week' } : { value: 'None', rest: 'added this week' },
      ...(added.complete ? { change: weekChange(week, before) } : {}),
    }),
  };
}

/** Who sends the most: the correspondents with the most documents, with the date of their newest. */
function whoSends(input: PaperlessInput) {
  const senders = input.more?.senders;
  if (!senders?.length) return null;
  return people({
    title: 'Who sends the most',
    meta: 'All time',
    items: senders.map((p) => ({
      name: p.name,
      n: p.documents,
      value: plural(p.documents, 'document'),
      ...(p.last ? { note: `Newest ${dayMonth(p.last, input.timeZone)}` } : {}),
    })),
  });
}

/** Paperless's lines in the machine card: its version and whether a newer one is out, its documents' disk, its database. */
export function paperlessMachineLines(s: PaperlessSnapshot): ThingPageBar[] {
  const out: ThingPageBar[] = [];
  if (s.version)
    out.push({
      id: 'paperless-version',
      label: 'Paperless-ngx',
      value: s.version,
      pct: null,
      ...(s.update?.available && s.update.version
        ? { sub: clip(`Version ${s.update.version} is out`, 120) }
        : s.update
          ? { sub: 'Up to date', subTone: 'ok' as const }
          : {}),
    });
  if (s.storage) {
    const used = s.storage.total - s.storage.available;
    const tone = fullTone((used / s.storage.total) * 100);
    out.push({
      id: 'documents-disk',
      label: 'Documents disk',
      value: usedOf(used, s.storage.total),
      pct: Math.min(1, Math.max(0, used / s.storage.total)),
      sub: `${bytes(s.storage.available)} free`,
      ...(tone ? { tone, subTone: tone } : {}),
    });
  }
  if (s.database) out.push({ id: 'database', label: 'Database', value: s.database, pct: null });
  return out;
}

/** The page's Paperless-ngx part (SD-56), in slots, from what was read; pure. */
export function paperlessView(input: PaperlessInput): KindView {
  const { snapshot: s, url } = input;
  const filed = input.more?.filed;
  const more: ThingPagePanel[] = [];
  const rows = failedRows(input);
  if (rows.length)
    more.push({
      kind: 'table',
      id: 'failed',
      place: 'main',
      title: 'Failed imports',
      meta:
        s.failedCount && s.failedCount > rows.length
          ? `Newest ${rows.length} of ${thousands(s.failedCount)}`
          : 'Not marked seen',
      link: { kind: 'url', label: 'Open Paperless-ngx', url: `${url}/tasks` },
      columns: [
        { key: 'file', label: 'File' },
        { key: 'why', label: 'Why' },
        { key: 'when', label: 'When' },
        { key: 'seen', label: '' },
      ],
      rows,
    });
  if (s.checks?.length)
    more.push({
      kind: 'list',
      id: 'checks',
      place: 'main',
      title: 'Paperless’s checks',
      ...(s.version ? { meta: `Version ${s.version}` } : {}),
      buttons: [sanityButton(input.buttons)],
      items: s.checks.map((c) => checkItem(c, input.now)),
    });
  const week = addedWeek(input);

  const facts: ThingLine[] = [];
  if (s.version) facts.push(line(`Paperless-ngx **${s.version}**`));
  if (s.total !== null)
    facts.push(line(`**${thousands(s.total)}** ${s.total === 1 ? 'document' : 'documents'}`));
  const shown = notices(input);
  return {
    // Its counts are in In Paperless and In the inbox; the card keeps its figures (`figures`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices: shown,
    ...slotPanels({
      live: inboxLive(input),
      inventory: holdings(input, week.week),
      shelf: filed?.length
        ? shelf({
            id: 'filed',
            title: 'Filed lately',
            meta: 'Newest first',
            link: { kind: 'url', label: 'Open documents', url: `${url}/documents?sort=added&reverse=1` },
            items: docItems(input, filed),
          })
        : null,
      trend: week.trend,
      people: whoSends(input),
      more,
      machine: paperlessMachineLines(s),
    }),
    tabs: [],
    facts,
    status: statusOf(
      shown,
      s.inboxCount ? `${plural(s.inboxCount, 'document')} in the inbox` : 'Inbox empty',
    ),
    open: { label: 'Open Paperless-ngx', url },
    actions: [],
    readAt: s.readAt,
    suggestions: [
      'Documents added this month',
      'Documents without a correspondent',
      'Biggest correspondents',
    ],
  };
}

/* The page ----------------------------------------------------------------------------------------------------------- */

export async function paperlessPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = serviceUrl(row);
  const [read, more] = await Promise.all([
    paperlessLatest(services, row, now),
    paperlessMore(services, row, now, ctx.timeZone),
  ]);
  if (!read.ok) return unreadView(NAME, url, problemOf(read.error, NAME).message, read.refreshing);
  const view = paperlessView({
    snapshot: read.value,
    now,
    timeZone: ctx.timeZone,
    url,
    buttons: ctx,
    picture: picturesOf(ctx),
    more,
  });
  return { ...view, refreshing: read.refreshing };
}

/* Buttons (SD-07, SD-08) --------------------------------------------------------------------------------------------- */

/** Mark seen: acknowledges one failed import, so it leaves the list (Paperless keeps the task). */
export const markSeen: KindAction = async ({ services, row, now }, { target }) => {
  const id = typeof target === 'string' && /^\d{1,12}$/.test(target) ? Number(target) : null;
  if (id === null) throw badRequest('Choose a failed import to mark as seen.');
  const read = await paperlessSnapshot(services, row, now).catch(() => null);
  const failed = read?.failed.find((f) => f.id === id);
  if (read && !failed) throw badRequest('That import isn’t among the failed ones any more.');
  await actAs(services, row, NAME, {
    method: 'POST',
    path: '/api/tasks/acknowledge/',
    body: { tasks: [id] },
  });
  const file = failed?.file ?? 'the failed import';
  return {
    message: 'Marked as seen.',
    title: clip(`Marked “${file}” as seen in ${NAME}`, 200),
    everyday: true,
  };
};

/**
 * Run sanity check: Paperless checks every document's files. API 10 names it `task_type: sanity_check`; Paperless-ngx 2
 * refuses that (400) and takes `task_name: check_sanity`, so a refused first call is tried once in 2's words.
 */
export const runSanityCheck: KindAction = async ({ services, row }) => {
  const run = (body: unknown) =>
    actAs(services, row, NAME, { method: 'POST', path: '/api/tasks/run/', body });
  try {
    await run({ task_type: 'sanity_check' });
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'unavailable') throw err;
    try {
      await run({ task_name: 'check_sanity' });
    } catch {
      throw err;
    }
  }
  return {
    message: 'Paperless-ngx is checking its documents. It takes a few minutes.',
    title: `Ran a sanity check in ${NAME}`,
    everyday: true,
  };
};

export const PAPERLESS_KIND: KindModule = {
  page: paperlessPage,
  prefetch: (services, row, now) => paperlessLatest(services, row, now),
  async seen(services, row, now, timeZone) {
    const s = await paperlessSnapshot(services, row, now);
    const view = paperlessView({
      snapshot: s,
      now,
      timeZone,
      url: serviceUrl(row),
      buttons: { row },
      picture: noPictures,
    });
    return seenOf(
      cardOf(
        { kpis: figures(s, now), notices: view.notices },
        ['inbox', 'failed'],
        s.version ? `Documents · Paperless-ngx ${s.version}` : 'Documents',
      ),
      view.notices as KindNotice[],
      paperlessSkipped(s),
    );
  },
  actions: { seen: markSeen, sanity: runSanityCheck },
  checks: PAPERLESS_CHECKS,
};
