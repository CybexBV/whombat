/**
 * Looks ahead's watcher (docs/decisions/looks-ahead.md): a home job every five minutes, per Whombat with a person. It
 * tidies (checks that failed, threads of events that passed, old rows), then — while Looks ahead is on, within the
 * day's hours and budgets, with a turn of the person's ready to run and no check going on — reads the calendars that
 * are on (up to 7 days ahead across early / eve / morning stages, carrying same-day schedule context) and incoming
 * mail across Google, Microsoft 365 and Email/IMAP (when mailOn is on), then begins the highest-priority due check
 * (`planAheadPass`). Also exposes `checkAheadNow` for an on-demand fresh pass from Settings.
 */
import {
  AHEAD_CHECKS_PER_DAY,
  AHEAD_FINDINGS_PER_DAY,
  AHEAD_MAIL_CALENDAR_MS,
  AHEAD_READ_MS,
  type AheadCandidate,
  type AheadChecked,
  type AheadScheduleEntry,
  type AheadStage,
  aheadPriority,
  aheadSkip,
  aheadStage,
  aheadStageVersion,
  aheadStartHours,
  aheadVersion,
  type CalendarEvent,
  planAheadPass,
} from '@whombat/core';
import { zonedParts } from '@whombat/core/text';
import { and, eq, gte, inArray, isNull, like, lt, or, sql } from 'drizzle-orm';
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
import { mailAccounts, upcomingMailCandidates } from './mail';
import { keyAllowed } from './turn';

/** How often the watcher looks. */
export const AHEAD_WATCH_MS = 5 * 60_000;

export interface AheadWatchOptions {
  /** Tests: whether a turn of the person's could run now (else the provider's readiness). */
  ready?: (agent: PrincipalRow, person: PrincipalRow) => Promise<boolean>;
  /** Bypass the 15-minute calendar/mail caches (`looksAhead.checkNow`). */
  fresh?: boolean;
}

/** An item the watcher may check, with what the check is told. */
interface Found {
  candidate: AheadCandidate;
  event: AheadEventInput;
}

/** Local YYYY-MM-DD key for grouping same-day schedule context. */
function localDateKey(start: string, allDay: boolean, timeZone: string): string {
  if (allDay && /^\d{4}-\d{2}-\d{2}/.test(start)) return start.slice(0, 10);
  try {
    const p = zonedParts(start, timeZone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  } catch {
    return start.slice(0, 10);
  }
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
        like(dispatches.providerSessionId, 'hermes:%'),
      ),
    )
    .limit(1);
  return !!ended;
}

/** One raw accepted event collected from enabled calendars (used both as check candidate and for same-day schedule). */
interface TrustedEvent {
  same: string;
  key: string;
  calendarName: string;
  account: CalendarAccount;
  calendarId: string;
  event: CalendarEvent;
  dayKey: string;
}

