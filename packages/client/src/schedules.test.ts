import { describe, expect, it } from 'vitest';
import { scheduleStatusText, scheduleTimeText, splitConfirm } from './schedules';

describe('the schedules’ words', () => {
  it('says the state, when next, and splits core’s confirm into title and text', () => {
    expect(scheduleStatusText({ status: 'active', endedReason: null })).toBe('Active');
    expect(scheduleStatusText({ status: 'ended', endedReason: 'expired' })).toBe('Ended · Ran its 90 days');
    expect(scheduleTimeText('2026-09-24T06:30:00.000Z', 'Europe/Amsterdam', '2026-09-23T09:22:00Z')).toBe(
      'Thu 24 Sep at 08:30',
    );
    expect(splitConfirm('Remove this schedule? Neo won’t run it again.')).toEqual({
      title: 'Remove this schedule?',
      text: 'Neo won’t run it again.',
    });
    expect(splitConfirm('Remove it')).toEqual({ title: 'Remove it', text: '' });
  });
});
