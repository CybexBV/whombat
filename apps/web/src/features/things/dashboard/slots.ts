/**
 * The pure parts of a service's slots on the web (Whombat docs/decisions/service-slots.md; app
 * docs/app/decisions/service-slots-web.md): how the Worth a look strip groups its lines and which it shows before “Show
 * N more”, how many
 * pictures a shelf holds in its one row, a person's initial and avatar tone, and the words of a chart whose bars carry
 * their own labels. Pure.
 */
import { lineNature, noticeGroups } from '@whombat/client';
import type { ThingPageNotice } from '@whombat/core';

/** How many of what is wrong now the Worth a look strip shows before “Show N more”. */
export const STRIP_SHOWN = 5;

const TONE_ORDER: Record<ThingPageNotice['tone'], number> = { bad: 0, warn: 1, info: 2 };

export interface StripLines<T> {
  /** What is wrong now or only the person can do (problems, then only-you), the worst first. */
  now: T[];
  /** What comes later or is advice (heads-ups: forecasts, updates): folded behind “Show N heads-ups”, not counted. */
  soon: T[];
  /** Quiet lines (ignored or snoozed, with Undo), last. */
  quiet: T[];
  /**
   * Lines quiet with the whole thing (kept quiet, or down because of something else; monitoring.md MON-04, MON-07):
   * folded behind their own “Show N kept quiet”, since the line under the page's head already says why.
   */
  held: T[];
  /** Every line in the order the strip draws them. */
  lines: T[];
  /** The ones shown while folded: the first of now, quiet lines in the room they leave; no heads-up. */
  shown: T[];
  /** How many more of now and quiet lines “Show N more” unfolds (0: no button); the heads-ups have their own row. */
  more: number;
  /** The lines that ask the person (the strip's “handle these” button). */
  asking: T[];
}

/**
 * The strip's lines (docs/decisions/overview-server-connection-final.md): what is wrong now first, the worst first (not
 * working, then needs a look), with their buttons; the heads-ups (what comes later or is advice) folded behind their own
 * “Show N heads-ups”, not counted with the problems; quiet lines last. Five of now show, quiet lines in the room
 * they leave, the rest behind “Show N more”.
 */
export function stripLines<T extends Pick<ThingPageNotice, 'quiet' | 'nature' | 'tone' | 'link' | 'action'>>(
  items: readonly T[],
  shown = STRIP_SHOWN,
): StripLines<T> {
  const groups = noticeGroups(items);
  const live = items.filter((n) => !n.quiet);
  const now = live
    .filter((n) => lineNature(n) !== 'fyi')
    .map((n, i) => ({ n, i }))
    .sort((a, b) => TONE_ORDER[a.n.tone] - TONE_ORDER[b.n.tone] || a.i - b.i)
    .map(({ n }) => n);
  const soon = live.filter((n) => lineNature(n) === 'fyi');
  const quiet = items.filter((n) => n.quiet && !n.quiet.held);
  const held = items.filter((n) => n.quiet?.held);
  const first = now.slice(0, shown);
  // Quiet lines take the room the others leave, so a just-ignored line's Undo stays in sight.
  first.push(...quiet.slice(0, Math.max(1, shown - first.length)));
  return {
    now,
    soon,
    quiet,
    held,
    lines: [...now, ...soon, ...quiet, ...held],
    shown: first,
    more: now.length + quiet.length - first.length,
    asking: groups.asking,
  };
}

/** The strip's colour: the most serious line that isn't quiet (a strip of quiet lines only is plain). */
export function stripTone(
  items: readonly Pick<ThingPageNotice, 'tone' | 'quiet'>[],
): ThingPageNotice['tone'] | 'quiet' {
  const live = items.filter((n) => !n.quiet);
  if (live.some((n) => n.tone === 'bad')) return 'bad';
  if (live.some((n) => n.tone === 'warn')) return 'warn';
  return live.length ? 'info' : 'quiet';
}

/** A shelf's least picture width and the gap between pictures: 8 posters in a row on a 1440 px page. */
export const SHELF_MIN = 110;
export const SHELF_GAP = 16;

/**
 * How many pictures a shelf's one row holds at `width` (its inner width, px): as many as fit at their least width, at
 * least one; never more than there are. Unmeasured (0): `fallback`.
 */
export function shelfFit(
  width: number,
  count: number,
  fallback = 8,
  min = SHELF_MIN,
  gap = SHELF_GAP,
): number {
  if (count <= 0) return 0;
  if (!(width > 0)) return Math.min(count, fallback);
  return Math.max(1, Math.min(count, Math.floor((width + gap) / (min + gap))));
}

/** The first letter of a person's name, upper case (“Kids’ room” → “K”). */
export function personInitial(name: string): string {
  const letter = /[\p{L}\p{N}]/u.exec(name)?.[0] ?? '?';
  return letter.toLocaleUpperCase();
}

/**
 * Which of the five human avatar tones (`--tone-1` … `--tone-5`) a person on a service's page gets: from their name, so
 * Anna is the same colour in Now playing, on the shelf and in Who watches.
 */
export function personTone(name: string): 1 | 2 | 3 | 4 | 5 {
  let sum = 0;
  for (const ch of name.trim().toLocaleLowerCase()) sum = (sum * 31 + (ch.codePointAt(0) ?? 0)) % 9973;
  return ((sum % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

/** A shelf picture's tag: the person's own words (“Anna asked”), else their name. */
export function shelfTag(person: { name: string; note?: string | undefined }): string {
  return person.note?.trim() || person.name;
}

/**
 * A labelled bar's words for its tooltip and for a screen reader: “Thu · 5 plays”. A value with a unit keeps it
 * (“Today · 3 h”); a bare count takes the series' name in lower case.
 */
export function labelledBarWords(label: string, value: string, series: string, unit: string | null): string {
  return unit ? `${label} · ${value}` : `${label} · ${value} ${series.toLocaleLowerCase()}`;
}
