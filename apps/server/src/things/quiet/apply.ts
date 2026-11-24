/**
 * What a thing's lines of Worth a look come to (quiet-notices.md QN-01…QN-04, QN-11…QN-14; QN-S03…QN-S08): given its
 * lines as a kind (and the generic parts) made them, its quiet rows (Ignore, Remind me tomorrow), the checks it no
 * longer watches, what the health pass saw before, the time, the checks this read skipped and whether this is a health
 * pass, it says which lines are active, which are quiet (with their row), which aren't watched (dropped), the thing's
 * status and reason from the active lines, and — in a health pass only — the quiet rows that end now and the states to
 * write. A page read only marks: it never ends a row, but a row that would end at the next pass (worse, another episode,
 * past its time) no longer quiets its line there either, so the page and the dot agree. Pure.
 */
import type { ThingPageNotice } from '@whombat/core';
import type { NoticeQuietRow, NoticeStateRow, WatchOffRow } from '../../db/schema/quiet';
import { defaultNature, type NoticeNature, type NoticeWatch } from './types';
import { type CauseLike, type Hold, heldRow, holdOf, type WindowLike } from './windows';

/** What `applyQuiet` needs of a line: a page's (`LooseNotice`, `KindNotice`) or a glance's (`GlanceLine`). */
export type ApplyLine = Pick<ThingPageNotice, 'tone' | 'title' | 'link'> & Partial<NoticeWatch>;

export type Tone = 'bad' | 'warn' | 'info';
export const TONE_RANK: Record<Tone, number> = { info: 0, warn: 1, bad: 2 };

/** The rows `apply` reads: the stored ones, or the same fields from anywhere. */
export type QuietRow = Pick<
  NoticeQuietRow,
  | 'checkId'
  | 'subject'
  | 'state'
  | 'lifts'
  | 'episode'
  | 'tone'
  | 'band'
  | 'until'
  | 'clearPasses'
  | 'title'
  | 'subjectName'
  | 'words'
  | 'byId'
  | 'at'
>;
export type OffRow = Pick<WatchOffRow, 'checkId' | 'subject'>;
export type StateRow = Pick<
  NoticeStateRow,
  'checkId' | 'subject' | 'firstSeen' | 'lastSeen' | 'seenPasses' | 'tone'
>;

/**
 * Checks a read skipped (an optional part not read, a capped list): an exact check, a prefix (`unifi.*`), `*` for every
 * check, or a function. A skipped check's missing line says nothing: it never counts as back to normal.
 */
export type Skipped = readonly string[] | ((check: string) => boolean);

export function isSkipped(skipped: Skipped | undefined, check: string): boolean {
  if (!skipped) return false;
  if (typeof skipped === 'function') return skipped(check);
  return skipped.some((s) =>
    s === '*' ? true : s.endsWith('.*') ? check.startsWith(s.slice(0, -1)) : s === check,
  );
}

/** The key of a line or row: its check and item (`''` for the whole thing). */
export function lineKey(check: string, subject: string | undefined | null): string {
  return `${check}\n${subject ?? ''}`;
}

const keyOfLine = (l: ApplyLine) => (l.check ? lineKey(l.check, l.subject?.id) : null);
const keyOfRow = (r: { checkId: string; subject: string }) => lineKey(r.checkId, r.subject);

/** The nature a line has: its own, else the older default (QN-01). */
export function natureOf(l: ApplyLine): NoticeNature {
  return l.nature ?? defaultNature(l);
}

/** How many health passes in a row a line with `confirm: 2` needs before it colours the dot (QN-04). */
export const CONFIRM_PASSES = 2;
/**
 * Health passes in a row without the line before an Ignore ends (QN-11): about an hour at one pass every 5 minutes, so
 * a service that stops reporting a problem for a moment (Plex testing its port mapping again) doesn't end it and bring
 * the line back as new (on-purpose.md).
 */
export const FIXED_PASSES = 12;

