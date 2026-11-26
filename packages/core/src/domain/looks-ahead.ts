/**
 * Looks ahead (Whombat looks-ahead.md): across the week before something on the person's calendar (early, afternoon
 * before, morning of) and across incoming mail, Whombat has the assistant check plans quietly against mail, connected
 * files and docs, and the public web. It says something only when it found a sourced issue, a schedule conflict, a
 * booking missing from the calendar, or a concrete deadline waiting on the person.
 *
 * A few times a day it also looks through new mail as a whole and picks what needs a closer check, and it keeps a short
 * list of things it keeps an eye on over days (“tell me when the notary replies”).
 *
 * Pure: which events, mails and follow-ups are checked and when, priority scoring, the reports a check and a look end
 * with, the setting's view and change, and the words the apps and the turn read.
 */

import { z } from 'zod';
import { type DateInput, daysAgo, toDate, zonedParts } from '../text/time.js';
import type { CalendarEvent } from './workspace.js';

/* Limits ------------------------------------------------------------------------------------------------------------ */

/** At most this many checks a day (the person's day), so a full calendar or inbox can't use up their AI allowance. */
export const AHEAD_CHECKS_PER_DAY = 12;
/** After this many findings in a day nothing more is checked that day: keeps chat calm. */
export const AHEAD_FINDINGS_PER_DAY = 4;
/** An event this close or closer isn't checked any more: too late to change plans. */
export const AHEAD_MIN_LEAD_MS = 90 * 60_000;
/** Same-day morning-of window: checks for last-minute cancellations or travel disruptions. */
export const AHEAD_MORNING_LEAD_MS = 4 * 3600_000;
/** Checks run only from this hour… */
export const AHEAD_DAY_FROM = 8;
/** …to this hour, in the person's zone: nobody gets a message at night. */
export const AHEAD_DAY_UNTIL = 21;
/** No check begins after this time (hour, minute) in the person's zone: one begun later couldn't tell before 21:00. */
export const AHEAD_START_UNTIL = { hour: 20, minute: 30 } as const;
/** Tomorrow's events enter the afternoon-before stage from this hour today. */
export const AHEAD_EVE_FROM = 14;
/** How many days ahead the early stage checks (tickets, bookings, dates while there is still time to act). */
export const AHEAD_EARLY_MAX_DAYS = 7;
/** How far the watcher reads calendar events ahead: a full week. */
export const AHEAD_READ_MS = AHEAD_EARLY_MAX_DAYS * 24 * 3600_000;
/** How far ahead mail checks cross-reference the calendar (two weeks). */
export const AHEAD_MAIL_CALENDAR_MS = 14 * 24 * 3600_000;
/** Web searches one check may make. */
export const AHEAD_SEARCHES_MAX = 4;
/** Web pages one check may read. */
export const AHEAD_PAGES_MAX = 6;
/** Sources a finding names. */
export const AHEAD_SOURCES_MAX = 6;
/** Longest finding: one to three sentences, or two short issues on the same plan. */
export const AHEAD_TEXT_MAX = 900;
/** User-owned standing rules (“What to watch for”), at most. */
export const AHEAD_RULES_MAX = 20;
/** Longest standing rule. */
export const AHEAD_RULE_MAX = 200;
/** Recent checks returned to Settings. */
export const AHEAD_RECENT_MAX = 15;
/** Longest structured note kept for later stages of the same event (never in Hermes memory). */
export const AHEAD_NOTE_MAX = 300;
/** Longest one-tap action chip label on a finding. */
export const AHEAD_ACTION_MAX = 52;
/** Longest optional reason attached to a “Not useful” verdict. */
export const AHEAD_FEEDBACK_REASON_MAX = 200;

/** Looks through new mail as a whole at most this many times a day; these passes aren't counted as checks. */
export const AHEAD_TRIAGE_PER_DAY = 3;
/** At least this long between two looks through new mail, unless the person pressed “Check now”. */
export const AHEAD_TRIAGE_GAP_MS = 4.5 * 3600_000;
/** At most this many mails in one look through new mail: a short list the background model reads cheaply. */
export const AHEAD_TRIAGE_MAIL_MAX = 60;
/** At most this many mails one look picks for a closer check. */
export const AHEAD_TRIAGE_PICKS_MAX = 3;
/** The newest this many inbox mails of each mailbox are read for one look, so a busy day loses nothing. */
export const AHEAD_MAIL_SWEEP_LIMIT = 50;
/**
 * A look covers mail that came after the last finished look read the inbox, but never more than this far back. A look
 * that failed doesn't move it, so nothing is lost to a look that never ended.
 */
export const AHEAD_TRIAGE_SINCE_MAX_MS = 48 * 3600_000;
/**
 * A look starts this much before the last finished look read the inbox: a mail whose date is a little behind its arrival
 * still falls in. Mails an earlier look listed are left out of the next by their keys.
 */
export const AHEAD_TRIAGE_OVERLAP_MS = 10 * 60_000;
/** The very first look covers this far back. */
export const AHEAD_TRIAGE_FIRST_MS = 24 * 3600_000;
/** Mails a look picked wait this long for their check; after that they are too old to matter. */
export const AHEAD_PICKS_KEEP_MS = 48 * 3600_000;

/** At most this many things kept an eye on at once (“Keeping an eye on”). */
export const AHEAD_MATTERS_MAX = 30;
/** Checks open at most this many new things to keep an eye on a day; the person's own requests aren't counted. */
export const AHEAD_MATTERS_OPENED_PER_DAY = 3;
/** Longest name of a thing kept an eye on. */
export const AHEAD_MATTER_TITLE_MAX = 120;
/** Longest “who” of a thing kept an eye on. */
export const AHEAD_MATTER_WHO_MAX = 80;
/** A thing kept an eye on goes after this long without news… */
export const AHEAD_MATTER_KEEP_MS = 30 * 24 * 3600_000;
/** …but one with a date never before this long after that date. */
export const AHEAD_MATTER_KEEP_AFTER_DUE_MS = 14 * 24 * 3600_000;
/** No follow-up within this long of a thing's start or its last news: what was just told isn't told again. */
export const AHEAD_MATTER_QUIET_MS = 12 * 3600_000;
/**
 * At most this many mails a day are checked at once for one thing kept an eye on because they match it; more matching
 * mail that day waits for a look through new mail like any other.
 */
export const AHEAD_MATTER_CHECKS_PER_DAY = 3;
/**
 * A thing a check started keeping an eye on takes this many mails a day on its sender alone (mail in its own thread
 * still counts up to `AHEAD_MATTER_CHECKS_PER_DAY`): a shop's shared address writes about much else.
 */
export const AHEAD_MATTER_SENDER_CHECKS_PER_DAY = 1;
/** A follow-up for a date whose first try failed may still be tried this long after that date's noon. */
export const AHEAD_MATTER_DUE_RETRY_MS = 24 * 3600_000;
/** A sender word or a subject word needs at least this many characters. */
export const AHEAD_MATCH_WORD_MIN = 3;
/** Waiting for an answer this long without news is worth one follow-up. */
export const AHEAD_MATTER_NO_ANSWER_MS = 5 * 24 * 3600_000;
/** Something waiting on the person is followed up this long before its date. */
export const AHEAD_MATTER_DUE_LEAD_MS = 24 * 3600_000;
/** A follow-up that is due stays due this long; a Whombat that was off doesn't follow up weeks late. */
export const AHEAD_MATTER_FOLLOW_WINDOW_MS = 3 * 24 * 3600_000;
/** A thing kept an eye on has a date from today to this many days ahead, never further. */
export const AHEAD_MATTER_DUE_MAX_DAYS = 366;
/** Sender words one thing kept an eye on matches mail by, at most. */
export const AHEAD_MATTER_SENDERS_MAX = 3;
/** Subject words one thing kept an eye on matches mail by, at most. */
export const AHEAD_MATTER_WORDS_MAX = 5;

/* Stages and trigger sources ---------------------------------------------------------------------------------------- */

/**
 * When a check runs: early (2–7 days out), eve (afternoon before / today), morning (2–4 h before), a mail, a look
 * through new mail (`triage`), or a follow-up of a thing kept an eye on (`matter`). Server and runner only: the
 * Settings view keeps the values older apps know (`LooksAheadCheckItem`).
 */
export const AHEAD_STAGES = ['early', 'eve', 'morning', 'mail', 'triage', 'matter'] as const;
export const AheadStage = z.enum(AHEAD_STAGES);
export type AheadStage = z.infer<typeof AheadStage>;

/** What started a check: a calendar event, a mail, a look through new mail, or a thing kept an eye on. */
export const AHEAD_TRIGGER_SOURCES = ['calendar', 'mail', 'triage', 'matter'] as const;
export const AheadTriggerSource = z.enum(AHEAD_TRIGGER_SOURCES);
export type AheadTriggerSource = z.infer<typeof AheadTriggerSource>;

/** Stored version key per stage: `eve` keeps the bare 8-char hash so older rows match; other stages suffix `:stage`. */
export function aheadStageVersion(version: string, stage: AheadStage): string {
  return stage === 'eve' ? version : `${version}:${stage}`;
}

/* What a finding is about ------------------------------------------------------------------------------------------- */

/**
 * The kinds of finding (a fixed list, so “Stop checking for this” means the same thing every time): the time differs,
 * the place differs or moved, it was cancelled or postponed, tickets or a booking are missing or not confirmed, a crowd
 * or closure nearby (another event, roadworks), a travel disruption, a schedule conflict or impossible travel gap, a
 * booking found in mail that isn't on the calendar, a concrete deadline waiting on the person, or something else worth
 * knowing before going.
 */
