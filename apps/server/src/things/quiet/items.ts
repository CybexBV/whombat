/**
 * Lines about several items (quiet-notices.md QN-03): at most `ITEM_LINES_MAX` lines for one check — every item when
 * there are that few, else one line each for the first ones and one line for the rest whose subject is `MORE_SUBJECT`
 * and whose episode is `shortHash` of the rest's ids, so an Ignore of it lasts while the rest is the same items
 * (`lifts: 'newer'`). Three: more lines about one thing bury the rest of the card, and each brings its own ⋯.
 */
import { createHash } from 'node:crypto';
import type { NoticeSubject } from './types';

export const ITEM_LINES_MAX = 3;

/** The subject id of the “and N more” line: the apply step treats it as one item like any other. */
export const MORE_SUBJECT = '+more';

/** Up to `max` items get a line each; past that the first `max − 1` do and the rest share the last line. */
export function splitItems<T>(items: readonly T[], max = ITEM_LINES_MAX): { each: T[]; rest: T[] } {
  if (items.length <= max) return { each: [...items], rest: [] };
  const shown = Math.max(max - 1, 0);
  return { each: items.slice(0, shown), rest: items.slice(shown) };
}

/** Eight hex characters naming a set of ids, whatever their order. */
export function shortHash(ids: readonly string[]): string {
  return createHash('sha1')
    .update([...ids].sort().join('\n'))
    .digest('hex')
    .slice(0, 8);
}

/** The “and N more” line's subject. */
export function moreSubject(count: number): NoticeSubject {
  return { id: MORE_SUBJECT, name: `${count} more` };
}

/** The names a grouped line shows: “Hallway AP”, “Hallway AP and Garage AP”, “Hallway AP and 3 more”. */
export function someNames(names: readonly string[]): string {
  const [a, b] = names;
  if (names.length <= 1) return a ?? '';
  if (names.length === 2) return `${a} and ${b}`;
  return `${a} and ${names.length - 1} more`;
}
