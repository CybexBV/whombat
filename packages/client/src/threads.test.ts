import { describe, expect, it } from 'vitest';
import { lastReplyLabel } from './threads';

const now = Date.parse('2026-10-09T14:30:00.000Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const tz = 'Europe/Amsterdam';

describe('lastReplyLabel (AP-941)', () => {
  it('says how long ago within the week, as Slack does', () => {
    expect(lastReplyLabel(ago(20_000), now, tz)).toBe('Last reply just now');
    expect(lastReplyLabel(ago(12 * 60_000), now, tz)).toBe('Last reply 12 min ago');
    expect(lastReplyLabel(ago(60 * 60_000), now, tz)).toBe('Last reply 1 hour ago');
    expect(lastReplyLabel(ago(4 * 24 * 60 * 60_000), now, tz)).toBe('Last reply 4 days ago');
    expect(lastReplyLabel(ago(7 * 24 * 60 * 60_000 - 60_000), now, tz)).toBe('Last reply 6 days ago');
  });

  it('gives the date from a week on, the year only when it differs', () => {
    expect(lastReplyLabel(ago(7 * 24 * 60 * 60_000), now, tz)).toBe('Last reply on 2 Oct');
    expect(lastReplyLabel('2025-03-03T10:00:00.000Z', now, tz)).toBe('Last reply on 3 Mar 2025');
  });

  it('reads a reply from a clock running ahead as just now', () => {
    expect(lastReplyLabel(ago(-30_000), now, tz)).toBe('Last reply just now');
  });
});