export const AHEAD_KINDS = [
  'time',
  'place',
  'cancelled',
  'tickets',
  'crowds',
  'travel',
  'conflict',
  'missing_event',
  'deadline',
  'other',
] as const;
export const AheadKind = z.enum(AHEAD_KINDS);
export type AheadKind = z.infer<typeof AheadKind>;

/** Each kind in plain words, as a list in Settings and in the assistant's lines: “changed times”. */
export const AHEAD_KIND_WORDS: Readonly<Record<AheadKind, string>> = {
  time: 'Changed times',
  place: 'A changed or moved place',
  cancelled: 'Cancelled or postponed plans',
  tickets: 'Missing tickets or confirmations',
  crowds: 'Crowds and closures nearby',
  travel: 'Travel disruptions',
  conflict: 'Overlaps and tight travel',
  missing_event: 'Bookings missing from your calendar',
  deadline: 'Deadlines and things waiting on you',
  other: 'Anything else worth knowing',
};

/* Which events -------------------------------------------------------------------------------------------------------- */

/** Words that make a location an online meeting rather than a place. */
const ONLINE_PLACE =
  /^(?:https?:\/\/|www\.)|\b(?:microsoft teams|teams meeting|zoom|google meet|meet\.google|webex|skype|online|virtual|phone call|bellen|telefonisch)\b/i;

/** Generic single-day all-day markers that aren't real trips or plans when they carry no place or notes. */
const ALL_DAY_NOISE =
  /^(?:ooo|out of office|busy|free|focus(?: time)?|block|blocked|wfh|work from home|working from home|thuiswerken|thuiswerk|verlof|vrij|free day|birthday|verjaardag|anniversary|reminder|herinnering)\b|\b(?:birthday|verjaardag|jarig)\b/i;

/** High-signal plan keywords used to prioritise checks (English and Dutch). */
const HIGH_SIGNAL_EVENT =
  /\b(?:flight|vlucht|schiphol|airport|luchthaven|train|trein|eurostar|thalys|ns|hotel|airbnb|booking|boeking|reservering|reservation|concert|festival|show|theatre|theater|museum|match|wedstrijd|arena|dome|stadion|stadium|cinema|bioscoop|restaurant|dinner|diner|lunch|ferry|boot|doctor|dokter|tandarts|dentist|ziekenhuis|hospital|conference|conferentie|ticket|tickets|trip|weekend|vacation|vakantie)\b/i;

/** Why an event isn't checked, or null when it is one to check. */
export type AheadSkip =
  | 'all_day'
  | 'recurring'
  | 'no_place'
  | 'online'
  | 'declined'
  | 'unanswered'
  | 'cancelled';

/**
 * Whether an event is one to check (pure): timed or real all-day plans (not generic OOO/birthday markers), one-off or
 * a modified occurrence of a repeating event, not online-only, not declined, unanswered or cancelled. Events with a
 * real title but an empty location field ARE checked (people often put “Coldplay” or “Flight to Rome” in the title).
 */
export function aheadSkip(
  event: Pick<
    CalendarEvent,
    'allDay' | 'location' | 'recurrence' | 'recurring' | 'response' | 'cancelled'
  > & {
    summary?: string;
    description?: string;
    meetUrl?: string | null;
    recurringException?: boolean;
  },
): AheadSkip | null {
  if (event.cancelled) return 'cancelled';
  if (event.response === 'declined') return 'declined';
  if (event.response === 'needs_action') return 'unanswered';
  if ((event.recurring || event.recurrence?.length) && !event.recurringException) return 'recurring';
  const place = event.location.trim();
  const title = (event.summary ?? '').trim();
  const notes = (event.description ?? '').trim();
  if (place && ONLINE_PLACE.test(place)) return 'online';
  if (!place && event.meetUrl) return 'online';
  if (!place && !title) return 'no_place';
  if (event.allDay) {
    if (!place && !notes && (!title || ALL_DAY_NOISE.test(title))) return 'all_day';
  }
  return null;
}

/**
 * The version of an event the check is about: what it says, where, when and its notes. Another version (the time, the
 * place or a new door time in its notes) is checked again; the same one never twice per stage. A short stable hash
 * (FNV-1a, 32 bits, hex).
 */
