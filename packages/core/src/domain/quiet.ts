/**
 * Quiet notices (contracts 0.122.0, CT-1060…CT-1066; Whombat quiet-notices.md QN-01…QN-24): what kind of line each
 * “Worth a look” line is, which check and item it is about, what Ignore would do to it, and whether it is quiet now.
 *
 * Every line is a Problem (`problem`: something is wrong that the assistant can look into), Only you (`you`: only a
 * person can do it — sign in again, pay, approve, replace a disk, decide) or a Heads-up (`fyi`: a forecast, an update,
 * plain information) (QN-01, QN-02). A problem colours the dot and keeps “Look into it”; only-you colours the dot and
 * leads to where it is done; a heads-up shows on its page only.
 *
 * Every line names its check (`unifi.device_offline`, `conn.signin`, `host.disk.space_high`) and, when it is about one
 * item, that item (QN-03). People who may manage the thing can Ignore a line until it changes (`QUIET_LIFTS`), be
 * reminded tomorrow, or stop watching a check for one item or the whole thing (QN-10…QN-13). Quiet is shared for the
 * whole Whombat (QN-14) and stays inside Whombat (QN-16). What Whombat watches (`ThingWatch`) lists every check of a
 * thing with what is excepted (QN-15).
 *
 * Everything here is optional on the wire: absent where it doesn't apply.
 */

import { z } from 'zod';
import { coreTree, type WordTree } from '../i18n/catalog.js';
import { PrincipalId } from '../ids.js';
import { Timestamp } from './common.js';

/* CT-1060 Kinds of line, checks, Ignore --------------------------------------------------------------------------- */

/** Problem · Only you · Heads-up (QN-01), in the order their words are listed. */
export const NOTICE_NATURES = ['problem', 'you', 'fyi'] as const;
export const NoticeNature = z.enum(NOTICE_NATURES);
export type NoticeNature = z.infer<typeof NoticeNature>;

/**
 * How an Ignore ends by itself (QN-11): `fixed` when the check saw it back to normal twice in a row (only where that
 * part was actually read), `newer` when there is a newer one (a newer version, another failure, a different set of
 * items), `period` when the window it is about resets (the week, the month; `NoticeIgnore.until`). Whatever the way, it
 * ends early when the line gets worse (amber to red, a higher band).
 */
export const QUIET_LIFTS = ['fixed', 'newer', 'period'] as const;
export const QuietLifts = z.enum(QUIET_LIFTS);
export type QuietLifts = z.infer<typeof QuietLifts>;

/**
 * A check's id (QN-03): `<area>.<what>` in lower case, at least two parts joined by dots, digits and underscores
 * inside (`unifi.device_offline`, `conn.signin`, `host.disk.space_high`, `host.hint.system.updates`). Stable across
 * releases: it is also the check's switch in What Whombat watches.
 */
export const NOTICE_CHECK_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
export const NoticeCheck = z.string().max(80).regex(NOTICE_CHECK_RE);
export type NoticeCheck = z.infer<typeof NoticeCheck>;

/**
 * The item a line is about, as the server keeps it across reads (QN-03): `device:<UniFi id>`, a container's name, an
 * invoice's id. Opaque to clients: they send it back as they got it.
 */
export const NoticeSubjectId = z.string().min(1).max(160);
export type NoticeSubjectId = z.infer<typeof NoticeSubjectId>;

/** The item with its name as people know it (“Hallway AP”). */
export const NoticeSubject = z.object({ id: NoticeSubjectId, name: z.string().min(1).max(80) });
export type NoticeSubject = z.infer<typeof NoticeSubject>;

/** Which line: its check, and its item when it is about one (absent: the thing as a whole). */
export const NoticeRef = z.object({ check: NoticeCheck, subject: NoticeSubjectId.optional() });
export type NoticeRef = z.infer<typeof NoticeRef>;

/**
 * What Ignore would do (QN-10, QN-11): how it ends, and when you'll hear again in the check's own words, a sentence
 * (“Until it’s back online.”, “Until it’s renewed.”, “Until the week resets.”), drawn under Ignore in the ⋯ menu.
 * `until`: with `period`, when the window resets. Present only for people who may quiet the line (owners and managers;
 * a server's: owners): a line without it has no ⋯ menu.
 */
export const NoticeIgnore = z.object({
  lifts: QuietLifts,
  words: z.string().min(1).max(60),
  until: Timestamp.optional(),
});
export type NoticeIgnore = z.infer<typeof NoticeIgnore>;

/** Who quieted a line or switched a check off, as the line names them (“Ignored by John …”). */
export const QuietBy = z.object({ id: PrincipalId, name: z.string().min(1).max(80) });
export type QuietBy = z.infer<typeof QuietBy>;

/** A quiet line is `ignored` (until it changes) or `snoozed` (Remind me tomorrow). */
export const QUIET_STATES = ['ignored', 'snoozed'] as const;
export const QuietState = z.enum(QUIET_STATES);
export type QuietState = z.infer<typeof QuietState>;

