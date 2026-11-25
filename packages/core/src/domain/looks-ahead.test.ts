import { describe, expect, it } from 'vitest';
import {
  AHEAD_CHECKS_PER_DAY,
  AHEAD_FINDINGS_PER_DAY,
  AHEAD_MATTER_DUE_LEAD_MS,
  AHEAD_MATTER_FOLLOW_WINDOW_MS,
  AHEAD_MATTER_NO_ANSWER_MS,
  AHEAD_TOOL_NAMES,
  AHEAD_TRIAGE_FIRST_MS,
  AHEAD_TRIAGE_GAP_MS,
  AHEAD_TRIAGE_PER_DAY,
  AHEAD_TRIAGE_PICKS_MAX,
  AHEAD_TRIAGE_SINCE_MAX_MS,
  AheadDispatchContext,
  AheadReportInput,
  AheadTriageInput,
  AheadWatchInput,
  aheadDue,
  aheadHours,
  aheadMailNoise,
  aheadMailSignal,
  aheadMatterDue,
  aheadMatterMatches,
  aheadPriority,
  aheadQueryRefusal,
  aheadSkip,
  aheadStage,
  aheadStageVersion,
  aheadStartHours,
  aheadTriageDue,
  aheadTriageSince,
  aheadVersion,
  LOOKS_AHEAD_WORDS,
  LooksAheadCheckItem,
  LooksAheadUpdate,
  LooksAheadView,
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

  const mail = {
    key: 'mail:con_g:msg1',
    version: 'msg1',
    start: '2026-12-13T14:00:00+01:00',
    source: 'mail' as const,
  };
  const asked = { ...mail, key: 'mail:con_g:msg2', version: 'msg2', asked: true };
  const followUp = { key: 'matter:ahm_1', version: 'no_answer', start: base.now, source: 'matter' as const };
  const look = {
    key: 'triage:2026-12-13T14:00',
    version: 'triage',
    start: base.now,
    source: 'triage' as const,
  };
  const early = { key: 'conn:primary:e3', version: 'bbbbbbbb', start: '2026-12-17T20:00:00+01:00' };

  it('orders morning, eve, mail, follow-up, look, early; asked mail first among mail', () => {
    const all = [early, look, followUp, mail, candidate];
    expect(planAheadPass({ ...base, candidates: all })).toMatchObject({ key: candidate.key, stage: 'eve' });
    expect(planAheadPass({ ...base, candidates: all.slice(0, 4) })).toMatchObject({
      key: mail.key,
      stage: 'mail',
    });
    expect(planAheadPass({ ...base, candidates: all.slice(0, 3) })).toMatchObject({
      key: followUp.key,
      stage: 'matter',
      source: 'matter',
    });
    expect(planAheadPass({ ...base, candidates: all.slice(0, 2) })).toMatchObject({
      key: look.key,
      stage: 'triage',
    });
    expect(planAheadPass({ ...base, candidates: [{ ...mail, priority: 9 }, asked] })).toMatchObject({
      key: asked.key,
    });
  });

  it('starts a mail, a follow-up or a look once', () => {
    for (const c of [mail, followUp, look]) {
      const stage = c.source;
      expect(
        planAheadPass({
          ...base,
          candidates: [c],
          checked: [{ key: c.key, version: aheadStageVersion(c.version, stage), stage, found: false }],
        }),
      ).toBeNull();
    }
    // A follow-up for another reason still starts after one that was told.
    expect(
      planAheadPass({
        ...base,
        candidates: [followUp],
        checked: [
          { key: followUp.key, version: aheadStageVersion('due', 'matter'), stage: 'matter', found: true },
        ],
      }),
    ).toMatchObject({ key: followUp.key });
  });

  it('once the day’s findings are used, only mail the person asked about starts', () => {
    const used = { ...base, findingsToday: AHEAD_FINDINGS_PER_DAY };
    expect(planAheadPass({ ...used, candidates: [candidate, mail, followUp, look] })).toBeNull();
    expect(
      planAheadPass({ ...used, candidates: [candidate, mail, asked, { ...look, asked: true }] }),
    ).toMatchObject({
      key: asked.key,
    });
    expect(planAheadPass({ ...used, candidates: [{ ...look, asked: true }] })).toBeNull();
    // The checks cap holds for everything.
    expect(planAheadPass({ ...used, checksToday: AHEAD_CHECKS_PER_DAY, candidates: [asked] })).toBeNull();
  });
});

