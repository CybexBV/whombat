/**
 * Settings → This Whombat → Backups as the web and the phone show it (Whombat docs/decisions/backup-options.md; app
 * docs/app/decisions/backup-options.md): the top card that answers “am I safe?”, the list of backups grouped by day,
 * the options dialog with its plain-terms costs, one backup's page, the backups left on the box's own disk, and the
 * words of keeping a way back in and bringing a Whombat back. Pure and shared, so both apps say the same.
 */
import { placeOfDisplay } from '@whombat/core';
import { interpolate, tCore } from '@whombat/core/i18n';
import { formatBytes, monthName, shortMonthName, shortWeekdayName, weekdayName } from '@whombat/core/text';
import {
  BACKUP_KEEP_90_DAYS,
  BACKUP_KEEP_YEAR,
  type BackupBringBack,
  type BackupCheckpoint,
  type BackupCheckpointsOutput,
  type BackupFrequency,
  type BackupKeep,
  type BackupPolicy,
  type BackupRestoreState,
  type BackupServiceStatus,
  type BackupStatus,
} from '@whombat/protocol/session';
import { clientTree } from '../i18n/catalog';
import { BACKUP_OPTIONS_WORDS } from '../i18n/messages/backupOptions';
import { ago } from './status-copy';

/* Words ------------------------------------------------------------------------------------------------------- */

/** Backups' words in a locale (English when none is given). */
export function backupOptionsText(locale?: string | null) {
  const {
    span: _span,
    fixAsk: _fixAsk,
    and: _and,
    chips: { spaceFree, ...chips },
    wayBack: { saving: _saving, verify: _verify, ...wayBack },
    local: { thePlace, moveThem, ...local },
    dialog: {
      summarySize,
      summarySizeOn,
      summarySizeFree,
      summarySizeOnFree,
      thePlace: ThePlace,
      weeklyCheckMetaLast,
      ...dialog
    },
    detail: { added, onPlace, ...detail },
    details: {
      clears: { thePlace: ClearsPlace, ...clears },
      ...details
    },
    bringBack: {
      yourPrefix,
      chooseLeadOn,
      steps: { copyFrom, ...steps },
      workingFootOn,
      thatPlace,
      doneServersFind,
      doneBackupsTo,
      ...bringBack
    },
    ...w
  } = clientTree(locale, BACKUP_OPTIONS_WORDS);
  const f = interpolate;
  return {
    ...w,
    backedUp: (when: string) => f(w.backedUp, { when }),
    lastFinished: (when: string) => f(w.lastFinished, { when }),
    askFix: (agent: string) => f(w.askFix, { agent }),
    on: (place: string) => f(w.on, { place }),
    next: (time: string) => f(w.next, { time }),
    oldest: (date: string) => f(w.oldest, { date }),
    chips: {
      ...chips,
      frequency: chips.frequency as Record<BackupFrequency, string>,
      keptFor: (span: string) => f(chips.keptFor, { span }),
      space: (used: string, free: string | null) =>
        free ? f(spaceFree, { used, free }) : f(chips.space, { used }),
      checked: (day: string) => f(chips.checked, { day }),
      checkFailed: (day: string) => f(chips.checkFailed, { day }),
    },
    wayBack,
    leftOutWhy: { ...w.leftOutWhy, files: (n: number) => w.leftOutWhy.files(n) },
    local: {
      ...local,
      title: (n: number) => local.title(n),
      meta: (range: string, size: string, place: string | null) =>
        f(local.meta, { range, size, place: place ?? thePlace }),
      move: (place: string | null) => (place ? f(local.move, { place }) : moveThem),
      moved: (n: number) => local.moved(n),
      removeLead: (size: string) => f(local.removeLead, { size }),
    },
    list: {
      ...w.list,
      label: (n: number) => f(w.list.label, { n }),
      thinned: (keep: BackupKeep) => thinnedLine(keep, locale),
      reasons: { ...w.list.reasons },
      beforeUpdate: (version: string) => f(w.list.beforeUpdate, { version }),
      earlier: (name: string) => f(w.list.earlier, { name }),
      earlierPlaces: (places: string) => f(w.list.earlierPlaces, { places }),
    },
    dusty: (agent: string) => f(w.dusty, { agent }),
    dialog: {
      ...dialog,
      summary: (span: string, size: string | null, place: string | null, free: string | null) =>
        f(
          !size
            ? dialog.summary
            : place
              ? free
                ? summarySizeOnFree
                : summarySizeOn
              : free
                ? summarySizeFree
                : summarySize,
          { span, size: size ?? '', place: place ?? '', free: free ?? '' },
        ),
      frequency: dialog.frequency as Record<BackupFrequency, string>,
      frequencyHint: dialog.frequencyHint as Record<BackupFrequency, string>,
      limitOff: (place: string | null, free: string | null) =>
        free ? f(dialog.limitOff, { place: place ?? ThePlace, free }) : dialog.limitOffPlain,
      limitOn: (size: string) => f(dialog.limitOn, { size }),
      weeklyCheckMeta: (last: string | null) =>
        last ? f(weeklyCheckMetaLast, { last }) : dialog.weeklyCheckMeta,
      lastGood: (day: string) => f(dialog.lastGood, { day }),
      lastBad: (day: string) => f(dialog.lastBad, { day }),
    },
    detail: {
      ...detail,
      meta: (reason: string, addedBytes: string | null, place: string | null) =>
        [reason, addedBytes ? f(added, { added: addedBytes }) : null, place ? f(onPlace, { place }) : null]
          .filter(Boolean)
          .join(' · '),
      checked: (day: string) => f(detail.checked, { day }),
      checkFailed: (day: string) => f(detail.checkFailed, { day }),
      lines: { ...detail.lines, filesMissing: (n: number) => detail.lines.filesMissing(n) },
    },
    details: {
      ...details,
      where: (where: string) => f(details.where, { where }),
      clears: {
        ...clears,
        place: (place: string | null) => f(clears.place, { place: place ?? ClearsPlace }),
      },
    },
    paper: {
      ...w.paper,
      saved: (date: string) => f(w.paper.saved, { date }),
      printTitle: (name: string) => f(w.paper.printTitle, { name }),
    },
    later: { ...w.later, confirmLead: (name: string) => f(w.later.confirmLead, { name }) },
    kit: {
      ...w.kit,
      lead: (name: string) => f(w.kit.lead, { name }),
      noPasskey: (name: string) => f(w.kit.noPasskey, { name }),
      lockedWith: (when: string) => f(w.kit.lockedWith, { when }),
      printTitle: (name: string) => f(w.kit.printTitle, { name }),
    },
    bringBack: {
      ...bringBack,
      found: (name: string, when: string) => f(bringBack.found, { name, when }),
      openTitle: (name: string) => f(bringBack.openTitle, { name }),
      openLead: (name: string) => f(bringBack.openLead, { name, Name: capital(name) }),
      foundNear: (date: string) => f(bringBack.foundNear, { date }),
      chooseTitle: (name: string) => f(bringBack.chooseTitle, { name, Name: capital(name) }),
      chooseLead: (place: string | null) => (place ? f(chooseLeadOn, { place }) : bringBack.chooseLead),
      restore: (name: string) => f(bringBack.restore, { name }),
      workingTitle: (name: string) => f(bringBack.workingTitle, { name }),
      steps: {
        ...steps,
        copy: (place: string | null) => (place ? f(copyFrom, { place }) : steps.copy),
      },
      workingFoot: (place: string | null) => (place ? f(workingFootOn, { place }) : bringBack.workingFoot),
      almostLead: (name: string, time: string) =>
        f(bringBack.almostLead, { name, Name: capital(name), time }),
      oldLostMetaYou: (place: string | null) => f(bringBack.oldLostMetaYou, { place: place ?? thatPlace }),
      start: (name: string) => f(bringBack.start, { name }),
      doneTitle: (name: string) => f(bringBack.doneTitle, { name, Name: capital(name) }),
      doneLead: (agent: string, time: string) => f(bringBack.doneLead, { agent, time }),
      doneServers: (n: number | null) => (n === null ? doneServersFind : bringBack.doneServers(n)),
      doneBackups: (place: string | null) => (place ? f(doneBackupsTo, { place }) : bringBack.doneBackups),
      doneOldOff: (name: string) =>
        f(bringBack.doneOldOff, {
          name: name.startsWith(`${yourPrefix} `) ? name.slice(yourPrefix.length + 1) : name,
        }),
      donePassword: (place: string | null) => f(bringBack.donePassword, { place: place ?? thatPlace }),
      doneKey: (name: string) => f(bringBack.doneKey, { name }),
      doneKeyDone: (name: string) => f(bringBack.doneKeyDone, { name }),
      doneFoot: (agent: string, time: string) => f(bringBack.doneFoot, { agent, time }),
      savedOn: (date: string) => f(bringBack.savedOn, { date }),
    },
  };
}

