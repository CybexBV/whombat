/**
 * Looks ahead (Whombat looks-ahead.md): across the week before something on the person's calendar (early, afternoon
 * before, morning of) and across incoming mail, Whombat has the assistant check plans quietly against mail, connected
 * files and docs, and the public web. It says something only when it found a sourced issue, a schedule conflict, a
 * booking missing from the calendar, or a concrete deadline waiting on the person.
 *
 * Pure: which events and emails are checked and when, priority scoring, the report the check ends with, the setting's
 * view and change, and the words the apps and the turn read.
 */

import { z } from 'zod';
import { type DateInput, daysAgo, toDate, zonedParts } from '../text/time.js';
import type { CalendarEvent } from './workspace.js';

/* Limits ------------------------------------------------------------------------------------------------------------ */

/** At most this many checks a day (the person's day), so a full calendar or inbox can't use up their AI allowance. */
export const AHEAD_CHECKS_PER_DAY = 8;
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

/* Stages and trigger sources ---------------------------------------------------------------------------------------- */

/** When a check runs: early (2–7 days out), eve (afternoon before / today), morning (2–4 h before), or mail sweep. */
export const AHEAD_STAGES = ['early', 'eve', 'morning', 'mail'] as const;
export const AheadStage = z.enum(AHEAD_STAGES);
export type AheadStage = z.infer<typeof AheadStage>;

/** What triggered a check: a calendar event or an incoming email. */
export const AHEAD_TRIGGER_SOURCES = ['calendar', 'mail'] as const;
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
  early: 3,
};

