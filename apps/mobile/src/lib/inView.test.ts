/** Rows in view, for chat rows' HTML pages (AP-909). */
import { describe, expect, it, vi } from 'vitest';
import { createInViewStore, rowsNearView } from './inView';

describe('rowsNearView (AP-909)', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  it('takes the rows on screen and two either side', () => {
    expect([...rowsNearView(ids, [3, 4])]).toEqual(['b', 'c', 'd', 'e', 'f', 'g']);
    expect([...rowsNearView(ids, [0])]).toEqual(['a', 'b', 'c']);
    expect([...rowsNearView(ids, [7, null])]).toEqual(['f', 'g', 'h']);
    expect(rowsNearView(ids, []).size).toBe(0);
  });
});

describe('createInViewStore (AP-909)', () => {
  it('tells its readers only when the rows change', () => {
    const store = createInViewStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.has('a')).toBe(false);
    store.set(new Set(['a', 'b']));
    expect(store.has('a')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    store.set(new Set(['b', 'a']));
    expect(listener).toHaveBeenCalledTimes(1);
    store.set(new Set(['c']));
    expect(store.has('a')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
