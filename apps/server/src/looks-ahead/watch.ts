/**
 * Looks ahead's watcher (docs/decisions/looks-ahead.md): a home job every five minutes, per Whombat with a person. It
 * tidies (checks that failed, threads of events that passed, old rows), then — while Looks ahead is on, within the
 * day's hours and budgets, with a turn of the person's ready to run and no check going on — reads the calendars that
 * are on and begins the check of the soonest due event (`planAheadPass`). Whombat wakes the assistant: it never wakes
 * itself.
 */
import {
  AHEAD_CHECKS_PER_DAY,
  AHEAD_FINDINGS_PER_DAY,
  AHEAD_READ_MS,
  type AheadChecked,
  aheadHours,
  aheadSkip,
  aheadVersion,
  type CalendarEvent,
  planAheadPass,
} from '@whombat/core';
import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { aheadChecks, burrows, dispatches } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { startOfLocalDay } from '../home/time';
import { agentRuntimeOf, loadAgentRow, type PrincipalRow } from '../read/principals';
import { providerReadiness } from '../runtime/readiness';
import type { Services } from '../services';
import {
  accountCalendars,
  type CalendarAccount,
  calendarAccounts,
  calendarIsOn,
  calendarKey,
  eventKey,
  upcomingEvents,
} from './calendars';
import {
  type AheadEventInput,
  aheadSettingsOf,
  CHECKING_MAX_MS,
  CHECKS_KEEP_MS,
  findingsSince,
  SETTLE_AFTER_MS,
  startAheadCheck,
  tidyAhead,
} from './commands';
import { keyAllowed } from './turn';

/** How often the watcher looks. */
export const AHEAD_WATCH_MS = 5 * 60_000;

export interface AheadWatchOptions {
  /** Tests: whether a turn of the person's could run now (else the provider's readiness). */
  ready?: (agent: PrincipalRow, person: PrincipalRow) => Promise<boolean>;
}

/** An event the watcher may check, with what the check is told. */
interface Found {
  key: string;
  version: string;
  start: string;
  event: AheadEventInput;
}

/** Whether there is anything to tidy, read cheaply so a quiet Whombat commits nothing. */
async function tidyDue(services: Services, burrowId: string, now: Date): Promise<boolean> {
  const [row] = await services.db
    .select({ id: aheadChecks.id })
    .from(aheadChecks)
    .where(
      and(
        eq(aheadChecks.burrowId, burrowId),
        or(
          eq(aheadChecks.state, 'checking'),
          and(
            eq(aheadChecks.state, 'told'),
            isNull(aheadChecks.settledAt),
            lt(aheadChecks.endAt, new Date(now.getTime() - SETTLE_AFTER_MS)),
          ),
          lt(aheadChecks.endAt, new Date(now.getTime() - CHECKS_KEEP_MS)),
        ),
      ),
    )
    .limit(1);
  if (row) return true;
  // A check that ended whose Hermes session is still there.
  const [ended] = await services.db
    .select({ id: dispatches.id })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.burrowId, burrowId),
        eq(dispatches.trigger, 'ahead'),
        inArray(dispatches.state, ['done', 'failed', 'cancelled']),
        isNotNull(dispatches.providerSessionId),
      ),
    )
    .limit(1);
  return !!ended;
}

/** The events on the calendars that are on, from now to `AHEAD_READ_MS` ahead, that are ones to check. */
async function upcoming(
  services: Services,
  accounts: readonly CalendarAccount[],
  settings: Awaited<ReturnType<typeof aheadSettingsOf>>,
  now: Date,
  timeZone: string,
): Promise<Found[]> {
  const out = new Map<string, Found>();
  for (const account of accounts) {
    const calendars = await accountCalendars(services, account).catch((err) => {
      services.log.warn(
        { err: String(err), connectionId: account.connectionId },
        'looks ahead: calendars unread',
      );
      return [];
    });
    for (const calendar of calendars) {
      if (!calendarIsOn(calendarKey(account.connectionId, calendar.id), calendar, settings)) continue;
      const events: CalendarEvent[] = await upcomingEvents(
        services,
        account,
        calendar.id,
        now,
        AHEAD_READ_MS,
      ).catch((err) => {
        services.log.warn(
          { err: String(err), connectionId: account.connectionId },
          'looks ahead: events unread',
        );
        return [];
      });
      for (const event of events) {
        if (aheadSkip(event)) continue;
        const key = eventKey(account.connectionId, { ...event, calendarId: calendar.id });
        // One event on two calendars (the person's and the family's) is checked once: by its iCalendar id, else by
        // its provider id and the moment it starts.
        const same = event.uid ? key : `${event.id}\n${Date.parse(event.start)}`;
        if (out.has(same)) continue;
        const version = aheadVersion(event);
        out.set(same, {
          key,
          version,
          start: event.start,
          event: {
            key,
            version,
            connectionId: account.connectionId,
            calendarId: calendar.id,
            eventId: event.id,
            guests: event.guests
              .flatMap((g) => [g.email, ...(g.name ? g.name.split(/\s+/) : [])])
              .filter(Boolean)
              .slice(0, 100),
            summary: event.summary.slice(0, 300),
            location: event.location.slice(0, 500),
            description: event.description.slice(0, 2000),
            calendar: (calendar.primary ? 'Your calendar' : calendar.name).slice(0, 120),
            start: event.start,
            end: event.end,
            timeZone,
          },
        });
      }
    }
  }
  return [...out.values()];
}