export function aheadVersion(
  event: Pick<CalendarEvent, 'summary' | 'start' | 'end' | 'location' | 'description'>,
): string {
  const text = [
    event.summary.trim(),
    event.start,
    event.end,
    event.location.trim(),
    event.description.trim(),
  ].join('\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Whether a finding may be told now: within the day's hours in the person's zone. */
export function aheadHours(now: DateInput, timeZone: string): boolean {
  const hour = zonedParts(now, timeZone).hour;
  return hour >= AHEAD_DAY_FROM && hour < AHEAD_DAY_UNTIL;
}

/** Whether a check may begin now: from the day's first hour until `AHEAD_START_UNTIL`. */
export function aheadStartHours(now: DateInput, timeZone: string): boolean {
  const p = zonedParts(now, timeZone);
  const minutes = p.hour * 60 + p.minute;
  return p.hour >= AHEAD_DAY_FROM && minutes < AHEAD_START_UNTIL.hour * 60 + AHEAD_START_UNTIL.minute;
}

/** Local calendar days from `now` until `date` (`YYYY-MM-DD` or ISO timestamp) in `timeZone`. */
function calendarDaysUntil(start: DateInput, allDay: boolean, now: DateInput, timeZone: string): number {
  if (allDay && typeof start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(start.trim())) {
    const [y, m, d] = start.trim().split('-').map(Number);
    const n = zonedParts(now, timeZone);
    const startUtc = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
    const nowUtc = Date.UTC(n.year, n.month - 1, n.day);
    return Math.round((startUtc - nowUtc) / 86_400_000);
  }
  return -daysAgo(start, now, timeZone);
}

/**
 * Which check stage is due now for an event, or null (pure):
 * - `morning`: today, 90 minutes to 4 hours before start (timed events; last-minute cancellations or travel).
 * - `eve`: today (> 4 hours before start) or tomorrow from 14:00 today (door times, crowds, closures, bookings).
 * - `early`: 2 to 7 days ahead (or tomorrow before 14:00) for catching missing tickets/bookings while there's time.
 */
export function aheadStage(
  event: { start: DateInput; allDay?: boolean },
  now: DateInput,
  timeZone: string,
): 'early' | 'eve' | 'morning' | null {
  const allDay = Boolean(event.allDay);
  const days = calendarDaysUntil(event.start, allDay, now, timeZone);
  const hour = zonedParts(now, timeZone).hour;
  if (allDay) {
    if (days === 1) return hour >= AHEAD_EVE_FROM ? 'eve' : 'early';
    if (days >= 2 && days <= AHEAD_EARLY_MAX_DAYS) return 'early';
    return null;
  }
  const at = toDate(event.start).getTime();
  const nowMs = toDate(now).getTime();
  const leadMs = at - nowMs;
  if (leadMs < AHEAD_MIN_LEAD_MS) return null;
  if (days === 0) return leadMs <= AHEAD_MORNING_LEAD_MS ? 'morning' : 'eve';
  if (days === 1) return hour >= AHEAD_EVE_FROM ? 'eve' : 'early';
  if (days >= 2 && days <= AHEAD_EARLY_MAX_DAYS) return 'early';
  return null;
}

/**
 * Whether an event is due for its afternoon-before / same-day check now (pure): today's (still at least
 * `AHEAD_MIN_LEAD_MS` away) at once, tomorrow's from `AHEAD_EVE_FROM` today, anything later not yet.
 */
export function aheadDue(start: DateInput, now: DateInput, timeZone: string): boolean {
  const stage = aheadStage({ start }, now, timeZone);
  return stage === 'eve' || stage === 'morning';
}

/** Priority score for choosing which due candidate to check first when a day has more candidates than budget. */
export function aheadPriority(candidate: {
  stage?: AheadStage;
  summary?: string;
  location?: string;
  allDay?: boolean;
  recurringException?: boolean;
  hasDescription?: boolean;
}): number {
  let score = 0;
  if (candidate.location?.trim()) score += 3;
  const text = `${candidate.summary ?? ''} ${candidate.location ?? ''}`;
  if (HIGH_SIGNAL_EVENT.test(text)) score += 3;
  if (candidate.recurringException) score += 2;
  if (candidate.allDay) score += 2;
  if (candidate.hasDescription) score += 1;
  return score;
}

const STAGE_RANK: Readonly<Record<AheadStage, number>> = {
  morning: 0,
  eve: 1,
  mail: 2,
  matter: 3,
  triage: 4,
  early: 5,
};

/** Sources whose candidates are checked once: the caller gives their key and version. */
const ONE_SHOT: ReadonlySet<AheadStage> = new Set<AheadStage>(['mail', 'matter', 'triage']);

/** An event, a mail, a follow-up or a look through new mail that the watcher found and may start. */
export interface AheadCandidate {
  /**
   * Event key (`uid:...` / `<conn>:<cal>:<id>`), mail key (`mail:<conn>:<msgId>`), follow-up key (`matter:<id>`) or
   * look key (`triage:<start>`).
   */
  key: string;
  /** Event version hash (without stage suffix); for the others what makes them once-only (a follow-up's reason). */
  version: string;
  start: string;
  /** Default `'eve'` when omitted (backwards-compatible with single-stage callers). */
  stage?: AheadStage;
  /** Default `'calendar'`. */
  source?: AheadTriggerSource;
  allDay?: boolean;
  /** Higher checks first within the same stage (give mail that matches a thing kept an eye on a higher one). */
  priority?: number;
  /**
   * About something the person asked Whombat to keep an eye on (a mail that matched it, a triage pick about it, or its
   * follow-up): it goes first within its stage, and still starts once the day's findings are used, since they asked.
   */
  asked?: boolean;
}

/** What is known of an item's checks. */
export interface AheadChecked {
  key: string;
  /** Stored `ahead_checks.version` (may carry `:early` / `:morning` / `:mail` suffix). */
  version: string;
  stage?: AheadStage;
  /** It ended in a finding. */
  found: boolean;
}

export interface AheadPassInput {
  candidates: readonly AheadCandidate[];
  checked: readonly AheadChecked[];
  /** Checks begun today, failed ones too. */
  checksToday: number;
  /** Findings told today. */
  findingsToday: number;
  /** A check is going on now. */
  busy: boolean;
  /** A turn of the person's could run now. */
  ready: boolean;
  now: DateInput;
  timeZone: string;
}

/**
 * The item to check on this pass, or null (pure): one at a time, within the day's hours and budgets. Picks by stage
 * urgency (`morning` > `eve` > `mail` > `matter` > `triage` > `early`), then mail the person asked about, then candidate
 * priority, then soonest start time. A version+stage is never checked twice; a later stage (`eve` after `early`,
 * `morning` after `eve`) may still run even if an earlier stage had a finding, carrying its prior note so Dusty never
 * repeats itself. Once the day's findings are used only what the person asked for may start.
 */
export function planAheadPass(input: AheadPassInput): AheadCandidate | null {
  if (input.busy || !input.ready) return null;
  if (!aheadStartHours(input.now, input.timeZone)) return null;
  if (input.checksToday >= AHEAD_CHECKS_PER_DAY) return null;
  const findingsUsed = input.findingsToday >= AHEAD_FINDINGS_PER_DAY;
  const seenStage = new Set(input.checked.map((c) => `${c.key}\n${c.version}`));
  const foundByStage = new Set(
    input.checked.filter((c) => c.found).map((c) => `${c.key}\n${c.stage ?? 'eve'}`),
  );
  const due = input.candidates
    .map((c) => {
      const oneShot =
        c.source && c.source !== 'calendar'
          ? c.source
          : c.stage && ONE_SHOT.has(c.stage)
            ? (c.stage as Exclude<AheadTriggerSource, 'calendar'>)
            : null;
      if (oneShot) {
        const stage: AheadStage = oneShot;
        return {
          candidate: { ...c, stage, source: oneShot },
          stage,
          sv: aheadStageVersion(c.version, stage),
        };
      }
      const stage = c.stage ?? aheadStage({ start: c.start, allDay: c.allDay }, input.now, input.timeZone);
      if (!stage) return null;
      return {
        candidate: { ...c, stage, source: 'calendar' as const },
        stage,
        sv: aheadStageVersion(c.version, stage),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .filter(({ candidate, stage, sv }) => {
      if (findingsUsed && (stage === 'triage' || !candidate.asked)) return false;
      if (seenStage.has(`${candidate.key}\n${sv}`)) return false;
      // Same stage already posted a finding for this event or mail: its thread is where it goes on. A follow-up is
      // once per reason instead, and a look is a row of its own.
      if ((stage === 'mail' || !ONE_SHOT.has(stage)) && foundByStage.has(`${candidate.key}\n${stage}`))
        return false;
      return true;
    })
    .sort((a, b) => {
      const sr = STAGE_RANK[a.stage] - STAGE_RANK[b.stage];
      if (sr !== 0) return sr;
      const ar = Number(Boolean(b.candidate.asked)) - Number(Boolean(a.candidate.asked));
      if (ar !== 0) return ar;
      const pr = (b.candidate.priority ?? 0) - (a.candidate.priority ?? 0);
      if (pr !== 0) return pr;
      return toDate(a.candidate.start).getTime() - toDate(b.candidate.start).getTime();
    });
  return due[0]?.candidate ?? null;
}

/**
 * Whether a look through new mail is due now (pure): within the hours a check may begin, new mail came, fewer than
 * `AHEAD_TRIAGE_PER_DAY` looks today (failed ones count), and either “Check now” asked (`fresh`), none ran yet, or the
 * last that didn't fail began at least `AHEAD_TRIAGE_GAP_MS` ago: a failed look doesn't make the next one wait.
 */
export function aheadTriageDue(input: {
  now: DateInput;
  timeZone: string;
  /** When the last look that didn't fail (finished or still going) began; null when there is none. */
  lastTriageAt: Date | null;
  /** Looks begun today, failed ones too. */
  triagesToday: number;
  newMail: number;
  fresh?: boolean;
}): boolean {
  if (!aheadStartHours(input.now, input.timeZone)) return false;
  if (input.newMail <= 0 || input.triagesToday >= AHEAD_TRIAGE_PER_DAY) return false;
  if (input.fresh || !input.lastTriageAt) return true;
  return toDate(input.now).getTime() - input.lastTriageAt.getTime() >= AHEAD_TRIAGE_GAP_MS;
}

/**
 * From when a look through new mail covers mail (pure): from when the last look that finished read the inbox (which can
 * be a while before it began), less `AHEAD_TRIAGE_OVERLAP_MS`, so mail that came at night, while the day's checks were
 * used, or between that read and its start is still in it; never more than `AHEAD_TRIAGE_SINCE_MAX_MS` back. With no
 * finished look, `AHEAD_TRIAGE_FIRST_MS`. A look that failed isn't given here, so it moves nothing.
 */
export function aheadTriageSince(lastSweptAt: Date | null, now: DateInput): Date {
  const nowMs = toDate(now).getTime();
  if (!lastSweptAt) return new Date(nowMs - AHEAD_TRIAGE_FIRST_MS);
  return new Date(
    Math.max(lastSweptAt.getTime() - AHEAD_TRIAGE_OVERLAP_MS, nowMs - AHEAD_TRIAGE_SINCE_MAX_MS),
  );
}

/* Incoming mail: what is left out of a look, and what is listed first ---------------------------------------------- */

/** Booking and deadline words: such mail is listed first when a look has more mail than it can show. */
const MAIL_ACTION_SIGNAL =
  /\b(?:booking|booked|reservation|reserved|confirmation|confirmed|itinerary|boarding pass|check-?in|e-?ticket|tickets?|flight|airline|gate|delayed|cancelled|canceled|rescheduled|postponed|moved|delivery slot|choose a time|pick a slot|pick a time|rsvp|reply by|respond by|due date|overdue|invoice|payment due|action required|appointment|expires?|expiring|boeking|geboekt|reservering|bevestiging|bevestigd|vlucht|trein|inchecken|geannuleerd|verplaatst|gewijzigd|uitgesteld|bezorgmoment|tijdslot|bezorging|factuur|vervaldatum|afspraak|bevestig)\b/i;

/** Words of bulk mail. */
const MAIL_PROMO_NOISE =
  /\b(?:newsletter|nieuwsbrief|unsubscribe|uitschrijven|weekly digest|sale ends|% off|korting|promo code|special offer|black friday|shop now|view in browser)\b/i;

/** Words that make bulk-looking mail still worth a look: a shop's booking or invoice comes with an unsubscribe line. */
const MAIL_STRONG_SIGNAL =
  /\b(?:confirmation|confirmed|itinerary|e-?ticket|boarding pass|booking|reservation|invoice|overdue|cancelled|rescheduled|boeking|bevestiging|factuur|geannuleerd|bezorgmoment)\b/i;

/** What an address must look like: `local@domain.tld`. */
const MAIL_ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** The longest From line read: one longer than this is no one's address. */
const FROM_LINE_MAX = 4000;

/**
 * A From line without its quoted strings and comments (each a space), or null when it can't be read for sure: a quote
 * or a comment that isn't closed, a `)` without its `(`, or a backslash outside them. Quoted strings and comments honour
 * backslash escapes, and comments nest, as RFC 5322 has them.
 */
function fromLineBare(from: string): string | null {
  if (from.length > FROM_LINE_MAX) return null;
  let out = '';
  let i = 0;
  while (i < from.length) {
    const c = from[i] as string;
    if (c === '"') {
      i++;
      for (;;) {
        if (i >= from.length) return null;
        const q = from[i] as string;
        if (q === '\\') i += 2;
        else if (q === '"') break;
        else i++;
      }
      i++;
      out += ' ';
    } else if (c === '(') {
      let depth = 1;
      i++;
      while (depth > 0) {
        if (i >= from.length) return null;
        const q = from[i] as string;
        if (q === '\\') i += 2;
        else {
          if (q === '(') depth++;
          else if (q === ')') depth--;
          i++;
        }
      }
      out += ' ';
    } else if (c === ')' || c === '\\') return null;
    else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * The address a From line came from, lowercased, or null (pure). A sender chooses their display name and comments, so
 * they can hold anything, another address too (`"Refund <boss@company.example>" <attacker@evil.example>`): quoted
 * strings and comments (nested, with escapes) are set aside first, and what is left must hold exactly one `<…>`, which is
 * the address, or, without brackets, be exactly one address. Anything else (an unclosed quote or comment, two bracketed
 * addresses, a stray `<` or `>`) has none. It must look like `local@domain.tld`. When in doubt: none.
 */
export function mailFromAddress(from: string): string | null {
  const line = fromLineBare(from);
  if (line === null) return null;
  const opens = line.split('<').length - 1;
  const closes = line.split('>').length - 1;
  let address: string;
  if (opens === 0 && closes === 0) {
    address = line.trim();
    if (/\s/.test(address)) return null;
  } else {
    if (opens !== 1 || closes !== 1) return null;
    // The name before it is plain words: an @ or a comma there is a second mailbox, and then there is no telling.
    const m = /^([^<>]*)<([^<>]*)>\s*$/.exec(line);
    if (!m || /[@,;]/.test(m[1] ?? '')) return null;
    address = (m[2] ?? '').trim();
  }
  const lower = address.toLowerCase();
  return lower.length <= 254 && MAIL_ADDRESS.test(lower) ? lower : null;
}

/** Whether the person sent a mail themselves (pure): its address is one of theirs. */
export function aheadMailOwn(input: { from: string; ownAddresses: readonly string[] }): boolean {
  const address = mailFromAddress(input.from);
  if (!address) return false;
  return input.ownAddresses.some((own) => own.trim().toLowerCase() === address);
}

/** Whether a mail is plain bulk mail (pure): a newsletter or offer without a booking or invoice word. */
export function aheadMailBulk(input: { subject: string; snippet: string }): boolean {
  const text = `${input.subject}\n${input.snippet}`;
  return MAIL_PROMO_NOISE.test(text) && !MAIL_STRONG_SIGNAL.test(text);
}

/**
 * Whether a mail is left out of a look through new mail before any AI reads it (pure): the person sent it themselves,
 * or it is plain bulk mail (`aheadMailBulk`). Bulk mail may still be news on a thing kept an eye on
 * (`aheadMatterForMail`); the person's own never is.
 */
export function aheadMailNoise(input: {
  from: string;
  subject: string;
  snippet: string;
  ownAddresses: readonly string[];
}): boolean {
  return aheadMailOwn(input) || aheadMailBulk(input);
}

/**
 * Whether a mail has a booking or deadline word, or a word of one of the person's rules (pure). Such mail is listed
 * first when a look has more mail than it can show; it decides nothing else.
 */
export function aheadMailSignal(input: {
  subject: string;
  snippet: string;
  rules?: readonly string[];
}): boolean {
  const text = `${input.subject}\n${input.snippet}`;
  if (MAIL_ACTION_SIGNAL.test(text)) return true;
  const lower = text.toLowerCase();
  return (input.rules ?? []).some((rule) => ruleWords(rule).some((w) => lower.includes(w)));
}

/** The words of a rule worth matching: four letters or more, without the words every rule has. */
function ruleWords(rule: string): string[] {
  return rule
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !RULE_STOP_WORDS.has(w));
}

const RULE_STOP_WORDS = new Set([
  'always',
  'never',
  'check',
  'watch',
  'about',
  'before',
  'after',
  'when',
  'with',
  'from',
  'that',
  'this',
  'have',
  'only',
  'also',
  'dont',
  'usually',
  'live',
  'events',
  'event',
  'mail',
  'email',
  'calendar',
]);

/* Keeping an eye on (matters) --------------------------------------------------------------------------------------- */

/** Whom a thing kept an eye on waits on: the person (`you`) or someone else (`them`). */
export const AheadWaitingOn = z.enum(['you', 'them']);
export type AheadWaitingOn = z.infer<typeof AheadWaitingOn>;

/** Why a thing kept an eye on is followed up: its date is near (`due`), or no answer came (`no_answer`). */
export const AheadMatterReason = z.enum(['due', 'no_answer']);
export type AheadMatterReason = z.infer<typeof AheadMatterReason>;

/**
 * How mail is matched to a thing kept an eye on: the mail threads it is in, its senders (full addresses or sites,
 * `aheadSenderKind`), and words of its subject (which narrow a sender, or match on their own when it has no sender).
 */
export const AheadMatterMatch = z.object({
  threads: z.array(z.object({ connectionId: z.string().max(64), threadId: z.string().max(200) })).max(10),
  senders: z.array(z.string().min(AHEAD_MATCH_WORD_MIN).max(80)).max(AHEAD_MATTER_SENDERS_MAX),
  words: z.array(z.string().min(AHEAD_MATCH_WORD_MIN).max(40)).max(AHEAD_MATTER_WORDS_MAX),
});
export type AheadMatterMatch = z.infer<typeof AheadMatterMatch>;

/** What a site must look like: `domain.tld`, labels of letters, digits and dashes. */
const MAIL_SITE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/**
 * A sender word as a matter matches mail by, or null when it is none (pure): a full address (`jan@example.com`, matched
 * when the mail's address is that one) or a site (`notaris-jansen.example`: a dot and no `@`, matched when the address
 * is at that site or a part of it). A bare word (`klm`) or a fragment (`info@`, `@shop.example`) is none.
 */
export function aheadSenderKind(word: string): 'address' | 'site' | null {
  const w = word.trim().toLowerCase();
  if (w.length > 254) return null;
  if (w.includes('@')) return MAIL_ADDRESS.test(w) ? 'address' : null;
  return MAIL_SITE.test(w) ? 'site' : null;
}

/** Sites of public mailbox providers: an address there is anyone's, so the site matches almost everyone's mail. */
const PUBLIC_MAIL_SITES: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'ymail.com',
  'aol.com',
  'proton.me',
  'pm.me',
  'protonmail.com',
  'protonmail.ch',
  'tutanota.com',
  'tuta.io',
  'fastmail.com',
  'zoho.com',
  'mail.com',
  'mail.ru',
  'web.de',
  't-online.de',
  'freenet.de',
  'orange.fr',
  'wanadoo.fr',
  'free.fr',
  'laposte.net',
  'libero.it',
  'kpnmail.nl',
  'kpnplanet.nl',
  'planet.nl',
  'ziggo.nl',
  'xs4all.nl',
  'hetnet.nl',
  'home.nl',
  'telenet.be',
  'skynet.be',
]);

/** Providers with a site in many countries (`gmx.de`, `yahoo.co.uk`, `hotmail.nl`): every one of them is public. */
const PUBLIC_MAIL_FAMILIES: ReadonlySet<string> = new Set([
  'gmx',
  'yahoo',
  'hotmail',
  'outlook',
  'live',
  'yandex',
]);

/** Labels of a site everyone shares: a top-level word or a mailbox's role, never someone's own site on their own. */
const COMMON_SITE_LABELS: ReadonlySet<string> = new Set([
  'com',
  'net',
  'org',
  'nl',
  'be',
  'de',
  'co',
  'uk',
  'fr',
  'eu',
  'io',
  'info',
  'mail',
  'email',
  'www',
]);

/**
 * Whether a site is too common to match mail by (pure): a public mailbox provider's (`gmail.com`, `gmx.de`,
 * `yahoo.co.uk`, a part of one) or only top-level words (`co.uk`), so every friend's mail would match. A full address
 * at a public provider (`jan@gmail.com`) is fine: it is that one person's.
 */
export function aheadCommonSender(word: string): boolean {
  const w = word.trim().toLowerCase().replace(/^@/, '');
  if (w.includes('@')) return false;
  const labels = w.split('.').filter((p) => p.length > 0);
  if (labels.length === 0 || labels.every((p) => COMMON_SITE_LABELS.has(p))) return true;
  for (let i = 0; i < labels.length - 1; i++) {
    const tail = labels.slice(i);
    if (PUBLIC_MAIL_SITES.has(tail.join('.'))) return true;
    // `gmx.de`, `yahoo.co.uk`: the family's name followed only by top-level words.
    if (
      PUBLIC_MAIL_FAMILIES.has(tail[0] as string) &&
      tail.length <= 3 &&
      tail.slice(1).every((p) => p.length <= 3)
    )
      return true;
  }
  return false;
}

/** Why a sender word can't be matched by, or null when it can (pure): it is none, or a public provider's site. */
export function aheadSenderRefusal(word: string): 'not_sender' | 'public' | null {
  const kind = aheadSenderKind(word);
  if (!kind) return 'not_sender';
  return kind === 'site' && aheadCommonSender(word) ? 'public' : null;
}

/** Whether an address is the sender a sender word names (pure): the same address, or one at that site or a part of it. */
export function aheadSenderMatches(word: string, address: string): boolean {
  const w = word.trim().toLowerCase();
  const kind = aheadSenderKind(w);
  if (!kind) return false;
  const a = address.trim().toLowerCase();
  if (kind === 'address') return a === w;
  const domain = a.slice(a.lastIndexOf('@') + 1);
  return a.includes('@') && (domain === w || domain.endsWith(`.${w}`));
}

/** How a mail matched a thing kept an eye on: by its thread, its sender's address, or the thing's subject words. */
export type AheadMatchedBy = 'thread' | 'sender' | 'words';

/** The words of a match worth comparing: trimmed, lowercased, at least `AHEAD_MATCH_WORD_MIN` characters. */
function matchWordsOf(words: readonly string[]): string[] {
  return words.map((w) => w.trim().toLowerCase()).filter((w) => w.length >= AHEAD_MATCH_WORD_MIN);
}

/**
 * A mail as a thing kept an eye on is matched against. `address`, when given, is the sender's address Whombat read from
 * the whole From line when the mail came (null: it has none); without it, it is read from `from` here.
 */
export interface AheadMailToMatch {
  connectionId: string;
  threadId: string;
  from: string;
  address?: string | null;
  subject: string;
  snippet: string;
}

/** The sender's address of a mail to match: the one read when it came, or else read from its From line. */
function addressOf(mail: AheadMailToMatch): string | null {
  return mail.address !== undefined ? mail.address : mailFromAddress(mail.from);
}

/**
 * How a mail belongs to a thing kept an eye on, or null (pure; words match whatever their case): it is in one of its
 * threads (`thread`); or its sender's address (never the display name a stranger chose) is a sender word's address or
 * at its site (`aheadSenderMatches`) and, when the thing also has subject words, one of them is in the subject or the
 * snippet (`sender`); or the thing has no sender words and one of its subject words is in the subject or the snippet
 * (`words`).
 */
export function aheadMatterMatchBy(match: AheadMatterMatch, mail: AheadMailToMatch): AheadMatchedBy | null {
  if (
    mail.threadId &&
    match.threads.some((t) => t.connectionId === mail.connectionId && t.threadId === mail.threadId)
  )
    return 'thread';
  const senders = matchWordsOf(match.senders);
  const words = matchWordsOf(match.words);
  const text = `${mail.subject}\n${mail.snippet}`.toLowerCase();
  const worded = words.some((w) => text.includes(w));
  if (senders.length > 0) {
    const address = addressOf(mail);
    if (!address || !senders.some((s) => aheadSenderMatches(s, address))) return null;
    return words.length === 0 || worded ? 'sender' : null;
  }
  return worded ? 'words' : null;
}

/** Whether a mail belongs to a thing kept an eye on (pure; `aheadMatterMatchBy`). */
export function aheadMatterMatches(match: AheadMatterMatch, mail: AheadMailToMatch): boolean {
  return aheadMatterMatchBy(match, mail) !== null;
}

/** A thing kept an eye on as `aheadMatterForMail` weighs it. */
export interface AheadMatterToMatch {
  id: string;
  /** The person asked for it, or a check opened it. */
  origin: 'person' | 'check';
  /** When it began: mail that came after is news on it, a second reply already in the inbox too. */
  createdAt: Date;
  match: AheadMatterMatch;
}

/**
 * The thing kept an eye on a new mail is news on, and how it matched, or null (pure). Only mail that came after the
 * thing began. A mail in its thread counts whatever it looks like; a sender or word match counts for a thing the person
 * asked for even when the mail looks like bulk mail, and not for one a check opened. When several match, a thread match
 * wins, then the person's own, then the newest. The caller leaves out the person's own mail; when the thing chosen used
 * its `AHEAD_MATTER_CHECKS_PER_DAY` today, the mail goes to a look through new mail, never to another thing.
 */
export function aheadMatterForMail<M extends AheadMatterToMatch>(
  matters: readonly M[],
  mail: AheadMailToMatch & { at: DateInput; bulk: boolean },
): { matter: M; by: AheadMatchedBy } | null {
  const at = toDate(mail.at).getTime();
  const hits = matters.flatMap((matter) => {
    if (!(at > matter.createdAt.getTime())) return [];
    const by = aheadMatterMatchBy(matter.match, mail);
    if (!by) return [];
    if (by !== 'thread' && mail.bulk && matter.origin !== 'person') return [];
    return [{ matter, by }];
  });
  hits.sort(
    (a, b) =>
      Number(b.by === 'thread') - Number(a.by === 'thread') ||
      Number(b.matter.origin === 'person') - Number(a.matter.origin === 'person') ||
      b.matter.createdAt.getTime() - a.matter.createdAt.getTime(),
  );
  return hits[0] ?? null;
}

/**
 * Whether an open thing kept an eye on has run out (pure): `AHEAD_MATTER_KEEP_MS` without news, and, when it has a date,
 * at least `AHEAD_MATTER_KEEP_AFTER_DUE_MS` past that date.
 */
export function aheadMatterExpired(
  matter: { lastNewsAt: Date; dueAt: Date | null },
  now: DateInput,
): boolean {
  const at = toDate(now).getTime();
  if (at - matter.lastNewsAt.getTime() < AHEAD_MATTER_KEEP_MS) return false;
  return !matter.dueAt || at - matter.dueAt.getTime() >= AHEAD_MATTER_KEEP_AFTER_DUE_MS;
}

/**
 * Whether a thing kept an eye on is due for its follow-up now, and why (pure). Waiting on the person with a date: from
 * `AHEAD_MATTER_DUE_LEAD_MS` before that date until it (`due`). Waiting on someone else: from its date, or else from
 * `AHEAD_MATTER_NO_ANSWER_MS` after the last news, for `AHEAD_MATTER_FOLLOW_WINDOW_MS` (`no_answer`). Never a reason it
 * was already followed up for, and never within `AHEAD_MATTER_QUIET_MS` of its start or its last news, so what was just
 * told isn't told again. A `due` follow-up whose first try failed (`retry.failed`) may still start for
 * `AHEAD_MATTER_DUE_RETRY_MS` after its date's noon, where its first window ends.
 */
export function aheadMatterDue(
  matter: {
    waitingOn: AheadWaitingOn;
    dueAt: Date | null;
    lastNewsAt: Date;
    /** When it began. */
    createdAt: Date;
    followedUp: readonly AheadMatterReason[];
  },
  now: DateInput,
  retry?: { timeZone: string; failed: readonly AheadMatterReason[] },
): AheadMatterReason | null {
  const at = toDate(now).getTime();
  const quietUntil =
    Math.max(matter.createdAt.getTime(), matter.lastNewsAt.getTime()) + AHEAD_MATTER_QUIET_MS;
  if (at < quietUntil) return null;
  if (matter.waitingOn === 'you') {
    if (!matter.dueAt || matter.followedUp.includes('due')) return null;
    const due = matter.dueAt.getTime();
    let until = due;
    // The second try may come the morning after: one that reported at night is done again then.
    if (retry?.failed.includes('due')) until = due + AHEAD_MATTER_DUE_RETRY_MS;
    return at >= due - AHEAD_MATTER_DUE_LEAD_MS && at < until ? 'due' : null;
  }
  if (matter.followedUp.includes('no_answer')) return null;
  const from = matter.dueAt
    ? matter.dueAt.getTime()
    : matter.lastNewsAt.getTime() + AHEAD_MATTER_NO_ANSWER_MS;
  return at >= from && at < from + AHEAD_MATTER_FOLLOW_WINDOW_MS ? 'no_answer' : null;
}

/**
 * The version of a follow-up to start for a reason that is due, or null (pure). A reason counts as followed up when its
 * check reported (the caller's `followedUp`); a follow-up whose turn failed is tried once more (`<reason>.again`), not
 * more, and one still going or that reported is never started again. `earlier`: the follow-up rows of this thing, with
 * their stored (stage-suffixed) versions.
 */
export function aheadMatterTry(
  reason: AheadMatterReason,
  earlier: readonly { version: string; failed: boolean }[],
): string | null {
  return aheadTry(reason, 'matter', earlier);
}

/**
 * The version of a one-shot check to start, or null (pure): `version` the first time, `<version>.again` once when the
 * first one's turn failed, never more, and never again once one is going on or reported. `earlier`: the rows of the same
 * item, with their stored (stage-suffixed) versions. A mail check and a follow-up are tried this way.
 */
export function aheadTry(
  version: string,
  stage: AheadStage,
  earlier: readonly { version: string; failed: boolean }[],
): string | null {
  const tries = [version, `${version}.again`];
  const mine = earlier.filter((e) => tries.some((t) => e.version === aheadStageVersion(t, stage)));
  if (mine.some((e) => !e.failed)) return null;
  return tries[mine.length] ?? null;
}

/** A date as `YYYY-MM-DD`. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a matter's date (`YYYY-MM-DD`) is a real day from today to `AHEAD_MATTER_DUE_MAX_DAYS` ahead in `timeZone`
 * (pure): a date in the past or years ahead is no date to follow up by.
 */
export function aheadMatterDayOk(day: string, now: DateInput, timeZone: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return false;
  const [year, month, date] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = Date.UTC(year, month - 1, date);
  const check = new Date(at);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date)
    return false;
  const n = zonedParts(now, timeZone);
  const today = Date.UTC(n.year, n.month - 1, n.day);
  return at >= today && at <= today + AHEAD_MATTER_DUE_MAX_DAYS * 86_400_000;
}

/**
 * `ahead_report`'s `matter`: open a thing to keep an eye on (no `ref`: `title` and `waitingOn` needed), or update or
 * close the one this check was given (`ref`).
 */
export const AheadReportMatter = z
  .strictObject({
    ref: z
      .string()
      .regex(/^k\d{1,2}$/)
      .optional()
      .describe('The thing this check was given (k1). Leave it out to start keeping an eye on a new one.'),
    title: z
      .string()
      .trim()
      .min(2)
      .max(AHEAD_MATTER_TITLE_MAX)
      .optional()
      .describe('What it is, in a few plain words (“Refund for the broken kettle”). Needed for a new one.'),
    who: z
      .string()
      .trim()
      .max(AHEAD_MATTER_WHO_MAX)
      .optional()
      .describe('Who it is with, as the person would say it (“the notary”, “Coolblue”).'),
    waitingOn: AheadWaitingOn.optional().describe(
      'you: it waits on the person (an answer, a payment, a choice). them: the person waits on someone else. Needed for a new one.',
    ),
    due: z
      .string()
      .regex(DAY)
      .optional()
      .describe('The date it is due, as YYYY-MM-DD, when the mail names one.'),
    note: z
      .string()
      .trim()
      .min(1)
      .max(AHEAD_NOTE_MAX)
      .optional()
      .describe('A brief factual note on where it stands, for the next check about it.'),
    close: z.boolean().optional().describe('true when it is done: Whombat stops keeping an eye on it.'),
  })
  .refine((v) => (v.ref ? true : Boolean(v.title && v.waitingOn && !v.close)), {
    message: 'A new one needs its title and waitingOn; only one given by ref can be closed.',
    path: ['ref'],
  });
export type AheadReportMatter = z.infer<typeof AheadReportMatter>;

/* The check's report ------------------------------------------------------------------------------------------------ */

/**
 * Where a finding comes from: a web page the check read (or an attempted-and-blocked search listing, or a headline
 * from the person's news sites), a mail it read, a Drive/OneDrive file it read, a Paperless/Notion document it read, the
 * person's own calendar (for conflicts), the weather forecast it was given or read (Whombat weather-news.md), or in a
 * follow-up the thing kept an eye on itself. Whombat names each itself, so a finding's links and names are never the
 * model's words.
 */
export const AheadSource = z.union([
  z.strictObject({
    url: z
      .string()
      .url()
      .max(2048)
      .describe(
        'A web page this check read with read_web_page (or tried to read when the site blocked fetching), or a headline’s link from news_headlines.',
      ),
  }),
  z.strictObject({
    mailId: z.string().min(1).max(1024).describe('A message this check read with mail_read.'),
  }),
  z.strictObject({
    fileId: z.string().min(1).max(1024).describe('A file this check read with files_read.'),
  }),
  z.strictObject({
    docId: z.string().min(1).max(1024).describe('A document this check read with ahead_read_docs.'),
  }),
  z.strictObject({
    calendar: z
      .literal(true)
      .describe('The person’s own calendar schedule given in this check (for conflicts).'),
  }),
  z.strictObject({
    matter: z
      .literal(true)
      .describe('The thing kept an eye on that this follow-up is about, as Whombat gave it.'),
  }),
  z.strictObject({
    weather: z
      .literal(true)
      .describe('The weather forecast given in this check, or one you read with weather_forecast in it.'),
  }),
]);
export type AheadSource = z.infer<typeof AheadSource>;

/**
 * `ahead_report`'s input: nothing worth telling (`found: false`, with an optional `note` kept for later stages of the
 * same event), or a finding with primary `kind`, optional `extraKinds` (when the same plan has two real problems),
 * plain text, verified `sources`, optional one-tap `action` chip label, and optional `note`. Either way a mail check
 * or a follow-up may open, update or close a thing kept an eye on (`matter`).
 */
export const AheadReportInput = z
  .strictObject({
    found: z
      .boolean()
      .describe(
        'false: everything matches, or nothing you can show with a source. true: a sourced finding with kind, text and sources.',
      ),
    kind: AheadKind.optional(),
    extraKinds: z
      .array(AheadKind)
      .max(2)
      .optional()
      .describe('Additional kinds if this same plan has a second distinct issue in the same message.'),
    text: z
      .string()
      .trim()
      .min(1)
      .max(AHEAD_TEXT_MAX)
      .optional()
      .describe(
        'One to three plain sentences for the person, in their language, like a colleague (short lines if two issues).',
      ),
    sources: z.array(AheadSource).min(1).max(AHEAD_SOURCES_MAX).optional(),
    action: z
      .string()
      .trim()
      .min(2)
      .max(AHEAD_ACTION_MAX)
      .optional()
      .describe(
        'Optional short one-tap next step chip in plain words (e.g. “Update event to 20:45”, “Add flight to calendar”, “Draft reply”).',
      ),
    note: z
      .string()
      .trim()
      .min(1)
      .max(AHEAD_NOTE_MAX)
      .optional()
      .describe(
        'Optional brief factual note kept only for later check stages of this same event (never general memory).',
      ),
    matter: AheadReportMatter.optional().describe(
      'Only in a mail check or a follow-up: start keeping an eye on something that goes on after today (no ref), or update or close the one you were given (ref).',
    ),
    unrelated: z
      .boolean()
      .optional()
      .describe(
        'Only in a mail check that was given a matter: true when your finding is about something else in the mail, not that matter.',
      ),
  })
  .refine((v) => !v.found || (v.kind && v.text && v.sources?.length), {
    message: 'A finding needs its kind, its text and at least one source.',
    path: ['found'],
  })
  // A quiet check may still start, update or close a thing kept an eye on.
  .refine((v) => v.found || (!v.kind && !v.extraKinds?.length && !v.text && !v.sources && !v.action), {
    message: 'Nothing found says nothing more (other than an optional note or matter).',
    path: ['found'],
  });
export type AheadReportInput = z.infer<typeof AheadReportInput>;

/**
 * A time or a date as people write them, on its own (not a piece of a longer run of numbers): “20:45”, “20.45”,
 * “2026-12-14”, “14-12-2026”, “14.12.2026”. A time followed by another number with only a space between isn't one
 * (“06.12 14.25 18.30” is a phone number); one with a dash is a range (“20.45 - 23.00”).
 */
const DATE_OR_TIME =
  /(?<![\d./:-])(?:[01]?\d|2[0-3])[.:][0-5]\d(?![\d./:-]|\s+\d)|(?<![\d./-])20\d{2}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])(?![\d./-])|(?<![\d./-])(?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-]20\d{2}(?![\d./-])/g;

/**
 * A change to a text that leaves its times, dates and years as they are (“20.45 - 23.00”, “14-12-2026”): they are set
 * aside while `change` runs (so a phone number's rule can't take them) and put back after.
 */
export function keepingDatesAndTimes(text: string, change: (text: string) => string): string {
  const kept: string[] = [];
  // Nothing of the text can pass for a placeholder: control characters and the two markers become spaces.
  const hidden = [...text]
    .map((c) => (c < ' ' || c === '\uE000' || c === '\uE001' ? ' ' : c))
    .join('')
    .replace(DATE_OR_TIME, (m) => `\uE000${kept.push(m) - 1}\uE001`);
  return change(hidden).replace(/\uE000(\d+)\uE001/g, (_m, i: string) => kept[Number(i)] ?? '');
}

/** Words that never go into a search: an address, a link, a phone number, a code or number from a booking. */
const PRIVATE_IN_QUERY: readonly [RegExp, string][] = [
  [/[^\s@]+@[^\s@]+\.[^\s@]+/, 'an e-mail address'],
  [/https?:\/\/|www\./i, 'a link'],
  [/\+?\d[\d\s().-]{7,}\d/, 'a phone number'],
  [/\d{5,}/, 'a long number'],
  [/\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z\d]{6,}\b/, 'a code'],
];

