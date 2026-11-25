/**
 * True uptime: an hour rolled up weighs as an hour against 5-minute points, older points fall back
 * to the response time, overlapping outages count once, and the page's line in plain words.
 */
import { describe, expect, it } from 'vitest';
import {
  downTime,
  durationWords,
  percentWords,
  thingUptime,
  UPTIME_WEEK_MS,
  upPoints,
  upShare,
  uptimeLine,
} from './uptime';

const NOW = new Date('2026-11-24T15:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('how much of the time it answered', () => {
  it('weighs a rolled-up hour as twelve 5-minute checks', () => {
    // A rolled-up hour where it answered half the time, then 12 five-minute checks that all answered.
    const points = [
      { at: ago(60 * HOUR), value: 0.5 },
      ...Array.from({ length: 12 }, (_, i) => ({ at: ago(2 * HOUR - i * 5 * MIN), value: 1 })),
    ];
    const share = upShare(points, ago(UPTIME_WEEK_MS), NOW);
    // The rolled-up point covers one hour. The gap between it and the live readings adds no weight.
    expect(share.share).toBeCloseTo(90 / 120, 3);
    expect(share.missedMs).toBe(30 * MIN);
  });

  it.each([0, 1])('caps a live reading of %s before a gap', (value) => {
    const points = [
      { at: ago(10 * HOUR), value },
      { at: ago(2 * HOUR), value: 1 - value },
      { at: ago(2 * HOUR - 5 * MIN), value: 1 - value },
    ];
    const share = upShare(points, ago(UPTIME_WEEK_MS), NOW);
    expect(share.coveredMs).toBe(17.5 * MIN);
    expect(share.missedMs).toBe((value === 1 ? 10 : 7.5) * MIN);
  });

  it('counts the latest failing pass as soon as it is recorded', () => {
    const points = [
      { at: ago(5 * MIN), value: 1 },
      { at: NOW, value: 0 },
    ];
    expect(upShare(points, ago(HOUR), NOW).missedMs).toBe(5 * MIN);
  });

  it('falls back to the response time before the first up point', () => {
    const rtt = [
      { at: ago(3 * HOUR), value: 120 },
      { at: ago(2 * HOUR), value: null },
      { at: ago(HOUR), value: null },
    ];
    const up = [{ at: ago(HOUR), value: 1 }];
    expect(upPoints(up, rtt).map((p) => p.value)).toEqual([1, 0, 1]);
    expect(upShare([], ago(HOUR), NOW).share).toBeNull();
  });
});

describe('down time', () => {
  it('counts overlapping outages once and clips them to the period', () => {
    const from = ago(UPTIME_WEEK_MS);
    const out = downTime(
      [
        { from: ago(10 * HOUR), to: ago(9 * HOUR) },
        // The same outage, as the server's offline alert saw it.
        { from: ago(9.5 * HOUR), to: ago(8.5 * HOUR) },
        { from: ago(2 * HOUR), to: null },
        // Before the period: only its part inside counts.
        { from: ago(UPTIME_WEEK_MS + HOUR), to: ago(UPTIME_WEEK_MS - 30 * MIN) },
      ],
      from,
      NOW,
    );
    expect(out.count).toBe(3);
    expect(out.minutes).toBe(90 + 120 + 30);
  });
});

describe('the page’s line', () => {
  const week = { from: ago(UPTIME_WEEK_MS), now: NOW, timeZone: 'Europe/Amsterdam' };

  it('says the share and the outages', () => {
    const said = uptimeLine({ share: 0.9961, downs: 3, downMinutes: 41, ...week });
    expect(said?.text).toBe('Up 99.6 % this week · down 3 times, 41 min');
    expect(said?.parts.some((p) => p.strong && p.text === '99.6 %')).toBe(true);
    expect(uptimeLine({ share: 1, downs: 0, downMinutes: 0, ...week })?.text).toBe('Up all week');
  });

  it('says “since” for a thing watched less than a week, and nothing when it knows nothing', () => {
    const late = uptimeLine({ share: 1, downs: 0, downMinutes: 0, ...week, from: ago(2 * 24 * HOUR) });
    expect(late?.text).toContain('since');
    expect(uptimeLine({ share: null, downs: 0, downMinutes: 0, ...week })).toBeNull();
    expect(uptimeLine({ share: null, downs: 2, downMinutes: 12, ...week })?.text).toContain('twice');
  });

  it('never says 100 % while it missed something, and words durations plainly', () => {
    expect(percentWords(0.99999)).toBe('99.9 %');
    expect(percentWords(0.5)).toBe('50 %');
    expect(durationWords(41)).toBe('41 min');
    expect(durationWords(125)).toBe('2 h 5 min');
    expect(durationWords(27 * 60)).toBe('1 d 3 h');
    expect(thingUptime({ share: 0.99999, downs: 0, downMinutes: 0, ...week })?.uptime.upPct).toBe(99.9);
  });

  it('never says 100 % beside an outage, also when every reading said it answered', () => {
    const said = thingUptime({ share: 1, downs: 1, downMinutes: 12, ...week });
    expect(said?.uptime.text).toContain('99.9 %');
    expect(said?.uptime.text).not.toContain('100');
    expect(said?.uptime.upPct).toBe(99.9);
  });
});