export interface ApplyInput<L extends ApplyLine> {
  lines: readonly L[];
  quiets: readonly QuietRow[];
  offs: readonly OffRow[];
  states: readonly StateRow[];
  now: Date;
  /** A health pass: rows end and states are written. A page read only marks. */
  pass: boolean;
  skipped?: Skipped;
  /**
   * Checks Whombat doesn't watch on this thing because they start off and nobody turned them on (watch-defaults.md;
   * `defaults.ts` `notWatched`): their lines are dropped like those of a check switched off.
   */
  unwatched?: (check: string) => boolean;
  /**
   * The thing's quiet windows and its cause (monitoring.md MON-04, MON-07): while one holds at `now`, every watched line
   * is quiet with it, and a pass keeps no line's count, so what is still wrong when it ends counts from the start.
   */
  windows?: readonly WindowLike[];
  cause?: CauseLike | null;
}

export interface QuietLine<L extends ApplyLine, R extends QuietRow = QuietRow> {
  line: L;
  row: R;
}

export interface ApplyResult<L extends ApplyLine, R extends QuietRow = QuietRow> {
  /** Lines nobody quieted, in the order they came. */
  active: L[];
  /** Lines quieted by a row that still holds. */
  quiet: QuietLine<L, R>[];
  /** Lines of a check (or an item) Whombat doesn't watch: shown nowhere. */
  dropped: L[];
  /** The worst tone among active lines that aren't heads-ups and are confirmed. */
  status: 'ok' | 'warn' | 'bad';
  /** The line behind `status`; null when fine. */
  worst: L | null;
  /** Every line that counts towards `status`, in the order they came: what a research of the thing covers. */
  asking: L[];
  /** `worst`'s badge or title, at most 120 characters (the card's reason). */
  reason?: string;
  /** `worst`'s badge or title, at most 60 characters (the head's badge). */
  badge?: string;
  /** Pass only: rows that end now (fixed, newer, worse, past their time). */
  lift: R[];
  /** Pass only: rows whose `clearPasses` changed (with the new count). */
  cleared: R[];
  /** Pass only: the states of the lines seen now. */
  states: StateRow[];
  /** Pass only: states of lines gone (read and not there, or not watched). */
  gone: StateRow[];
  /** What holds the whole thing quiet now (a window or a cause); null when nothing does. */
  held: Hold | null;
}

function worse(line: ApplyLine, row: QuietRow): boolean {
  if (TONE_RANK[line.tone] > TONE_RANK[row.tone]) return true;
  return line.band != null && row.band != null && line.band > row.band;
}

/** An episode that differs ends an Ignore of any kind; one missing on either side counts as the same (QN-S05). */
function newEpisode(line: ApplyLine, row: QuietRow): boolean {
  return line.episode != null && row.episode != null && line.episode !== row.episode;
}

function pastTime(row: QuietRow, now: Date): boolean {
  return row.until !== null && row.until.getTime() <= now.getTime();
}

/** Whether a row no longer holds over the line it quiets (present) at `now`. */
export function rowEnds(row: QuietRow, line: ApplyLine | undefined, now: Date): boolean {
  if (row.state === 'snoozed' || row.lifts === 'period') {
    if (pastTime(row, now)) return true;
  }
  if (!line) return false;
  if (worse(line, row)) return true;
  return row.state === 'ignored' && newEpisode(line, row);
}

/** Whether an off covers a line: the whole check, or its item. */
function offCovers(off: OffRow, line: ApplyLine): boolean {
  return off.checkId === line.check && (off.subject === '' || off.subject === (line.subject?.id ?? ''));
}