export type BackupOptionsWords = ReturnType<typeof backupOptionsText>;

export const BACKUP_OPTIONS_TEXT: BackupOptionsWords = backupOptionsText('en');

/** “your Whombat” at the start of a sentence or a title. */
export function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A Whombat's device id (`wb-3fkq-8mzt-2049`): never said as its name. */
const DEVICE_ID = /^wb-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;

/**
 * The name a Whombat to bring back goes by: its own (the account's, the network copy's, the paper copy's), else “your
 * Whombat”, never its device id.
 */
export function bringBackName(name: string | null | undefined, locale?: string | null): string {
  const n = name?.trim();
  return n && !DEVICE_ID.test(n) ? n : backupOptionsText(locale).bringBack.yourWhombat;
}

/** A place as people read it when it has no name (`10.0.2.2:8747`). */
export const placeShown = placeOfDisplay;

/* Dates ------------------------------------------------------------------------------------------------------- */

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** “3 November” (local). */
export function longDate(iso: string, locale?: string | null): string {
  const d = new Date(iso);
  return `${d.getDate()} ${monthName(d.getMonth() + 1, locale)}`;
}

/** “Sun 25 Oct” (local). */
export function shortDay(iso: string, locale?: string | null): string {
  const d = new Date(iso);
  return `${shortWeekdayName(d.getDay(), locale)} ${d.getDate()} ${shortMonthName(d.getMonth() + 1, locale)}`;
}

/** “today”, “yesterday”, “Sunday” within a week, else “3 November”. */
export function relativeDay(iso: string, now = new Date(), locale?: string | null): string {
  const d = new Date(iso);
  if (dayKey(d) === dayKey(now)) return tCore(locale, 'time.todayLower');
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (dayKey(d) === dayKey(y)) return tCore(locale, 'time.yesterdayLower');
  if (now.getTime() - d.getTime() < 6 * 86_400_000) return weekdayName(d.getDay(), locale);
  return longDate(iso, locale);
}

