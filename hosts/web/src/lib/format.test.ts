import { describe, expect, it } from 'vitest';
import {
  countWord,
  formatAgo,
  formatAgoIso,
  formatCellSize,
  formatClock,
  formatDateOnly,
  formatDiskRate,
  formatDuration,
  formatGb,
  formatMemPair,
  formatNetRate,
  formatNum,
  formatPct,
  formatPct1,
  formatRatio,
  formatRelativeDay,
  formatSince,
  formatTb,
  formatTemp,
  formatTempDense,
  formatTick,
  formatTooltipTime,
  formatUptimeShort,
  plural,
} from './format';

const NOW = Date.parse('2026-10-11T14:00:08Z');

describe('sizes (SCREENS 7.1)', () => {
  it('TB and GB', () => {
    expect(formatTb(62.2)).toBe('62.2 TB');
    expect(formatTb(100)).toBe('100 TB');
    expect(formatGb(440)).toBe('440 GB');
    expect(formatGb(1420)).toBe('1.42 TB');
    expect(formatGb(10240)).toBe('10.2 TB');
    expect(formatGb(1000)).toBe('1 TB');
    expect(formatGb(35000)).toBe('35 TB');
    expect(formatGb(22340)).toBe('22.3 TB');
    expect(formatGb(3190)).toBe('3.19 TB');
  });
  it('below 1 GB in MB', () => {
    expect(formatGb(0.128)).toBe('128 MB');
  });
  it('guest memory pairs (MiB)', () => {
    expect(formatMemPair(128, null)).toBe('128 MB');
    expect(formatMemPair(2150, 4096)).toBe('2.1 / 4 GB');
    expect(formatMemPair(380, 1024)).toBe('380 MB / 1 GB');
    expect(formatMemPair(96, 512)).toBe('96 MB / 512 MB');
    expect(formatMemPair(3072, 4096)).toBe('3.0 / 4 GB');
    expect(formatMemPair(null, null)).toBe('—');
  });
});

describe('rates', () => {
  it('disk MB/s, network Mb/s switching to Gb/s above 1000', () => {
    expect(formatDiskRate(42)).toBe('42 MB/s');
    expect(formatNetRate(412)).toBe('412 Mb/s');
    expect(formatNetRate(1200)).toBe('1.2 Gb/s');
    expect(formatNetRate(1900)).toBe('1.9 Gb/s');
  });
  it('compact numbers', () => {
    expect(formatNum(0)).toBe('0');
    expect(formatNum(0.4)).toBe('0.4');
    expect(formatNum(12.0)).toBe('12');
    expect(formatNum(118)).toBe('118');
    expect(formatNum(1.0)).toBe('1');
  });
});

describe('percent and ratio', () => {
  it('integers on cards, one decimal in tables', () => {
    expect(formatPct(33.28)).toBe('33%');
    expect(formatPct1(44)).toBe('44.0%');
    expect(formatPct(null)).toBe('—');
  });
  it('ratio', () => {
    expect(formatRatio(22 / 48)).toBe('0.46 : 1');
    expect(formatRatio(52 / 32)).toBe('1.63 : 1');
  });
});

describe('temperatures', () => {
  it('"64 °C" in text and "64°" in dense tables', () => {
    expect(formatTemp(64)).toBe('64 °C');
    expect(formatTempDense(64)).toBe('64°');
  });
});

