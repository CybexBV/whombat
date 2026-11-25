import { describe, expect, it } from 'vitest';
import {
  AHEAD_CHECKS_PER_DAY,
  AHEAD_FINDINGS_PER_DAY,
  AheadReportInput,
  aheadDue,
  aheadHours,
  aheadMailCandidate,
  aheadPriority,
  aheadQueryRefusal,
  aheadSkip,
  aheadStage,
  aheadStageVersion,
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
  it('checks timed plans, plans without a location field, real all-day trips and modified repeating occurrences', () => {
    expect(aheadSkip(event)).toBeNull();
    expect(aheadSkip({ ...event, response: 'accepted' })).toBeNull();
    // On a calendar the person shares (a family's), without them on its guest list.
    expect(aheadSkip({ ...event, response: undefined })).toBeNull();
    // Events with a real title but no location field are checked.
    expect(aheadSkip({ ...event, location: '  ' })).toBeNull();
    // Real all-day trips and events with a title/location are checked.
    expect(aheadSkip({ ...event, allDay: true, summary: 'Weekend Rome', location: '' })).toBeNull();
    expect(
      aheadSkip({ ...event, allDay: true, summary: 'Birthday', location: 'Restaurant De Kas' }),
    ).toBeNull();
    // Modified single occurrence of a repeating event is checked.
    expect(aheadSkip({ ...event, recurring: true, recurringException: true })).toBeNull();
  });

  it('skips generic all-day markers, unmodified repeating, empty, online, declined, unanswered and cancelled events', () => {
    expect(aheadSkip({ ...event, allDay: true, summary: 'Out of office', location: '' })).toBe('all_day');
    expect(aheadSkip({ ...event, allDay: true, summary: 'Verjaardag Oma', location: '' })).toBe('all_day');
    expect(aheadSkip({ ...event, recurring: true })).toBe('recurring');
    expect(aheadSkip({ ...event, recurrence: ['RRULE:FREQ=WEEKLY'] })).toBe('recurring');
    expect(aheadSkip({ ...event, summary: '  ', location: '  ' })).toBe('no_place');
    expect(aheadSkip({ ...event, location: 'Microsoft Teams Meeting' })).toBe('online');
    expect(aheadSkip({ ...event, location: 'https://meet.example.com/abc' })).toBe('online');
    expect(aheadSkip({ ...event, location: '', meetUrl: 'https://meet.google.com/abc-defg-hij' })).toBe(
      'online',
    );
    expect(aheadSkip({ ...event, response: 'declined' })).toBe('declined');
    expect(aheadSkip({ ...event, response: 'needs_action' })).toBe('unanswered');
    expect(aheadSkip({ ...event, cancelled: true })).toBe('cancelled');
  });
});

