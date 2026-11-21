/**
 * Worst first, but never under the finger (docs/app/decisions/phone-refresh-status.md): Overview's servers and
 * connections sort by their status level when the list loads or the person pulls to refresh; a live update between
 * keeps the order the person is looking at, adds what is new at the end and drops what is gone. Pure.
 */
import { type StatusLevel, sortByStatusLevel } from '@whombat/client';

/**
 * The order to show `items` in, as ids: worst first (the same level keeps the order it came in) when `kept` is null,
 * else `kept` without what is gone and with what is new after it, in the order it came.
 */
export function statusOrder<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  levelOf: (item: T) => StatusLevel,
  kept: readonly string[] | null,
): string[] {
  if (!kept) return sortByStatusLevel(items, levelOf).map(idOf);
  const here = new Set(items.map(idOf));
  const out = kept.filter((id) => here.has(id));
  const known = new Set(out);
  for (const item of items) if (!known.has(idOf(item))) out.push(idOf(item));
  return out;
}

/** `items` in `order` (ids); anything `order` doesn't name goes at the end, in the order it came. */
export function inOrder<T>(items: readonly T[], idOf: (item: T) => string, order: readonly string[]): T[] {
  const at = new Map(order.map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, i, at: at.get(idOf(item)) ?? order.length + i }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.item);
}