/**
 * The line is quiet (QN-14): drawn greyed at the bottom of Worth a look with `quietLine` (“Ignored by John until it’s
 * back online”) and Undo; it counts for no dot, reason, badge, desk, Watch or Needs you. `words` lower case, without a
 * full stop (“until it’s back online”, “until tomorrow 09:00”); `until` when it ends at a time (a snooze, a period);
 * `by` absent when Whombat doesn't know who (the hosts service's own acknowledgement).
 */
export const NoticeQuiet = z.object({
  state: QuietState,
  words: z.string().min(1).max(60),
  until: Timestamp.optional(),
  by: QuietBy.optional(),
  at: Timestamp,
  /**
   * Quiet as part of the whole thing rather than this line: `window` while the
   * thing is kept quiet (its page's `keptQuiet`, ended with End now, not Undo), `cause` while it is down because of
   * something else (its page's `causedBy`). Absent: the line's own Ignore or snooze. An app before session minor 9
   * leaves it out and reads the line as snoozed (a window) or ignored (a cause).
   */
  held: z.enum(['window', 'cause']).optional(),
});
export type NoticeQuiet = z.infer<typeof NoticeQuiet>;

/* Keep quiet for a while, and one cause ----------------------------- */

/** The shortest and longest a thing can be kept quiet. */
export const KEEP_QUIET_MIN_MINUTES = 5;
export const KEEP_QUIET_MAX_MINUTES = 31 * 24 * 60;

/**
 * A server, connection or device kept quiet until a time: while it holds, its lines colour nothing and make no
 * look, Inbox item, incident or push. `words` is the page's line as drawn (“Quiet until 23:00 · Moving the NAS”);
 * `whombat` when Whombat keeps it quiet for its own planned work (“Whombat is updating it”); `canEnd` when the
 * caller may end it now (`things.endQuiet`, End now). `by` absent: Whombat.
 */
export const KeptQuiet = z.object({
  id: z.string().min(1).max(64),
  words: z.string().min(1).max(160),
  since: Timestamp,
  until: Timestamp,
  note: z.string().min(1).max(120).optional(),
  by: QuietBy.optional(),
  whombat: z.boolean().optional(),
  canEnd: z.boolean(),
});
export type KeptQuiet = z.infer<typeof KeptQuiet>;

/**
 * What a thing is down because of: the server it runs on that is down, its machine that stopped, or the
 * internet (`box:network`); or, with `kind: 'quiet'`, the server or machine it runs on that is kept quiet, which
 * quiets it whatever it answers. `thing` is the cause's id (`server:pve-02`); `words` the page's line (“Not answering
 * while pve-02 is down”, “Quiet while pve-02 is kept quiet”); `href` the cause's page when it has one.
 */
export const ThingCause = z.object({
  thing: z.string().min(3).max(220),
  name: z.string().min(1).max(80),
  words: z.string().min(1).max(160),
  kind: z.enum(['down', 'quiet']).optional(),
  href: z.string().min(1).max(500).optional(),
});
export type ThingCause = z.infer<typeof ThingCause>;

/** Remind me tomorrow: until this hour tomorrow in the Whombat's time zone (QN-12, Home's snooze). */
export const QUIET_SNOOZE_HOUR = 9;

/**
 * A line's kind (QN-01): its own `nature`, else as the line reads — `info` a heads-up, a line whose link asks the
 * assistant a problem, any other an only-you.
 */
export function noticeNature(n: {
  nature?: NoticeNature;
  tone: 'bad' | 'warn' | 'info';
  link?: { kind: string };
}): NoticeNature {
  if (n.nature) return n.nature;
  if (n.tone === 'info') return 'fyi';
  return n.link?.kind === 'ask' ? 'problem' : 'you';
}

const QUIET_WORDS_SHAPE = {
  /** The ⋯ button's label. */
  menu: 0,
  ignore: 0,
  snooze: 0,
  stop: 0,
  stopThis: 0,
  ignored: 0,
  snoozed: 0,
  /** A line quieted by someone Whombat can't name (the hosts service's own acknowledgement). */
  ignoredBare: 0,
  snoozedBare: 0,
  undo: 0,
  toastIgnored: 0,
  toastSnoozed: 0,
  toastStopped: 0,
  toastWatched: 0,
  watchTitle: 0,
  watchNot: 0,
  always: 0,
  watchEmpty: 0,
  natures: {
    problem: 0,
    you: 0,
    fyi: 0,
  } satisfies Record<NoticeNature, 0>,
  /** Keep quiet for a while: the ⋯ item, its choices, the page's line and its button. */
  keepQuiet: 0,
  keepQuietHour: 0,
  keepQuietTonight: 0,
  keepQuietMorning: 0,
  keepQuietPick: 0,
  keepQuietNote: 0,
  keptUntil: 0,
  endNow: 0,
  toastKept: 0,
  toastEnded: 0,
  /** A thing down because of something else: “Not answering while pve-02 is down”. */
  notAnswering: 0,
} as const;