describe('incoming mail before a look', () => {
  const own = ['mara@example.com'];

  it('leaves out the person’s own mail and plain bulk mail, keeps the rest', () => {
    expect(
      aheadMailNoise({
        from: 'Mara <Mara@Example.com>',
        subject: 'Flight booking confirmation',
        snippet: 'Here are the tickets.',
        ownAddresses: own,
      }),
    ).toBe(true);
    expect(
      aheadMailNoise({
        from: 'deals@shop.example',
        subject: 'Weekly newsletter: 20% off tickets',
        snippet: 'Shop now or unsubscribe anytime.',
        ownAddresses: own,
      }),
    ).toBe(true);
    // A shop's invoice keeps its unsubscribe line and is still looked at.
    expect(
      aheadMailNoise({
        from: 'billing@shop.example',
        subject: 'Your invoice',
        snippet: 'Unsubscribe from these emails.',
        ownAddresses: own,
      }),
    ).toBe(false);
    // A question without any keyword is not noise.
    expect(
      aheadMailNoise({
        from: 'notary@example.com',
        subject: 'Re: deed',
        snippet: 'Can you answer me by Friday?',
        ownAddresses: own,
      }),
    ).toBe(false);
    // An empty own address never matches everything.
    expect(aheadMailNoise({ from: 'a@example.com', subject: 'Hi', snippet: '', ownAddresses: ['  '] })).toBe(
      false,
    );
  });

  it('lists booking and deadline mail and the person’s rules first', () => {
    expect(aheadMailSignal({ subject: 'Online check-in is now open for flight KL1234', snippet: '' })).toBe(
      true,
    );
    expect(aheadMailSignal({ subject: 'Kies je bezorgmoment', snippet: 'Pakket' })).toBe(true);
    expect(
      aheadMailSignal({
        subject: 'Zwemles vrijdag',
        snippet: 'Het zwembad sluit eerder.',
        rules: ['Always watch messages about zwemles'],
      }),
    ).toBe(true);
    expect(aheadMailSignal({ subject: 'Re: deed', snippet: 'Can you answer me?' })).toBe(false);
    // The words every rule has don't match.
    expect(
      aheadMailSignal({
        subject: 'Your calendar this week',
        snippet: '',
        rules: ['Always check my calendar'],
      }),
    ).toBe(false);
  });
});

describe('looking through new mail', () => {
  const now = new Date('2026-12-13T12:00:00+01:00');
  const base = { now, timeZone: TZ, lastTriageAt: null, triagesToday: 0, newMail: 4 };

  it('is due when new mail came, within the day, its budget and its gap', () => {
    expect(aheadTriageDue(base)).toBe(true);
    expect(aheadTriageDue({ ...base, newMail: 0 })).toBe(false);
    expect(aheadTriageDue({ ...base, triagesToday: AHEAD_TRIAGE_PER_DAY })).toBe(false);
    expect(aheadTriageDue({ ...base, now: new Date('2026-12-13T20:45:00+01:00') })).toBe(false);
    const recent = new Date(now.getTime() - AHEAD_TRIAGE_GAP_MS + 60_000);
    expect(aheadTriageDue({ ...base, lastTriageAt: recent, triagesToday: 1 })).toBe(false);
    // “Check now” doesn't wait for the gap, but keeps the day's budget.
    expect(aheadTriageDue({ ...base, lastTriageAt: recent, triagesToday: 1, fresh: true })).toBe(true);
    expect(
      aheadTriageDue({ ...base, lastTriageAt: recent, triagesToday: AHEAD_TRIAGE_PER_DAY, fresh: true }),
    ).toBe(false);
    const longAgo = new Date(now.getTime() - AHEAD_TRIAGE_GAP_MS);
    expect(aheadTriageDue({ ...base, lastTriageAt: longAgo, triagesToday: 1 })).toBe(true);
  });

  it('covers mail since the last look began, never too far back', () => {
    expect(aheadTriageSince(null, now).getTime()).toBe(now.getTime() - AHEAD_TRIAGE_FIRST_MS);
    const last = new Date(now.getTime() - 5 * 3600_000);
    expect(aheadTriageSince(last, now).getTime()).toBe(last.getTime());
    const old = new Date(now.getTime() - 5 * 24 * 3600_000);
    expect(aheadTriageSince(old, now).getTime()).toBe(now.getTime() - AHEAD_TRIAGE_SINCE_MAX_MS);
  });

  it('ends with picks by number only', () => {
    expect(AheadTriageInput.safeParse({ picks: [] }).success).toBe(true);
    expect(
      AheadTriageInput.safeParse({ picks: [{ mail: 'm12', matter: 'k3' }, { mail: 'm1' }] }).success,
    ).toBe(true);
    const many = Array.from({ length: AHEAD_TRIAGE_PICKS_MAX + 1 }, (_, i) => ({ mail: `m${i + 1}` }));
    expect(AheadTriageInput.safeParse({ picks: many }).success).toBe(false);
    expect(AheadTriageInput.safeParse({ picks: [{ mail: 'mail 3' }] }).success).toBe(false);
    expect(AheadTriageInput.safeParse({ picks: [{ mail: 'm3', why: 'urgent' }] }).success).toBe(false);
    expect(AheadTriageInput.safeParse({ picks: [{ mail: 'm3', matter: 'kx' }] }).success).toBe(false);
    expect(AHEAD_TOOL_NAMES).toContain('ahead_triage');
  });
});

