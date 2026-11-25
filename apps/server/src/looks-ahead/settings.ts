/**
 * Looks ahead in Settings (docs/decisions/looks-ahead.md): `looksAhead.get` reads the switch, calendars, incoming mail
 * switch, standing rules, stopped kinds, last week and recent checks; `looksAhead.update` changes one setting and
 * answers the same view; `looksAhead.checkNow` runs one immediate fresh pass and returns `{ started, view }`.
 */
import {
  AHEAD_KINDS,
  AHEAD_RECENT_MAX,
  api,
  type LooksAheadCalendar,
  type LooksAheadCheckItem,
  type LooksAheadView,
} from '@whombat/core';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { aheadChecks } from '../db/schema/index';
import { isThePerson, thePerson } from '../domain/the-person';
import { forbidden } from '../lib/errors';
import { commitAs } from '../routes/burrows';
import { type RouteDef, route } from '../routes/define';
import type { Services } from '../services';
import { accountCalendars, calendarAccounts, calendarIsOn, calendarKey } from './calendars';
import { aheadSettingsOf, updateLooksAhead } from './commands';
import { mailAccounts } from './mail';
import { checkAheadNow } from './watch';

const WEEK_MS = 7 * 24 * 3600_000;

/** What Settings shows. */
export async function looksAheadView(services: Services, burrowId: string): Promise<LooksAheadView> {
  const settings = await aheadSettingsOf(services.db, burrowId);
  const person = await thePerson(services.db, burrowId);
  const accounts = person?.accountId ? await calendarAccounts(services.db, person.accountId) : [];
  const mailboxes = person?.accountId ? await mailAccounts(services, services.db, person.accountId) : [];
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
        // A main calendar is often called by its address, which its line already says.
        name: (c.primary && (!c.name || c.name === account.email) ? 'Calendar' : c.name).slice(0, 120),
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

  const rows = await services.db
    .select({
      id: aheadChecks.id,
      source: aheadChecks.source,
      stage: aheadChecks.stage,
      summary: aheadChecks.summary,
      startedAt: aheadChecks.startedAt,
      state: aheadChecks.state,
      kind: aheadChecks.kind,
      threadRootId: aheadChecks.threadRootId,
      feedback: aheadChecks.feedback,
    })
    .from(aheadChecks)
    .where(eq(aheadChecks.burrowId, burrowId))
    .orderBy(desc(aheadChecks.startedAt))
    .limit(AHEAD_RECENT_MAX);

  const recent: LooksAheadCheckItem[] = rows.map((r) => ({
    id: r.id,
    source: r.source,
    stage: r.stage,
    title: r.summary.slice(0, 300),
    at: r.startedAt.toISOString(),
    state: r.state,
    kind: r.kind,
    threadRootId: r.state === 'told' ? r.threadRootId : null,
    feedback: r.feedback,
  }));

  return {
    on: settings.on,
    calendars: calendars.slice(0, 100),
    calendarsRead: read,
    hasCalendar: accounts.length > 0,
    mailOn: settings.mailOn,
    hasMail: mailboxes.length > 0,
    rules: [...settings.rules],
    stopped: AHEAD_KINDS.filter((k) => settings.stopped.includes(k)),
    week: { checked: week?.checked ?? 0, told: week?.told ?? 0 },
    recent,
  };
}

export const looksAheadRoutes: RouteDef[] = [
  route(api.looksAhead.get, async ({ services, access }) => looksAheadView(services, access.burrow.id)),
  route(api.looksAhead.update, async (ctx) => {
    await commitAs(ctx, updateLooksAhead, ctx.body);
    return looksAheadView(ctx.services, ctx.access.burrow.id);
  }),
  route(api.looksAhead.checkNow, async ({ services, access }) => {
    if (!(await isThePerson(services.db, access.burrow.id, access.principal.id)))
      throw forbidden('Only you can start a Looks ahead check.');
    const started = await checkAheadNow(services, access.burrow.id);
    return { started, view: await looksAheadView(services, access.burrow.id) };
  }),
];
