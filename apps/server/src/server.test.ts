import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, validationError, zodFields } from './lib/errors';
import { newSecret, safeEqual, sha256 } from './lib/secrets';
import { normalizeIso } from './lib/time';
import { decodeCursor, encodeCursor } from './read/views';
import { RealtimeBus } from './realtime/bus';
import { TypingService } from './realtime/typing';

describe('helpers', () => {
  it('round-trips message cursors and rejects garbage', () => {
    const cursor = encodeCursor({ createdAt: '2026-09-23T09:22:00.000Z', ord: 42 });
    expect(decodeCursor(cursor)).toEqual({ createdAt: '2026-09-23T09:22:00.000Z', ord: 42 });
    expect(decodeCursor('bm9wZQ')).toBeNull();
  });

  it('normalises timestamps to the canonical ISO form signed envelopes use', () => {
    expect(normalizeIso('2026-09-23T11:22:00+02:00')).toBe('2026-09-23T09:22:00.000Z');
    expect(() => normalizeIso('yesterday')).toThrow();
  });

  it('makes prefixed secrets and constant-time comparisons', () => {
    expect(newSecret('ws')).toMatch(/^ws_[A-Za-z0-9_-]{43}$/);
    expect(safeEqual(sha256('a'), sha256('a'))).toBe(true);
    expect(safeEqual(sha256('a'), sha256('b'))).toBe(false);
    expect(safeEqual('short', 'longer')).toBe(false);
  });

  it('maps Zod issues to contract field errors', () => {
    const r = z.object({ text: z.string().min(2), n: z.number() }).safeParse({ text: 'x', n: 'y' });
    if (r.success) throw new Error('should fail');
    expect(Object.keys(zodFields(r.error)).sort()).toEqual(['n', 'text']);
    const err = validationError(r.error);
    expect(err.status).toBe(400);
    expect(err.toBody().error.code).toBe('validation_failed');
    expect(new ApiError('not_implemented', 'later').status).toBe(501);
  });
});

describe('typing indicators', () => {
  afterEach(() => vi.useRealTimers());

  it('expires after 6 s unless refreshed, and clears on stop', () => {
    vi.useFakeTimers();
    const bus = new RealtimeBus();
    const frames: { active: boolean }[] = [];
    bus.onFrame((f) => {
      if (f.event.type === 'typing') frames.push({ active: f.event.active });
    });
    const typing = new TypingService(bus, () => new Date());
    const key = { conversationId: 'cnv_general', threadRootId: null, principalId: 'prn_tom' };
    typing.start(key);
    vi.advanceTimersByTime(5000);
    typing.start(key);
    vi.advanceTimersByTime(5000);
    expect(frames).toEqual([{ active: true }, { active: true }]);
    vi.advanceTimersByTime(1000);
    expect(frames.at(-1)).toEqual({ active: false });
    typing.start(key);
    typing.stop(key);
    expect(frames.at(-1)).toEqual({ active: false });
    expect(typing.isActive(key)).toBe(false);
  });
});
