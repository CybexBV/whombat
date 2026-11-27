import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatMbits,
  HOST_STATUS_COPY,
  hostDiskAlertDue,
  hostDiskAlertText,
  hostDiskUsedPct,
} from './host.js';

const nb = (s: string) => s.replace(/ /g, ' ');

describe('formatBytes', () => {
  it('reads like a phone does', () => {
    expect(
      [
        0, 850_000, 40_756_658, 2_240_911_499, 22_900_000_000, 87_000_000_000, 140_000_000_000,
        1_240_000_000_000,
      ].map((b) => nb(formatBytes(b))),
    ).toEqual(['0 B', '850 KB', '41 MB', '2.2 GB', '22.9 GB', '87 GB', '140 GB', '1.2 TB']);
  });
  it('never shows 1000 MB', () => {
    expect(nb(formatBytes(999_700_000))).toBe('1 GB');
  });
});

describe('formatMbits', () => {
  it('one decimal below 10', () => {
    expect([0, 20_000, 400_000, 3_240_000, 48_400_000].map((b) => formatMbits(b))).toEqual([
      '0',
      '<0.1',
      '0.4',
      '3.2',
      '48',
    ]);
  });
});

describe('hostDiskUsedPct', () => {
  it('counts like df', () => {
    expect(hostDiskUsedPct({ usedBytes: 40, freeBytes: 46 })).toBeCloseTo(46.5, 1);
    expect(hostDiskUsedPct({ usedBytes: 0, freeBytes: 0 })).toBe(0);
  });
});

describe('hostDiskAlertDue', () => {
  it('alerts 85 then 95 once each', () => {
    expect(hostDiskAlertDue(84.9, 0)).toEqual({ alert: null, keep: 0 });
    expect(hostDiskAlertDue(86, 0)).toEqual({ alert: 85, keep: 85 });
    expect(hostDiskAlertDue(90, 85)).toEqual({ alert: null, keep: 85 });
    expect(hostDiskAlertDue(96, 85)).toEqual({ alert: 95, keep: 95 });
    expect(hostDiskAlertDue(97, 95)).toEqual({ alert: null, keep: 95 });
  });
  it('jumps straight to 95', () => {
    expect(hostDiskAlertDue(99, 0)).toEqual({ alert: 95, keep: 95 });
  });
  it('re-arms 5 points below a level', () => {
    expect(hostDiskAlertDue(84, 85)).toEqual({ alert: null, keep: 85 });
    expect(hostDiskAlertDue(79, 85)).toEqual({ alert: null, keep: 0 });
    expect(hostDiskAlertDue(86, 0)).toEqual({ alert: 85, keep: 85 });
    expect(hostDiskAlertDue(91, 95)).toEqual({ alert: null, keep: 95 });
    expect(hostDiskAlertDue(88, 95)).toEqual({ alert: null, keep: 85 });
    expect(hostDiskAlertDue(96, 85)).toEqual({ alert: 95, keep: 95 });
  });
});

describe('hostDiskAlertText', () => {
  it('says it plainly', () => {
    const full = nb(
      hostDiskAlertText({
        level: 85,
        usedPct: 86.2,
        freeBytes: 12_400_000_000,
        biggest: { key: 'containers', bytes: 22_900_000_000 },
      }),
    );
    expect(full).toContain('86 % full');
    expect(full).toContain('12.4 GB left');
    expect(full).toContain('the agent’s containers (22.9 GB)');
    const almost = nb(hostDiskAlertText({ level: 95, usedPct: 96, freeBytes: 4_100_000_000 }));
    expect(almost).toContain('almost full: 4.1 GB left');
    expect(almost).toContain('the agent can’t work');
  });
});

describe('HOST_STATUS_COPY', () => {
  it('formats the tile lines', () => {
    expect(nb(HOST_STATUS_COPY.peak(86.4, '2026-10-11T12:25:00Z', 'Europe/Amsterdam'))).toBe(
      'Peak 86 % at 14:25',
    );
    expect(nb(HOST_STATUS_COPY.tokensToday(3_400_000, 94.2))).toBe('3.4M today · 94 % read from cache');
    expect(HOST_STATUS_COPY.tokensToday(0, null)).toBe('0 today');
    expect(HOST_STATUS_COPY.processorHint(4)).toBe('How busy the Whombat was, in percent of all 4 cores');
  });
});
