import { DEFAULT_QUIET_HOURS } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { daysText, dndSetText, endsText, quietHoursText, toggleDay, WEEKDAY_LABELS } from './notifications';

const Z = 'Europe/Amsterdam';
/** Wednesday 23 September 2026, 11:22 in Amsterdam. */
const NOW = '2026-09-23T09:22:00.000Z';

describe('Settings → Notifications', () => {
  it('says when Do not disturb ends, in the person’s zone', () => {
    expect(endsText('2026-09-23T10:22:00.000Z', NOW, Z)).toBe('12:22');
    expect(endsText('2026-09-24T06:00:00.000Z', NOW, Z)).toBe('tomorrow at 08:00');
    expect(endsText('2026-09-26T06:00:00.000Z', NOW, Z)).toBe('Sat at 08:00');
    expect(endsText('2026-10-03T06:00:00.000Z', NOW, Z)).toBe('3 Oct at 08:00');
    expect(dndSetText('2026-09-24T06:00:00.000Z', NOW, Z)).toContain('until tomorrow at 08:00');
  });

  it('names the quiet hours and their days', () => {
    expect(quietHoursText(DEFAULT_QUIET_HOURS)).toBe('Off');
    expect(quietHoursText({ ...DEFAULT_QUIET_HOURS, enabled: true })).toBe(
      'Every day, 22:00–08:00 (until the next morning)',
    );
    expect(
      quietHoursText({
        enabled: true,
        start: '12:00',
        end: '13:00',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      }),
    ).toBe('Weekdays, 12:00–13:00');
    expect(quietHoursText({ enabled: true, start: '00:00', end: '00:00', days: ['sat', 'sun'] })).toBe(
      'Weekends, all day',
    );
    expect(quietHoursText({ enabled: true, start: '22:00', end: '08:00', days: [] })).toBe('Off');
    expect(daysText(['fri', 'mon', 'tue'])).toBe('Mon, Tue and Fri');
    expect(daysText(['wed'])).toBe(WEEKDAY_LABELS.wed.short);
    expect(toggleDay(['mon', 'fri'], 'wed')).toEqual(['mon', 'wed', 'fri']);
    expect(toggleDay(['mon', 'fri'], 'mon')).toEqual(['fri']);
  });
});