/**
 * Why a search can't go out, or null (pure): it holds an address, a link, a phone number, a booking code or number, or a
 * private word (the person's own name or address). The search engine only ever gets public words.
 */
export function aheadQueryRefusal(query: string, privateWords: readonly string[]): string | null {
  // Dates, times and flight numbers are public: “14-12-2026”, “20:45”, “20.45”, “KL1234”.
  const plain = query.replace(DATE_OR_TIME, ' ').replace(/\b[A-Z]{2}\s?\d{1,4}\b/g, ' ');
  for (const [pattern, what] of PRIVATE_IN_QUERY)
    if (pattern.test(plain)) return `The search holds ${what}: search with public words only.`;
  const words = new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  for (const w of privateWords)
    if (w.length >= 3 && words.has(w.toLowerCase()))
      return 'The search holds a private word (a name or an address): search with public words only.';
  return null;
}

/** `search_web`'s input: a public search, never anything private. */
export const AheadSearchInput = z.strictObject({
  query: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .describe(
      'Public words only: the event, the venue, the town, the date. Never names, addresses or mail text.',
    ),
});
export const AheadSearchResult = z.object({
  title: z.string().max(300),
  url: z.string().max(2048),
  snippet: z.string().max(1200),
});

/** `read_web_page`'s input: a page the check already saw. */
export const AheadPageInput = z.strictObject({
  url: z
    .string()
    .url()
    .max(2048)
    .describe('Exactly as it appeared in a search result or on a page you read.'),
});