/** An event or email the watcher found and may check. */
export interface AheadCandidate {
  /** Event key (`uid:...` / `<conn>:<cal>:<id>`) or mail key (`mail:<conn>:<msgId>`). */
  key: string;
  /** Event version hash (without stage suffix), or message id hash for mail. */
  version: string;
  start: string;
  /** Default `'eve'` when omitted (backwards-compatible with single-stage callers). */
  stage?: AheadStage;
  /** Default `'calendar'`. */
  source?: AheadTriggerSource;
  allDay?: boolean;
  /** Higher checks first within the same stage. */
  priority?: number;
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
 * urgency (`morning` > `eve` > `mail` > `early`), then candidate priority, then soonest start time. A version+stage is
 * never checked twice; a later stage (`eve` after `early`, `morning` after `eve`) may still run even if an earlier
 * stage had a finding, carrying its prior note so Dusty never repeats itself.
 */
export function planAheadPass(input: AheadPassInput): AheadCandidate | null {
  if (input.busy || !input.ready) return null;
  if (!aheadStartHours(input.now, input.timeZone)) return null;
  if (input.checksToday >= AHEAD_CHECKS_PER_DAY || input.findingsToday >= AHEAD_FINDINGS_PER_DAY) return null;
  const seenStage = new Set(input.checked.map((c) => `${c.key}\n${c.version}`));
  const foundByStage = new Set(
    input.checked.filter((c) => c.found).map((c) => `${c.key}\n${c.stage ?? 'eve'}`),
  );
  const due = input.candidates
    .map((c) => {
      if (c.source === 'mail' || c.stage === 'mail') {
        const stage: AheadStage = 'mail';
        return {
          candidate: { ...c, stage, source: 'mail' as const },
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
      if (seenStage.has(`${candidate.key}\n${sv}`)) return false;
      // Same stage already posted a finding for this event: its thread is where it goes on.
      if (foundByStage.has(`${candidate.key}\n${stage}`)) return false;
      // Mail checks are one-shot per message.
      if (stage === 'mail' && foundByStage.has(`${candidate.key}\nmail`)) return false;
      return true;
    })
    .sort((a, b) => {
      const sr = STAGE_RANK[a.stage] - STAGE_RANK[b.stage];
      if (sr !== 0) return sr;
      const pr = (b.candidate.priority ?? 0) - (a.candidate.priority ?? 0);
      if (pr !== 0) return pr;
      return toDate(a.candidate.start).getTime() - toDate(b.candidate.start).getTime();
    });
  return due[0]?.candidate ?? null;
}

/* Incoming mail pre-filter (cheap, deterministic — no LLM cost on newsletters) -------------------------------------- */

const MAIL_ACTION_SIGNAL =
  /\b(?:booking|booked|reservation|reserved|confirmation|confirmed|itinerary|boarding pass|check-?in|e-?ticket|tickets?|flight|airline|gate|delayed|cancelled|canceled|rescheduled|postponed|moved|delivery slot|choose a time|pick a slot|pick a time|rsvp|reply by|respond by|due date|overdue|invoice|payment due|action required|appointment|expires?|expiring|boeking|geboekt|reservering|bevestiging|bevestigd|vlucht|trein|inchecken|geannuleerd|verplaatst|gewijzigd|uitgesteld|bezorgmoment|tijdslot|bezorging|factuur|vervaldatum|afspraak|bevestig)\b/i;

const MAIL_PROMO_NOISE =
  /\b(?:newsletter|nieuwsbrief|unsubscribe|uitschrijven|weekly digest|sale ends|% off|korting|promo code|special offer|black friday|shop now|view in browser)\b/i;

/**
 * Whether an incoming email looks like a plan, booking, or concrete deadline worth checking quietly (pure). Skips mail
 * sent by the person themselves and bulk marketing newsletters unless a concrete booking/deadline signal is present.
 */
export function aheadMailCandidate(input: {
  from: string;
  subject: string;
  snippet: string;
  ownAddresses: readonly string[];
  rules?: readonly string[];
}): boolean {
  const fromLower = input.from.toLowerCase();
  for (const own of input.ownAddresses) {
    if (own && fromLower.includes(own.toLowerCase())) return false;
  }
  const text = `${input.subject}\n${input.snippet}`;
  const hasSignal = MAIL_ACTION_SIGNAL.test(text);
  const matchesRule = (input.rules ?? []).some((rule) => {
    const words = rule
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4 && !RULE_STOP_WORDS.has(w));
    return words.length > 0 && words.some((w) => text.toLowerCase().includes(w));
  });
  if (!hasSignal && !matchesRule) return false;
  if (
    MAIL_PROMO_NOISE.test(text) &&
    !/\b(?:confirmation|confirmed|itinerary|e-?ticket|boarding pass|booking|reservation|invoice|overdue|cancelled|rescheduled|boeking|bevestiging|factuur|geannuleerd|bezorgmoment)\b/i.test(
      text,
    )
  )
    return false;
  return true;
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

/* The check's report ------------------------------------------------------------------------------------------------ */

/**
 * Where a finding comes from: a web page the check read (or an attempted-and-blocked search listing), a mail it read,
 * a Drive/OneDrive file it read, a Paperless/Notion document it read, or the person's own calendar (for conflicts).
 * Whombat names each itself, so a finding's links and names are never the model's words.
 */
export const AheadSource = z.union([
  z.strictObject({
    url: z
      .string()
      .url()
      .max(2048)
      .describe(
        'A web page this check read with read_web_page (or tried to read when the site blocked fetching).',
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
]);
export type AheadSource = z.infer<typeof AheadSource>;

/**
 * `ahead_report`'s input: nothing worth telling (`found: false`, with an optional `note` kept for later stages of the
 * same event), or a finding with primary `kind`, optional `extraKinds` (when the same plan has two real problems),
 * plain text, verified `sources`, optional one-tap `action` chip label, and optional `note`.
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
  })
  .refine((v) => !v.found || (v.kind && v.text && v.sources?.length), {
    message: 'A finding needs its kind, its text and at least one source.',
    path: ['found'],
  })
  .refine((v) => v.found || (!v.kind && !v.extraKinds?.length && !v.text && !v.sources && !v.action), {
    message: 'Nothing found says nothing more (other than an optional note).',
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
 * Everything a Looks ahead check may be served (Whombat looks-ahead.md): read mail, Drive/OneDrive files, and
 * Paperless/Notion docs (all strictly read-only, closing the web once touched), search and read public web pages, and
 * report what it found. Nothing that writes, sends, remembers, or opens the general browser/commands/Vault.
 */
export const AHEAD_TOOL_NAMES = [
  'mail_search',
  'mail_read',
  'files_search',
  'files_read',
  'ahead_read_docs',
  'search_web',
  'read_web_page',
  'ahead_report',
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

/**
 * `DispatchContext.ahead`: the event or email a Looks ahead turn checks (trigger `ahead`), along with same-day/upcoming
 * trusted schedule, prior check notes for this event, user-owned standing rules, and recent dismissals; or, in the
 * person's own turn in a finding's thread, what was found (`found`).
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
  /** Other accepted plans on the same day (calendar check) or next 14 days (mail check), for conflict/missing-event detection. */
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
    })
    .optional(),
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

/** One recent check shown in Settings → {assistant} → Looks ahead. */
export const LooksAheadCheckItem = z.object({
  id: z.string().min(1).max(64),
  source: AheadTriggerSource,
  stage: AheadStage,
  title: z.string().max(300),
  at: z.string().max(40),
  state: z.enum(['checking', 'quiet', 'told', 'failed']),
  kind: AheadKind.nullable().optional(),
  threadRootId: z.string().max(64).nullable().optional(),
  feedback: z.enum(['not_useful', 'stop_kind']).nullable().optional(),
});
export type LooksAheadCheckItem = z.infer<typeof LooksAheadCheckItem>;

/** `looksAhead.get`: the switch, calendars, incoming mail switch, standing rules, stopped kinds, week stats and recent checks. */
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
    `${assistant} quietly checks your upcoming plans (up to a week ahead and again before they start) and your incoming mail against your files and the web, and tells you only when something needs attention.`,
  calendars: 'Calendars',
  noCalendar: 'Connect a Google or Microsoft 365 account to check your calendar.',
  calendarsUnread: 'Your calendars can’t be read right now.',
  mail: 'Incoming mail',
  mailLine:
    'Spot bookings missing from your calendar, schedule mismatches, and concrete deadlines waiting on you.',
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
} as const;
