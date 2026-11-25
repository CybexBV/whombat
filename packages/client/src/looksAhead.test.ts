import type { LooksAheadView } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  hasLooksAhead,
  hasLooksAheadMatters,
  hasLooksAheadV2,
  LOOKS_AHEAD_TEXT,
  looksAheadCalendarMeta,
  looksAheadCheckMeta,
  looksAheadRecentLabel,
  looksAheadSavedText,
  matterLine,
  removeMatterLabel,
  withLooksAheadChange,
} from './looksAhead';
import { agentGroupParts, SETTINGS_GROUP_TEXT, settingsHomeRows } from './settingsGroups';

const view: LooksAheadView = {
  on: true,
  calendars: [
    { key: 'con_g:primary', name: 'Mara', account: 'mara@example.com', on: true, primary: true },
    { key: 'con_g:family', name: 'Family', account: 'mara@example.com', on: false, primary: false },
  ],
  calendarsRead: true,
  hasCalendar: true,
  mailOn: true,
  hasMail: true,
  rules: ['I live in Utrecht'],
  stopped: ['travel'],
  week: { checked: 3, told: 1 },
  recent: [],
  matters: [
    {
      id: 'ahm_1',
      title: 'Answer from the notary',
      who: 'The notary',
      waitingOn: 'them',
      since: '2026-12-10T10:00:00Z',
      asked: true,
    },
    {
      id: 'ahm_2',
      title: 'Refund for the kettle',
      waitingOn: 'you',
      since: '2026-12-11T10:00:00Z',
      asked: false,
    },
  ],
};