describe('aheadVersion and stages', () => {
  it('is the same for the same event and changes with its time or place', () => {
    expect(aheadVersion(event)).toBe(aheadVersion({ ...event }));
    expect(aheadVersion(event)).toMatch(/^[0-9a-f]{8}$/);
    expect(aheadVersion({ ...event, start: '2026-12-14T20:45:00+01:00' })).not.toBe(aheadVersion(event));
    expect(aheadVersion({ ...event, location: 'AFAS Live' })).not.toBe(aheadVersion(event));
    expect(aheadStageVersion('a1b2c3d4', 'eve')).toBe('a1b2c3d4');
    expect(aheadStageVersion('a1b2c3d4', 'early')).toBe('a1b2c3d4:early');
    expect(aheadStageVersion('a1b2c3d4', 'morning')).toBe('a1b2c3d4:morning');
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

  it('splits upcoming events into early (2–7d), eve (afternoon before / today) and morning (2–4h before)', () => {
    expect(aheadStage({ start: event.start }, '2026-12-06T12:00:00+01:00', TZ)).toBeNull();
    expect(aheadStage({ start: event.start }, '2026-12-09T12:00:00+01:00', TZ)).toBe('early');
    expect(aheadStage({ start: event.start }, '2026-12-13T13:59:00+01:00', TZ)).toBe('early');
    expect(aheadStage({ start: event.start }, '2026-12-13T14:00:00+01:00', TZ)).toBe('eve');
    expect(aheadStage({ start: event.start }, '2026-12-14T09:00:00+01:00', TZ)).toBe('eve');
    expect(aheadStage({ start: event.start }, '2026-12-14T16:30:00+01:00', TZ)).toBe('morning');
    // Too close to change plans (< 90 min).
    expect(aheadStage({ start: event.start }, '2026-12-14T19:00:00+01:00', TZ)).toBeNull();
    // All-day events check early (2–7d) and eve (day before from 14:00).
    expect(aheadStage({ start: '2026-12-18', allDay: true }, '2026-12-13T15:00:00+01:00', TZ)).toBe('early');
    expect(aheadStage({ start: '2026-12-14', allDay: true }, '2026-12-13T15:00:00+01:00', TZ)).toBe('eve');
    expect(aheadStage({ start: '2026-12-13', allDay: true }, '2026-12-13T15:00:00+01:00', TZ)).toBeNull();
    // aheadDue remains true for eve and morning, false for early.
    expect(aheadDue(event.start, '2026-12-13T13:59:00+01:00', TZ)).toBe(false);
    expect(aheadDue(event.start, '2026-12-13T14:00:00+01:00', TZ)).toBe(true);
    expect(aheadDue(event.start, '2026-12-14T16:30:00+01:00', TZ)).toBe(true);
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

  it('picks by stage urgency, then priority, then soonest start', () => {
    const early = {
      key: 'conn:primary:e3',
      version: 'bbbbbbbb',
      start: '2026-12-17T20:00:00+01:00',
      priority: 8,
    };
    const laterHigh = {
      key: 'conn:family:e2',
      version: 'aaaaaaaa',
      start: '2026-12-14T21:00:00+01:00',
      priority: 6,
    };
    const soonerLow = { ...candidate, priority: 2 };
    // Eve beats early even when early has higher priority; higher priority beats lower within eve.
    expect(planAheadPass({ ...base, candidates: [early, soonerLow, laterHigh] })).toMatchObject({
      key: laterHigh.key,
      stage: 'eve',
    });
    // Priority boosts flights/venues over bare titles.
    expect(aheadPriority({ summary: 'Flight KL1234', location: 'Schiphol' })).toBeGreaterThan(
      aheadPriority({ summary: 'Catch up', location: '' }),
    );
  });

  it('never checks a version+stage twice, while allowing a later stage even if an earlier stage had a finding', () => {
    expect(planAheadPass({ ...base, checked: [{ ...candidate, stage: 'eve', found: false }] })).toBeNull();
    expect(
      planAheadPass({
        ...base,
        checked: [{ key: candidate.key, version: 'other000', stage: 'eve', found: true }],
      }),
    ).toBeNull();
    // Early stage had a finding: eve stage STILL checks for new issues (with prior note).
    expect(
      planAheadPass({
        ...base,
        checked: [
          {
            key: candidate.key,
            version: aheadStageVersion(candidate.version, 'early'),
            stage: 'early',
            found: true,
          },
        ],
      }),
    ).toMatchObject({ key: candidate.key, stage: 'eve' });
    // Another version of a quiet eve check is checked again.
    expect(
      planAheadPass({
        ...base,
        checked: [{ key: candidate.key, version: 'other000', stage: 'eve', found: false }],
      }),
    ).toMatchObject({ key: candidate.key, stage: 'eve' });
  });

  it('keeps to one at a time, the day’s budgets, readiness and hours', () => {
    expect(planAheadPass({ ...base, busy: true })).toBeNull();
    expect(planAheadPass({ ...base, ready: false })).toBeNull();
    expect(planAheadPass({ ...base, checksToday: AHEAD_CHECKS_PER_DAY })).toBeNull();
    expect(planAheadPass({ ...base, findingsToday: AHEAD_FINDINGS_PER_DAY })).toBeNull();
    expect(planAheadPass({ ...base, now: '2026-12-13T22:00:00+01:00' })).toBeNull();
  });
});

describe('incoming mail pre-filter', () => {
  it('picks booking confirmations, deadlines and user-rule matches while skipping own mail and newsletters', () => {
    expect(
      aheadMailCandidate({
        from: 'noreply@klm.example',
        subject: 'Online check-in is now open for flight KL1234',
        snippet: 'Check in now and pick your seat.',
        ownAddresses: ['mara@example.com'],
      }),
    ).toBe(true);
    expect(
      aheadMailCandidate({
        from: 'bezorging@postnl.example',
        subject: 'Kies je bezorgmoment',
        snippet: 'Geef aan wanneer we je pakket mogen bezorgen.',
        ownAddresses: ['mara@example.com'],
      }),
    ).toBe(true);
    // Skips own sent mail.
    expect(
      aheadMailCandidate({
        from: 'Mara <mara@example.com>',
        subject: 'Flight booking confirmation',
        snippet: 'Here are the tickets.',
        ownAddresses: ['mara@example.com'],
      }),
    ).toBe(false);
    // Skips promo newsletters.
    expect(
      aheadMailCandidate({
        from: 'deals@shop.example',
        subject: 'Weekly newsletter: 20% off tickets',
        snippet: 'Shop now or unsubscribe anytime.',
        ownAddresses: ['mara@example.com'],
      }),
    ).toBe(false);
    // Matches user-owned standing rules.
    expect(
      aheadMailCandidate({
        from: 'school@utrecht.example',
        subject: 'Zwemles vrijdag',
        snippet: 'Het zwembad sluit eerder.',
        ownAddresses: ['mara@example.com'],
        rules: ['Always watch messages about zwemles'],
      }),
    ).toBe(true);
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
    expect(aheadQueryRefusal('The Script Ziggo Dome 2026-12-14', [])).toBeNull();
    expect(aheadQueryRefusal('Ziggo Dome 14.12.2026 20:45', [])).toBeNull();
    expect(aheadQueryRefusal('KL1234 Schiphol 14-12-2026', [])).toBeNull();
    expect(aheadQueryRefusal('booking X7K2PQ', [])).not.toBeNull();
    expect(aheadQueryRefusal('call 06-12-345678', [])).not.toBeNull();
    expect(aheadQueryRefusal('Ziggo Dome 14 december 2026 20.45', [])).toBeNull();
    expect(aheadQueryRefusal('Ziggo Dome 20.45 - 23.00', [])).toBeNull();
    for (const phone of ['06.12.34.56.78', '06-12-34-56-78', '0800 2026 2027', '06.12 14.25 18.30'])
      expect(aheadQueryRefusal(`call ${phone}`, [])).not.toBeNull();
  });
});

describe('the report and the setting', () => {
  it('supports single/multi-kind findings, action chips, notes, and new verified source types', () => {
    expect(AheadReportInput.safeParse({ found: false }).success).toBe(true);
    expect(AheadReportInput.safeParse({ found: false, note: 'Tickets confirmed in mail.' }).success).toBe(
      true,
    );
    expect(
      AheadReportInput.safeParse({
        found: true,
        kind: 'time',
        extraKinds: ['crowds'],
        text: 'Starts at 20:45, not 20:00. Ajax plays next door at 20:00.',
        sources: [{ url: 'https://example.com/the-script' }, { fileId: 'drv_1' }, { docId: 'paperless:1:9' }],
        action: 'Update event to 20:45',
        note: 'Flagged time mismatch and Ajax match.',
      }).success,
    ).toBe(true);
    expect(
      AheadReportInput.safeParse({
        found: true,
        kind: 'conflict',
        text: 'Overlaps with dinner across town.',
        sources: [{ calendar: true }],
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
    expect(LooksAheadUpdate.safeParse({ mailOn: false }).success).toBe(true);
    expect(LooksAheadUpdate.safeParse({ calendar: 'c:family', on: true }).success).toBe(true);
    expect(LooksAheadUpdate.safeParse({ kind: 'crowds', on: false }).success).toBe(true);
    expect(LooksAheadUpdate.safeParse({ addRule: 'I live in Utrecht' }).success).toBe(true);
    expect(LooksAheadUpdate.safeParse({ removeRule: 'I live in Utrecht' }).success).toBe(true);
    expect(LooksAheadUpdate.safeParse({ on: true, kind: 'crowds', calendar: 'x' }).success).toBe(false);
  });
});