describe('relative time (SCREENS 7.2)', () => {
  it('s / min / d', () => {
    expect(formatAgo(8)).toBe('8 s ago');
    expect(formatAgo(14 * 60 + 8)).toBe('14 min ago');
    expect(formatAgo(2 * 86400 + 3600)).toBe('2 d ago');
    expect(formatAgoIso('2026-10-11T13:46:00Z', NOW)).toBe('14 min ago');
    expect(formatAgoIso('2026-10-09T13:00:00Z', NOW)).toBe('2 d ago');
  });
  it('"since 02:14" today, in the viewer time zone', () => {
    expect(formatSince(Date.parse('2026-10-11T02:14:00Z'), NOW, 'UTC')).toBe('since 02:14');
    expect(formatSince(Date.parse('2026-10-11T02:14:00Z'), NOW, 'Europe/Amsterdam')).toBe('since 04:14');
    expect(formatSince(Date.parse('2026-10-09T02:14:00Z'), NOW, 'UTC')).toBe('since Oct 9');
  });
  it('clock and durations', () => {
    expect(formatClock(Date.parse('2026-10-11T02:14:00Z'), NOW, 'UTC')).toBe('02:14');
    expect(formatDuration(11 * 3600 + 47 * 60)).toBe('11 h 47 m');
    expect(formatDuration(3567600)).toBe('41 d 7 h');
    expect(formatUptimeShort(3542400)).toBe('41 d');
    expect(formatUptimeShort(777600)).toBe('9 d');
  });
  it('relative day', () => {
    expect(formatRelativeDay(Date.parse('2026-10-11T00:00:00Z'), NOW, 'UTC')).toBe('Today 00:00');
    expect(formatRelativeDay(Date.parse('2026-10-11T00:00:00Z'), NOW, 'Europe/Amsterdam')).toBe('Today 02:00');
    expect(formatRelativeDay(Date.parse('2026-10-12T00:00:00Z'), NOW, 'UTC')).toBe('Mon 00:00');
    expect(formatRelativeDay(Date.parse('2026-10-10T09:00:00Z'), NOW, 'UTC')).toBe('Yesterday 09:00');
  });
});

describe('axis ticks (SCREENS 7.3), viewer time zone', () => {
  const t = Date.parse('2026-10-10T20:11:00Z'); // a Saturday
  it('per range', () => {
    expect(formatTick('1h', Date.parse('2026-10-11T13:15:00Z'), 'UTC')).toBe('13:15');
    expect(formatTick('6h', Date.parse('2026-10-11T13:15:00Z'), 'UTC')).toBe('13:15');
    expect(formatTick('24h', t, 'UTC')).toBe('Sat 20:11');
    expect(formatTick('7d', Date.parse('2026-10-06T14:00:00Z'), 'UTC')).toBe('Oct 6');
    expect(formatTick('30d', Date.parse('2026-10-06T14:00:00Z'), 'UTC')).toBe('Oct 6');
  });
  it('tooltip times', () => {
    expect(formatTooltipTime('7d', Date.parse('2026-10-06T14:00:00Z'), 'UTC')).toBe('Oct 6, 14:00');
    expect(formatTooltipTime('24h', Date.parse('2026-10-11T07:15:00Z'), 'UTC')).toBe('Sun 07:15');
    expect(formatTooltipTime('1h', Date.parse('2026-10-11T07:15:00Z'), 'UTC')).toBe('07:15');
  });
  it('shifts with the zone', () => {
    expect(formatTick('24h', t, 'Asia/Tokyo')).toBe('Sun 05:11');
    expect(formatTick('1h', Date.parse('2026-10-11T23:30:00Z'), 'America/New_York')).toBe('19:30');
  });
  it('midnight renders as 00:00', () => {
    expect(formatTick('1h', Date.parse('2026-10-11T00:05:00Z'), 'UTC')).toBe('00:05');
  });
});

describe('misc', () => {
  it('plurals', () => {
    expect(plural(1, 'server')).toBe('1 server');
    expect(plural(3, 'server')).toBe('3 servers');
    expect(plural(0, 'server')).toBe('0 servers');
    expect(countWord(5, 'sensor')).toBe('Five sensors');
    expect(countWord(1, 'sensor')).toBe('One sensor');
  });
  it('date-only and cell size', () => {
    expect(formatDateOnly('2026-08-31')).toBe('Aug 31');
    expect(formatCellSize(75)).toBe('75 s');
    expect(formatCellSize(450)).toBe('7.5 min');
    expect(formatCellSize(1800)).toBe('30 min');
    expect(formatCellSize(12600)).toBe('3.5 h');
    expect(formatCellSize(54000)).toBe('15 h');
  });
});
