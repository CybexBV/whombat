/**
 * What a person's Google, Microsoft 365 or Email account is read for, kept once for everyone who shows it: the
 * account's page and the desk's widgets ask for the same calendar and unread mail, so each is read once per keep. Read
 * with the person's own token (one refresh on a 401, as the connector tools do). A read that fails isn't kept: the
 * next asker tries again.
 *
 * Kept: today's calendar 5 minutes, unread mail (the count and the newest five) 2 minutes, how full the storage is an
 * hour, Drive's newest changed files 10 minutes.
 */
import type { CalendarEvent, ConnectorProvider } from '@whombat/core';
import { providerWorkspace } from '../../connectors/providers';
import {
  ConnectionUnavailableError,
  type FilesQuota,
  GoogleApiError,
  type InboxUnread,
  type RecentFile,
} from '../../connectors/types';
import type { Services } from '../../services';
import { recordAccountUptime } from '../points';

/** How long each read is kept (ms). */
export const ACCOUNT_READ_KEEP_MS = {
  calendar: 5 * 60_000,
  unread: 2 * 60_000,
  quota: 60 * 60_000,
  recent: 10 * 60_000,
} as const;
export type AccountRead = keyof typeof ACCOUNT_READ_KEEP_MS;

/** The newest unread mails read with the count. */
export const UNREAD_NEWEST = 5;
/** Today's calendar items read at most. */
const CALENDAR_LIMIT = 50;
/** Drive's newest changed files read. */
export const RECENT_FILES = 5;
/** Reads kept at most, the oldest dropped first. */
const KEPT_MAX = 500;

/** A read and when it was made. */
export interface Held<T> {
  value: T;
  at: Date;
}

/** The connection a read is for. */
export interface AccountRef {
  id: string;
  provider: ConnectorProvider;
}

interface Entry {
  value: unknown;
  at: number;
  until: number;
}

/** Reads kept by key, one going at a time per key. */
class Kept {
  readonly #entries = new Map<string, Entry>();
  readonly #pending = new Map<string, Promise<Held<unknown>>>();

  constructor(private readonly clock: () => number) {}

  peek<T>(key: string): Held<T> | null {
    const e = this.#entries.get(key);
    if (!e || this.clock() >= e.until) return null;
    return { value: e.value as T, at: new Date(e.at) };
  }

