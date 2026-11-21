/** Search filters in the address and their menus (docs/decisions/essentials-messages.md AP-448). */
import type { Principal } from '@whombat/core';
import { dusty, mara } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { validateSearchSearch } from '../../app/routing/search';
import {
  addDays,
  chatInOptions,
  fromOptions,
  hasSearchFilters,
  parseSearchFilters,
  presetOf,
  presetRange,
  todayIn,
} from './searchFilters';

describe('parseSearchFilters', () => {
  it('keeps well-formed values and drops the rest', () => {
    expect(
      parseSearchFilters({ from: 'mara', in: 'cnv_billing-v2', after: '2026-09-01', before: '2026-09-30' }),
    ).toEqual({ from: 'mara', in: 'cnv_billing-v2', after: '2026-09-01', before: '2026-09-30' });
    expect(parseSearchFilters({ from: 'Mara!', in: 'billing', after: '2026-13-01', before: 'soon' })).toEqual(
      {},
    );
    expect(hasSearchFilters({})).toBe(false);
    expect(hasSearchFilters({ before: '2026-09-30' })).toBe(true);
  });

  it('is part of the search route’s address, next to q and type', () => {
    expect(
      validateSearchSearch({ q: 'vat', type: 'threads', from: 'dusty', after: '2026-09-01', x: 1 }),
    ).toEqual({
      q: 'vat',
      type: 'threads',
      from: 'dusty',
      after: '2026-09-01',
    });
    expect(validateSearchSearch({ q: '', from: undefined })).toEqual({ q: '' });
  });
});

describe('date presets', () => {
  const today = '2026-09-23';

  it('turn into days, by the calendar', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(presetRange('any', today)).toEqual({ after: undefined, before: undefined });
    expect(presetRange('today', today)).toEqual({ after: today, before: undefined });
    expect(presetRange('week', today)).toEqual({ after: '2026-09-17', before: undefined });
    expect(presetRange('month', today)).toEqual({ after: '2026-08-25', before: undefined });
    expect(presetRange('custom', today)).toEqual({ after: '2026-09-17', before: today });
    expect(presetRange('custom', today, { after: '2026-09-01' })).toEqual({
      after: '2026-09-01',
      before: today,
    });
  });

  it('are read back from the address', () => {
    expect(presetOf({}, today)).toBe('any');
    expect(presetOf({ after: today }, today)).toBe('today');
    expect(presetOf({ after: '2026-09-17' }, today)).toBe('week');
    expect(presetOf({ after: '2026-08-25' }, today)).toBe('month');
    expect(presetOf({ after: '2026-09-17', before: today }, today)).toBe('custom');
    expect(presetOf({ before: '2026-09-01' }, today)).toBe('custom');
  });

  it('count days in the viewer’s zone', () => {
    const lateEvening = Date.parse('2026-09-23T22:30:00.000Z');
    expect(todayIn('Europe/Amsterdam', lateEvening)).toBe('2026-09-24');
    expect(todayIn('America/New_York', lateEvening)).toBe('2026-09-23');
  });
});

describe('menus', () => {
  it('From lists you, then the agent, never a system actor (AP-4925)', () => {
    const github = {
      ...dusty,
      kind: 'system',
      id: 'prn_github',
      handle: 'github',
      name: 'GitHub',
    } as unknown as Principal;
    const options = fromOptions([dusty, github, mara]);
    expect(options.map((o) => o.value)).toEqual([mara.handle, dusty.handle]);
    expect(options[0]?.label).toBe(mara.name);
  });
});

describe('“In” (less-is-more.md AP-1808)', () => {
  it('lists the person’s chats by title, not the archived ones', () => {
    expect(
      chatInOptions([
        { id: 'cnv_a', title: 'Add our heat pump' },
        { id: 'cnv_b', title: 'Old one', archivedAt: '2026-10-01T00:00:00.000Z' },
      ]),
    ).toEqual([{ value: 'cnv_a', label: 'Add our heat pump' }]);
  });
});
