/**
 * Worth a look's lines as the storage and business kinds make them (quiet-notices.md QN-01…QN-04, QN-S40…QN-S49): how
 * an Ignore of a line ends, in the line's own words; which lines colour the dot and the head (not heads-ups); the words
 * for the head; lines about several items, one per item; and how full is a problem. Pure.
 */
import type { ThingPageNotice } from '@whombat/core';
import { moreSubject, shortHash, splitItems } from '../../quiet/items';
import { defaultNature, type KindNotice, type NoticeIgnore, type NoticeNature } from '../../quiet/types';

export type { KindNotice };

/** Ignore ends when the check sees it back to normal twice (QN-11), or it gets worse. */
export const fixed = (words: string): NoticeIgnore => ({ lifts: 'fixed', words });
/** Ignore ends when the line's episode changes (another run, another version, other items). */
export const newer = (words: string): NoticeIgnore => ({ lifts: 'newer', words });
/** Ignore ends when the window the line is about resets (`until`). */
export const period = (words: string, until: Date): NoticeIgnore => ({
  lifts: 'period',
  words,
  until: until.toISOString(),
});

/** When you'll hear again, the words several kinds share (at most 60 characters, QN-10). */
export const UNTIL = {
  healthy: 'Until it’s healthy again.',
  fuller: 'Until it gets fuller.',
  replaced: 'Until it’s replaced.',
  cooler: 'Until it cools down.',
  nextBackup: 'Until the next backup.',
  nextRun: 'Until the next run.',
  version: 'Until the next version.',
  running: 'Until it’s running again.',
  back: 'Until it’s back.',
  fixed: 'Until it’s fixed.',
  others: 'Until the list changes.',
} as const;

/** A line's kind (QN-01), also for one without it (an info line a heads-up, an ask a problem, else only you). */
export function natureOf(n: ThingPageNotice & { nature?: NoticeNature }): NoticeNature {
  return n.nature ?? defaultNature(n);
}

/** It colours the dot, the head and the card (QN-02): amber or red and not a heads-up. */
export function counts(n: ThingPageNotice & { nature?: NoticeNature }): boolean {
  return n.tone !== 'info' && natureOf(n) !== 'fyi';
}

/** The head's badge and the card's reason from a line: its short badge when it has one, else its title. */
export function headWords(n: ThingPageNotice & { badge?: string }): string {
  return n.badge ?? n.title;
}

/**
 * One line per item in the order given (worst first), at most three lines (QN-03); the rest share the last one, with the same
 * check, the subject “N more”, and an Ignore that lasts while the rest is the same items (`shortHash` of their ids).
 */
export function itemLines<T>(
  items: readonly T[],
  each: (item: T) => KindNotice,
  idOf: (item: T) => string,
  rest: (items: T[]) => Omit<KindNotice, 'subject' | 'ignore' | 'episode'>,
): KindNotice[] {
  const { each: first, rest: others } = splitItems(items);
  const out = first.map(each);
  if (others.length)
    out.push({
      ...rest(others),
      subject: moreSubject(others.length),
      ignore: newer(UNTIL.others),
      episode: shortHash(others.map(idOf)),
    });
  return out;
}

/** The worst tone and its nature among lines (for the “N more” line). */
export function worstOf(lines: readonly KindNotice[]): Pick<KindNotice, 'tone' | 'nature'> {
  const rank = (n: KindNotice) => ({ info: 0, warn: 1, bad: 2 })[n.tone] + (counts(n) ? 3 : 0);
  const worst = [...lines].sort((a, b) => rank(b) - rank(a))[0];
  return worst ? { tone: worst.tone, nature: worst.nature } : { tone: 'info', nature: 'fyi' };
}

/* How full ------------------------------------------------------------------------------------------------------------ */

/** Amber fullness with this much room left is a heads-up (QN-04, QN-S41): weeks of room on a home NAS. */
export const FULL_ROOM_BYTES = 1e12;

/**
 * How full, as a line's tone, nature and band (QN-S41): from 95 % red and a problem; from 85 % amber and a problem,
 * unless a terabyte or more is still free (a heads-up). The band (85, 95) ends an Ignore when it rises.
 */
export function fullness(
  pct: number,
  freeBytes: number | null,
  { warn = 85, bad = 95 }: { warn?: number; bad?: number } = {},
): Pick<KindNotice, 'tone' | 'nature' | 'band'> | null {
  if (pct >= bad) return { tone: 'bad', nature: 'problem', band: bad };
  if (pct < warn) return null;
  const roomy = freeBytes !== null && freeBytes >= FULL_ROOM_BYTES;
  return { tone: 'warn', nature: roomy ? 'fyi' : 'problem', band: warn };
}

/** “Look into it” with the line's own question (QN-02: problems only). */
export function lookInto(question: string): Extract<ThingPageNotice['link'], { kind: 'ask' }> {
  const q = question.replace(/\s+/g, ' ').trim();
  return { kind: 'ask', label: 'Look into it', question: q.length > 300 ? `${q.slice(0, 299)}…` : q };
}