export function applyQuiet<L extends ApplyLine, R extends QuietRow = QuietRow>(
  input: Omit<ApplyInput<L>, 'quiets'> & { quiets: readonly R[] },
): ApplyResult<L, R> {
  const { now, pass } = input;
  const held = holdOf(input, now);
  const dropped: L[] = [];
  const watched: L[] = [];
  for (const line of input.lines) {
    if (line.check && (input.unwatched?.(line.check) || input.offs.some((o) => offCovers(o, line))))
      dropped.push(line);
    else watched.push(line);
  }
  const byKey = new Map<string, L>();
  for (const line of watched) {
    const key = keyOfLine(line);
    if (key && !byKey.has(key)) byKey.set(key, line);
  }
  const droppedKeys = new Set(dropped.map(keyOfLine).filter((k): k is string => k !== null));

  // Quiet rows: which still hold, which end (a pass), which count a pass without their line.
  const holding = new Map<string, R>();
  const lift: R[] = [];
  const cleared: R[] = [];
  for (const row of input.quiets) {
    const key = keyOfRow(row);
    if (droppedKeys.has(key)) continue;
    const line = byKey.get(key);
    if (rowEnds(row, line, now)) {
      if (pass) lift.push(row);
      continue;
    }
    if (line) {
      holding.set(key, row);
      if (pass && row.clearPasses > 0) cleared.push({ ...row, clearPasses: 0 });
      continue;
    }
    // Gone: any Ignore ends after `FIXED_PASSES` passes in a row that read its check without the line (QN-11, QN-S04),
    // so the next time it comes is new, whatever its episode; a snooze waits for its time.
    if (!pass || row.state !== 'ignored' || isSkipped(input.skipped, row.checkId)) continue;
    const passes = row.clearPasses + 1;
    if (passes >= FIXED_PASSES) lift.push(row);
    else cleared.push({ ...row, clearPasses: passes });
  }

  // States: since when each line is seen, how many passes in a row.
  const before = new Map(input.states.map((s) => [keyOfRow(s), s]));
  const states: StateRow[] = [];
  const seenNow = new Map<string, number>();
  // Held quiet, a pass counts no line and forgets what was counted (it counts again from the start).
  if (pass && !held) {
    for (const [key, line] of byKey) {
      const prev = before.get(key);
      const next: StateRow = {
        checkId: line.check as string,
        subject: line.subject?.id ?? '',
        firstSeen: prev?.firstSeen ?? now,
        lastSeen: now,
        seenPasses: (prev?.seenPasses ?? 0) + 1,
        tone: line.tone,
      };
      states.push(next);
      seenNow.set(key, next.seenPasses);
    }
  } else if (!pass) for (const [key, s] of before) seenNow.set(key, s.seenPasses);
  const gone = pass
    ? input.states.filter((s) => {
        const key = keyOfRow(s);
        if (held) return true;
        if (byKey.has(key)) return false;
        return droppedKeys.has(key) || !isSkipped(input.skipped, s.checkId);
      })
    : [];

  const active: L[] = [];
  const quiet: QuietLine<L, R>[] = [];
  for (const line of watched) {
    const key = keyOfLine(line);
    const row = key ? holding.get(key) : undefined;
    if (row) quiet.push({ line, row });
    // A line held with the whole thing is drawn with a row of its own kind (`held`): every reader keeps it quiet.
    else if (held) quiet.push({ line, row: heldRow(line, held) as unknown as R });
    else active.push(line);
  }

  const confirmed = (l: L) => {
    if (l.confirm !== CONFIRM_PASSES) return true;
    const key = keyOfLine(l);
    return key !== null && (seenNow.get(key) ?? 0) >= CONFIRM_PASSES;
  };
  let worst: L | null = null;
  const asking: L[] = [];
  for (const l of active) {
    if (l.tone === 'info' || natureOf(l) === 'fyi' || !confirmed(l)) continue;
    asking.push(l);
    if (!worst || TONE_RANK[l.tone] > TONE_RANK[worst.tone]) worst = l;
  }
  const status = worst ? (worst.tone as 'bad' | 'warn') : 'ok';
  const words = worst ? (worst.badge ?? worst.title) : null;
  return {
    active,
    quiet,
    dropped,
    status,
    worst,
    asking,
    ...(words ? { reason: words.slice(0, 120), badge: words.slice(0, 60) } : {}),
    lift,
    cleared,
    states,
    gone,
    held,
  };
}

/**
 * Worth a look in its order (QN-14): active lines that aren't heads-ups, worst tone first; then heads-ups; then the
 * quiet ones, greyed at the bottom. Within each, the order they came in.
 */
export function inPageOrder<L extends ApplyLine, R extends QuietRow>(
  result: Pick<ApplyResult<L, R>, 'active' | 'quiet'>,
): { line: L; row: R | null }[] {
  const ranked = result.active.map((line, i) => ({ line, i, fyi: natureOf(line) === 'fyi' }));
  ranked.sort(
    (a, b) =>
      Number(a.fyi) - Number(b.fyi) ||
      (a.fyi ? 0 : TONE_RANK[b.line.tone] - TONE_RANK[a.line.tone]) ||
      a.i - b.i,
  );
  return [
    ...ranked.map((r) => ({ line: r.line, row: null })),
    ...result.quiet.map((q) => ({ line: q.line, row: q.row })),
  ];
}
