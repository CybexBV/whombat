/**
 * The calendars Looks ahead reads (docs/decisions/looks-ahead.md): every calendar of the person's Google and Microsoft
 * 365 accounts that is on. By default the ones they can add to and show (their own, a shared Family calendar), never a
 * subscription like holidays or birthdays; the person switches any of them in Settings.
 */
import type { CalendarEvent, CalendarInfo } from '@whombat/core';
import { and, eq, inArray } from 'drizzle-orm';
import { providerWorkspace } from '../connectors/providers';
import { GoogleApiError } from '../connectors/types';
import type { Db, Tx } from '../db/client';
import { connections } from '../db/schema/index';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { withAccountToken } from '../things/accounts/reads';

/** A Google or Microsoft 365 account of the person's with its calendar connected. */
export interface CalendarAccount {
  connectionId: string;
  accountId: string;
  provider: 'google' | 'microsoft';
  email: string;
}

/** The person's setting, as it bears on calendars and kinds. */
export interface AheadSettings {
  on: boolean;
  calendarsOff: readonly string[];
  calendarsOn: readonly string[];
  stopped: readonly string[];
}

/** How long an account's list of calendars is kept: it changes rarely. */
const LIST_KEEP_MS = 30 * 60_000;
/** Events read per calendar and pass. */
const EVENTS_PER_CALENDAR = 50;

/** `<connection id>:<calendar id>`: one calendar, whichever account it is in. */
export function calendarKey(connectionId: string, calendarId: string): string {
  return `${connectionId}:${calendarId}`;
}

/**
 * One event, whichever calendar of the account shows it: its iCalendar id where the provider gives one (an event on the
 * person's calendar and the family's is one event), else `<calendar id>:<event id>`; after the connection's id.
 */
export function eventKey(
  connectionId: string,
  event: { calendarId: string; id: string; uid?: string | undefined },
): string {
  return event.uid ? `${connectionId}:uid:${event.uid}` : `${connectionId}:${event.calendarId}:${event.id}`;
}

/** On by default: the main calendar, and any other the person can add to and shows. */
export function calendarOnByDefault(c: Pick<CalendarInfo, 'primary' | 'writable' | 'hidden'>): boolean {
  return c.primary || (c.writable && !c.hidden);
}

/** Whether a calendar is read: the person's own choice, else the default. */
export function calendarIsOn(
  key: string,
  c: Pick<CalendarInfo, 'primary' | 'writable' | 'hidden'>,
  settings: Pick<AheadSettings, 'calendarsOff' | 'calendarsOn'>,
): boolean {
  if (settings.calendarsOff.includes(key)) return false;
  if (settings.calendarsOn.includes(key)) return true;
  return calendarOnByDefault(c);
}

/** The person's accounts with a working calendar. */
export async function calendarAccounts(db: Db | Tx, accountId: string): Promise<CalendarAccount[]> {
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.accountId, accountId), inArray(connections.provider, ['google', 'microsoft'])));
  return rows.flatMap((r) =>
    r.status === 'active' &&
    r.services.includes('calendar') &&
    (r.provider === 'google' || r.provider === 'microsoft')
      ? [{ connectionId: r.id, accountId, provider: r.provider, email: r.email }]
      : [],
  );
}

const lists = new WeakMap<Services, Map<string, { at: number; list: CalendarInfo[] }>>();

/** An account's calendars, kept a while. Throws when the provider can't be read. */
export async function accountCalendars(
  services: Services,
  account: CalendarAccount,
): Promise<CalendarInfo[]> {
  let kept = lists.get(services);
  if (!kept) {
    kept = new Map();
    lists.set(services, kept);
  }
  const now = services.clock().getTime();
  const held = kept.get(account.connectionId);
  if (held && now - held.at < LIST_KEEP_MS) return held.list;
  const list = await withAccountToken(services, account.accountId, account.provider, (token) =>
    providerWorkspace(services, account.provider).calendarList(token),
  );
  kept.set(account.connectionId, { at: now, list });
  return list;
}

/** One event as the provider has it now, or null when it is gone. Throws when the provider can't be read. */
export async function currentEvent(
  services: Services,
  account: CalendarAccount,
  calendarId: string,
  eventId: string,
): Promise<CalendarEvent | null> {
  try {
    return await withAccountToken(services, account.accountId, account.provider, (token) =>
      providerWorkspace(services, account.provider).calendarGetEvent(token, { calendarId, eventId }),
    );
  } catch (err) {
    const gone =
      err instanceof GoogleApiError
        ? err.status === 404 || err.status === 410 || err.reason === 'not_found'
        : err instanceof ApiError && err.code === 'not_found';
    if (gone) return null;
    throw err;
  }
}

/** The events on one calendar between two moments. Throws when the provider can't be read. */
export function calendarEventsBetween(
  services: Services,
  account: CalendarAccount,
  calendarId: string,
  from: Date,
  to: Date,
): Promise<CalendarEvent[]> {
  return withAccountToken(services, account.accountId, account.provider, (token) =>
    providerWorkspace(services, account.provider).calendarEvents(token, {
      calendarId,
      from: from.toISOString(),
      to: to.toISOString(),
      limit: EVENTS_PER_CALENDAR,
    }),
  );
}
