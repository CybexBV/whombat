import { describe, expect, it } from 'vitest';
import {
  AHEAD_CHECKS_PER_DAY,
  AHEAD_FINDINGS_PER_DAY,
  AheadReportInput,
  aheadDue,
  aheadHours,
  aheadQueryRefusal,
  aheadSkip,
  aheadStartHours,
  aheadVersion,
  LooksAheadUpdate,
  planAheadPass,
} from './looks-ahead.js';

const TZ = 'Europe/Amsterdam';
const event = {
  allDay: false,
  description: '',
  location: 'Ziggo Dome, Amsterdam',
  summary: 'The Script',
  start: '2026-12-14T20:00:00+01:00',
  end: '2026-12-14T23:00:00+01:00',
};

describe('aheadSkip (looks-ahead.md)', () => {
  it('checks a timed, one-off event with a place', () => {
    expect(aheadSkip(event)).toBeNull();
    expect(aheadSkip({ ...event, response: 'accepted' })).toBeNull();
    // On a calendar the person shares (a family's), without them on its guest list.
    expect(aheadSkip({ ...event, response: undefined })).toBeNull();
  });

  it('skips all-day, repeating, placeless, online, declined, unanswered and cancelled events', () => {
    expect(aheadSkip({ ...event, allDay: true })).toBe('all_day');
    expect(aheadSkip({ ...event, recurring: true })).toBe('recurring');
    expect(aheadSkip({ ...event, recurrence: ['RRULE:FREQ=WEEKLY'] })).toBe('recurring');
    expect(aheadSkip({ ...event, location: '  ' })).toBe('no_place');
    expect(aheadSkip({ ...event, location: 'Microsoft Teams Meeting' })).toBe('online');
    expect(aheadSkip({ ...event, location: 'https://meet.example.com/abc' })).toBe('online');
    expect(aheadSkip({ ...event, response: 'declined' })).toBe('declined');
    expect(aheadSkip({ ...event, response: 'needs_action' })).toBe('unanswered');
    expect(aheadSkip({ ...event, cancelled: true })).toBe('cancelled');
  });
});

describe('aheadVersion', () => {
  it('is the same for the same event and changes with its time or place', () => {
    expect(aheadVersion(event)).toBe(aheadVersion({ ...event }));
    expect(aheadVersion(event)).toMatch(/^[0-9a-f]{8}$/);
    expect(aheadVersion({ ...event, start: '2026-12-14T20:45:00+01:00' })).not.toBe(aheadVersion(event));
    expect(aheadVersion({ ...event, location: 'AFAS Live' })).not.toBe(aheadVersion(event));
  });
});

describe('when a check may run', () => {
  it('begins none after 20:30, so it can still tell before 21:00', () => {
    expect(aheadStartHours('2026-12-13T20:29:00+01:00', TZ)).toBe(true);
    expect(aheadStartHours('2026-12-13T20:30:00+01:00', TZ)).toBe(false);
  });

  it('only within the day’s hours in the person’s zone', () => {
    expect(aheadHours('2026-12-13T07:59:00+01:00', TZ)).toBe(false);
    expect(aheadHours('2026-12-13T08:00:00+01:00', TZ)).toBe(true);
    expect(aheadHours('2026-12-13T20:59:00+01:00', TZ)).toBe(true);
    expect(aheadHours('2026-12-13T21:00:00+01:00', TZ)).toBe(false);
  });

  it('checks tomorrow’s event from the afternoon before, today’s at once, later ones not yet', () => {
    expect(aheadDue(event.start, '2026-12-13T13:59:00+01:00', TZ)).toBe(false);
    expect(aheadDue(event.start, '2026-12-13T14:00:00+01:00', TZ)).toBe(true);
    expect(aheadDue(event.start, '2026-12-14T09:00:00+01:00', TZ)).toBe(true);
    expect(aheadDue(event.start, '2026-12-12T16:00:00+01:00', TZ)).toBe(false);
    // Too close to change plans.
    expect(aheadDue(event.start, '2026-12-14T19:00:00+01:00', TZ)).toBe(false);
  });
});