/** Reads all enabled calendars once, returning both eligible check candidates and trusted schedule summaries. */
async function upcomingCalendar(
  services: Services,
  accounts: readonly CalendarAccount[],
  settings: Awaited<ReturnType<typeof aheadSettingsOf>>,
  now: Date,
  timeZone: string,
  aheadMs: number,
  fresh = false,
): Promise<{ found: Found[]; schedule: AheadScheduleEntry[] }> {
  const trusted = new Map<string, TrustedEvent>();
  const rejected = new Set<string>();
  const skipCheck = new Set<string>();

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
        aheadMs,
        fresh,
      ).catch((err) => {
        services.log.warn(
          { err: String(err), connectionId: account.connectionId },
          'looks ahead: events unread',
        );
        return [];
      });
      const calendarName = (calendar.primary ? 'Your calendar' : calendar.name).slice(0, 120);
      for (const event of events) {
        const key = eventKey(account.connectionId, { ...event, calendarId: calendar.id });
        const same = event.uid ? key : `${event.id}\n${Date.parse(event.start)}`;
        if (rejected.has(same)) continue;
        // Never trust declined, unanswered (stranger invites) or cancelled events anywhere — not even in daySchedule.
        if (event.cancelled || event.response === 'declined' || event.response === 'needs_action') {
          rejected.add(same);
          trusted.delete(same);
          continue;
        }
        if (aheadSkip(event)) skipCheck.add(same);
        if (trusted.has(same)) continue;
        trusted.set(same, {
          same,
          key,
          calendarName,
          account,
          calendarId: calendar.id,
          event,
          dayKey: localDateKey(event.start, event.allDay, timeZone),
        });
      }
    }
  }

  // Group trusted events by local day so each check sees the rest of that day's trusted schedule.
  const byDay = new Map<string, TrustedEvent[]>();
  const allSchedule: AheadScheduleEntry[] = [];
  for (const item of trusted.values()) {
    const list = byDay.get(item.dayKey) ?? [];
    list.push(item);
    byDay.set(item.dayKey, list);
    allSchedule.push({
      summary: item.event.summary.slice(0, 300),
      start: item.event.start,
      end: item.event.end,
      location: item.event.location.slice(0, 300),
      calendar: item.calendarName,
      ...(item.event.allDay ? { allDay: true } : {}),
    });
  }
  allSchedule.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  const found: Found[] = [];
  for (const item of trusted.values()) {
    if (skipCheck.has(item.same)) continue;
    const stage = aheadStage({ start: item.event.start, allDay: item.event.allDay }, now, timeZone);
    if (!stage) continue;
    const rawVersion = aheadVersion(item.event);
    const stageVer = aheadStageVersion(rawVersion, stage);
    const daySchedule = (byDay.get(item.dayKey) ?? [])
      .filter((other) => other.same !== item.same)
      .sort((a, b) => Date.parse(a.event.start) - Date.parse(b.event.start))
      .slice(0, 15)
      .map((other) => ({
        summary: other.event.summary.slice(0, 300),
        start: other.event.start,
        end: other.event.end,
        location: other.event.location.slice(0, 300),
        calendar: other.calendarName,
        ...(other.event.allDay ? { allDay: true } : {}),
      }));
    const priority = aheadPriority({
      stage,
      summary: item.event.summary,
      location: item.event.location,
      allDay: item.event.allDay,
      recurringException: item.event.recurringException,
      hasDescription: Boolean(item.event.description.trim()),
    });
    found.push({
      candidate: {
        key: item.key,
        version: rawVersion,
        start: item.event.start,
        stage,
        source: 'calendar',
        allDay: item.event.allDay,
        priority,
      },
      event: {
        source: 'calendar',
        stage,
        key: item.key,
        version: stageVer,
        connectionId: item.account.connectionId,
        calendarId: item.calendarId,
        eventId: item.event.id,
        guests: item.event.guests
          .flatMap((g) => [g.email, ...(g.name ? g.name.split(/\s+/) : [])])
          .filter(Boolean)
          .slice(0, 100),
        summary: item.event.summary.slice(0, 300),
        location: item.event.location.slice(0, 500),
        description: item.event.description.slice(0, 2000),
        calendar: item.calendarName,
        start: item.event.start,
        end: item.event.end,
        timeZone,
        ...(item.event.allDay ? { allDay: true } : {}),
        ...(daySchedule.length ? { daySchedule } : {}),
      },
    });
  }

  return { found, schedule: allSchedule.slice(0, 30) };
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
  if (!settings.on || !aheadStartHours(now, timeZone)) return null;
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
  // A check's turn still at work (one past its two hours, hung) holds the next back too.
  const [working] = await services.db
    .select({ id: dispatches.id })
    .from(dispatches)
    .where(
      and(
        eq(dispatches.burrowId, burrowId),
        eq(dispatches.trigger, 'ahead'),
        inArray(dispatches.state, ['queued', 'claimed', 'running']),
      ),
    )
    .limit(1);
  if (working) return null;

  const [canReadCal, canReadMail] = await Promise.all([
    keyAllowed(services, agent.id, 'calendar.read'),
    keyAllowed(services, agent.id, 'mail.read'),
  ]);
  const calAccounts = canReadCal ? await calendarAccounts(services.db, person.accountId) : [];
  const mailboxes =
    settings.mailOn && canReadMail ? await mailAccounts(services, services.db, person.accountId) : [];
  if (!calAccounts.length && !mailboxes.length) return null;

  const ready = options.ready
    ? await options.ready(agent, person)
    : (await providerReadiness(services, agent, agentRuntimeOf(agent.runtime).provider, person)).ok;
  if (!ready) return null;

  const fresh = Boolean(options.fresh);
  // When mail checks are active, read 14 days of calendar once so mail checks can spot missing events cleanly.
  const calWindow = mailboxes.length ? AHEAD_MAIL_CALENDAR_MS : AHEAD_READ_MS;
  const calData = calAccounts.length
    ? await upcomingCalendar(services, calAccounts, settings, now, timeZone, calWindow, fresh)
    : { found: [], schedule: [] };

  const mailFound: Found[] = [];
  if (mailboxes.length) {
    const mailCandidates = await upcomingMailCandidates(services, mailboxes, settings.rules, now, fresh);
    for (const m of mailCandidates) {
      const stage: AheadStage = 'mail';
      mailFound.push({
        candidate: {
          key: m.key,
          version: m.version,
          start: m.start,
          stage,
          source: 'mail',
          priority: 2,
        },
        event: {
          source: 'mail',
          stage,
          key: m.key,
          version: aheadStageVersion(m.version, stage),
          connectionId: m.account.connectionId,
          calendarId: '',
          eventId: m.message.id,
          guests: [],
          summary: (m.message.subject || '(no subject)').slice(0, 300),
          location: '',
          description: m.message.snippet.slice(0, 2000),
          calendar: m.account.email.slice(0, 120),
          start: m.start,
          end: m.start,
          timeZone,
          ...(calData.schedule.length ? { daySchedule: calData.schedule } : {}),
          mail: {
            provider: m.account.provider,
            messageId: m.message.id,
            from: m.message.from.slice(0, 320),
            subject: (m.message.subject || '(no subject)').slice(0, 300),
            date: m.message.date.slice(0, 64),
            snippet: m.message.snippet.slice(0, 600),
          },
        },
      });
    }
  }

  const allFound = [...calData.found, ...mailFound];
  if (!allFound.length) return null;

  const checked: AheadChecked[] = (
    await services.db
      .select({
        key: aheadChecks.eventKey,
        version: aheadChecks.version,
        stage: aheadChecks.stage,
        state: aheadChecks.state,
      })
      .from(aheadChecks)
      .where(
        and(
          eq(aheadChecks.burrowId, burrowId),
          inArray(
            aheadChecks.eventKey,
            allFound.map((f) => f.candidate.key),
          ),
          gte(aheadChecks.startedAt, new Date(now.getTime() - CHECKS_KEEP_MS)),
        ),
      )
  ).map((r) => ({ key: r.key, version: r.version, stage: r.stage, found: r.state === 'told' }));

  const next = planAheadPass({
    candidates: allFound.map((f) => f.candidate),
    checked,
    checksToday,
    findingsToday,
    busy: false,
    ready,
    now,
    timeZone,
  });
  const pick = next
    ? allFound.find(
        (f) =>
          f.candidate.key === next.key &&
          f.candidate.version === next.version &&
          (f.candidate.stage ?? 'eve') === (next.stage ?? 'eve'),
      )
    : null;
  if (!pick) return null;
  const res = await services.pipeline.commit(startAheadCheck, { event: pick.event, personId: person.id }, as);
  return res.status === 'ok' ? (res.result?.checkId ?? null) : null;
}

/** Runs one fresh pass right now (`looksAhead.checkNow`). Returns whether a check began. */
export async function checkAheadNow(
  services: Services,
  burrowId: string,
  options: Omit<AheadWatchOptions, 'fresh'> = {},
): Promise<boolean> {
  const started = await watchAhead(services, burrowId, { ...options, fresh: true });
  return started !== null;
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
