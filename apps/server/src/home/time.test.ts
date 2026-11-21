import { describe, expect, it } from 'vitest';
import { startOfLocalDay } from './time';

describe('startOfLocalDay', () => {
  it('is local midnight on an ordinary day', () => {
    expect(startOfLocalDay(new Date('2026-09-05T15:00:00Z'), 'America/Santiago').toISOString()).toBe(
      '2026-09-05T04:00:00.000Z',
    );
    expect(startOfLocalDay(new Date('2026-03-29T12:00:00Z'), 'Europe/Amsterdam').toISOString()).toBe(
      '2026-03-28T23:00:00.000Z',
    );
  });

  it('starts where the gap ends when a clock change skips midnight', () => {
    // Chile moves 00:00 to 01:00 on 6 September 2026: the day starts at 01:00 local (UTC−3), not the evening before.
    expect(startOfLocalDay(new Date('2026-09-06T15:00:00Z'), 'America/Santiago').toISOString()).toBe(
      '2026-09-06T04:00:00.000Z',
    );
  });
});
