import { describe, expect, it } from 'vitest';
import { overviewHeadline } from './greeting';
import { OVERVIEW_WORDS } from './tabs';
import { readingsMoment, readingTime, readState } from './time';

const TZ = 'Europe/Amsterdam';
const NOW = Date.parse('2026-09-23T12:05:00Z'); // 14:05 in Amsterdam

describe('reading times (overview-server-connection-final.md)', () => {
  it('says how old each server’s own report is, or that its time is unknown', () => {
    expect(readingTime('2026-09-23T11:53:00Z', NOW, TZ)).toMatchObject({
      text: 'Read 12 min ago',
      known: true,
    });
    expect(readingTime('2026-09-23T11:53:00Z', NOW, TZ).exact).toContain('13:53');
    expect(readingTime(null, NOW, TZ)).toMatchObject({ text: 'Reading time unknown', known: false });
    expect(readingTime('not a time', NOW, TZ).known).toBe(false);
  });

  it('says the saved readings’ moment with its day', () => {
    expect(readingsMoment('2026-09-23T12:00:00Z', TZ)).toMatch(/^14:00 on 23 Sept?$/);
    expect(OVERVIEW_WORDS.savedFrom(readingsMoment('2026-09-23T12:00:00Z', TZ))).toContain('14:00');
  });

  it('keeps refreshing apart from a failed refresh, and both apart from a failed first read', () => {
    expect(readState({ hasData: false, error: null })).toBe('loading');
    expect(readState({ hasData: false, error: new Error('x') })).toBe('failed');
    expect(readState({ hasData: true, error: null, fetching: true })).toBe('refreshing');
    expect(readState({ hasData: true, error: new Error('x'), fetching: true })).toBe('saved');
    expect(readState({ hasData: true, error: null })).toBe('ready');
  });
});

describe('Overview’s first line', () => {
  const summary = { needsYou: 3, problems: 0 } as never;
  const broken = {
    id: 'ny_1',
    kind: 'problem' as const,
    severity: 'bad' as const,
    title: 'blackbox’s disk array failed.',
    body: 'Your files have no protection now.',
  };

  it('leads with the broken thing, its consequence and how many others need you', () => {
    const h = overviewHeadline({ summary, needsYou: [broken] as never });
    expect(h).toMatchObject({
      kind: 'broken',
      title: 'blackbox’s disk array failed',
      detail: 'Your files have no protection now.',
      itemId: 'ny_1',
      others: 2,
      busy: null,
    });
    expect(OVERVIEW_WORDS.others(2)).toBe('2 other things need you');
    expect(OVERVIEW_WORDS.others(1)).toBe('1 other thing needs you');
  });

  it('says the status sentence when nothing serious is open', () => {
    const h = overviewHeadline({ summary: { needsYou: 0, problems: 0 } as never, needsYou: [] });
    expect(h.kind).toBe('status');
  });
});
