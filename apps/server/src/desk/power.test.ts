import { formatPowerLeft } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { POWER_OUT_AFTER_MS, powerAlertDue, powerAlertText, powerOf } from './power';

const battery = (percent: number, minutesLeft: number | null = 180) => ({
  source: 'battery' as const,
  percent,
  charging: false,
  minutesLeft,
  chargeLimit: null,
  since: '2026-10-20T03:10:00.000Z',
});
const mains = {
  source: 'ac' as const,
  percent: 80,
  charging: false,
  minutesLeft: null,
  chargeLimit: 80,
  since: null,
};

describe('the battery as a UPS (DK-10)', () => {
  it('reads the manager’s power, or none', () => {
    const metrics = (power: unknown) => ({ now: { at: 'x', power } }) as never;
    expect(powerOf(metrics(mains))).toEqual(mains);
    expect(powerOf(metrics({ ...mains, percent: 79.6 }))?.percent).toBe(80);
    expect(powerOf(metrics(undefined))).toBeNull();
    expect(powerOf(metrics({ ...mains, percent: 140 }))).toBeNull();
    expect(powerOf(null)).toBeNull();
  });

  it('says the power is out after a minute on battery, never for a flicker', () => {
    expect(powerAlertDue(battery(90), 0, POWER_OUT_AFTER_MS - 1)).toEqual({ keep: 0, alert: null });
    expect(powerAlertDue(battery(90), 0, POWER_OUT_AFTER_MS)).toEqual({ keep: 1, alert: 'out' });
    expect(powerAlertDue(battery(80), 1, 600_000)).toEqual({ keep: 1, alert: null });
    expect(powerAlertDue(mains, 0, 0)).toEqual({ keep: 0, alert: null });
  });

  it('says the battery is low at 15 %, once, after the outage', () => {
    expect(powerAlertDue(battery(15), 1, 600_000)).toEqual({ keep: 2, alert: 'low' });
    expect(powerAlertDue(battery(12), 2, 600_000)).toEqual({ keep: 2, alert: null });
    // Unplugged already low: first that the power is out, then the next minute that it's low.
    expect(powerAlertDue(battery(14), 0, POWER_OUT_AFTER_MS)).toEqual({ keep: 1, alert: 'out' });
  });

  it('says the power is back after either, and after a restart that kept the level', () => {
    expect(powerAlertDue(mains, 1, 0)).toEqual({ keep: 0, alert: 'back' });
    expect(powerAlertDue(mains, 2, 0)).toEqual({ keep: 0, alert: 'back' });
    expect(powerAlertDue(null, 2, 0)).toEqual({ keep: 2, alert: null });
  });

  it('words the messages plainly, with the time left when known', () => {
    expect(powerAlertText('out', battery(90, 180))).toContain('about 3 h left');
    expect(powerAlertText('out', battery(90, null))).toContain('running on its battery');
    expect(powerAlertText('low', battery(15))).toMatch(/15\s%/u);
    expect(powerAlertText('back', mains)).toContain('power is back');
    expect([40, 60, 80, 200].map(formatPowerLeft)).toEqual(['40 min', '1 h', '1 h 20 min', '3 h 20 min']);
  });
});
