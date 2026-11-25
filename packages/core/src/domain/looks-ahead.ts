/**
 * Looks ahead (Whombat looks-ahead.md): the afternoon before something on the person's calendar, Whombat has the
 * assistant check it quietly against their mail and the web, and it says something only when it found a mismatch it can
 * show (the concert starts at 20:45, not 20:00; the venue is next to a football match; no confirmation in the mail).
 *
 * Pure: which events are checked and when, the report the check ends with, the setting's view and change, and the
 * words the apps and the turn read.
 */

import { z } from 'zod';
import { type DateInput, daysAgo, toDate, zonedParts } from '../text/time.js';
import type { CalendarEvent } from './workspace.js';

/* Limits ------------------------------------------------------------------------------------------------------------ */

/** At most this many checks a day (the person's day), so a full calendar can't use up their AI allowance. */
export const AHEAD_CHECKS_PER_DAY = 4;
/** After this many findings in a day nothing more is checked that day: two messages a day is plenty. */
export const AHEAD_FINDINGS_PER_DAY = 2;
/** An event this close or closer isn't checked any more: too late to change plans. */
export const AHEAD_MIN_LEAD_MS = 90 * 60_000;
/** Checks run only from this hour… */
export const AHEAD_DAY_FROM = 8;
/** …to this hour, in the person's zone: nobody gets a message at night. */
export const AHEAD_DAY_UNTIL = 21;
/** No check begins after this time (hour, minute) in the person's zone: one begun later couldn't tell before 21:00. */
export const AHEAD_START_UNTIL = { hour: 20, minute: 30 } as const;
/** Tomorrow's events are checked from this hour today: “the afternoon before”. */
export const AHEAD_EVE_FROM = 14;
/** How far the watcher reads ahead: up to the end of tomorrow fits in this. */
export const AHEAD_READ_MS = 48 * 3600_000;
/** Web searches one check may make. */
export const AHEAD_SEARCHES_MAX = 4;
/** Web pages one check may read. */
export const AHEAD_PAGES_MAX = 6;
/** Sources a finding names. */
export const AHEAD_SOURCES_MAX = 4;
/** Longest finding: one to three sentences. */
export const AHEAD_TEXT_MAX = 500;

/* What a finding is about ------------------------------------------------------------------------------------------- */

/**
 * The kinds of finding (a fixed list, so “Stop checking for this” means the same thing every time): the time differs,
 * the place differs or moved, it was cancelled or postponed, tickets or a booking are missing or not confirmed, a crowd
 * or closure nearby (another event, roadworks), a travel disruption, or something else the person must know before
 * going.
 */
export const AHEAD_KINDS = ['time', 'place', 'cancelled', 'tickets', 'crowds', 'travel', 'other'] as const;
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
  other: 'Anything else worth knowing',
};

/* Which events -------------------------------------------------------------------------------------------------------- */

/** Words that make a location an online meeting rather than a place. */
const ONLINE_PLACE =
  /^(?:https?:\/\/|www\.)|\b(?:microsoft teams|teams meeting|zoom|google meet|meet\.google|webex|skype|online|virtual|phone call|bellen|telefonisch)\b/i;

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
 * Whether an event is one to check (pure): a timed, one-off event with a real place, that the person didn't decline and
 * isn't only invited to. Everyday things repeat (a weekly meeting, practice), online meetings have no place to get
 * wrong, and an invite nobody accepted may be a stranger's (its text would steer the check).
 */
export function aheadSkip(
  event: Pick<CalendarEvent, 'allDay' | 'location' | 'recurrence' | 'recurring' | 'response' | 'cancelled'>,
): AheadSkip | null {
  if (event.allDay) return 'all_day';
  if (event.cancelled) return 'cancelled';
  if (event.recurring || event.recurrence?.length) return 'recurring';
  const place = event.location.trim();
  if (!place) return 'no_place';
  if (ONLINE_PLACE.test(place)) return 'online';
  if (event.response === 'declined') return 'declined';
  if (event.response === 'needs_action') return 'unanswered';
  return null;
}

/**
 * The version of an event the check is about: what it says, where, when and its notes. Another version (the time, the
 * place or a new door time in its notes) is checked again; the same one never twice. A short stable hash (FNV-1a, 32 bits, hex).
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

/**
 * Whether an event is due for its check now (pure): today's (still at least `AHEAD_MIN_LEAD_MS` away) at once,
 * tomorrow's from `AHEAD_EVE_FROM` today, anything later not yet.
 */
