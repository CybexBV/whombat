import { describe, expect, it } from 'vitest';
import type { DeskLayout } from './contract';
import { pageHoursText, pageShowSaid, pageWhenText, setPageShow } from './pageTimes';

const layout: DeskLayout = {
  pages: [
    { id: 'p_first', name: 'Overview', layouts: { '8x5': [] }, last: '8x5' },
    { id: 'p_morning', name: 'Morning', layouts: { '8x5': [] }, last: '8x5' },
  ],
  turn: 'touch',
  size: 'normal',
};
const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;

describe('a page at set times', () => {
  it('keeps a window on its page, every day as no days, and clears it with Always', () => {
    const set = setPageShow(layout, 1, { from: '07:00', to: '09:00', days: [...WEEK] });
    expect(set?.pages[1]?.show).toEqual({ from: '07:00', to: '09:00', days: [...WEEK] });
    expect(set?.pages[0]).toBe(layout.pages[0]);
    const daily = setPageShow(layout, 1, {
      from: '22:00',
      to: '06:00',
      days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    });
    expect(daily?.pages[1]?.show).toEqual({ from: '22:00', to: '06:00' });
    const cleared = set ? setPageShow(set, 1, null) : null;
    expect(cleared?.pages[1]).not.toHaveProperty('show');
    expect(setPageShow(layout, 1, null)).toBe(layout);
  });

  it('refuses a window without a day', () => {
    expect(setPageShow(layout, 1, { from: '07:00', to: '09:00', days: [] })).toBeNull();
  });

  it('says its hours on the tab and in full', () => {
    expect(pageHoursText({ from: '07:00', to: '09:00', days: [...WEEK] })).toBe('07:00–09:00');
    expect(pageHoursText({ from: '00:00', to: '00:00', days: ['sat', 'sun'] })).toBe('Weekends');
    expect(pageHoursText({ from: '00:00', to: '00:00' })).toBe('All day');
    expect(pageWhenText({ from: '07:00', to: '09:00', days: [...WEEK] })).toBe('Weekdays, 07:00–09:00');
    expect(pageWhenText({ from: '22:00', to: '06:00' })).toBe('Every day, 22:00–06:00');
    expect(pageShowSaid('Morning', { from: '07:00', to: '09:00' })).toContain('Every day, 07:00–09:00');
    expect(pageShowSaid('Morning', null)).toContain('Morning');
  });
});
