import { describe, expect, it } from 'vitest';
import {
  afterAsk,
  enqueue,
  freshAsks,
  liveQueue,
  POPUP_LOCKED_MS,
  popupFor,
  popupLapsed,
  putFirst,
  queuePlace,
} from './askQueue';
import type { DeskAsk, DeskGlance } from './desk';

const ask = (number: number): DeskAsk => ({
  number,
  kind: 'approval',
  title: `Ask ${number}?`,
  at: '2026-10-20T12:31:00Z',
  where: null,
  detail: null,
  facts: [],
  approveLabel: null,
  onDesk: true,
  phoneReason: null,
});
const glance = (numbers: number[], count = numbers.length): DeskGlance => ({
  status: { text: 'x', more: null },
  needsYou: { count, items: numbers.map(ask) },
  working: null,
  done: [],
  servers: [],
  moreServers: 0,
  tiles: [],
  box: null,
});

describe('asks that come to you (DK-60, CG-194)', () => {
  it('opens only asks new to the screen, not those it finds when it starts', () => {
    expect(freshAsks(null, { count: 2, numbers: [1, 2] })).toEqual([]);
    expect(freshAsks({ count: 1, numbers: [1] }, { count: 3, numbers: [3, 1, 2] })).toEqual([3, 2]);
  });

  it('queues each once, in the order they came; one opened from Needs you goes first', () => {
    expect(enqueue([1], [2, 1, 2, 3])).toEqual([1, 2, 3]);
    expect(putFirst([1, 2, 3], 3)).toEqual([3, 1, 2]);
    expect(putFirst([], 7)).toEqual([7]);
  });

  it('drops asks answered somewhere else when it sees them all, never the open one', () => {
    expect(liveQueue([1, 2, 3], glance([2]), null)).toEqual([2]);
    expect(liveQueue([1, 2, 3], glance([2]), 1)).toEqual([1, 2]);
    // Titles hidden while locked, or more than five: it can't tell, the queue stays.
    expect(liveQueue([1, 2], glance([], 4), null)).toEqual([1, 2]);
    expect(liveQueue([1, 2], glance([2, 3, 4, 5, 6], 7), null)).toEqual([1, 2]);
  });

  it('says “2 of 3” only among several', () => {
    expect(queuePlace([4, 5, 6], 5)).toEqual({ n: 2, m: 3 });
    expect(queuePlace([4], 4)).toBeNull();
    expect(queuePlace([4, 5], 9)).toBeNull();
  });

  it('opens the first card still waiting; locked without titles, the pad alone', () => {
    expect(popupFor([9, 2], glance([2, 3]), true)).toEqual({ kind: 'ask', number: 2 });
    expect(popupFor([2], glance([2]), false)).toEqual({ kind: 'ask', number: 2 });
    expect(popupFor([], glance([], 1), false)).toEqual({ kind: 'pad' });
    expect(popupFor([], glance([]), false)).toBeNull();
    // More than five: the first one in Needs you.
    expect(popupFor([9], glance([1, 2, 3, 4, 5], 6), true)).toEqual({ kind: 'ask', number: 1 });
    expect(popupFor([], glance([1]), true)).toBeNull();
  });

  it('goes on after the open one, and closes a locked card nobody touched after 2 minutes', () => {
    expect(afterAsk([1, 2, 3], 1)).toEqual([2, 3]);
    const t = 1_000_000;
    expect(popupLapsed(t, t, t + POPUP_LOCKED_MS - 1, false)).toBe(false);
    expect(popupLapsed(t, t, t + POPUP_LOCKED_MS, false)).toBe(true);
    expect(popupLapsed(t, t + 60_000, t + POPUP_LOCKED_MS, false)).toBe(false);
    expect(popupLapsed(t, t, t + POPUP_LOCKED_MS, true)).toBe(false);
    expect(popupLapsed(null, t, t + POPUP_LOCKED_MS, false)).toBe(false);
  });
});