export function aheadDue(start: DateInput, now: DateInput, timeZone: string): boolean {
  const at = toDate(start).getTime();
  const nowMs = toDate(now).getTime();
  if (at - nowMs < AHEAD_MIN_LEAD_MS) return false;
  const days = -daysAgo(start, now, timeZone);
  if (days === 0) return true;
  return days === 1 && zonedParts(now, timeZone).hour >= AHEAD_EVE_FROM;
}

/** An event the watcher found, on a calendar that is on. */
export interface AheadCandidate {
  /** `<connection id>:<calendar id>:<event id>`: one event, whatever its version. */
  key: string;
  version: string;
  start: string;
}

/** What is known of an event's checks. */
export interface AheadChecked {
  key: string;
  version: string;
  /** It ended in a finding (its thread is there): a later version isn't checked again. */
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
 * The event to check on this pass, or null (pure): one at a time, within the day's hours and budgets, the soonest due
 * event whose version wasn't checked and that hasn't had a finding.
 */
export function planAheadPass(input: AheadPassInput): AheadCandidate | null {
  if (input.busy || !input.ready) return null;
  if (!aheadStartHours(input.now, input.timeZone)) return null;
  if (input.checksToday >= AHEAD_CHECKS_PER_DAY || input.findingsToday >= AHEAD_FINDINGS_PER_DAY) return null;
  const found = new Set(input.checked.filter((c) => c.found).map((c) => c.key));
  const seen = new Set(input.checked.map((c) => `${c.key}\n${c.version}`));
  const due = input.candidates
    .filter((c) => !found.has(c.key) && !seen.has(`${c.key}\n${c.version}`))
    .filter((c) => aheadDue(c.start, input.now, input.timeZone))
    .sort((a, b) => toDate(a.start).getTime() - toDate(b.start).getTime());
  return due[0] ?? null;
}

/* The check's report ------------------------------------------------------------------------------------------------ */

/**
 * Where a finding comes from: a web page the check read, or a mail it read. Whombat names each itself (the
 * site, the sender), so a finding's links and names are never the model's words.
 */
export const AheadSource = z.union([
  z.strictObject({
    url: z
      .string()
      .url()
      .max(2048)
      .describe('A web page this check read with read_web_page (a search result is only a lead).'),
  }),
  z.strictObject({
    mailId: z.string().min(1).max(1024).describe('A message this check read with mail_read.'),
  }),
]);
export type AheadSource = z.infer<typeof AheadSource>;

/**
 * `ahead_report`'s input: nothing worth telling (`found: false`, the usual end), or one finding of a kind with one to
 * three plain sentences and its sources.
 */
export const AheadReportInput = z
  .strictObject({
    found: z
      .boolean()
      .describe(
        'false: everything matches, or nothing you can show with a source. true: one finding, with kind, text and sources.',
      ),
    kind: AheadKind.optional(),
    text: z
      .string()
      .trim()
      .min(1)
      .max(AHEAD_TEXT_MAX)
      .optional()
      .describe('One to three plain sentences for the person, in their language, like a colleague.'),
    sources: z.array(AheadSource).min(1).max(AHEAD_SOURCES_MAX).optional(),
  })
  .refine((v) => !v.found || (v.kind && v.text && v.sources?.length), {
    message: 'A finding needs its kind, its text and at least one source.',
    path: ['found'],
  })
  .refine((v) => v.found || (!v.kind && !v.text && !v.sources), {
    message: 'Nothing found says nothing more.',
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
  // Nothing of the text can pass for a placeholder.
  const hidden = text
    .replace(/[\u0000-\u001f\uE000\uE001]/g, ' ')
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
  snippet: z.string().max(600),
});

/** `read_web_page`'s input: a page the check already saw. */
export const AheadPageInput = z.strictObject({
  url: z
    .string()
    .url()
    .max(2048)
    .describe('Exactly as it appeared in a search result or on a page you read.'),
});

/** `ahead_feedback`'s input: the person's word on a finding, in its thread. */
export const AheadFeedbackInput = z.strictObject({
  verdict: z
    .enum(['not_useful', 'stop_kind'])
    .describe('not_useful: this one wasn’t worth telling. stop_kind: never check for this kind again.'),
});

/**
 * Everything a Looks ahead check may be served (Whombat looks-ahead.md): read the mail, search and read public web pages,
 * and say what it found. Not the calendar: the event is in its request, and other events (invites a stranger sent among
 * them) would bring their words in while its web is open. The server serves only these, and Hermes's policy allows only these.
 */
export const AHEAD_TOOL_NAMES = [
  'mail_search',
  'mail_read',
  'search_web',
  'read_web_page',
  'ahead_report',
] as const;

/** The quick replies under a finding: the person's own words, which the assistant acts on. */
export const AHEAD_REPLIES = ['Not useful', 'Stop checking for this'] as const;

/* The turn's context -------------------------------------------------------------------------------------------------- */

/**
 * `DispatchContext.ahead`: the event a Looks ahead turn checks (trigger `ahead`), as the calendar has it; or, in the
 * person's own turn in a finding's thread, what was found (`found`), so their word on it reaches `ahead_feedback`.
 */
export const AheadDispatchContext = z.object({
  summary: z.string().max(300),
  start: z.string().max(40),
  end: z.string().max(40),
  location: z.string().max(500),
  /** The event's own notes, cut short. */
  description: z.string().max(2000),
  /** The calendar it is on, as its owner named it (“Family”). */
  calendar: z.string().max(120),
  timeZone: z.string().max(64),
  /** The kinds the person stopped: not worth reporting. */
  stopped: z.array(AheadKind).max(AHEAD_KINDS.length),
  /** In a finding's thread: what was told. */
  found: z.object({ kind: AheadKind, text: z.string().max(AHEAD_TEXT_MAX) }).optional(),
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

/** `looksAhead.get`: the switch, the calendars, the kinds stopped and the last week. */
export const LooksAheadView = z.object({
  on: z.boolean(),
  /** The calendars of the person's accounts; empty when none could be read (`calendarsRead`). */
  calendars: z.array(LooksAheadCalendar).max(100),
  /** The accounts' calendars were read now (false: none connected, or a read failed). */
  calendarsRead: z.boolean(),
  /** A Google or Microsoft 365 account with a calendar is connected. */
  hasCalendar: z.boolean(),
  stopped: z.array(AheadKind).max(AHEAD_KINDS.length),
  /** The last seven days: events checked and findings told. */
  week: z.object({ checked: z.number().int().min(0), told: z.number().int().min(0) }),
});
export type LooksAheadView = z.infer<typeof LooksAheadView>;

/** `looksAhead.update`: one change at a time. */
export const LooksAheadUpdate = z.union([
  z.strictObject({ on: z.boolean() }),
  z.strictObject({ calendar: z.string().min(1).max(1200), on: z.boolean() }),
  z.strictObject({ kind: AheadKind, on: z.boolean() }),
]);
export type LooksAheadUpdate = z.infer<typeof LooksAheadUpdate>;

/* Words --------------------------------------------------------------------------------------------------------------- */

export const LOOKS_AHEAD_WORDS = {
  title: 'Looks ahead',
  /** With the assistant's name. */
  explainFor: (assistant: string) =>
    `The afternoon before something on your calendar, ${assistant} checks it against your mail and the web, and tells you only when something doesn’t match.`,
  calendars: 'Calendars',
  noCalendar: 'Connect a Google or Microsoft 365 account to use this.',
  calendarsUnread: 'Your calendars can’t be read right now.',
  stopped: 'Not checked any more',
  turnBackOn: 'Check again',
  week: (checked: number, told: number) =>
    checked === 0
      ? 'Nothing checked in the last seven days.'
      : `${checked} checked in the last seven days, ${told === 0 ? 'nothing worth telling you' : `${told} worth telling you`}.`,
  switched: (on: boolean) => (on ? 'Looks ahead is on.' : 'Looks ahead is off.'),
  calendarSwitched: (name: string, on: boolean) =>
    on ? `${name} is checked.` : `${name} isn’t checked any more.`,
  kindSwitched: (kind: AheadKind, on: boolean) =>
    on
      ? `“${AHEAD_KIND_WORDS[kind]}” is checked again.`
      : `“${AHEAD_KIND_WORDS[kind]}” isn’t checked any more.`,
} as const;
