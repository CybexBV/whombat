/** The shared “now” (AP-900): 15-second steps rounded up, one timer while read, the same object between steps. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNowStore, NOW_STEP_MS, stepUp } from './now';

const START = Date.parse('2026-09-23T09:22:07.250Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

const clock = () => new Date();

describe('createNowStore (AP-900)', () => {
  it('rounds the clock up to the step, so nothing just sent is later than now', () => {
    expect(stepUp(Date.parse('2026-09-23T09:22:07.250Z'))).toBe(Date.parse('2026-09-23T09:22:15.000Z'));
    expect(stepUp(Date.parse('2026-09-23T09:22:15.000Z'))).toBe(Date.parse('2026-09-23T09:22:15.000Z'));
    const store = createNowStore(clock);
    expect(store.get().toISOString()).toBe('2026-09-23T09:22:15.000Z');
    expect(store.get().getTime()).toBeGreaterThanOrEqual(Date.now());
  });

  it('is the same object until the next step', () => {
    const store = createNowStore(clock);
    const first = store.get();
    vi.setSystemTime(START + 5_000);
    expect(store.get()).toBe(first);
  });

  it('moves once per step for every reader, with one timer', () => {
    const store = createNowStore(clock);
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(7_000);
    expect(a).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(store.get().toISOString()).toBe('2026-09-23T09:22:30.000Z');
    vi.advanceTimersByTime(NOW_STEP_MS * 4);
    expect(a).toHaveBeenCalledTimes(5);
    expect(store.get().toISOString()).toBe('2026-09-23T09:23:30.000Z');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stops when nobody reads it and catches up when someone does again', () => {
    const store = createNowStore(clock);
    const off = store.subscribe(() => {});
    off();
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(START + 10 * 60_000);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.get().toISOString()).toBe('2026-09-23T09:32:15.000Z');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('follows the fixture world’s clock, which runs from its seed moment', () => {
    const seed = Date.parse('2026-09-23T09:22:00.000Z');
    const started = Date.now();
    const store = createNowStore(() => new Date(seed + (Date.now() - started)));
    expect(store.get().toISOString()).toBe('2026-09-23T09:22:00.000Z');
    store.subscribe(() => {});
    vi.advanceTimersByTime(NOW_STEP_MS);
    expect(store.get().toISOString()).toBe('2026-09-23T09:22:15.000Z');
  });
});