/** One pass for one Whombat. The check it began, or null. */
export async function watchAhead(
  services: Services,
  burrowId: string,
  options: AheadWatchOptions = {},
): Promise<string | null> {
  const now = services.clock();
  const [burrow] = await services.db.select().from(burrows).where(eq(burrows.id, burrowId));
  const person = await thePerson(services.db, burrowId);
  const agent = await loadAgentRow(services.db, burrowId);
  if (!burrow || !person?.accountId || !agent) return null;
  const as = { burrowId, actorId: agent.id };
  if (await tidyDue(services, burrowId, now)) await services.pipeline.commit(tidyAhead, {}, as);
  const settings = await aheadSettingsOf(services.db, burrowId);
  const timeZone = burrow.timeZone;
  if (!settings.on || !aheadHours(now, timeZone)) return null;
  // The day's budgets and one at a time, before anything is read.
  const dayStart = startOfLocalDay(now, timeZone);
  const [counts] = await services.db
    .select({
      today: sql<number>`count(*) filter (where ${aheadChecks.startedAt} >= ${dayStart.toISOString()}::timestamptz)::int`,
      busy: sql<number>`count(*) filter (where ${aheadChecks.state} = 'checking')::int`,
    })
    .from(aheadChecks)
    .where(eq(aheadChecks.burrowId, burrowId));
  const checksToday = counts?.today ?? 0;
  const findingsToday = await findingsSince(services.db, burrowId, dayStart);
  if (
    (counts?.busy ?? 0) > 0 ||
    checksToday >= AHEAD_CHECKS_PER_DAY ||
    findingsToday >= AHEAD_FINDINGS_PER_DAY
  )
    return null;
  // The calendar is read only where its key is Allowed: an assistant that must ask first doesn't read it by itself.
  if (!(await keyAllowed(services, agent.id, 'calendar.read'))) return null;
  const accounts = await calendarAccounts(services.db, person.accountId);
  if (!accounts.length) return null;
  const ready = options.ready
    ? await options.ready(agent, person)
    : (await providerReadiness(services, agent, agentRuntimeOf(agent.runtime).provider, person)).ok;
  if (!ready) return null;
  const found = await upcoming(services, accounts, settings, now, timeZone);
  if (!found.length) return null;
  const checked: AheadChecked[] = (
    await services.db
      .select({ key: aheadChecks.eventKey, version: aheadChecks.version, state: aheadChecks.state })
      .from(aheadChecks)
      .where(
        and(
          eq(aheadChecks.burrowId, burrowId),
          inArray(
            aheadChecks.eventKey,
            found.map((f) => f.key),
          ),
          gte(aheadChecks.startedAt, new Date(now.getTime() - CHECKS_KEEP_MS)),
        ),
      )
  ).map((r) => ({ key: r.key, version: r.version, found: r.state === 'told' }));
  const next = planAheadPass({
    candidates: found.map((f) => ({ key: f.key, version: f.version, start: f.start })),
    checked,
    checksToday,
    findingsToday,
    busy: false,
    ready,
    now,
    timeZone,
  });
  const pick = next ? found.find((f) => f.key === next.key && f.version === next.version) : null;
  if (!pick) return null;
  const res = await services.pipeline.commit(startAheadCheck, { event: pick.event, personId: person.id }, as);
  return res.status === 'ok' ? (res.result?.checkId ?? null) : null;
}

/** The job: every Whombat with a person, one after another. */
export class AheadWatcher {
  constructor(
    private readonly services: Services,
    private readonly options: AheadWatchOptions = {},
  ) {}

  async pass(): Promise<void> {
    const rows = await this.services.db.select({ id: burrows.id }).from(burrows);
    for (const { id } of rows)
      await watchAhead(this.services, id, this.options).catch((err) =>
        this.services.log.warn({ err: String(err), burrowId: id }, 'looks ahead: the pass failed'),
      );
  }
}

/** The longest a check may take before the watcher calls it failed (for tests and the docs). */
export const AHEAD_CHECK_MAX_MS = CHECKING_MAX_MS;