/** `ahead_read_docs`'s input: read-only search over Paperless-ngx and Notion documents. */
export const AheadDocsInput = z.strictObject({
  query: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .describe('Keywords to search in Paperless-ngx and Notion (tickets, bookings, meeting notes).'),
});
export const AheadDocHit = z.object({
  docId: z.string().min(1).max(1024),
  source: z.string().min(1).max(60),
  title: z.string().max(300),
  date: z.string().max(64).optional(),
  excerpt: z.string().max(4500),
});
export type AheadDocHit = z.infer<typeof AheadDocHit>;

/** `ahead_feedback`'s input: the person's word on a finding, in its thread. */
export const AheadFeedbackInput = z.strictObject({
  verdict: z
    .enum(['not_useful', 'stop_kind'])
    .describe('not_useful: this one wasn’t worth telling. stop_kind: never check for this kind again.'),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(AHEAD_FEEDBACK_REASON_MAX)
    .optional()
    .describe(
      'Short plain reason the person gave for why it wasn’t useful, used to calibrate future checks.',
    ),
});

/**
 * `ahead_triage`'s input: the end of a look through new mail. Only numbers: the mails worth a closer look, each with
 * the thing kept an eye on it belongs to, if any. No words of its own, so a stranger's subject line can at most get a
 * mail picked or passed over.
 */
