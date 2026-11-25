/**
 * Looks ahead's watcher (docs/decisions/looks-ahead.md): a home job every five minutes, per Whombat with a person. It
 * tidies (checks that failed, threads that passed, old rows, matters without news), then — while Looks ahead is on,
 * within the day's hours and budgets, with a turn of the person's ready to run and no check going on — reads the
 * calendars that are on (up to 7 days ahead across early / eve / morning stages, carrying same-day schedule context) and
 * the newest inbox mail across Google, Microsoft 365 and Email/IMAP (when mailOn is on), and begins the most urgent thing
 * due (`planAheadPass`): a calendar check, a mail check (mail that matches a matter, or a triage pass's pick), a
 * matter's follow-up, or a triage pass over the new mail. Also exposes `checkAheadNow` for an on-demand fresh pass from
 * Settings.
 */
import {
  AHEAD_CHECKS_PER_DAY,
  AHEAD_FINDINGS_PER_DAY,
  AHEAD_MAIL_CALENDAR_MS,
  AHEAD_MATTER_CHECKS_PER_DAY,
  AHEAD_MATTER_SENDER_CHECKS_PER_DAY,
  AHEAD_MATTERS_MAX,
  AHEAD_PICKS_KEEP_MS,
  AHEAD_READ_MS,
  type AheadCandidate,
  type AheadChecked,
  AheadMatterReason,
  type AheadScheduleEntry,
  type AheadStage,
  aheadMatterDue,
  aheadMatterForMail,
  aheadMatterMatchBy,
  aheadMatterTry,
  aheadPriority,
  aheadSkip,
  aheadStage,
  aheadStageVersion,
  aheadStartHours,
  aheadTriageDue,
  aheadTriageSince,
  aheadTry,
  aheadVersion,
  type CalendarEvent,
  planAheadPass,
} from '@whombat/core';
import { zonedParts } from '@whombat/core/text';
import { and, desc, eq, gte, inArray, isNull, like, lt, or, sql } from 'drizzle-orm';
import { aheadChecks, aheadMatters, burrows, dispatches } from '../db/schema/index';
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
  CHECKING_MAX_MS,
  CHECKS_KEEP_MS,
  MATTERS_CLOSED_KEEP_MS,
  mattersExpiredBy,
  SETTLE_AFTER_MS,
  startAheadCheck,
  tidyAhead,
} from './commands';
import { type MailAccount, mailAccounts, mailEventKey, mailVersion, type SweptMail, sweepMail } from './mail';
import { openMatters } from './matters';
import { aheadSettingsOf, findingsSince, keyAllowedIn } from './store';
import { type TriageMail, triageMailList } from './triage';

/** Whether the agent's key is Allowed: nobody is there to say yes while it checks ahead. */
function keyAllowed(services: Services, agentId: string, key: Parameters<typeof keyAllowedIn>[2]) {
  return keyAllowedIn(services.db, agentId, key);
}

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
  // A matter without news for a month, or one closed a month ago.
  const [matter] = await services.db
    .select({ id: aheadMatters.id })
    .from(aheadMatters)
    .where(
      and(
        eq(aheadMatters.burrowId, burrowId),
        or(
          mattersExpiredBy(now),
          and(
            eq(aheadMatters.state, 'closed'),
            lt(aheadMatters.closedAt, new Date(now.getTime() - MATTERS_CLOSED_KEEP_MS)),
          ),
        ),
      ),
    )
    .limit(1);
  if (matter) return true;
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

/** What a mail check is told about one mail, wherever the watcher found it (the sweep or a triage pass's list). */
interface MailFacts {
  key: string;
  version: string;
  start: string;
  connectionId: string;
  provider: 'google' | 'microsoft' | 'imap';
  account: string;
  messageId: string;
  threadId: string;
  from: string;
  /** The sender's address read from the whole From line when it came; null when it has none. */
  address: string | null;
  subject: string;
  date: string;
  snippet: string;
}

function factsOfSwept(m: SweptMail): MailFacts {
  return {
    key: m.key,
    version: m.version,
    start: m.start,
    connectionId: m.account.connectionId,
    provider: m.account.provider,
    account: m.account.email,
    messageId: m.message.id,
    threadId: m.message.threadId,
    from: m.message.from,
    address: m.address,
    subject: m.message.subject,
    date: m.message.date,
    snippet: m.message.snippet,
  };
}

