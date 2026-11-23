/**
 * Website feedback's page from recorded reports: the new ones with their site and the reporter's name, the counts,
 * reports per day and who reports most, by name only. Pure.
 */
import type { ThingPageItem, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../kinds/slots';
import { type FeedbackInput, type FeedbackRow, feedbackView } from './feedback';

const NOW = new Date('2026-11-23T10:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const report = (over: Partial<FeedbackRow> & Pick<FeedbackRow, 'id'>): FeedbackRow => ({
  type: 'bug',
  status: 'new',
  description: 'Something is off.',
  site: 'Billing portal',
  reporterName: null,
  createdAt: ago(DAY),
  updatedAt: ago(DAY),
  ...over,
});

const fresh = [
  report({
    id: 'r1',
    description: 'The export button does nothing\nI clicked it twice.',
    reporterName: 'Jamie Ortega',
    createdAt: ago(12 * MIN),
  }),
  report({
    id: 'r2',
    type: 'feature',
    site: 'Docs',
    description: 'Typo on the pricing page',
    reporterName: 'Priya Nair',
    createdAt: ago(3 * 60 * MIN),
  }),
];

function input(over: Partial<FeedbackInput> = {}): FeedbackInput {
  return {
    sites: ['Billing portal', 'Docs'],
    fresh,
    newCount: 2,
    openCount: 5,
    recent: [
      ...fresh,
      report({ id: 'r3', status: 'resolved', reporterName: 'Jamie Ortega', createdAt: ago(2 * DAY) }),
      report({ id: 'r4', status: 'triaged', reporterName: 'Jamie Ortega', createdAt: ago(3 * DAY) }),
      report({ id: 'r5', status: 'closed', createdAt: ago(10 * DAY), updatedAt: ago(9 * DAY) }),
    ],
    now: NOW,
    timeZone: 'Europe/Amsterdam',
    ...over,
  };
}

const panel = (panels: readonly ThingPagePanel[], id: string) => panels.find((p) => p.id === id);
const items = (p: ThingPagePanel | undefined): ThingPageItem[] => (p && p.kind === 'list' ? p.items : []);

describe('Website feedback’s page', () => {
  it('lists the new reports with their site and who sent them', () => {
    const view = feedbackView(input());
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['new', 'reports', 'week', 'people']);
    expect(items(panel(view.panels, 'new')).map((i) => [i.title, i.detail, i.icon, i.right])).toEqual([
      [
        'The export button does nothing I clicked it twice.',
        'Billing portal · Jamie Ortega',
        'warn',
        '12 min ago',
      ],
      ['Typo on the pricing page', 'Docs · Priya Nair', 'info', '3 h ago'],
    ]);
    expect(view.verdict).toBe('2 new reports wait for a look.');
  });

  it('counts this week against last week, what is open, fixed in 30 days and the sites', () => {
    const view = feedbackView(input());
    expect(items(panel(view.panels, 'reports')).map((i) => [i.id, i.figure?.value, i.figure?.note])).toEqual([
      ['week', '4', '+3 on last week'],
      ['open', '5', undefined],
      ['fixed', '1', undefined],
      ['sites', '2', undefined],
    ]);
    expect(items(panel(view.panels, 'reports')).find((i) => i.id === 'sites')?.detail).toBe(
      'Billing portal, Docs',
    );
    const week = panel(view.panels, 'week');
    expect(week?.kind === 'chart' && week.figure).toEqual({ value: '4', rest: 'this week' });
    const people = panel(view.panels, 'people');
    expect(people?.kind === 'bars' && people.items.map((p) => [p.label, p.value])).toEqual([
      ['Jamie Ortega', '3 reports'],
      ['Priya Nair', '1 report'],
    ]);
  });

  it('says so when nothing is new', () => {
    const view = feedbackView(input({ fresh: [], newCount: 0, openCount: 0, recent: [] }));
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['new', 'reports']);
    expect(view.verdict).toBe('No new reports.');
  });
});