describe('keeping an eye on', () => {
  const mail = {
    connectionId: 'con_g',
    threadId: 'th_1',
    from: 'Notariskantoor Smit <info@notaris-smit.example>',
    subject: 'Akte levering',
    snippet: 'Bijgaand het concept.',
  };

  it('matches mail by its thread, its sender, or (without senders) its words', () => {
    const none = { threads: [], senders: [], words: [] };
    expect(aheadMatterMatches(none, mail)).toBe(false);
    expect(
      aheadMatterMatches({ ...none, threads: [{ connectionId: 'con_g', threadId: 'th_1' }] }, mail),
    ).toBe(true);
    expect(
      aheadMatterMatches({ ...none, threads: [{ connectionId: 'con_m', threadId: 'th_1' }] }, mail),
    ).toBe(false);
    expect(aheadMatterMatches({ ...none, senders: ['NOTARIS'] }, mail)).toBe(true);
    expect(aheadMatterMatches({ ...none, senders: ['coolblue'] }, mail)).toBe(false);
    expect(aheadMatterMatches({ ...none, words: ['akte'] }, mail)).toBe(true);
    expect(aheadMatterMatches({ ...none, words: ['concept'] }, mail)).toBe(true);
    // With senders, words alone don't match.
    expect(aheadMatterMatches({ ...none, senders: ['coolblue'], words: ['akte'] }, mail)).toBe(false);
  });

  it('follows up by the clock, once per reason', () => {
    const dueAt = new Date('2026-12-18T00:00:00+01:00');
    const you = {
      waitingOn: 'you' as const,
      dueAt,
      lastNewsAt: new Date('2026-12-10T10:00:00Z'),
      followedUp: [],
    };
    expect(aheadMatterDue(you, new Date(dueAt.getTime() - AHEAD_MATTER_DUE_LEAD_MS - 1))).toBeNull();
    expect(aheadMatterDue(you, new Date(dueAt.getTime() - AHEAD_MATTER_DUE_LEAD_MS))).toBe('due');
    expect(aheadMatterDue(you, dueAt)).toBeNull();
    expect(aheadMatterDue({ ...you, followedUp: ['due'] }, new Date(dueAt.getTime() - 3600_000))).toBeNull();
    expect(aheadMatterDue({ ...you, dueAt: null }, dueAt)).toBeNull();

    const lastNewsAt = new Date('2026-12-10T10:00:00Z');
    const them = { waitingOn: 'them' as const, dueAt: null, lastNewsAt, followedUp: [] };
    const quietFrom = lastNewsAt.getTime() + AHEAD_MATTER_NO_ANSWER_MS;
    expect(aheadMatterDue(them, new Date(quietFrom - 1))).toBeNull();
    expect(aheadMatterDue(them, new Date(quietFrom))).toBe('no_answer');
    expect(aheadMatterDue(them, new Date(quietFrom + AHEAD_MATTER_FOLLOW_WINDOW_MS))).toBeNull();
    expect(aheadMatterDue({ ...them, followedUp: ['no_answer'] }, new Date(quietFrom))).toBeNull();
    // With a date, from that date.
    expect(aheadMatterDue({ ...them, dueAt }, dueAt)).toBe('no_answer');
    expect(aheadMatterDue({ ...them, dueAt }, new Date(quietFrom))).toBeNull();
  });

  it('a check opens one with a title and whom it waits on, and updates or closes the one it was given', () => {
    const quiet = { found: false };
    expect(
      AheadReportInput.safeParse({
        ...quiet,
        matter: { title: 'Refund for the kettle', who: 'Coolblue', waitingOn: 'them', due: '2026-12-20' },
      }).success,
    ).toBe(true);
    expect(
      AheadReportInput.safeParse({ ...quiet, matter: { ref: 'k2', note: 'Refund sent.', close: true } })
        .success,
    ).toBe(true);
    expect(
      AheadReportInput.safeParse({
        found: true,
        kind: 'deadline',
        text: 'The notary needs your answer by Friday.',
        sources: [{ matter: true }],
        matter: { ref: 'k1', note: 'Asked again.' },
      }).success,
    ).toBe(true);
    expect(AheadReportInput.safeParse({ ...quiet, matter: { title: 'Refund' } }).success).toBe(false);
    expect(
      AheadReportInput.safeParse({ ...quiet, matter: { title: 'Refund', waitingOn: 'them', close: true } })
        .success,
    ).toBe(false);
    expect(AheadReportInput.safeParse({ ...quiet, matter: { ref: 'k1', due: '20-12-2026' } }).success).toBe(
      false,
    );
    expect(AheadReportInput.safeParse({ ...quiet, matter: { ref: 'k1', link: 'x' } }).success).toBe(false);
  });

  it('the person starts, lists and stops one in their own words', () => {
    const start = AheadWatchInput.safeParse({ title: 'Answer from the notary', senders: ['notaris'] });
    expect(start.success && start.data).toMatchObject({ action: 'start', waitingOn: 'them' });
    expect(AheadWatchInput.safeParse({ title: 'Answer from the notary', words: ['akte'] }).success).toBe(
      true,
    );
    expect(AheadWatchInput.safeParse({ title: 'Answer from the notary' }).success).toBe(false);
    expect(AheadWatchInput.safeParse({ senders: ['notaris'] }).success).toBe(false);
    expect(AheadWatchInput.safeParse({ action: 'list' }).success).toBe(true);
    expect(AheadWatchInput.safeParse({ action: 'stop' }).success).toBe(false);
    expect(AheadWatchInput.safeParse({ action: 'stop', id: 'ahm_1' }).success).toBe(true);
    expect(AheadWatchInput.safeParse({ title: 'x y', senders: ['a', 'notaris'] }).success).toBe(false);
  });

  it('a turn reads the list by number, and a follow-up its reason', () => {
    const base = {
      summary: 'New mail',
      start: '2026-12-13T12:00:00Z',
      end: '2026-12-13T12:00:00Z',
      location: '',
      description: '',
      calendar: 'Mail',
      timeZone: TZ,
      stopped: [],
    };
    const matter = {
      ref: 'k1',
      title: 'Answer from the notary',
      waitingOn: 'them',
      asked: true,
      since: '2026-12-10',
    };
    expect(
      AheadDispatchContext.safeParse({
        ...base,
        source: 'triage',
        stage: 'triage',
        triage: { mails: [{ ref: 'm1', from: 'Notary', subject: 'Deed', date: '2026-12-13', snippet: '…' }] },
        matters: [matter],
      }).success,
    ).toBe(true);
    expect(
      AheadDispatchContext.safeParse({
        ...base,
        source: 'matter',
        matter: { ...matter, reason: 'no_answer' },
      }).success,
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
    expect(LooksAheadUpdate.safeParse({ removeMatter: 'ahm_1' }).success).toBe(true);
    expect(LooksAheadUpdate.safeParse({ removeMatter: '' }).success).toBe(false);
    expect(LooksAheadUpdate.safeParse({ on: true, kind: 'crowds', calendar: 'x' }).success).toBe(false);
  });

  it('keeps the values older apps know in recent rows, and adds only optional fields', () => {
    const row = {
      id: 'ahc_1',
      source: 'mail',
      stage: 'mail',
      title: 'New mail',
      at: '2026-12-13T12:00:00Z',
      state: 'quiet',
    };
    expect(LooksAheadCheckItem.safeParse({ ...row, of: 'triage', count: 42, picked: 2 }).success).toBe(true);
    expect(LooksAheadCheckItem.safeParse({ ...row, source: 'triage' }).success).toBe(false);
    expect(LooksAheadCheckItem.safeParse({ ...row, stage: 'matter' }).success).toBe(false);
    const view = {
      on: true,
      calendars: [],
      calendarsRead: true,
      hasCalendar: true,
      stopped: [],
      week: { checked: 0, told: 0 },
    };
    expect(LooksAheadView.safeParse(view).success).toBe(true);
    expect(
      LooksAheadView.safeParse({
        ...view,
        matters: [
          {
            id: 'ahm_1',
            title: 'Answer from the notary',
            waitingOn: 'them',
            since: '2026-12-10T10:00:00Z',
            asked: true,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('says a look and a follow-up in plain words', () => {
    expect(LOOKS_AHEAD_WORDS.recentTriage(42, 2)).toContain('42');
    expect(LOOKS_AHEAD_WORDS.recentTriage(42, 2)).toContain('2 to check');
    expect(LOOKS_AHEAD_WORDS.recentTriage(1, 0)).toContain('nothing');
    expect(LOOKS_AHEAD_WORDS.mattersEmpty('Dusty')).toContain('Dusty');
    expect(LOOKS_AHEAD_WORDS.matterDue('20 Dec')).toContain('20 Dec');
  });
});