/** The person's hour and minute in `timeZone` at `at` (Intl; the device's own zone when it doesn't know it). */
function zonedHourMinute(at: Date, timeZone: string): { h: number; m: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    if (Number.isFinite(h) && Number.isFinite(m)) return { h, m };
  } catch {
    // an unknown zone: the device's own
  }
  return { h: at.getHours(), m: at.getMinutes() };
}

/** The hours a frequency backs up at, in the person's zone (the backup service's `-if-due` uses the same). */
export const BACKUP_SLOT_HOURS: Record<BackupFrequency, readonly number[]> = {
  nightly: [3],
  '6h': [3, 9, 15, 21],
  hourly: Array.from({ length: 24 }, (_, i) => i),
};

/** When the next scheduled backup starts (on the quarter hour after its slot at the latest). */
export function nextBackupAt(policy: Pick<BackupPolicy, 'frequency' | 'timeZone'>, now = new Date()): Date {
  const slots = BACKUP_SLOT_HOURS[policy.frequency];
  const t = new Date(now);
  t.setSeconds(0, 0);
  t.setMinutes(Math.ceil((t.getMinutes() + 1) / 15) * 15);
  for (let i = 0; i < 26 * 4; i++) {
    const { h, m } = zonedHourMinute(t, policy.timeZone);
    if (m === 0 && slots.includes(h)) return t;
    t.setMinutes(t.getMinutes() + 15);
  }
  return t;
}

/* The top card ------------------------------------------------------------------------------------------------ */

export interface BackupHeroChip {
  text: string;
  dot?: 'ok' | 'bad';
}

/**
 * Where the backups stand, which the card's title, tone and icon follow: `running` (one is being made), `failing` (the
 * service says so: its attempts failed), `behind` (none finished for longer than the schedule allows), `justNow`
 * (Back up now just finished), `ok` (backed up), `none` (nothing finished yet).
 */
export type BackupHeroState = 'ok' | 'justNow' | 'running' | 'behind' | 'failing' | 'none' | 'unknown';

export interface BackupHero {
  state: BackupHeroState;
  title: string;
  sub: string;
  chips: BackupHeroChip[];
  /** `bad` while failing, `warn` while behind, `mut` with nothing yet: the card says so instead of the reassuring shield. */
  tone: 'ok' | 'warn' | 'bad' | 'mut';
  /**
   * While failing or behind: the box's reason and when the last one finished; while the backup service isn't answering,
   * the page's notice; null otherwise.
   */
  problem: string | null;
  /** *Ask {assistant} to fix it* on the card (failing, behind, or the backup service not answering). */
  askFix: boolean;
  /** What the last backup left out, in the service's plain words; null when it was whole. */
  leftOut: string | null;
  /** Recovery status, including saving and waiting for verification. */
  wayBack: string | null;
  /** Only confirmed recovery gets the success check. */
  wayBackReady: boolean;
  /** The passkey's one calm line: no passkey holds the key to these backups yet. */
  askPasskey: boolean;
}

/** How far back a custom policy reaches, without “up to” (“3 months”); null for the dialog's two choices. */
function customSpan(keep: BackupKeep, locale?: string | null): string | null {
  if (sameKeep(keep, BACKUP_KEEP_YEAR) || sameKeep(keep, BACKUP_KEEP_90_DAYS)) return null;
  const S = clientTree(locale, BACKUP_OPTIONS_WORDS).span;
  const days = keepDays(keep);
  if (days >= 365 && days % 365 < 31) return S.years(Math.round(days / 365));
  if (days >= 60) return S.months(Math.round(days / 30.4));
  if (days >= 14 && days % 7 === 0) return S.weeks(days / 7);
  return S.days(days);
}

/** How far back a policy reaches, in words (“up to a year”, “90 days”, “up to 3 months”). */
export function keepSpan(keep: BackupKeep, locale?: string | null): string {
  const S = clientTree(locale, BACKUP_OPTIONS_WORDS).span;
  if (sameKeep(keep, BACKUP_KEEP_YEAR)) return interpolate(S.upTo, { span: S.year });
  if (sameKeep(keep, BACKUP_KEEP_90_DAYS)) return S.days90;
  return interpolate(S.upTo, { span: customSpan(keep, locale) ?? '' });
}

/** The longest window of a policy, in days. */
export function keepDays(keep: BackupKeep): number {
  return Math.max(keep.allDays, keep.dailyDays, keep.weeklyWeeks * 7, Math.round(keep.monthlyMonths * 30.4));
}

export function sameKeep(a: BackupKeep, b: BackupKeep): boolean {
  return (
    a.allDays === b.allDays &&
    a.dailyDays === b.dailyDays &&
    a.weeklyWeeks === b.weeklyWeeks &&
    a.monthlyMonths === b.monthlyMonths
  );
}

/** Which of the dialog's choices a policy's keep is. */
export function keepChoice(keep: BackupKeep): 'year' | 'days90' | 'custom' {
  return sameKeep(keep, BACKUP_KEEP_YEAR)
    ? 'year'
    : sameKeep(keep, BACKUP_KEEP_90_DAYS)
      ? 'days90'
      : 'custom';
}

function thinnedLine(keep: BackupKeep, locale?: string | null): string {
  const S = clientTree(locale, BACKUP_OPTIONS_WORDS).span;
  const parts: string[] = [];
  if (keep.dailyDays > keep.allDays)
    parts.push(interpolate(S.dailyFirst, { span: spanOf(keep.dailyDays, 'day', locale) }));
  if (keep.weeklyWeeks * 7 > Math.max(keep.allDays, keep.dailyDays))
    parts.push(
      interpolate(parts.length ? S.weekly : S.weeklyFirst, {
        span: spanOf(keep.weeklyWeeks * 7, 'week', locale),
      }),
    );
  if (keep.monthlyMonths * 30 > Math.max(keep.allDays, keep.dailyDays, keep.weeklyWeeks * 7))
    parts.push(parts.length ? S.monthly : S.monthlyFirst);
  return parts.join(', ');
}

