import type { LooksAheadView } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  hasLooksAhead,
  looksAheadCalendarMeta,
  looksAheadSavedText,
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
  stopped: ['travel'],
  week: { checked: 3, told: 1 },
};

describe('Looks ahead in Settings', () => {
  it('shows only on a Whombat that has it', () => {
    expect(hasLooksAhead({ major: 5, minor: 10 })).toBe(true);
    expect(hasLooksAhead({ major: 5, minor: 9 })).toBe(false);
    expect(hasLooksAhead(null)).toBe(false);
    expect(agentGroupParts({ looksAhead: true })).toContain('ahead');
    expect(agentGroupParts({ looksAhead: false })).not.toContain('ahead');
    expect(SETTINGS_GROUP_TEXT.agent('dusty').ahead).toBe('Looks ahead');
    const old = settingsHomeRows('dusty', ['profile'], agentGroupParts({ looksAhead: false }));
    expect(old[1]?.line).not.toContain('Looks ahead');
    expect(settingsHomeRows('dusty', ['profile'])[1]?.line).toContain('Looks ahead');
  });

  it('makes one change to the view while it saves', () => {
    expect(withLooksAheadChange(view, { on: false }).on).toBe(false);
    const family = withLooksAheadChange(view, { calendar: 'con_g:family', on: true });
    expect(family.calendars.map((c) => c.on)).toEqual([true, true]);
    expect(withLooksAheadChange(view, { kind: 'travel', on: true }).stopped).toEqual([]);
    // Stopped kinds keep the list's order.
    expect(withLooksAheadChange(view, { kind: 'time', on: false }).stopped).toEqual(['time', 'travel']);
    expect(view.stopped).toEqual(['travel']);
  });

  it('says what changed', () => {
    expect(looksAheadSavedText(view, { on: false })).toContain('off');
    expect(looksAheadSavedText(view, { calendar: 'con_g:family', on: true })).toContain('Family');
    expect(looksAheadSavedText(view, { kind: 'travel', on: true })).toContain('Travel disruptions');
  });

  it('names a calendar’s account', () => {
    expect(looksAheadCalendarMeta({ account: 'mara@example.com', primary: false })).toBe('mara@example.com');
    expect(looksAheadCalendarMeta({ account: 'mara@example.com', primary: true })).toContain('·');
  });
});
