/**
 * A thing page read before it opens (page-speed.md AP-2660…AP-2664): which links read, the wait before reading (a sweep
 * reads nothing, a touch nothing, the keyboard's focus as the pointer), and a fresh copy isn't read again.
 */
import { QueryClient } from '@tanstack/react-query';
import type { FocusEvent, PointerEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  linkHandlers,
  PAGE_FRESH_MS,
  PREFETCH_DELAY_MS,
  prefetchedThing,
  readThingPage,
  restTimer,
} from './prefetch';

describe('prefetchedThing (AP-2660)', () => {
  it('reads a connection’s or a device’s page at the default range, never a server’s', () => {
    expect(prefetchedThing('/things/connection%3Acon_ha')).toBe('connection:con_ha');
    expect(prefetchedThing('/things/device%3Advp_pool')).toBe('device:dvp_pool');
    expect(prefetchedThing('/things/connection%3Acon_ha?tab=settings')).toBe('connection:con_ha');
    expect(prefetchedThing('/things/connection%3Acon_ha?range=7d')).toBeNull();
    expect(prefetchedThing('/things/server%3Apve-02')).toBeNull();
    expect(prefetchedThing('/things/servers?view=guests')).toBeNull();
    expect(prefetchedThing('/connections')).toBeNull();
    expect(prefetchedThing('/things/%E0%A4%A')).toBeNull();
  });
});

describe('the wait before reading (AP-2661, AP-2664)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const pointer = (pointerType: string) => ({ pointerType }) as PointerEvent<HTMLElement>;
  const focus = (visible: boolean) =>
    ({ currentTarget: { matches: () => visible } }) as unknown as FocusEvent<HTMLElement>;
  const setup = () => {
    const read = vi.fn();
    const timer = restTimer(PREFETCH_DELAY_MS, read);
    return { read, on: (thing: string) => linkHandlers(thing, timer) };
  };

  it('reads once the mouse has rested, not before, and not when it left first', () => {
    const { read, on } = setup();
    on('connection:con_ha').onPointerEnter?.(pointer('mouse'));
    vi.advanceTimersByTime(PREFETCH_DELAY_MS - 1);
    expect(read).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(read.mock.calls).toEqual([['connection:con_ha']]);
    read.mockClear();
    on('connection:con_x').onPointerEnter?.(pointer('mouse'));
    on('connection:con_x').onPointerLeave?.();
    vi.advanceTimersByTime(PREFETCH_DELAY_MS * 2);
    expect(read).not.toHaveBeenCalled();
  });

  it('reads only where a sweep over the rows stops', () => {
    const { read, on } = setup();
    for (const thing of ['connection:con_a', 'connection:con_b', 'connection:con_c']) {
      on(thing).onPointerEnter?.(pointer('mouse'));
      vi.advanceTimersByTime(PREFETCH_DELAY_MS / 4);
    }
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(read.mock.calls).toEqual([['connection:con_c']]);
  });

  it('leaves a touch alone, and reads for the keyboard’s focus but not a click’s', () => {
    const { read, on } = setup();
    on('connection:con_ha').onPointerEnter?.(pointer('touch'));
    on('connection:con_x').onFocus?.(focus(false));
    vi.advanceTimersByTime(PREFETCH_DELAY_MS * 2);
    expect(read).not.toHaveBeenCalled();
    on('connection:con_ha').onFocus?.(focus(true));
    on('connection:con_ha').onBlur?.();
    on('device:dvp_pool').onFocus?.(focus(true));
    vi.advanceTimersByTime(PREFETCH_DELAY_MS);
    expect(read.mock.calls).toEqual([['device:dvp_pool']]);
  });
});

describe('readThingPage (AP-2662)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads once while the copy is fresh, again once it is older', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const qc = new QueryClient();
    const queryFn = vi.fn(async () => ({ id: 'connection:con_ha' }));
    const options = { queryKey: ['whombat', 'things.page', { thing: 'connection:con_ha' }, {}], queryFn };
    await readThingPage(qc, options);
    await readThingPage(qc, options);
    expect(queryFn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + PAGE_FRESH_MS + 1);
    await readThingPage(qc, options);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('keeps a refusal quiet and leaves it to the page', async () => {
    const qc = new QueryClient();
    const queryFn = vi.fn(async () => {
      throw new Error('not_found');
    });
    await expect(readThingPage(qc, { queryKey: ['x'], queryFn })).resolves.toBeUndefined();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});