function spanOf(days: number, unit: 'day' | 'week', locale?: string | null): string {
  const S = clientTree(locale, BACKUP_OPTIONS_WORDS).span;
  if (unit === 'week' && days >= 56 && days % 28 === 0) return S.months(days / 28);
  if (days >= 14 && days % 7 === 0) return S.weeks(days / 7);
  return S.days(days);
}

export interface BackupHeroInput {
  status: BackupServiceStatus | null;
  /** The summary (`appliance.status`'s or `backup.overview`'s): what the last backup left out, bringing it back. */
  summary?: Pick<BackupStatus, 'incomplete' | 'bringBack'> | null;
  policy: BackupPolicy | null;
  list: BackupCheckpointsOutput | null;
  /** The place's name (“BlackBox”), or the destination's display. */
  placeName: string | null;
  /** Back up now is running here (the service may not say so yet). */
  running?: boolean;
  /** Back up now just finished here: “Backed up just now”. */
  justNow?: boolean;
  /** The overview's plain sentence while the backup service isn't answering (`backup.overview`'s `notice`). */
  notice?: string | null;
  /** When the last backup finished as the Whombat last said it (`appliance.status`), for when the service can't say. */
  lastKnownAt?: string | null;
  now?: Date;
  /** The language its words are in (English when none is given). */
  locale?: string | null;
}

function sentence(text: string): string {
  const t = text.trim();
  return t && !/[.!?…]$/.test(t) ? `${t}.` : t;
}