export const AheadTriageInput = z.strictObject({
  picks: z
    .array(
      z.strictObject({
        mail: z
          .string()
          .regex(/^m\d{1,3}$/)
          .describe('The number of a mail in the list (m4).'),
        matter: z
          .string()
          .regex(/^k\d{1,2}$/)
          .optional()
          .describe('The number of the thing kept an eye on this mail is about (k2), if it is about one.'),
      }),
    )
    .max(AHEAD_TRIAGE_PICKS_MAX)
    .describe(
      `The mails that need the person, most important first, at most ${AHEAD_TRIAGE_PICKS_MAX}; empty when none does.`,
    ),
});
export type AheadTriageInput = z.infer<typeof AheadTriageInput>;

/**
 * `ahead_watch`'s input, in the person's own turn: start keeping an eye on something in their mail (“tell me when the
 * notary replies”), list what is kept an eye on, or stop one.
 */
export const AheadWatchInput = z
  .strictObject({
    action: z
      .enum(['start', 'list', 'stop'])
      .default('start')
      .describe(
        'start: keep an eye on something new. list: what is kept an eye on now. stop: stop one (id).',
      ),
    title: z
      .string()
      .trim()
      .min(2)
      .max(AHEAD_MATTER_TITLE_MAX)
      .optional()
      .describe('What to watch, in a few plain words (“Answer from the notary”). Needed to start.'),
    who: z
      .string()
      .trim()
      .max(AHEAD_MATTER_WHO_MAX)
      .optional()
      .describe('Who it is with, as the person says it (“the notary”).'),
    senders: z
      .array(z.string().trim().min(AHEAD_MATCH_WORD_MIN).max(80))
      .max(AHEAD_MATTER_SENDERS_MAX)
      .optional()
      .describe(
        'Each a full address (“jan@example.com”: matches mail from exactly that address) or a site (“notaris-jansen.example”: a dot and no @; matches addresses at that site or a part of it). Matched against the sender’s address only, never the name shown. Not a bare word (“klm”), a piece of an address (“info@”) or a public mailbox provider’s site (gmail.com, outlook.com); a full address there is fine. Don’t know it: look it up in the mail, or use words instead.',
      ),
    words: z
      .array(z.string().trim().min(AHEAD_MATCH_WORD_MIN).max(40))
      .max(AHEAD_MATTER_WORDS_MAX)
      .optional()
      .describe(
        'Words of the subject or the opening lines, at least 3 characters each: with senders, a mail must have one of them too; without, they match on their own.',
      ),
    waitingOn: AheadWaitingOn.default('them').describe(
      'them: the person waits for someone else (the usual). you: it waits on the person.',
    ),
    due: z
      .string()
      .regex(DAY)
      .optional()
      .describe(
        `A date it is due, as YYYY-MM-DD, if the person named one: from today to ${AHEAD_MATTER_DUE_MAX_DAYS} days ahead.`,
      ),
    id: z.string().min(1).max(64).optional().describe('The one to stop, as list gave it.'),
  })
  .refine((v) => v.action !== 'start' || Boolean(v.title && (v.senders?.length || v.words?.length)), {
    message: 'Starting needs a title and at least one sender or subject word.',
    path: ['action'],
  })
  .refine((v) => v.action !== 'stop' || Boolean(v.id), {
    message: 'Stopping needs the id that list gave.',
    path: ['id'],
  });