describe('planAheadPass', () => {
  const candidate = { key: 'conn:primary:e1', version: aheadVersion(event), start: event.start };
  const base = {
    candidates: [candidate],
    checked: [],
    checksToday: 0,
    findingsToday: 0,
    busy: false,
    ready: true,
    now: '2026-12-13T15:00:00+01:00',
    timeZone: TZ,
  };

  it('picks the soonest due event that wasn’t checked', () => {
    const later = { key: 'conn:family:e2', version: 'aaaaaaaa', start: '2026-12-14T21:00:00+01:00' };
    expect(planAheadPass({ ...base, candidates: [later, candidate] })).toEqual(candidate);
  });

  it('never checks a version twice, nor an event that had a finding', () => {
    expect(planAheadPass({ ...base, checked: [{ ...candidate, found: false }] })).toBeNull();
    expect(
      planAheadPass({ ...base, checked: [{ key: candidate.key, version: 'other000', found: true }] }),
    ).toBeNull();
    // Another version of a quiet check is checked again.
    expect(
      planAheadPass({ ...base, checked: [{ key: candidate.key, version: 'other000', found: false }] }),
    ).toEqual(candidate);
  });

  it('keeps to one at a time, the day’s budgets, readiness and hours', () => {
    expect(planAheadPass({ ...base, busy: true })).toBeNull();
    expect(planAheadPass({ ...base, ready: false })).toBeNull();
    expect(planAheadPass({ ...base, checksToday: AHEAD_CHECKS_PER_DAY })).toBeNull();
    expect(planAheadPass({ ...base, findingsToday: AHEAD_FINDINGS_PER_DAY })).toBeNull();
    expect(planAheadPass({ ...base, now: '2026-12-13T22:00:00+01:00' })).toBeNull();
  });
});

describe('what a search may hold', () => {
  it('only public words: no address, link, phone number, code or the person’s own name', () => {
    expect(
      aheadQueryRefusal('The Script Ziggo Dome 14 december 2026', ['Mara', 'mara@example.com']),
    ).toBeNull();
    expect(aheadQueryRefusal('Ajax wedstrijd 14 december', [])).toBeNull();
    expect(aheadQueryRefusal('order 4471929 Ticketmaster', [])).not.toBeNull();
    expect(aheadQueryRefusal('booking AB12CD34', [])).not.toBeNull();
    expect(aheadQueryRefusal('mara@example.com tickets', [])).not.toBeNull();
    expect(aheadQueryRefusal('call +31 6 1234 5678', [])).not.toBeNull();
    expect(aheadQueryRefusal('https://example.com/x', [])).not.toBeNull();
    expect(aheadQueryRefusal('Mara Okafor parents evening', ['Mara', 'Okafor'])).not.toBeNull();
    // Dates, times and flight numbers are public; a booking code isn't.
    expect(aheadQueryRefusal('The Script Ziggo Dome 2026-12-14', [])).toBeNull();
    expect(aheadQueryRefusal('Ziggo Dome 14.12.2026 20:45', [])).toBeNull();
    expect(aheadQueryRefusal('KL1234 Schiphol 14 12 2026', [])).toBeNull();
    expect(aheadQueryRefusal('booking X7K2PQ', [])).not.toBeNull();
    expect(aheadQueryRefusal('call 06-12-345678', [])).not.toBeNull();
  });
});

describe('the report and the setting', () => {
  it('a finding needs its kind, words and a source; nothing found says nothing more', () => {
    expect(AheadReportInput.safeParse({ found: false }).success).toBe(true);
    expect(
      AheadReportInput.safeParse({
        found: true,
        kind: 'time',
        text: 'It starts at 20:45.',
        sources: [{ url: 'https://example.com/the-script' }],
      }).success,
    ).toBe(true);
    expect(AheadReportInput.safeParse({ found: true, kind: 'time', text: 'x' }).success).toBe(false);
    expect(AheadReportInput.safeParse({ found: false, text: 'x' }).success).toBe(false);
    expect(
      AheadReportInput.safeParse({
        found: true,
        kind: 'weather',
        text: 'x',
        sources: [{ mailId: 'm', title: 't' }],
      }).success,
    ).toBe(false);
  });

  it('a change is one thing at a time', () => {
    expect(LooksAheadUpdate.safeParse({ on: false }).success).toBe(true);
    expect(LooksAheadUpdate.safeParse({ calendar: 'c:family', on: true }).success).toBe(true);
    expect(LooksAheadUpdate.safeParse({ kind: 'crowds', on: false }).success).toBe(true);
    expect(LooksAheadUpdate.safeParse({ on: true, kind: 'crowds', calendar: 'x' }).success).toBe(false);
  });
});