describe('Looks ahead in Settings', () => {
  it('shows only on a Whombat that has it, and gates v2 on minor 12', () => {
    expect(hasLooksAhead({ major: 5, minor: 10 })).toBe(true);
    expect(hasLooksAhead({ major: 5, minor: 9 })).toBe(false);
    expect(hasLooksAhead(null)).toBe(false);
    expect(hasLooksAheadV2({ major: 5, minor: 12 })).toBe(true);
    expect(hasLooksAheadV2({ major: 5, minor: 11 })).toBe(false);
    expect(hasLooksAheadMatters({ major: 5, minor: 14 })).toBe(true);
    expect(hasLooksAheadMatters({ major: 5, minor: 13 })).toBe(false);
    expect(agentGroupParts({ looksAhead: true })).toContain('ahead');
    expect(agentGroupParts({ looksAhead: false })).not.toContain('ahead');
    expect(SETTINGS_GROUP_TEXT.agent('dusty').ahead).toBe('Looks ahead');
    const old = settingsHomeRows('dusty', ['profile'], agentGroupParts({ looksAhead: false }));
    expect(old[1]?.line).not.toContain('Looks ahead');
    expect(settingsHomeRows('dusty', ['profile'])[1]?.line).toContain('Looks ahead');
  });

  it('makes one change to the view while it saves', () => {
    expect(withLooksAheadChange(view, { on: false }).on).toBe(false);
    expect(withLooksAheadChange(view, { mailOn: false }).mailOn).toBe(false);
    const family = withLooksAheadChange(view, { calendar: 'con_g:family', on: true });
    expect(family.calendars.map((c) => c.on)).toEqual([true, true]);
    expect(withLooksAheadChange(view, { kind: 'travel', on: true }).stopped).toEqual([]);
    // Stopped kinds keep the list's order.
    expect(withLooksAheadChange(view, { kind: 'time', on: false }).stopped).toEqual(['time', 'travel']);
    expect(withLooksAheadChange(view, { addRule: 'Always check trains' }).rules).toEqual([
      'I live in Utrecht',
      'Always check trains',
    ]);
    expect(withLooksAheadChange(view, { removeRule: 'I live in Utrecht' }).rules).toEqual([]);
    expect(withLooksAheadChange(view, { removeMatter: 'ahm_1' }).matters?.map((m) => m.id)).toEqual([
      'ahm_2',
    ]);
    expect(view.stopped).toEqual(['travel']);
  });

  it('says what changed and formats recent check lines', () => {
    expect(looksAheadSavedText(view, { on: false })).toContain('off');
    expect(looksAheadSavedText(view, { mailOn: false })).toContain('Incoming mail');
    expect(looksAheadSavedText(view, { calendar: 'con_g:family', on: true })).toContain('Family');
    expect(looksAheadSavedText(view, { kind: 'travel', on: true })).toContain('Travel disruptions');
    expect(looksAheadSavedText(view, { addRule: 'x' })).toContain('watch for');
    expect(looksAheadSavedText(view, { removeRule: 'x' })).toContain('Removed');
    expect(looksAheadSavedText(view, { removeMatter: 'ahm_1' })).toContain('eye on');
    expect(looksAheadCheckMeta({ stage: 'eve', state: 'told', kind: 'time', feedback: null })).toContain(
      'Changed times',
    );
    expect(looksAheadCheckMeta({ stage: 'mail', state: 'quiet', kind: null, feedback: null })).toContain(
      'Incoming mail',
    );
  });

  it('says a look through new mail and a follow-up', () => {
    const quiet = { stage: 'mail' as const, state: 'quiet' as const, kind: null, feedback: null };
    const look = looksAheadCheckMeta({ ...quiet, of: 'triage', count: 42, picked: 2 });
    expect(look).toContain('42');
    expect(look).toContain('2 to check');
    expect(looksAheadCheckMeta({ ...quiet, of: 'triage', count: 9, picked: 0 })).toContain('nothing');
    expect(looksAheadCheckMeta({ ...quiet, state: 'checking', of: 'triage' })).toContain('new mail');
    expect(looksAheadCheckMeta({ ...quiet, state: 'told', kind: 'deadline', of: 'matter' })).toContain(
      'Follow-up',
    );
    expect(looksAheadRecentLabel({ of: 'matter' })).toBe('Follow-up');
    expect(looksAheadRecentLabel({})).toBeNull();
    // “Stop checking for this” under a follow-up stopped that one thing, not a kind.
    const stopped = {
      ...quiet,
      state: 'told' as const,
      kind: 'deadline' as const,
      feedback: 'stop_kind' as const,
    };
    expect(looksAheadCheckMeta({ ...stopped, of: 'matter' })).toContain(LOOKS_AHEAD_TEXT.stoppedMatter);
    expect(looksAheadCheckMeta({ ...stopped, of: 'matter' })).not.toContain(LOOKS_AHEAD_TEXT.stoppedKind);
    expect(looksAheadCheckMeta(stopped)).toContain(LOOKS_AHEAD_TEXT.stoppedKind);
  });

  it('says who, whom it waits on and its date under a thing kept an eye on', () => {
    const line = matterLine({ who: 'The notary', waitingOn: 'them', due: '2026-12-20' });
    expect(line).toContain('The notary');
    expect(line).toContain('Waiting for an answer');
    expect(line).toContain('20 Dec');
    expect(line).not.toContain('2026');
    expect(matterLine({ waitingOn: 'you' })).toBe('Waiting on you');
    // A moment late in the day is read in the person's zone.
    expect(matterLine({ waitingOn: 'you', due: '2026-12-19T23:30:00Z' }, 'Europe/Amsterdam')).toContain(
      '20 Dec',
    );
    expect(matterLine({ waitingOn: 'you', due: '2027-01-04' }, undefined, '2026-12-13T12:00:00Z')).toContain(
      '2027',
    );
    expect(removeMatterLabel('Answer from the notary')).toContain('Answer from the notary');
  });

  it('names a calendar’s account', () => {
    expect(looksAheadCalendarMeta({ account: 'mara@example.com', primary: false })).toBe('mara@example.com');
    expect(looksAheadCalendarMeta({ account: 'mara@example.com', primary: true })).toContain('·');
  });
});