export type AheadWatchInput = z.infer<typeof AheadWatchInput>;

/**
 * Everything a Looks ahead check may be served (Whombat looks-ahead.md): read mail, Drive/OneDrive files, and
 * Paperless/Notion docs (all strictly read-only, closing the web once touched), search and read public web pages, the
 * weather forecast and the headlines of the person's news sites (weather-news.md: a forecast for another place only
 * while the web is open, by public words), and report what it found; a look through new mail only picks
 * (`ahead_triage`). Nothing that writes, sends, remembers, or opens the general browser/commands/Vault.
 */
export const AHEAD_TOOL_NAMES = [
  'mail_search',
  'mail_read',
  'files_search',
  'files_read',
  'ahead_read_docs',
  'search_web',
  'read_web_page',
  'weather_forecast',
  'news_headlines',
  'ahead_report',
  'ahead_triage',
] as const;

/** The quick replies under a finding: the person's own words, which the assistant acts on. */
export const AHEAD_REPLIES = ['Not useful', 'Stop checking for this'] as const;

/* The turn's context -------------------------------------------------------------------------------------------------- */

export const AheadScheduleEntry = z.object({
  summary: z.string().max(300),
  start: z.string().max(40),
  end: z.string().max(40),
  location: z.string().max(300),
  calendar: z.string().max(120),
  allDay: z.boolean().optional(),
});
export type AheadScheduleEntry = z.infer<typeof AheadScheduleEntry>;

export const AheadMailContext = z.object({
  provider: z.enum(['google', 'microsoft', 'imap']),
  messageId: z.string().max(1024),
  from: z.string().max(320),
  subject: z.string().max(300),
  date: z.string().max(64),
  snippet: z.string().max(600),
});
export type AheadMailContext = z.infer<typeof AheadMailContext>;

export const AheadPriorCheck = z.object({
  stage: AheadStage,
  state: z.enum(['quiet', 'told', 'failed']),
  kind: AheadKind.optional(),
  note: z.string().max(AHEAD_NOTE_MAX).optional(),
  text: z.string().max(AHEAD_TEXT_MAX).optional(),
});
export type AheadPriorCheck = z.infer<typeof AheadPriorCheck>;

export const AheadDismissedItem = z.object({
  title: z.string().max(300),
  kind: AheadKind,
  reason: z.string().max(AHEAD_FEEDBACK_REASON_MAX).optional(),
});
export type AheadDismissedItem = z.infer<typeof AheadDismissedItem>;

/** One mail of a look through new mail, as the list shows it (`m1`…). */
export const AheadTriageMail = z.object({
  ref: z.string().max(8),
  from: z.string().max(160),
  subject: z.string().max(200),
  date: z.string().max(64),
  snippet: z.string().max(240),
  unread: z.boolean().optional(),
  /** The mailbox it came in, when there is more than one. */
  account: z.string().max(120).optional(),
});
export type AheadTriageMail = z.infer<typeof AheadTriageMail>;

/** A thing kept an eye on, as a turn reads it (`k1`…): fixed short fields Whombat keeps, never a free note. */
export const AheadMatterContext = z.object({
  ref: z.string().max(8),
  title: z.string().max(AHEAD_MATTER_TITLE_MAX),
  who: z.string().max(AHEAD_MATTER_WHO_MAX).optional(),
  waitingOn: AheadWaitingOn,
  /** Its date, when it has one. */
  due: z.string().max(40).optional(),
  note: z.string().max(AHEAD_NOTE_MAX).optional(),
  /** The person asked for it themselves. */
  asked: z.boolean(),
  /** When it began. */
  since: z.string().max(40),
  /** When the last news on it came (a told finding or a note); with none, when it began. */
  lastNews: z.string().max(40).optional(),
  /** In a follow-up: why it is followed up now. */
  reason: AheadMatterReason.optional(),
  /**
   * In a follow-up or a mail check about it: where to look, from what Whombat knows rather than its title: the sender
   * words or address it is matched by, and the message ids of the mails its earlier checks were about, newest first.
   */
  anchors: z
    .object({
      senders: z.array(z.string().max(200)).max(5).optional(),
      messageIds: z.array(z.string().max(200)).max(5).optional(),
    })
    .optional(),
});
export type AheadMatterContext = z.infer<typeof AheadMatterContext>;

/** An hour of a check's forecast (local time with its offset), in the forecast's units. */
export const AheadForecastHour = z.object({
  at: z.string().max(40),
  temperature: z.number(),
  text: z.string().max(60),
  rain: z.number(),
  windSpeed: z.number(),
});
export type AheadForecastHour = z.infer<typeof AheadForecastHour>;

/**
 * The forecast where the person's Whombat is for a plan's day (MET Norway; Whombat weather-news.md), when the day is
 * within the forecast's week: the day's highest, lowest, rain and strongest wind, and the hours of the plan (at most 12).
 */
export const AheadForecast = z.object({
  place: z.string().max(80),
  date: z.string().regex(DAY),
  units: z.object({ temperature: z.enum(['°C', '°F']), wind: z.enum(['m/s', 'mph']) }),
  text: z.string().max(60),
  high: z.number(),
  low: z.number(),
  rain: z.number(),
  rainChance: z.number().nullable(),
  windMax: z.number().nullable(),
  hours: z.array(AheadForecastHour).max(12),
  credit: z.string().max(60),
});
export type AheadForecast = z.infer<typeof AheadForecast>;

/**
 * `DispatchContext.ahead`: the event or email a Looks ahead turn checks (trigger `ahead`), along with same-day/upcoming
 * trusted schedule, prior check notes for this event, user-owned standing rules, and recent dismissals; the new mail of
 * a look through it (`triage`) with the things kept an eye on (`matters`); the thing a mail check or a follow-up is
 * about (`matter`); or, in the person's own turn in a finding's thread, what was found (`found`).
 */
export const AheadDispatchContext = z.object({
  source: AheadTriggerSource.optional(),
  stage: AheadStage.optional(),
  summary: z.string().max(300),
  start: z.string().max(40),
  end: z.string().max(40),
  location: z.string().max(500),
  /** The event's own notes, cut short. */
  description: z.string().max(2000),
  /** The calendar it is on, as its owner named it (“Family”), or the mail account label. */
  calendar: z.string().max(120),
  timeZone: z.string().max(64),
  allDay: z.boolean().optional(),
  /** The kinds the person stopped: not worth reporting. */
  stopped: z.array(AheadKind).max(AHEAD_KINDS.length),
  /**
   * Other accepted plans on the same day (calendar check) or the next 14 days (mail check, follow-up, look through new
   * mail), for conflict/missing-event detection.
   */
  daySchedule: z.array(AheadScheduleEntry).max(30).optional(),
  /** Incoming mail candidate when `source === 'mail'`. */
  mail: AheadMailContext.optional(),
  /** Connected mail providers so the check passes `provider` when more than one account exists. */
  mailProviders: z
    .array(z.enum(['google', 'microsoft', 'imap']))
    .max(3)
    .optional(),
  /** Whether Drive / OneDrive file reads are available. */
  hasFiles: z.boolean().optional(),
  /** Active read-only document connections (`Paperless`, `Notion`). */
  docSources: z.array(z.string().max(60)).max(10).optional(),
  /** User-owned standing rules (“What to watch for”). */
  rules: z.array(z.string().max(AHEAD_RULE_MAX)).max(AHEAD_RULES_MAX).optional(),
  /** Recent findings the person marked “Not useful”, for calibration. */
  recentDismissed: z.array(AheadDismissedItem).max(10).optional(),
  /** Earlier check stages of THIS same event only (never general memory). */
  priorChecks: z.array(AheadPriorCheck).max(6).optional(),
  /** In a finding's thread: what was told. */
  found: z
    .object({
      kind: AheadKind,
      text: z.string().max(AHEAD_TEXT_MAX),
      action: z.string().max(AHEAD_ACTION_MAX).optional(),
      /** The finding is about a thing kept an eye on: “Stop checking for this” stops keeping an eye on it. */
      matter: z.object({ title: z.string().max(AHEAD_MATTER_TITLE_MAX), asked: z.boolean() }).optional(),
    })
    .optional(),
  /** A look through new mail: the mails to pick from, by number. */
  triage: z.object({ mails: z.array(AheadTriageMail).max(AHEAD_TRIAGE_MAIL_MAX) }).optional(),
  /** A look through new mail: the things kept an eye on, so a pick can name the one a mail belongs to. */
  matters: z.array(AheadMatterContext).max(AHEAD_MATTERS_MAX).optional(),
  /** A mail check or a follow-up: the thing kept an eye on it is about. */
  matter: AheadMatterContext.optional(),
  /** A calendar check: the forecast where the person's Whombat is, for the plan's day, when it is within the week. */
  weather: AheadForecast.optional(),
});
export type AheadDispatchContext = z.infer<typeof AheadDispatchContext>;

