/**
 * This phone's sync log: what it read from its Whombat and when, kept between launches, for finding out why something
 * on screen wasn't current (a list that stayed days old while the box had the answer). It notes the reads worth
 * knowing about — one asked over data that was old, marked to read again or failed before; one that took long; every
 * one that failed — and the connection, the app coming and going and the copy read back at start. Never what a read
 * brought: endpoint names, conversation ids, times and error codes only. The newest `SYNC_LOG_MAX` notes are kept.
 *
 * Nothing is sent anywhere by itself: This Whombat → About shares it as a text file where the person chooses, as the
 * diagnostic files are (`syncLogFile`).
 */
import type { Query, QueryCache } from '@tanstack/query-core';
import { parseKey } from '@whombat/client/query';
import { mobileTranslator } from '../i18n/translate';

/** The most notes kept: a few days of a phone's sync. */
export const SYNC_LOG_MAX = 400;
/** The file's name in the device's box (`SecureBox`). */
export const SYNC_LOG_NAME = 'synclog';
/** A read over data older than this is noted, with the age. */
export const SYNC_OLD_MS = 60_000;
/** A read that took longer than this is noted, whatever it read over. */
export const SYNC_SLOW_MS = 5_000;

export function syncLogText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    intro: t('data.syncLog.intro'),
    share: t('data.syncLog.share'),
    dialogTitle: t('data.syncLog.dialogTitle'),
    empty: t('data.syncLog.empty'),
  } as const;
}
export const SYNC_LOG_TEXT = syncLogText();

export interface SyncEntry {
  at: number;
  text: string;
}

export interface SyncLog {
  note(text: string): void;
  entries(): readonly SyncEntry[];
  /** Notes from an earlier run, merged in by time (the newest `max` stay). */
  prepend(earlier: readonly SyncEntry[]): void;
  /** Leaving a Whombat or its account: its notes go with its other data. */
  clear(): void;
}

export function createSyncLog(now: () => number = Date.now, max: number = SYNC_LOG_MAX): SyncLog {
  let list: SyncEntry[] = [];
  const trim = () => {
    if (list.length > max) list = list.slice(list.length - max);
  };
  return {
    note(text) {
      list.push({ at: now(), text });
      trim();
    },
    entries: () => list,
    clear() {
      list = [];
    },
    prepend(earlier) {
      if (!Array.isArray(earlier)) return;
      // Each Whombat's copy holds the whole log of the runs it was saved in: a note two copies hold counts once.
      const seen = new Set(list.map((e) => `${e.at} ${e.text}`));
      const ok = earlier.filter(
        (e) =>
          e &&
          typeof e.at === 'number' &&
          typeof e.text === 'string' &&
          e.text.length <= 300 &&
          !seen.has(`${e.at} ${e.text}`),
      );
      list = [...ok, ...list].sort((a, b) => a.at - b.at);
      trim();
    },
  };
}

/** The app's own log, one for the process: it outlives a switch between Whombats. */
export const syncLog = createSyncLog();

/** How long ago, short: `45 s`, `12 min`, `3 h 5 min`, `4 d 3 h`. */
export function shortAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** A read by its endpoint and the ids that tell its calls apart (`messages.list cnv_E09ut0t8XtZl`). */
export function readName(query: Pick<Query, 'queryKey'>): string {
  const key = parseKey(query.queryKey);
  if (!key) return String(query.queryKey[1] ?? 'read');
  const ids = Object.entries(key.params)
    .filter(([k, v]) => k !== 'burrow' && (typeof v === 'string' || typeof v === 'number'))
    .map(([, v]) => String(v).slice(0, 32));
  return [key.endpointId, ...ids].join(' ');
}

/** What a failure says: its code or status, else its kind; never more than a short line. */
function failureText(error: unknown): string {
  const e = error as { code?: unknown; status?: unknown; name?: unknown; message?: unknown } | null;
  const parts = [
    typeof e?.name === 'string' && e.name !== 'Error' ? e.name : null,
    typeof e?.status === 'number' ? String(e.status) : null,
    typeof e?.code === 'string' ? e.code : null,
  ].filter(Boolean);
  if (parts.length) return parts.join(' ').slice(0, 80);
  return typeof e?.message === 'string' ? e.message.slice(0, 80) : 'failed';
}

/** Why a read asked now is worth noting, or null for a routine one. */
function owed(state: Query['state'], now: number): string | null {
  if (state.data === undefined) return null;
  const why: string[] = [];
  const age = now - state.dataUpdatedAt;
  if (age >= SYNC_OLD_MS) why.push(`data ${shortAge(age)} old`);
  if (state.isInvalidated) why.push('marked to read again');
  if (state.status === 'error') why.push('failed before');
  return why.length ? why.join(', ') : null;
}

/** Notes the reads worth knowing about as they are asked, answered and fail; returns the stop function. */
export function watchReads(cache: QueryCache, log: SyncLog, now: () => number = Date.now): () => void {
  const asked = new Map<string, { at: number; why: string | null }>();
  return cache.subscribe((event) => {
    if (event.type === 'removed') {
      asked.delete(event.query.queryHash);
      return;
    }
    if (event.type !== 'updated') return;
    const { query, action } = event;
    if (action.type === 'fetch') {
      const why = owed(query.state, now());
      asked.set(query.queryHash, { at: now(), why });
      if (why) log.note(`ask ${readName(query)} · ${why}`);
      return;
    }
    if (action.type === 'success' && !action.manual) {
      const was = asked.get(query.queryHash);
      asked.delete(query.queryHash);
      const took = was ? now() - was.at : null;
      if (was?.why || (took !== null && took >= SYNC_SLOW_MS))
        log.note(`answer ${readName(query)}${took !== null ? ` · ${seconds(took)}` : ''}`);
      return;
    }
    if (action.type === 'error') {
      const was = asked.get(query.queryHash);
      asked.delete(query.queryHash);
      const took = was ? ` after ${seconds(now() - was.at)}` : '';
      log.note(`failed ${readName(query)}${took} · ${failureText(action.error)}`);
    }
  });
}

/**
 * The text file the person shares: what it is, which app and Whombat, then a note a line, oldest first. It stays in
 * English whatever the phone's language, like the notes in it: it is read by whoever helps.
 */
export function syncLogFile(input: { entries: readonly SyncEntry[]; app: string; whombat: string }): string {
  const lines = input.entries.map((e) => `${new Date(e.at).toISOString()} ${e.text}`);
  return [
    'Whombat sync log',
    `App: ${input.app}`,
    `Whombat: ${input.whombat}`,
    'Times in UTC.',
    '',
    ...(lines.length ? lines : [SYNC_LOG_TEXT.empty]),
    '',
  ].join('\n');
}
