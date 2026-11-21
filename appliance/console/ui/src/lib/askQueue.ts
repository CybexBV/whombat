/**
 * Asks that come to you (Whombat DK-60; appliance CG-194): a new ask opens its card by itself over whatever the screen
 * shows, one at a time (“2 of 3”), the next once one is answered or closed. Pure: the page keeps the queue (the
 * numbers it opened by itself, and the one opened from Needs you first) and asks these what to do.
 */
import type { DeskGlance } from './desk';
import type { AskSig } from './deskScene';

/** A card the screen opened by itself while locked closes after this long untouched; the amber edge stays (DK-60). */
export const POPUP_LOCKED_MS = 2 * 60_000;

/** The asks in `next` the page hadn't seen in `prev` (none on the first state: only asks new to the screen open). */
export function freshAsks(prev: AskSig | null, next: AskSig): number[] {
  if (!prev) return [];
  return next.numbers.filter((n) => !prev.numbers.includes(n));
}

/** The queue with `fresh` at the end, each once. */
export function enqueue(queue: readonly number[], fresh: readonly number[]): number[] {
  return [...queue, ...fresh.filter((n, i) => !queue.includes(n) && fresh.indexOf(n) === i)];
}

/** The queue with `first` (opened from Needs you) in front. */
export function putFirst(queue: readonly number[], first: number): number[] {
  return [first, ...queue.filter((n) => n !== first)];
}

/** Whether the page sees every ask that needs the person (titles show, and no more than the five it gets). */
const complete = (g: DeskGlance) => g.needsYou.items.length === g.needsYou.count;

/**
 * The queue without the asks that left Needs you (answered somewhere else), when the page can tell; `open` (the card
 * on the screen, which says it was answered elsewhere) stays.
 */
export function liveQueue(queue: readonly number[], g: DeskGlance | null, open: number | null): number[] {
  if (!g || !complete(g)) return [...queue];
  const live = new Set(g.needsYou.items.map((a) => a.number));
  return queue.filter((n) => n === open || live.has(n));
}

/** “2 of 3” for the open card, or null when it is the only one. */
export function queuePlace(queue: readonly number[], open: number): { n: number; m: number } | null {
  const i = queue.indexOf(open);
  return i < 0 || queue.length < 2 ? null : { n: i + 1, m: queue.length };
}

/** What opens: an ask's card (beside the PIN pad while locked), or the pad alone saying something needs the person. */
export type Popup = { kind: 'ask'; number: number } | { kind: 'pad' };

/**
 * What the screen opens for the queue now (DK-60): the first ask still in Needs you; locked without titles (*A summary*,
 * *Only the time*), the pad alone, and the card after the unlock. Unlocked with nothing of the queue in sight (more than
 * five asks), the first ask; nothing when nothing needs the person.
 */
export function popupFor(queue: readonly number[], g: DeskGlance | null, unlocked: boolean): Popup | null {
  const items = g?.needsYou.items ?? [];
  const first = queue.find((n) => items.some((a) => a.number === n));
  if (first !== undefined) return { kind: 'ask', number: first };
  if (!unlocked) return queue.length > 0 || (g?.needsYou.count ?? 0) > 0 ? { kind: 'pad' } : null;
  const top = items[0];
  return queue.length > 0 && top ? { kind: 'ask', number: top.number } : null;
}

/** The queue once the open card was answered or closed. */
export function afterAsk(queue: readonly number[], done: number): number[] {
  return queue.filter((n) => n !== done);
}

/** A card the screen opened by itself, still locked and untouched for `POPUP_LOCKED_MS`, closes (DK-60). */
export function popupLapsed(
  openedAt: number | null,
  lastInput: number,
  now: number,
  unlocked: boolean,
): boolean {
  return openedAt !== null && !unlocked && now - Math.max(openedAt, lastInput) >= POPUP_LOCKED_MS;
}