/* The setting ------------------------------------------------------------------------------------------------------- */

/** One calendar the person can switch on or off. */
export const LooksAheadCalendar = z.object({
  /** `<connection id>:<calendar id>`. */
  key: z.string().min(1).max(1200),
  name: z.string().max(120),
  /** The account it belongs to (its address). */
  account: z.string().max(320),
  on: z.boolean(),
  primary: z.boolean(),
});
export type LooksAheadCalendar = z.infer<typeof LooksAheadCalendar>;

/**
 * One recent check shown in Settings → {assistant} → Looks ahead. `source` and `stage` keep the values older apps know:
 * a look through new mail and a follow-up are `mail` rows that say what they are in `of`.
 */
export const LooksAheadCheckItem = z.object({
  id: z.string().min(1).max(64),
  source: z.enum(['calendar', 'mail']),
  stage: z.enum(['early', 'eve', 'morning', 'mail']),
  title: z.string().max(300),
  at: z.string().max(40),
  state: z.enum(['checking', 'quiet', 'told', 'failed']),
  kind: AheadKind.nullable().optional(),
  threadRootId: z.string().max(64).nullable().optional(),
  feedback: z.enum(['not_useful', 'stop_kind']).nullable().optional(),
  /** A look through new mail (`triage`) or a follow-up of a thing kept an eye on (`matter`). */
  of: z.enum(['triage', 'matter']).optional(),
  /** A look through new mail: how many mails it looked through. */
  count: z.number().int().min(0).optional(),
  /** A look through new mail: how many it picked for a closer check. */
  picked: z.number().int().min(0).optional(),
});
export type LooksAheadCheckItem = z.infer<typeof LooksAheadCheckItem>;

/** One thing kept an eye on, in Settings → {assistant} → Looks ahead → Keeping an eye on. */
export const LooksAheadMatter = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(AHEAD_MATTER_TITLE_MAX),
  who: z.string().max(AHEAD_MATTER_WHO_MAX).optional(),
  waitingOn: AheadWaitingOn,
  /** Its date (ISO), when it has one. */
  due: z.string().max(40).optional(),
  /** When it began (ISO). */
  since: z.string().max(40),
  /** The person asked for it themselves. */
  asked: z.boolean(),
});
export type LooksAheadMatter = z.infer<typeof LooksAheadMatter>;

/** `ahead_watch`'s answer: the one started or stopped, or the list. */
export const AheadWatchResult = z.object({
  matter: LooksAheadMatter.optional(),
  matters: z.array(LooksAheadMatter).max(AHEAD_MATTERS_MAX).optional(),
});
export type AheadWatchResult = z.infer<typeof AheadWatchResult>;

/**
 * `looksAhead.get`: the switch, calendars, incoming mail switch, standing rules, stopped kinds, week stats, recent
 * checks and the things kept an eye on.
 */
export const LooksAheadView = z.object({
  on: z.boolean(),
  /** The calendars of the person's accounts; empty when none could be read (`calendarsRead`). */
  calendars: z.array(LooksAheadCalendar).max(100),
  /** The accounts' calendars were read now (false: none connected, or a read failed). */
  calendarsRead: z.boolean(),
  /** A Google or Microsoft 365 account with a calendar is connected. */
  hasCalendar: z.boolean(),
  /** Whether Looks ahead also watches incoming mail for bookings and deadlines (default true). */
  mailOn: z.boolean().optional(),
  /** A Google, Microsoft 365 or Email (IMAP) account with mail is connected. */
  hasMail: z.boolean().optional(),
  /** User-owned standing rules (“What to watch for”). */
  rules: z.array(z.string().max(AHEAD_RULE_MAX)).max(AHEAD_RULES_MAX).optional(),
  stopped: z.array(AheadKind).max(AHEAD_KINDS.length),
  /** The last seven days: checks completed and findings told. */
  week: z.object({ checked: z.number().int().min(0), told: z.number().int().min(0) }),
  /** The most recent checks (newest first), for visibility without cluttering Chat. */
  recent: z.array(LooksAheadCheckItem).max(AHEAD_RECENT_MAX).optional(),
  /** The things kept an eye on now (“Keeping an eye on”), newest first. */
  matters: z.array(LooksAheadMatter).max(AHEAD_MATTERS_MAX).optional(),
});
export type LooksAheadView = z.infer<typeof LooksAheadView>;

/** `looksAhead.update`: one change at a time. */
export const LooksAheadUpdate = z.union([
  z.strictObject({ on: z.boolean() }),
  z.strictObject({ mailOn: z.boolean() }),
  z.strictObject({ calendar: z.string().min(1).max(1200), on: z.boolean() }),
  z.strictObject({ kind: AheadKind, on: z.boolean() }),
  z.strictObject({ addRule: z.string().trim().min(2).max(AHEAD_RULE_MAX) }),
  z.strictObject({ removeRule: z.string().trim().min(1).max(AHEAD_RULE_MAX) }),
  z.strictObject({ removeMatter: z.string().min(1).max(64) }),
]);
export type LooksAheadUpdate = z.infer<typeof LooksAheadUpdate>;

/** `looksAhead.checkNow`: whether a check started right now, plus the updated view. */
export const LooksAheadCheckNowResult = z.object({
  started: z.boolean(),
  view: LooksAheadView,
});
export type LooksAheadCheckNowResult = z.infer<typeof LooksAheadCheckNowResult>;

/* Words --------------------------------------------------------------------------------------------------------------- */

export const LOOKS_AHEAD_WORDS = {
  title: 'Looks ahead',
  /** With the assistant's name. */
  explainFor: (assistant: string) =>
    `${assistant} quietly checks your upcoming plans and looks through your new mail a few times a day, and tells you only when something needs you.`,
  calendars: 'Calendars',
  noCalendar: 'Connect a Google or Microsoft 365 account to check your calendar.',
  calendarsUnread: 'Your calendars can’t be read right now.',
  mail: 'Incoming mail',
  mailLine:
    'Spot what’s waiting on you: someone who needs an answer, a deadline, a booking that isn’t on your calendar, or news you asked about.',
  noMail: 'Connect Google, Microsoft 365 or Email to check incoming mail.',
  rules: 'What to watch for',
  rulesHint:
    'Short notes you own that guide every check — for example where you live, how you travel, or what to skip.',
  rulesPlaceholder: 'e.g. I live in Utrecht and usually drive to venues',
  addRule: 'Add',
  removeRule: 'Remove',
  stopped: 'Not checked any more',
  turnBackOn: 'Check again',
  recent: 'Recent checks',
  recentEmpty: 'No checks yet.',
  checkNow: 'Check now',
  checkingNow: 'Checking…',
  checkStarted: 'Started a check.',
  nothingDue: 'Everything up to date — nothing due to check right now.',
  week: (checked: number, told: number) =>
    checked === 0
      ? 'Nothing checked in the last seven days.'
      : `${checked} checked in the last seven days, ${told === 0 ? 'nothing worth telling you' : `${told} worth telling you`}.`,
  switched: (on: boolean) => (on ? 'Looks ahead is on.' : 'Looks ahead is off.'),
  mailSwitched: (on: boolean) => (on ? 'Incoming mail is checked.' : 'Incoming mail isn’t checked any more.'),
  calendarSwitched: (name: string, on: boolean) =>
    on ? `${name} is checked.` : `${name} isn’t checked any more.`,
  kindSwitched: (kind: AheadKind, on: boolean) =>
    on
      ? `“${AHEAD_KIND_WORDS[kind]}” is checked again.`
      : `“${AHEAD_KIND_WORDS[kind]}” isn’t checked any more.`,
  ruleAdded: 'Added to what to watch for.',
  ruleRemoved: 'Removed from what to watch for.',
  matters: 'Keeping an eye on',
  /** With the assistant's name. */
  mattersEmpty: (assistant: string) =>
    `Nothing right now. Ask ${assistant} to tell you when something arrives, like “tell me when the notary replies”.`,
  matterWaiting: { you: 'Waiting on you', them: 'Waiting for an answer' } as Readonly<
    Record<AheadWaitingOn, string>
  >,
  matterDue: (date: string) => `by ${date}`,
  removeMatter: 'Remove',
  matterRemoved: 'Not keeping an eye on it any more.',
  recentTriage: (count: number, picked: number) =>
    `Looked through ${count} new ${count === 1 ? 'mail' : 'mails'}, ${picked === 0 ? 'nothing to check' : `${picked} to check`}`,
  recentMatter: 'Follow-up',
} as const;