  async get<T>(key: string, keepMs: number, read: () => Promise<T>): Promise<Held<T>> {
    const held = this.peek<T>(key);
    if (held) return held;
    let pending = this.#pending.get(key) as Promise<Held<T>> | undefined;
    if (!pending) {
      pending = read()
        .then((value) => {
          const at = this.clock();
          this.#entries.delete(key);
          if (this.#entries.size >= KEPT_MAX) {
            const oldest = this.#entries.keys().next().value;
            if (oldest !== undefined) this.#entries.delete(oldest);
          }
          this.#entries.set(key, { value, at, until: at + keepMs });
          return { value, at: new Date(at) };
        })
        .finally(() => this.#pending.delete(key));
      this.#pending.set(key, pending as Promise<Held<unknown>>);
    }
    return pending;
  }
}

const kepts = new WeakMap<Services, Kept>();

function keptOf(services: Services): Kept {
  let k = kepts.get(services);
  if (!k) {
    k = new Kept(() => services.clock().getTime());
    kepts.set(services, k);
  }
  return k;
}

/** A call with the person's token, once more with a fresh one when the provider refused it (HTTP 401). */
export async function withAccountToken<T>(
  services: Services,
  accountId: string,
  provider: ConnectorProvider,
  call: (token: string) => Promise<T>,
): Promise<T> {
  const token = await services.google.tokens.accessFor(accountId, provider);
  try {
    return await call(token);
  } catch (err) {
    if (!(err instanceof GoogleApiError && err.reason === 'unauthorized')) throw err;
    return call(await services.google.tokens.accessFor(accountId, provider, { forceRefresh: true }));
  }
}

const keyOf = (read: AccountRead, connectionId: string, extra = '') =>
  `${read}\n${connectionId}${extra ? `\n${extra}` : ''}`;

/** Reads the provider itself. Local token trouble and reads served from the cache say nothing about uptime. */
async function readAccount<T>(
  services: Services,
  accountId: string,
  row: AccountRef,
  read: (token: string) => Promise<T>,
): Promise<T> {
  let up: 0 | 1 | undefined;
  try {
    return await withAccountToken(services, accountId, row.provider, async (token) => {
      try {
        const value = await read(token);
        up = 1;
        return value;
      } catch (err) {
        if (err instanceof GoogleApiError && err.reason === 'unauthorized') up = 1;
        else if (!(err instanceof ConnectionUnavailableError)) up ??= 0;
        throw err;
      }
    });
  } finally {
    if (up !== undefined) await recordAccountUptime(services, { connectionId: row.id }, up);
  }
}

/** The cheap unread count the health pass uses without opening any messages. */
export async function accountUnreadCount(
  services: Services,
  accountId: string,
  row: AccountRef,
): Promise<number> {
  return readAccount(
    services,
    accountId,
    row,
    async (token) => (await providerWorkspace(services, row.provider).inboxUnread(token)).count,
  );
}

/** Today's calendar items of an account, `window` the start of today to the start of tomorrow in the zone. */
export function accountCalendar(
  services: Services,
  accountId: string,
  row: AccountRef,
  window: { from: string; to: string },
): Promise<Held<CalendarEvent[]>> {
  return keptOf(services).get(
    keyOf('calendar', row.id, `${window.from}\n${window.to}`),
    ACCOUNT_READ_KEEP_MS.calendar,
    () =>
      readAccount(services, accountId, row, (token) =>
        providerWorkspace(services, row.provider).calendarEvents(token, {
          calendarId: 'primary',
          from: window.from,
          to: window.to,
          limit: CALENDAR_LIMIT,
        }),
      ),
  );
}

/** Its inbox's unread count and the newest five. */
export function accountUnread(
  services: Services,
  accountId: string,
  row: AccountRef,
): Promise<Held<InboxUnread>> {
  return keptOf(services).get(keyOf('unread', row.id), ACCOUNT_READ_KEEP_MS.unread, () =>
    readAccount(services, accountId, row, (token) =>
      providerWorkspace(services, row.provider).inboxUnread(token, { newest: UNREAD_NEWEST }),
    ),
  );
}

/** How full its Drive or OneDrive is. */
export function accountQuota(
  services: Services,
  accountId: string,
  row: AccountRef,
): Promise<Held<FilesQuota>> {
  return keptOf(services).get(keyOf('quota', row.id), ACCOUNT_READ_KEEP_MS.quota, () =>
    readAccount(services, accountId, row, (token) =>
      providerWorkspace(services, row.provider).filesQuota(token),
    ),
  );
}

/** Drive's newest changed files (Google only). */
export function accountRecentFiles(
  services: Services,
  accountId: string,
  row: AccountRef,
): Promise<Held<RecentFile[]>> {
  return keptOf(services).get(keyOf('recent', row.id), ACCOUNT_READ_KEEP_MS.recent, () =>
    readAccount(services, accountId, row, (token) =>
      providerWorkspace(services, row.provider).filesRecent(token, { limit: RECENT_FILES }),
    ),
  );
}

/** How full its storage was at the last read still kept, without reading (Home and Ignore read it often). */
export function heldQuota(services: Services, connectionId: string): Held<FilesQuota> | null {
  return keptOf(services).peek<FilesQuota>(keyOf('quota', connectionId));
}

/** When a calendar or unread read still kept was made (the desk counts its keep from it); null without one. */
export function heldAt(
  services: Services,
  read: 'calendar' | 'unread',
  connectionId: string,
  window?: { from: string; to: string },
): Date | null {
  const extra = read === 'calendar' && window ? `${window.from}\n${window.to}` : '';
  return keptOf(services).peek(keyOf(read, connectionId, extra))?.at ?? null;
}