/**
 * The words of Ignore, Remind me tomorrow and Stop watching, on the web and the phone alike. Holes:
 * `{title}` the line's title, `{name}` an item's or a person's name, `{words}` a quiet line's words (lower case).
 * `fillQuietWords` fills them; `quietLine` and `stopWatchingLabel` give the composed lines.
 */
export function quietWords(locale?: string | null): WordTree<typeof QUIET_WORDS_SHAPE> {
  return coreTree(locale, 'quiet', QUIET_WORDS_SHAPE);
}

export const QUIET_WORDS = quietWords('en');

/** Fills `{hole}`s of a quiet word; a hole without a value stays as it is. */
export function fillQuietWords(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z]+)\}/g, (hole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : hole,
  );
}

/** A quiet line's grey words (QN-14): “Ignored by John until it’s back online”, “Snoozed until tomorrow 09:00”. */
export function quietLine(q: Pick<NoticeQuiet, 'state' | 'words' | 'by'>): string {
  const w = QUIET_WORDS;
  if (q.by)
    return fillQuietWords(q.state === 'ignored' ? w.ignored : w.snoozed, { name: q.by.name, words: q.words });
  return fillQuietWords(q.state === 'ignored' ? w.ignoredBare : w.snoozedBare, { words: q.words });
}

/** The ⋯ menu's last line: “Stop watching Hallway AP”, or “Stop watching this” for a line about the whole thing. */
export function stopWatchingLabel(subject?: { name: string }): string {
  return subject ? fillQuietWords(QUIET_WORDS.stop, { name: subject.name }) : QUIET_WORDS.stopThis;
}

/**
 * Ignore's sentence as a quiet line's words: “Until it’s back online.” → “until it’s back online” (the first letter
 * lower case, the closing full stop left out), so the server words `NoticeQuiet.words` from `NoticeIgnore.words`.
 */
export function quietWordsOf(ignoreWords: string): string {
  const t = ignoreWords.trim().replace(/\.+$/, '');
  return t.charAt(0).toLowerCase() + t.slice(1);
}

/* CT-1062 What Whombat watches ------------------------------------------------------------------------------------ */

/** What is excepted from a check (QN-13…QN-15): switched off, ignored or snoozed. */
export const WATCH_EXCEPTION_STATES = ['stopped', 'ignored', 'snoozed'] as const;
export const WatchExceptionState = z.enum(WATCH_EXCEPTION_STATES);
export type WatchExceptionState = z.infer<typeof WatchExceptionState>;

/**
 * One item a check is off, ignored or snoozed for, with Undo (“Not for: Garage AP until it’s back · Attic AP always”).
 * `subject` absent: the check as a whole is ignored or snoozed (a check switched off as a whole is `ThingWatchCheck.off`).
 * `words` lower case: “until it’s back”, “until tomorrow 09:00”, `QUIET_WORDS.always` for one switched off.
 */
export const ThingWatchException = z.object({
  subject: NoticeSubject.optional(),
  state: WatchExceptionState,
  words: z.string().max(60).optional(),
  until: Timestamp.optional(),
  by: QuietBy.optional(),
  at: Timestamp,
});
export type ThingWatchException = z.infer<typeof ThingWatchException>;

/** At most this many exceptions under one check, and checks on one thing. */
export const THING_WATCH_EXCEPTIONS_MAX = 100;
export const THING_WATCH_CHECKS_MAX = 120;

export const WatchLimitValue = z.number().min(1).max(150);

export const ThingWatchLimit = z.object({
  unit: z.enum(['%', '°C']),
  min: WatchLimitValue,
  max: WatchLimitValue,
  /** The default when the check has one fixed limit. Sensors can have their own defaults. */
  defaultValue: WatchLimitValue.optional(),
  value: WatchLimitValue.nullable(),
  items: z.array(z.object({ subject: NoticeSubject, value: WatchLimitValue })).max(500),
});

/**
 * One switch of What Whombat watches (QN-15): the check in plain words (“Access points and switches going offline”),
 * its kind of line, whether it is on, whether its lines are about one item each (`perItem`: Stop watching can be for
 * one item), who switched it off and when (`off`, only while `on` is false), and its exceptions.
 */
export const ThingWatchCheck = z.object({
  check: NoticeCheck,
  name: z.string().min(1).max(80),
  nature: NoticeNature,
  on: z.boolean(),
  perItem: z.boolean(),
  off: z.object({ by: QuietBy.optional(), at: Timestamp }).optional(),
  exceptions: z.array(ThingWatchException).max(THING_WATCH_EXCEPTIONS_MAX),
  limit: ThingWatchLimit.optional(),
});
export type ThingWatchCheck = z.infer<typeof ThingWatchCheck>;

/**
 * A thing's What Whombat watches (`things.watch`): every check it can raise, also while it raises none, and whether the
 * caller may change them (owners and managers; a server's: owners). Look only and guests see the list without switches.
 */
export const ThingWatch = z.object({
  checks: z.array(ThingWatchCheck).max(THING_WATCH_CHECKS_MAX),
  mayChange: z.boolean(),
});
export type ThingWatch = z.infer<typeof ThingWatch>;
