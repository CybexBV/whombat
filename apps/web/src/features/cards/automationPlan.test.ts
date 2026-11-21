import type { AutomationPlanView } from '@whombat/core';
import type { AutomationSample } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import {
  CHANGE_MARKS,
  cardSections,
  newestSample,
  planCardWords,
  planSettledLine,
  planWhen,
  sampleBody,
  tryItLabel,
} from './automationPlan';

const TZ = 'Europe/Amsterdam';
// Wednesday 23 September 2026, 11:22 in Amsterdam.
const NOW = new Date('2026-09-23T09:22:00Z');

const plan = (over: Partial<AutomationPlanView> = {}) => ({
  state: 'waiting' as const,
  change: false,
  name: 'New Fusebox issues',
  decidedAt: null,
  ...over,
});

describe('the plan card’s words', () => {
  it('names a new automation and a change, and what the buttons say for each', () => {
    const fresh = planCardWords(plan(), 'Dusty');
    expect(fresh.status).toBe('NEW AUTOMATION · WAITING FOR YOU');
    expect(fresh.tone).toBe('warn');
    expect([fresh.accept, fresh.decline]).toEqual(['Turn it on', 'Not now']);
    expect(fresh.prompts).toContain('Dusty');

    const change = planCardWords(plan({ change: true }), 'Dusty');
    expect(change.status).toBe('CHANGE · WAITING FOR YOU');
    expect([change.accept, change.decline]).toEqual(['Use this version', 'Keep the old one']);
  });

  it('says how a decided plan ended in its label', () => {
    expect(planCardWords(plan({ state: 'accepted' }), 'Dusty')).toMatchObject({
      status: 'NEW AUTOMATION · TURNED ON',
      tone: 'ok',
    });
    expect(planCardWords(plan({ state: 'replaced', change: true }), 'Dusty')).toMatchObject({
      status: 'CHANGE · REPLACED BY A NEWER PLAN',
      tone: 'neutral',
    });
    expect(planCardWords(plan({ state: 'gone' }), 'Dusty').tone).toBe('neutral');
  });

  it('shows every row for a new automation; for a change only what asks first and its limits', () => {
    const sections = (['when', 'does', 'asks', 'posts', 'limits'] as const).map((id) => ({ id }));
    expect(cardSections({ change: false, sections }).map((s) => s.id)).toEqual([
      'when',
      'does',
      'asks',
      'posts',
      'limits',
    ]);
    expect(cardSections({ change: true, sections }).map((s) => s.id)).toEqual(['asks', 'limits']);
  });

  it('marks what a change removes with a minus sign, never a hyphen', () => {
    expect(CHANGE_MARKS.added.mark).toBe('+');
    expect(CHANGE_MARKS.removed.mark).toBe('−');
    expect(CHANGE_MARKS.changed.mark).toBe('~');
  });
});

describe('the line a plan settles into', () => {
  const opts = { decider: null, timeZone: TZ, now: NOW };

  it('says who turned it on and when', () => {
    const line = planSettledLine(plan({ state: 'accepted', decidedAt: '2026-09-21T12:02:00Z' }), opts);
    expect(line).toEqual({ lead: 'You turned on “New Fusebox issues”', detail: 'Mon 14:02', tone: 'ok' });
    expect(
      planSettledLine(plan({ state: 'accepted', change: true, decidedAt: null }), {
        ...opts,
        decider: 'Mara',
      }).lead,
    ).toBe('Mara turned on this change to “New Fusebox issues”');
  });

  it('reads not now, replaced and deleted quietly', () => {
    expect(planSettledLine(plan({ state: 'declined' }), opts)).toMatchObject({
      lead: 'Not now: “New Fusebox issues”',
      tone: 'mut',
    });
    expect(planSettledLine(plan({ state: 'replaced' }), opts)).toMatchObject({
      lead: 'Replaced by a newer plan',
      tone: 'mut',
    });
    expect(planSettledLine(plan({ state: 'gone' }), opts).lead).toBe('“New Fusebox issues” was deleted');
  });

  it('gives the clock today, the weekday this week and the date before that', () => {
    expect(planWhen('2026-09-23T07:05:00Z', NOW, TZ)).toBe('09:05');
    expect(planWhen('2026-09-18T07:05:00Z', NOW, TZ)).toBe('Fri 09:05');
    expect(planWhen('2026-09-02T07:05:00Z', NOW, TZ)).toBe('2 Sep');
  });
});

describe('Try it', () => {
  const issue = (number: number, openedAt: string): AutomationSample => ({
    kind: 'issue',
    repo: 'acme/web',
    number,
    title: 'A bug',
    author: null,
    url: `https://github.com/acme/web/issues/${number}`,
    draft: false,
    openedAt,
  });
  const report: AutomationSample = {
    kind: 'report',
    connectionId: 'con_tracker',
    reportId: '6f1c2a10-3b4d-4c5e-8f60-71a2b3c4d515',
    number: 15,
    title: 'It breaks',
    type: 'bug',
    organization: null,
    openedAt: '2026-09-23T08:00:00Z',
  };

  it('picks the newest sample, whatever order they come in', () => {
    const samples = [
      issue(10, '2026-09-20T08:00:00Z'),
      issue(12, '2026-09-22T08:00:00Z'),
      issue(11, '2026-09-21T08:00:00Z'),
    ];
    expect(newestSample(samples)?.number).toBe(12);
    expect(newestSample([])).toBeNull();
    expect(newestSample(undefined)).toBeNull();
  });

  it('says what it runs on, and has no button without a sample', () => {
    expect(tryItLabel('now', null)).toBe('Try it now');
    expect(tryItLabel('sample', issue(12, '2026-09-22T08:00:00Z'))).toBe('Try it on #12');
    expect(tryItLabel('sample', null)).toBeNull();
  });

  it('sends an issue by its number and a report by its id', () => {
    expect(sampleBody(issue(12, '2026-09-22T08:00:00Z'))).toEqual({ number: 12 });
    expect(sampleBody(report)).toEqual({ reportId: report.reportId });
  });
});
