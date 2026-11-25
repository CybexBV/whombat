/**
 * Looks ahead in Settings (docs/decisions/looks-ahead.md): `looksAhead.get` reads the switch, every calendar of the
 * person's accounts with whether it is read, the kinds of finding they stopped and the last week; `looksAhead.update`
 * changes one of them and answers the same view. The assistant reads and changes it as the person asks
 * (`ASSISTANT_SETTINGS`).
 */
import { AHEAD_KINDS, api, type LooksAheadCalendar, type LooksAheadView } from '@whombat/core';
import { and, eq, gte, sql } from 'drizzle-orm';
import { aheadChecks } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { commitAs } from '../routes/burrows';
import { type RouteDef, route } from '../routes/define';
import type { Services } from '../services';
import { accountCalendars, calendarAccounts, calendarIsOn, calendarKey } from './calendars';
import { aheadSettingsOf, updateLooksAhead } from './commands';

const WEEK_MS = 7 * 24 * 3600_000;

/** What Settings shows. */
export async function looksAheadView(services: Services, burrowId: string): Promise<LooksAheadView> {
  const settings = await aheadSettingsOf(services.db, burrowId);
  const person = await thePerson(services.db, burrowId);
  const accounts = person?.accountId ? await calendarAccounts(services.db, person.accountId) : [];
  let read = accounts.length > 0;
  const calendars: LooksAheadCalendar[] = [];
  for (const account of accounts) {
    const list = await accountCalendars(services, account).catch(() => null);
    if (!list) {
      read = false;
      continue;
    }
    for (const c of list) {
      const key = calendarKey(account.connectionId, c.id);
      calendars.push({
        key,
        name: (c.primary ? account.email : c.name).slice(0, 120),
        account: account.email.slice(0, 320),
        on: calendarIsOn(key, c, settings),
        primary: c.primary,
      });
    }
  }
  const since = new Date(services.clock().getTime() - WEEK_MS);
  const [week] = await services.db
    .select({
      checked: sql<number>`count(*) filter (where ${aheadChecks.state} in ('quiet', 'told'))::int`,
      told: sql<number>`count(*) filter (where ${aheadChecks.state} = 'told')::int`,
    })
    .from(aheadChecks)
    .where(and(eq(aheadChecks.burrowId, burrowId), gte(aheadChecks.startedAt, since)));
  return {
    on: settings.on,
    calendars: calendars.slice(0, 100),
    calendarsRead: read,
    hasCalendar: accounts.length > 0,
    stopped: AHEAD_KINDS.filter((k) => settings.stopped.includes(k)),
    week: { checked: week?.checked ?? 0, told: week?.told ?? 0 },
  };
}

export const looksAheadRoutes: RouteDef[] = [
  route(api.looksAhead.get, async ({ services, access }) => looksAheadView(services, access.burrow.id)),
  route(api.looksAhead.update, async (ctx) => {
    await commitAs(ctx, updateLooksAhead, ctx.body);
    return looksAheadView(ctx.services, ctx.access.burrow.id);
  }),
];