function factsOfListed(m: TriageMail): MailFacts {
  return {
    key: mailEventKey(m.connectionId, m.messageId),
    version: mailVersion(m.messageId),
    start: m.date,
    connectionId: m.connectionId,
    provider: m.provider,
    account: m.account,
    messageId: m.messageId,
    threadId: m.threadId,
    from: m.from,
    address: m.address ?? null,
    subject: m.subject,
    date: m.date,
    snippet: m.snippet,
  };
}

/**
 * A mail check of one mail, with the next 14 days of plans and the matter it is about, if any (`matched`: the mail
 * really matches it).
 */
function mailCheck(
  m: MailFacts,
  timeZone: string,
  schedule: readonly AheadScheduleEntry[],
  priority: number,
  matter?: { id: string; matched: boolean },
  asked?: boolean,
): Found {
  const stage: AheadStage = 'mail';
  const subject = (m.subject || '(no subject)').slice(0, 300);
  return {
    candidate: {
      key: m.key,
      version: m.version,
      start: m.start,
      stage,
      source: 'mail',
      priority,
      ...(asked ? { asked: true } : {}),
    },
    event: {
      source: 'mail',
      stage,
      key: m.key,
      version: aheadStageVersion(m.version, stage),
      connectionId: m.connectionId,
      calendarId: '',
      eventId: m.messageId,
      guests: [],
      summary: subject,
      location: '',
      description: m.snippet.slice(0, 2000),
      calendar: m.account.slice(0, 120),
      start: m.start,
      end: m.start,
      timeZone,
      ...(schedule.length ? { daySchedule: [...schedule] } : {}),
      mail: {
        provider: m.provider,
        messageId: m.messageId,
        from: m.from.slice(0, 320),
        subject,
        date: m.date.slice(0, 64),
        snippet: m.snippet.slice(0, 600),
        ...(m.threadId ? { threadId: m.threadId.slice(0, 200) } : {}),
        ...(m.address ? { address: m.address } : {}),
      },
      ...(matter ? { matterId: matter.id, ...(matter.matched ? { matterMatched: true } : {}) } : {}),
    },
  };
}

/** Mail that matches a matter goes first among mail; one the person asked for before any other. */
const MATTER_MAIL_PRIORITY = { person: 20, check: 10 } as const;
/** A triage pass's picks, most important first, after mail that matches a matter. */
const PICK_PRIORITY = 5;

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
  // The day's budgets and one at a time, before anything is read. Triage passes have their own count.
  const dayStart = startOfLocalDay(now, timeZone);
  const [counts] = await services.db
    .select({
      today: sql<number>`count(*) filter (where ${aheadChecks.startedAt} >= ${dayStart.toISOString()}::timestamptz and ${aheadChecks.source} <> 'triage')::int`,
      triages: sql<number>`count(*) filter (where ${aheadChecks.startedAt} >= ${dayStart.toISOString()}::timestamptz and ${aheadChecks.source} = 'triage')::int`,
      // The gap counts from the last pass that didn't fail: a failed one makes the next wait for nothing.
      lastTriage: sql<
        string | null
      >`max(${aheadChecks.startedAt}) filter (where ${aheadChecks.source} = 'triage' and ${aheadChecks.state} <> 'failed')`,
      busy: sql<number>`count(*) filter (where ${aheadChecks.state} = 'checking')::int`,
    })
    .from(aheadChecks)
    .where(eq(aheadChecks.burrowId, burrowId));
  const checksToday = counts?.today ?? 0;
  if ((counts?.busy ?? 0) > 0 || checksToday >= AHEAD_CHECKS_PER_DAY) return null;
  // The day's findings don't stop the pass while a matter the person asked for is open: news on it may still start.
  // Without one, nothing could start, so nothing is read.
  const findingsToday = await findingsSince(services.db, burrowId, dayStart);
  if (findingsToday >= AHEAD_FINDINGS_PER_DAY) {
    const [theirs] = await services.db
      .select({ id: aheadMatters.id })
      .from(aheadMatters)
      .where(
        and(
          eq(aheadMatters.burrowId, burrowId),
          eq(aheadMatters.state, 'open'),
          eq(aheadMatters.origin, 'person'),
        ),
      )
      .limit(1);
    if (!theirs) return null;
  }
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
  // When mail is read, 14 days of calendar are read once so mail checks can spot missing events cleanly.
  const calWindow = mailboxes.length ? AHEAD_MAIL_CALENDAR_MS : AHEAD_READ_MS;
  const calData = calAccounts.length
    ? await upcomingCalendar(services, calAccounts, settings, now, timeZone, calWindow, fresh)
    : { found: [], schedule: [] };

  const found: Found[] = [...calData.found];
  if (mailboxes.length)
    found.push(
      ...(await mailFound(services, burrowId, {
        mailboxes,
        rules: settings.rules,
        schedule: calData.schedule,
        now,
        timeZone,
        fresh,
        triagesToday: counts?.triages ?? 0,
        lastTriageAt: counts?.lastTriage ? new Date(counts.lastTriage) : null,
        dayStart,
      })),
    );
  if (!found.length) return null;

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
            found.map((f) => f.candidate.key),
          ),
          gte(aheadChecks.startedAt, new Date(now.getTime() - CHECKS_KEEP_MS)),
        ),
      )
  ).map((r) => ({ key: r.key, version: r.version, stage: r.stage, found: r.state === 'told' }));

  const next = planAheadPass({
    candidates: found.map((f) => f.candidate),
    checked,
    checksToday,
    findingsToday,
    busy: false,
    ready,
    now,
    timeZone,
  });
  const pick = next
    ? found.find(
        (f) =>
          f.candidate.key === next.key &&
          f.candidate.version === next.version &&
          (f.candidate.stage ?? 'eve') === (next.stage ?? 'eve'),
      )
    : null;
  if (!pick) return null;
  const res = await services.pipeline.commit(
    startAheadCheck,
    { event: pick.event, personId: person.id, ...(fresh ? { fresh: true } : {}) },
    as,
  );
  return res.status === 'ok' ? (res.result?.checkId ?? null) : null;
}

