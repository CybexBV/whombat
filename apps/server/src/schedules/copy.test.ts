import { describe, expect, it } from 'vitest';
import { scheduleMessageText } from './commands';

describe('the schedule card’s words (RA-DS35)', () => {
  const now = new Date('2026-10-03T12:00:00Z');

  it('says when, never the prompt, as a sentence', () => {
    expect(scheduleMessageText({ kind: 'every', minutes: 30 }, 'Europe/Amsterdam', now)).toBe(
      'I’ll come back to this every 30 minutes.',
    );
    expect(
      scheduleMessageText({ kind: 'at', at: '2026-10-04T09:00:00+02:00' }, 'Europe/Amsterdam', now),
    ).toBe('I’ll come back to this once, Sun 4 Oct at 09:00.');
    expect(
      scheduleMessageText({ kind: 'cron', expr: '30 8 * * 1-5', zone: 'Europe/Amsterdam' }, 'UTC', now),
    ).toBe('I’ll come back to this every weekday at 08:30 (Amsterdam time).');
  });
});