/** Signs that a reason is an error for developers, not a sentence for people: a path, an error code, a tool's prefix. */
const RAW_REASON = [
  /(^|[\s(])\/[\w.-]+\/[\w./-]*/,
  /\bno such file\b/i,
  /\bpermission denied\b/i,
  /\bexit (status|code)\b/i,
  /\b(E[A-Z]{3,}|errno)\b/,
  /\bwhombat-[a-z-]+:/,
  /\b(stat|open|read|dial|lstat) [^\s]+:/,
  /\(\s*[a-z][\w-]*:/,
];

/**
 * What a backup left out, in plain words (a sentence, curly apostrophes). An older backup service says why with its raw
 * error (`whombat-hosts: stat /persist/hosts/hub.db: …`): then the sentence comes from what is known (the servers, the
 * files that weren't there), else a general one. Null when nothing was left out.
 */
export function plainLeftOut(
  gap: { reason?: string | null; attachments?: number; servers?: boolean } | null | undefined,
  locale?: string | null,
): string | null {
  if (!gap) return null;
  const T = backupOptionsText(locale).leftOutWhy;
  const reason = gap.reason?.replace(/\s+/g, ' ').trim() ?? '';
  if (reason && !RAW_REASON.some((r) => r.test(reason))) return sentence(reason.replace(/'/g, '’'));
  if (gap.servers) return T.servers;
  if (gap.attachments) return T.files(gap.attachments);
  return reason ? T.other : null;
}

/** Where the backups stand (`BackupHeroState`), from the service's status and what this screen just did. */
export function backupHeroState(
  input: Pick<BackupHeroInput, 'status' | 'running' | 'justNow'>,
): BackupHeroState {
  const s = input.status;
  if (input.running || s?.running?.op === 'checkpoint') return 'running';
  if (s?.state === 'failing') return 'failing';
  if (s?.state === 'stale') return 'behind';
  if (input.justNow) return 'justNow';
  return s?.lastSuccess ? 'ok' : 'none';
}

/** “Can be brought back”: `ready`, or `paper_only` (a paper copy of the current details). */
export function canBeBroughtBack(
  bringBack: Pick<BackupBringBack, 'state' | 'setup'> | null | undefined,
): boolean {
  return (
    (bringBack?.state === 'ready' && (!bringBack.setup || bringBack.setup === 'verified')) ||
    bringBack?.state === 'paper_only'
  );
}

/**
 * Whether Backups and the Overview ask for the passkey's touch: while the Whombat has backups and no passkey holds their
 * key (`needs_passkey`). One rule for the web and the phone; a Whombat from before the passkey doesn't say, and nothing
 * is asked there.
 */
export function backupPasskeyAsked(summary: Pick<BackupStatus, 'bringBack'> | null | undefined): boolean {
  const b = summary?.bringBack;
  return b?.setup === 'verify' || (b?.state === 'needs_passkey' && b.setup !== 'saving');
}

/**
 * The top card: the answer to “am I safe?” and the settings in plain words. While the backup service isn't answering
 * the card keeps what it knows (the service's last word, else when the Whombat last said a backup finished), says the
 * notice and offers *Ask {assistant} to fix it*; without the service's word its shield says it can't tell.
 */
export function backupHero(input: BackupHeroInput): BackupHero {
  const locale = input.locale;
  const T = backupOptionsText(locale);
  const W = clientTree(locale, BACKUP_OPTIONS_WORDS).wayBack;
  const now = input.now ?? new Date();
  const notice = input.notice?.trim() ? sentence(input.notice) : null;
  const heroState = notice && !input.status && !input.running ? 'unknown' : backupHeroState(input);
  // A Whombat just brought back has made none of its own yet, but its list holds the backups it came back from: the
  // service says it has none, and nothing is wrong, so the card says when the newest of those was.
  const listed =
    heroState === 'none' && input.status ? (input.list?.checkpoints[0]?.createdAt ?? null) : null;
  const state: BackupHeroState = listed ? 'ok' : heroState;
  const last = input.status?.lastSuccess?.at ?? listed ?? (notice ? (input.lastKnownAt ?? null) : null);
  // A failing backup must not read as “Backed up 3 days ago” under a green shield: that is the one thing to know.
  const title =
    state === 'running'
      ? T.running
      : state === 'failing'
        ? T.failing
        : state === 'behind'
          ? T.behind
          : state === 'justNow'
            ? T.justNow
            : last
              ? T.backedUp(ago(last, locale))
              : state === 'unknown'
                ? T.unknown
                : T.notYet;
  const reason = input.status?.lastFailure?.reason ?? '';
  const finished = last ? T.lastFinished(ago(last, locale)) : T.noneFinished;
  const problem =
    [
      state === 'failing'
        ? [sentence(reason), finished].filter(Boolean).join(' ')
        : state === 'behind'
          ? finished
          : null,
      notice,
    ]
      .filter(Boolean)
      .join(' ') || null;
  const oldest = input.list?.checkpoints.at(-1)?.createdAt ?? null;
  const sub = [
    input.placeName ? T.on(input.placeName) : null,
    input.policy ? T.next(hhmm(nextBackupAt(input.policy, now))) : null,
    oldest ? T.oldest(longDate(oldest, locale)) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const chips: BackupHeroChip[] = [];
  if (input.policy) {
    chips.push({ text: T.chips.frequency[input.policy.frequency] });
    const choice = keepChoice(input.policy.keep);
    chips.push({
      text:
        choice === 'year'
          ? T.chips.keptYear
          : choice === 'days90'
            ? T.chips.kept90
            : T.chips.keptFor(customSpan(input.policy.keep, locale) ?? ''),
    });
  }
  const used = input.list?.space?.usedBytes ?? null;
  if (used !== null) {
    const free = input.list?.space?.freeBytes ?? null;
    chips.push({
      text: T.chips.space(formatBytes(used, locale), free === null ? null : formatBytes(free, locale)),
    });
  }
  const drill = input.status?.recoverability.lastDrill ?? null;
  if (drill) {
    const day = relativeDay(drill.at, now, locale);
    chips.push(
      drill.ok ? { text: T.chips.checked(day), dot: 'ok' } : { text: T.chips.checkFailed(day), dot: 'bad' },
    );
  }
  const bringBack = input.summary?.bringBack ?? null;
  const incomplete = input.summary?.incomplete ?? input.status?.lastSuccess?.incomplete ?? null;
  return {
    state,
    title,
    sub,
    chips,
    tone:
      state === 'failing' ? 'bad' : state === 'behind' || notice ? 'warn' : state === 'none' ? 'mut' : 'ok',
    problem,
    askFix: state === 'failing' || state === 'behind' || notice !== null,
    leftOut: incomplete ? plainLeftOut(incomplete, locale) : null,
    wayBackReady: canBeBroughtBack(bringBack),
    wayBack:
      bringBack?.setup === 'saving'
        ? W.saving
        : bringBack?.setup === 'verify'
          ? W.verify
          : bringBack?.state === 'ready'
            ? T.wayBack.ready
            : bringBack?.state === 'paper_only'
              ? T.wayBack.paper
              : null,
    askPasskey: backupPasskeyAsked(input.summary),
  };
}

/**
 * Which Backups page a Whombat gets: `yes` where it lists its backups; `down` where it does but the backup service isn't
 * answering now (the overview's `notice`: the same page, saying so and keeping what it knows); `no` on a box from before
 * or one without backups (what it showed before); `loading` while that isn't known. `notice` is undefined until the
 * overview answered. One rule for the web and the phone.
 */
export type BackupPageShown = 'loading' | 'yes' | 'down' | 'no';
export function backupPageShown(input: {
  list: { pending: boolean; failed: boolean };
  policy: { pending: boolean; failed: boolean };
  notice: string | null | undefined;
}): BackupPageShown {
  const failed = input.list.failed || input.policy.failed;
  if (failed && input.notice === undefined) return 'loading';
  if (failed) return input.notice ? 'down' : 'no';
  if (input.list.pending || input.policy.pending) return 'loading';
  return input.notice ? 'down' : 'yes';
}

/** The quiet line under the list about older backups on the places used before; null when there were none. */
export function earlierPlacesLine(
  places: readonly { name: string }[] | null | undefined,
  locale?: string | null,
): string | null {
  const names = [...new Set((places ?? []).map((p) => p.name))];
  return names.length ? backupOptionsText(locale).list.earlierPlaces(andList(names, locale)) : null;
}

/** What *Ask {assistant} to fix it* on the card says: what is wrong, then the ask (as the Inbox's own button does). */
export function backupFixText(hero: Pick<BackupHero, 'title' | 'problem'>, locale?: string | null): string {
  return [hero.title, hero.problem, clientTree(locale, BACKUP_OPTIONS_WORDS).fixAsk]
    .filter(Boolean)
    .join('\n');
}

/* The list ---------------------------------------------------------------------------------------------------- */

export interface BackupRow {
  id: string;
  /** “15:00” today and yesterday, “Sun 25 Oct” earlier. */
  time: string;
  label: string;
  /** “+41 MB”, or the whole size for the first backup. */
  size: string;
  check: 'ok' | 'bad' | null;
  /** It was made with a gap (what it left out is on its page). */
  leftOut: boolean;
  checkpoint: BackupCheckpoint;
}

export interface BackupGroup {
  key: 'today' | 'yesterday' | 'later';
  label: string;
  /** The thinning line under LATER ON. */
  note: string | null;
  rows: BackupRow[];
}

/** What a backup is, in words (“Scheduled”, “You asked”, “Before the update to 0.198”, “First backup”). */
export function backupLabel(cp: BackupCheckpoint, isFirst: boolean, locale?: string | null): string {
  const L = backupOptionsText(locale).list;
  if (isFirst) return L.first;
  if (cp.reason === 'pre-migration') {
    const v = cp.releaseId?.match(/\d+\.\d+(?:\.\d+)?/)?.[0];
    return v ? L.beforeUpdate(v) : L.reasons['pre-migration'];
  }
  return L.reasons[cp.reason];
}

/**
 * The first backup of each Whombat in a list (its oldest), so one brought back still calls the earlier one's first backup
 * “First backup”. Only for a list read to its start: a page that goes on doesn't hold the first.
 */
export function firstBackups(list: {
  checkpoints: readonly Pick<BackupCheckpoint, 'id' | 'applianceId' | 'own'>[];
  nextCursor?: string | null;
}): Set<string> {
  const firsts = new Map<string, string>();
  if (list.nextCursor) return new Set();
  // This box's own apart from any earlier Whombat's, whatever ids they carry.
  for (const cp of list.checkpoints) firsts.set(cp.own ? '(own)' : cp.applianceId, cp.id);
  return new Set(firsts.values());
}

/** The list grouped as the page shows it (newest first); `limit` rows in all unless `all`. */
export function backupGroups(
  list: BackupCheckpointsOutput,
  keep: BackupKeep | null,
  options: { now?: Date; limit?: number; locale?: string | null } = {},
): BackupGroup[] {
  const now = options.now ?? new Date();
  const locale = options.locale;
  const L = backupOptionsText(locale).list;
  const today = dayKey(now);
  const yd = new Date(now);
  yd.setDate(yd.getDate() - 1);
  const yesterday = dayKey(yd);
  const firsts = firstBackups(list);
  const groups: BackupGroup[] = [
    { key: 'today', label: L.today, note: null, rows: [] },
    { key: 'yesterday', label: L.yesterday, note: null, rows: [] },
    { key: 'later', label: L.later, note: keep ? thinnedLine(keep, locale) || null : null, rows: [] },
  ];
  let n = 0;
  for (const cp of list.checkpoints) {
    if (options.limit !== undefined && n >= options.limit) break;
    const d = new Date(cp.createdAt);
    const k = dayKey(d);
    const group = k === today ? groups[0] : k === yesterday ? groups[1] : groups[2];
    const isFirst = firsts.has(cp.id);
    const added = cp.bytesAdded;
    group?.rows.push({
      id: cp.id,
      time: group.key === 'later' ? shortDay(cp.createdAt, locale) : hhmm(d),
      label: backupLabel(cp, isFirst, locale),
      size:
        isFirst || added === null ? formatBytes(added ?? cp.bytes, locale) : `+${formatBytes(added, locale)}`,
      check: cp.check ? (cp.check.ok ? 'ok' : 'bad') : null,
      leftOut: !!cp.incomplete && (!!cp.incomplete.attachments || !!cp.incomplete.servers),
      checkpoint: cp,
    });
    n++;
  }
  return groups.filter((g) => g.rows.length > 0);
}

/* One backup's “What’s in it” ------------------------------------------------------------------------------------- */

export interface BackupContentsRow {
  key: string;
  text: string;
  note?: string;
  covered: boolean;
  /** Something of it was left out of this backup (a gap, said plainly in `note`). */
  gap?: boolean;
}

/** Each line and the coverage classes (`BackupScope`) behind it. */
const CONTENT_SCOPES: Record<string, readonly string[]> = {
  conversations: ['database', 'memory', 'packs'],
  files: ['attachments'],
  projects: ['workspaces', 'home'],
  servers: ['servers'],
  settings: ['configuration'],
  signIns: ['provider-sessions'],
};

/**
 * “What’s in it” from the backup's own coverage (`covered`, from its signed manifest) and what it left out
 * (`incomplete`). A backup service that doesn't list it yet: what every backup holds. The servers' line shows only where
 * the Whombat backs servers up. Wi-Fi, Bluetooth and voices are never in a backup, worded as the done screen says them.
 */
export function backupContents(
  cp: Pick<BackupCheckpoint, 'covered' | 'incomplete'>,
  locale?: string | null,
): BackupContentsRow[] {
  const L = backupOptionsText(locale).detail.lines;
  const covered = cp.covered ? new Set(cp.covered) : null;
  const has = (key: string) => !covered || (CONTENT_SCOPES[key] ?? []).some((id) => covered.has(id));
  const missing = cp.incomplete?.attachments ?? 0;
  const rows: BackupContentsRow[] = [
    { key: 'conversations', text: L.conversations, covered: has('conversations') },
    missing > 0
      ? { key: 'files', text: L.files, note: L.filesMissing(missing), covered: has('files'), gap: true }
      : { key: 'files', text: L.files, covered: has('files') },
    { key: 'projects', text: L.projects, note: L.projectsNote, covered: has('projects') },
  ];
  if (cp.incomplete?.servers)
    rows.push({ key: 'servers', text: L.servers, note: L.serversMissing, covered: false, gap: true });
  else if (!covered || covered.has('servers')) rows.push({ key: 'servers', text: L.servers, covered: true });
  rows.push(
    { key: 'settings', text: L.settings, covered: has('settings') },
    { key: 'signIns', text: L.signIns, note: L.signInsNote, covered: has('signIns') },
    { key: 'network', text: L.network, note: L.networkNote, covered: false },
    { key: 'voices', text: L.voices, note: L.voicesNote, covered: false },
  );
  return rows;
}

/* Details --------------------------------------------------------------------------------------------------------- */

/**
 * Backups' less-used details, folded under “Details”: where they are kept, who clears old ones, and that they can't be
 * deleted from here (one phrase, for a place that refuses the box's deletes).
 */
export function backupDetailLines(input: {
  status: BackupServiceStatus | null;
  clearedBy: 'place' | 'box' | 'none' | null;
  placeName: string | null;
  locale?: string | null;
}): string[] {
  const D = backupOptionsText(input.locale).details;
  const display = input.status?.destination.display?.trim() || null;
  const where =
    input.placeName && display && display !== input.placeName
      ? `${input.placeName} (${display})`
      : (input.placeName ?? display);
  return [
    where ? D.where(where) : null,
    input.clearedBy === 'place'
      ? D.clears.place(input.placeName)
      : input.clearedBy === 'box'
        ? D.clears.box
        : input.clearedBy === 'none'
          ? D.clears.none
          : null,
    input.status?.destination.appendOnly === 'verified' ? `${D.noDelete}.` : null,
  ].filter((l): l is string => l !== null);
}

/* Bringing back a Whombat you had, later ------------------------------------------------------------------------- */

/** How long a Whombat that started fresh still offers “Bring back a Whombat you had”. */
export const BRING_BACK_LATER_DAYS = 7;

/**
 * Whether Backups offers “Bring back a Whombat you had” (Whombat backup-options.md BKO-29): while this Whombat started
 * fresh — no backups set up, none of its own yet, or only a few days of them — and it didn't come back from one already.
 * A mistaken “Start fresh” isn't final.
 */
export function bringBackLaterOffered(input: {
  list: Pick<BackupCheckpointsOutput, 'checkpoints' | 'total' | 'nextCursor'> | null;
  /** No place set up: nothing listed yet. */
  unprotected: boolean;
  now?: Date;
}): boolean {
  if (input.unprotected) return true;
  const list = input.list;
  if (!list) return false;
  // Brought back already: its list holds the earlier Whombat's backups.
  if (list.checkpoints.some((c) => !c.own)) return false;
  if (list.nextCursor) return false;
  const own = list.checkpoints.filter((c) => c.own);
  const oldest = own.at(-1)?.createdAt;
  if (!oldest) return true;
  const now = input.now ?? new Date();
  return now.getTime() - Date.parse(oldest) < BRING_BACK_LATER_DAYS * 86_400_000;
}

/* The options dialog ------------------------------------------------------------------------------------------ */

/**
 * About how much the backups take with a policy: the newest backup's size once, plus what a day adds over the
 * policy's longest window (restic keeps a block once however many backups name it). Null without a week of history.
 */
export function estimateBytes(list: BackupCheckpointsOutput | null, keep: BackupKeep): number | null {
  if (!list || list.checkpoints.length < 2) return null;
  const own = list.checkpoints.filter((c) => c.own && c.bytesAdded !== null);
  if (own.length < 2) return null;
  const newest = own[0] as BackupCheckpoint;
  const oldest = own.at(-1) as BackupCheckpoint;
  const days = Math.max(1, (Date.parse(newest.createdAt) - Date.parse(oldest.createdAt)) / 86_400_000);
  const added = own.slice(0, -1).reduce((s, c) => s + (c.bytesAdded ?? 0), 0);
  const perDay = added / days;
  const base =
    (list.space?.usedBytes ?? 0) > 0 ? Math.min(list.space?.usedBytes ?? 0, newest.bytes) : newest.bytes;
  return Math.round(base + perDay * keepDays(keep));
}

/** The dialog's top line: how far back and about how much space. */
export function policySummary(
  keep: BackupKeep,
  list: BackupCheckpointsOutput | null,
  placeName: string | null,
  locale?: string | null,
): string {
  const est = estimateBytes(list, keep);
  const free = list?.space?.freeBytes ?? null;
  return backupOptionsText(locale).dialog.summary(
    keepSpan(keep, locale),
    est === null ? null : formatBytes(roundEstimate(est), locale),
    placeName,
    free === null ? null : formatBytes(free, locale),
  );
}

/** “About 20 GB”, not “19.37 GB”. */
function roundEstimate(bytes: number): number {
  const gb = bytes / 1e9;
  if (gb >= 10) return Math.round(gb / 5) * 5e9;
  if (gb >= 1) return Math.round(gb) * 1e9;
  return Math.max(1e8, Math.round(bytes / 1e8) * 1e8);
}

/** The timeline's ticks, 0…1 left to right: denser towards now (the dialog's picture of thinning). */
export function keepTicks(keep: BackupKeep): { at: number; tall: boolean }[] {
  const ticks: { at: number; tall: boolean }[] = [];
  const seg = (a: number, b: number, n: number, tall = false) => {
    for (let i = 0; i < n; i++) ticks.push({ at: a + ((b - a) * (i + 0.5)) / n, tall });
  };
  if (keep.monthlyMonths > 2) seg(0, 0.38, Math.min(12, keep.monthlyMonths - 2));
  if (keep.weeklyWeeks > 2) seg(0.38, 0.62, Math.min(8, keep.weeklyWeeks - 2));
  if (keep.dailyDays > 2) seg(0.62, 0.86, Math.min(14, keep.dailyDays - 2));
  seg(0.86, 1, Math.min(8, Math.max(2, keep.allDays * 4)), true);
  return ticks;
}

/* Choosing the backup to bring back ------------------------------------------------------------------------------ */

/**
 * The backups in a list made by a Whombat after another took its place: a Whombat brought back from it backs up to the
 * same backups from then on, so its first backup there marks when the old one was replaced. What the old one made after
 * that came from a box that was lost, stolen or switched off. Ids, of a list in any order.
 */
export function madeAfterReplaced(
  checkpoints: readonly Pick<BackupCheckpoint, 'id' | 'applianceId' | 'createdAt'>[],
): Set<string> {
  const firstAt = new Map<string, number>();
  for (const cp of checkpoints) {
    const at = Date.parse(cp.createdAt);
    const had = firstAt.get(cp.applianceId);
    if (had === undefined || at < had) firstAt.set(cp.applianceId, at);
  }
  const out = new Set<string>();
  for (const cp of checkpoints) {
    const mine = firstAt.get(cp.applianceId) ?? 0;
    // Replaced when a Whombat that came after this one made its first backup here.
    let replaced = Number.POSITIVE_INFINITY;
    for (const at of firstAt.values()) if (at > mine && at < replaced) replaced = at;
    if (Date.parse(cp.createdAt) > replaced) out.add(cp.id);
  }
  return out;
}

/** The backup a bring back picks first: the newest one not made after its Whombat was replaced (else the newest). */
export function backupToBringBack(
  checkpoints: readonly Pick<BackupCheckpoint, 'id' | 'applianceId' | 'createdAt'>[],
): string | null {
  const late = madeAfterReplaced(checkpoints);
  const newest = [...checkpoints].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return (newest.find((cp) => !late.has(cp.id)) ?? newest[0])?.id ?? null;
}

/**
 * The done screen's lines about the old Whombat: switched off (it can't reach the account once this one said where it
 * came from); and after “lost or stolen” on a place Whombat can't give a new password, that the person changes it.
 */
export function oldWhombatDoneLines(
  state: Pick<BackupRestoreState, 'items' | 'oldApplianceId' | 'newPassword'> | null,
  name: string,
  locale?: string | null,
): string[] {
  const B = backupOptionsText(locale).bringBack;
  const lost = state?.items.find((i) => i.id === 'old-appliance')?.resolution === 'credentials-rotated';
  return [
    ...(state?.oldApplianceId ? [B.doneOldOff(name)] : []),
    ...(lost && state?.newPassword?.by === 'you' ? [B.donePassword(state.newPassword.place)] : []),
  ];
}

/** The question's words about the old Whombat: they promise a new password only where Whombat can give one. */
export function oldWhombatMeta(
  answer: 'gone' | 'lost' | null,
  newPassword: BackupRestoreState['newPassword'] | null | undefined,
  locale?: string | null,
): string {
  const B = backupOptionsText(locale).bringBack;
  const yours = newPassword?.by === 'you';
  if (answer === 'lost') return yours ? B.oldLostMetaYou(newPassword?.place ?? null) : B.oldLostMeta;
  return yours ? B.oldGoneMetaYou : B.oldGoneMeta;
}

/* The restore ------------------------------------------------------------------------------------------------- */

/** The steps of the “Bringing … back” screen and which is going. */
export function restoreSteps(
  state: BackupRestoreState | null,
  runtimeReachable: boolean,
  place: string | null,
  locale?: string | null,
): { text: string; state: 'done' | 'running' | 'queued' }[] {
  const S = backupOptionsText(locale).bringBack.steps;
  const stage = state?.stage ?? null;
  const order = ['check', 'copy', 'put', 'servers'] as const;
  let at = 0;
  if (!runtimeReachable) at = 1;
  if (stage === 'prepare' || stage === 'check') at = 0;
  if (stage === 'restore') at = 1;
  if (stage === 'database' || stage === 'release') at = 2;
  if (stage === 'start' || state?.phase === 'checking' || state?.phase === 'released') at = 3;
  if (state?.phase === 'checking' || state?.phase === 'released') at = 4;
  return order.map((k, i) => ({
    text: k === 'copy' ? S.copy(place) : S[k],
    state: i < at ? 'done' : i === at ? 'running' : 'queued',
  }));
}

/** The providers to sign in to again, by name (“Claude and GitHub”). */
export function reloginNames(relogin: readonly string[]): string[] {
  const names: Record<string, string> = {
    claude: 'Claude',
    anthropic: 'Claude',
    codex: 'Codex',
    openai: 'Codex',
    github: 'GitHub',
    google: 'Google',
  };
  const out = new Set<string>();
  for (const r of relogin) {
    const provider = r.split('/').at(-1)?.toLowerCase() ?? '';
    out.add(names[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1));
  }
  return [...out];
}

/** “Claude and GitHub”, “Claude, Codex and GitHub”. */
export function andList(items: readonly string[], locale?: string | null): string {
  if (items.length <= 1) return items[0] ?? '';
  return interpolate(clientTree(locale, BACKUP_OPTIONS_WORDS).and, {
    head: items.slice(0, -1).join(', '),
    last: items.at(-1) ?? '',
  });
}