/**
 * Everything incoming mail may start: mail that is news on an open matter, the picks of earlier triage passes, a
 * matter's follow-up when its time came, and a triage pass when new mail came and one is due.
 */
async function mailFound(
  services: Services,
  burrowId: string,
  pass: {
    mailboxes: readonly MailAccount[];
    rules: readonly string[];
    schedule: readonly AheadScheduleEntry[];
    now: Date;
    timeZone: string;
    fresh: boolean;
    triagesToday: number;
    lastTriageAt: Date | null;
    dayStart: Date;
  },
): Promise<Found[]> {
  const { now, timeZone, schedule } = pass;
  const db = services.db;
  const sweep = await sweepMail(services, pass.mailboxes, now, pass.fresh);
  const swept = sweep.mails;
  const matters = await openMatters(db, burrowId);
  const picksSince = new Date(now.getTime() - AHEAD_PICKS_KEEP_MS);
  // The passes that finished: their picks wait, the mails they listed aren't listed again, and the newest says from
  // when the next pass covers mail.
  const triages = await db
    .select({ event: aheadChecks.event, startedAt: aheadChecks.startedAt })
    .from(aheadChecks)
    .where(
      and(
        eq(aheadChecks.burrowId, burrowId),
        eq(aheadChecks.source, 'triage'),
        eq(aheadChecks.state, 'quiet'),
        gte(aheadChecks.startedAt, picksSince),
      ),
    )
    .orderBy(desc(aheadChecks.startedAt));
  const [lastDone] = triages.length
    ? triages
    : await db
        .select({ event: aheadChecks.event, startedAt: aheadChecks.startedAt })
        .from(aheadChecks)
        .where(
          and(
            eq(aheadChecks.burrowId, burrowId),
            eq(aheadChecks.source, 'triage'),
            eq(aheadChecks.state, 'quiet'),
          ),
        )
        .orderBy(desc(aheadChecks.startedAt))
        .limit(1);
  const lastSweptAt = lastDone
    ? new Date(Date.parse(lastDone.event.triage?.sweptAt ?? '') || lastDone.startedAt.getTime())
    : null;
  const listed = new Set<string>();
  const picked: { mail: TriageMail; matterId?: string; rank: number }[] = [];
  for (const t of triages) {
    const triage = t.event.triage;
    for (const m of triage?.mails ?? []) listed.add(mailEventKey(m.connectionId, m.messageId));
    (triage?.picks ?? []).forEach((p, rank) => {
      const mail = triage?.mails.find((m) => m.ref === p.ref);
      if (mail) picked.push({ mail, rank, ...(p.matterId ? { matterId: p.matterId } : {}) });
    });
  }
  // Which of these mails already have a check: a mail is checked once, and once more when its turn failed (a watched
  // reply no runner took at night isn't lost for good because its row is there).
  const keys = [
    ...new Set([
      ...swept.map((m) => m.key),
      ...picked.map((p) => mailEventKey(p.mail.connectionId, p.mail.messageId)),
    ]),
  ];
  const rowsByKey = new Map<string, { version: string; failed: boolean }[]>();
  if (keys.length)
    for (const r of await db
      .select({ key: aheadChecks.eventKey, version: aheadChecks.version, state: aheadChecks.state })
      .from(aheadChecks)
      .where(and(eq(aheadChecks.burrowId, burrowId), inArray(aheadChecks.eventKey, keys)))) {
      const list = rowsByKey.get(r.key) ?? [];
      list.push({ version: r.version, failed: r.state === 'failed' });
      rowsByKey.set(r.key, list);
    }
  /** The version of a mail check to start now, or null when it has one going, done or tried twice. */
  const versionFor = (key: string, version: string) => aheadTry(version, 'mail', rowsByKey.get(key) ?? []);

  const out = new Map<string, Found>();
  // Mail that is news on a matter: checked at once, without a triage pass, up to the matter's checks for the day; more
  // matching mail that day waits for a pass like any other.
  const checkedToday = new Map(
    matters.length
      ? (
          await db
            .select({
              id: sql<string>`${aheadChecks.event}->'matter'->>'id'`,
              n: sql<number>`count(*)::int`,
            })
            .from(aheadChecks)
            .where(
              and(
                eq(aheadChecks.burrowId, burrowId),
                eq(aheadChecks.source, 'mail'),
                gte(aheadChecks.startedAt, pass.dayStart),
                inArray(
                  sql`${aheadChecks.event}->'matter'->>'id'`,
                  matters.map((m) => m.id),
                ),
              ),
            )
            .groupBy(sql`${aheadChecks.event}->'matter'->>'id'`)
        ).map((r) => [r.id, r.n] as const)
      : [],
  );
  const used = new Map(matters.map((m) => [m.id, checkedToday.get(m.id) ?? 0]));
  const matched = new Set<string>();
  // Oldest first, so the first reply takes the day's first check.
  for (const m of [...swept].reverse()) {
    const version = versionFor(m.key, m.version);
    if (!version) continue;
    const hit = aheadMatterForMail(matters, {
      connectionId: m.account.connectionId,
      threadId: m.message.threadId,
      from: m.message.from,
      address: m.address,
      subject: m.message.subject,
      snippet: m.message.snippet,
      at: m.start,
      bulk: m.bulk,
    });
    if (!hit) continue;
    const { matter, by } = hit;
    // The matter is chosen first; when it used its checks today, the mail goes through a pass like other mail, never
    // to another matter that happens to match by sender. A matter a check opened takes one mail a day on its sender
    // alone: a shop's shared address writes about much else.
    const cap =
      matter.origin === 'check' && by !== 'thread'
        ? AHEAD_MATTER_SENDER_CHECKS_PER_DAY
        : AHEAD_MATTER_CHECKS_PER_DAY;
    if ((used.get(matter.id) ?? 0) >= cap) continue;
    used.set(matter.id, (used.get(matter.id) ?? 0) + 1);
    matched.add(m.key);
    out.set(
      m.key,
      mailCheck(
        { ...factsOfSwept(m), version },
        timeZone,
        schedule,
        MATTER_MAIL_PRIORITY[matter.origin],
        { id: matter.id, matched: true },
        matter.origin === 'person',
      ),
    );
  }
  // The picks of earlier triage passes, one at a time as the budget allows. A pass's link to a matter holds only when
  // the mail really matches that matter and came after it began: a pass's say-so, steered by a stranger's subject
  // line, isn't enough to make a mail that matter's. Otherwise it is checked as any other mail.
  const openById = new Map(matters.map((m) => [m.id, m]));
  for (const p of picked) {
    const facts = factsOfListed(p.mail);
    if (out.has(facts.key)) continue;
    const version = versionFor(facts.key, facts.version);
    if (!version) continue;
    const linked = p.matterId ? openById.get(p.matterId) : undefined;
    const about =
      linked &&
      Date.parse(facts.start) > linked.createdAt.getTime() &&
      aheadMatterMatchBy(linked.match, {
        connectionId: facts.connectionId,
        threadId: facts.threadId,
        from: facts.from,
        address: facts.address,
        subject: facts.subject,
        snippet: facts.snippet,
      }) !== null
        ? linked
        : undefined;
    out.set(
      facts.key,
      mailCheck(
        { ...facts, version },
        timeZone,
        schedule,
        PICK_PRIORITY - p.rank,
        about ? { id: about.id, matched: true } : undefined,
        about?.origin === 'person',
      ),
    );
  }
  // A follow-up of a matter whose time came: once per reason, a failed one tried once more.
  const followUps = matters.length
    ? await db
        .select({ key: aheadChecks.eventKey, version: aheadChecks.version, state: aheadChecks.state })
        .from(aheadChecks)
        .where(
          and(
            eq(aheadChecks.burrowId, burrowId),
            inArray(
              aheadChecks.eventKey,
              matters.map((m) => `matter:${m.id}`),
            ),
          ),
        )
    : [];
  for (const matter of matters) {
    const key = `matter:${matter.id}`;
    const earlier = followUps
      .filter((f) => f.key === key)
      .map((f) => ({ version: f.version, failed: f.state === 'failed' }));
    // A reason whose first try failed may be tried a little longer (a `due` one until the evening of its date).
    const failed = AheadMatterReason.options.filter((r) =>
      earlier.some((e) => e.failed && e.version === aheadStageVersion(r, 'matter')),
    );
    const reason = aheadMatterDue(
      {
        waitingOn: matter.waitingOn,
        dueAt: matter.dueAt,
        lastNewsAt: matter.lastNewsAt,
        createdAt: matter.createdAt,
        followedUp: matter.followedUp,
      },
      now,
      { timeZone, failed },
    );
    if (!reason) continue;
    const version = aheadMatterTry(reason, earlier);
    if (!version) continue;
    const start = (matter.dueAt ?? now).toISOString();
    out.set(key, {
      candidate: {
        key,
        version,
        start,
        stage: 'matter',
        source: 'matter',
        ...(matter.origin === 'person' ? { asked: true } : {}),
      },
      event: {
        source: 'matter',
        stage: 'matter',
        key,
        version: aheadStageVersion(version, 'matter'),
        connectionId: '',
        calendarId: '',
        eventId: '',
        guests: [],
        summary: matter.title.slice(0, 300),
        location: '',
        description: '',
        calendar: '',
        start,
        end: start,
        timeZone,
        ...(schedule.length ? { daySchedule: [...schedule] } : {}),
        matter: { id: matter.id, reason },
      },
    });
  }
  // A triage pass over the new mail no check, matter or finished pass took yet: what came since the last finished pass
  // read the inbox, so nothing slips between two passes, and a failed pass loses nothing.
  const since = aheadTriageSince(lastSweptAt, now);
  const fresh = swept.filter(
    (m) =>
      !m.bulk &&
      !rowsByKey.has(m.key) &&
      !matched.has(m.key) &&
      !listed.has(m.key) &&
      Date.parse(m.start) >= since.getTime(),
  );
  if (
    aheadTriageDue({
      now,
      timeZone,
      lastTriageAt: pass.lastTriageAt,
      triagesToday: pass.triagesToday,
      newMail: fresh.length,
      fresh: pass.fresh,
    })
  ) {
    const at = now.toISOString();
    const key = `triage:${at}`;
    const mails = triageMailList(fresh, pass.rules);
    // A mailbox that couldn't be read now keeps this pass from moving the window past its mail; so does mail the list
    // had no room for: the next pass covers it, and leaves out what this one listed by its keys.
    const shown = new Set(mails.map((m) => mailEventKey(m.connectionId, m.messageId)));
    let sweptAt = (sweep.partial ? since : sweep.readAt).getTime();
    for (const m of fresh) if (!shown.has(m.key)) sweptAt = Math.min(sweptAt, Date.parse(m.start));
    out.set(key, {
      candidate: { key, version: 'pass', start: at, stage: 'triage', source: 'triage' },
      event: {
        source: 'triage',
        stage: 'triage',
        key,
        version: aheadStageVersion('pass', 'triage'),
        connectionId: '',
        calendarId: '',
        eventId: '',
        guests: [],
        summary: 'New mail',
        location: '',
        description: '',
        calendar: '',
        start: at,
        end: at,
        timeZone,
        ...(schedule.length ? { daySchedule: [...schedule] } : {}),
        triage: {
          since: since.toISOString(),
          sweptAt: new Date(Math.min(sweptAt, now.getTime())).toISOString(),
          count: mails.length,
          mails,
          matters: matters.slice(0, AHEAD_MATTERS_MAX).map((m, i) => ({ ref: `k${i + 1}`, id: m.id })),
        },
      },
    });
  }
  return [...out.values()];
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
