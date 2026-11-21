/**
 * A service's slots on the web (service-slots-web.md): which lines the Worth a look strip shows and its colour, how many
 * pictures a shelf's row holds, a person's initial and tone, a labelled bar's words, a chart's own words under its
 * points, and the range picker leaving a page whose only chart has them.
 */
import type { ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { type ChartPanel, chartModel } from './chartModel';
import { rangeInTabRow } from './figures';
import {
  labelledBarWords,
  personInitial,
  personTone,
  shelfFit,
  shelfTag,
  stripLines,
  stripTone,
} from './slots';

const AT = '2026-11-04T10:00:00.000Z';

const notice = (id: string, over: Partial<ThingPageNotice> = {}): ThingPageNotice => ({
  id,
  tone: 'warn',
  icon: 'info',
  title: id,
  ...over,
});

describe('the Worth a look strip (SLT-08)', () => {
  it('puts what is wrong now first, the worst first, the heads-ups folded and uncounted, quiet lines last', () => {
    const items = [
      notice('fyi', { nature: 'fyi', tone: 'info' }),
      notice('quiet', { quiet: { state: 'ignored', words: 'Ignored by you', at: AT } }),
      notice('only-you', { nature: 'you' }),
      notice('problem', { nature: 'problem', tone: 'bad' }),
      notice('fyi2', { nature: 'fyi', tone: 'info' }),
      notice('fyi3', { nature: 'fyi', tone: 'info' }),
    ];
    const s = stripLines(items);
    expect(s.now.map((n) => n.id)).toEqual(['problem', 'only-you']);
    expect(s.soon.map((n) => n.id)).toEqual(['fyi', 'fyi2', 'fyi3']);
    expect(s.lines.map((n) => n.id)).toEqual(['problem', 'only-you', 'fyi', 'fyi2', 'fyi3', 'quiet']);
    // Folded: what is wrong now and a quiet line stay in sight; no heads-up until asked for.
    expect(s.shown.map((n) => n.id)).toEqual(['problem', 'only-you', 'quiet']);
    expect(s.more).toBe(0);
    expect(s.asking.map((n) => n.id)).toEqual(['only-you', 'problem']);
    const many = Array.from({ length: 7 }, (_, i) => notice(`p${i}`, { nature: 'problem' }));
    expect(stripLines(many).more).toBe(2);
    expect(stripLines([]).lines).toEqual([]);
  });

  it('takes the colour of its most serious line that isn’t quiet', () => {
    expect(stripTone([notice('a', { tone: 'info' }), notice('b', { tone: 'warn' })])).toBe('warn');
    expect(stripTone([notice('a', { tone: 'bad' }), notice('b', { tone: 'warn' })])).toBe('bad');
    expect(stripTone([notice('a', { tone: 'info' })])).toBe('info');
    expect(
      stripTone([notice('a', { tone: 'bad', quiet: { state: 'snoozed', words: 'Snoozed', at: AT } })]),
    ).toBe('quiet');
  });
});

describe('the shelf (SLT-04)', () => {
  it('holds as many as fit in one row: eight on a 1440 px page, fewer when narrower, never more than there are', () => {
    // The Summary's inner width at 1440 px less the card's padding.
    expect(shelfFit(1062, 12)).toBe(8);
    expect(shelfFit(400, 12)).toBe(3);
    expect(shelfFit(80, 12)).toBe(1);
    expect(shelfFit(1062, 5)).toBe(5);
    expect(shelfFit(0, 12)).toBe(8);
    expect(shelfFit(1062, 0)).toBe(0);
  });

  it('tags a picture with the person’s own words, else their name', () => {
    expect(shelfTag({ name: 'Anna', note: 'Anna asked' })).toBe('Anna asked');
    expect(shelfTag({ name: 'Anna' })).toBe('Anna');
  });
});

describe('people (SLT-05)', () => {
  it('draws a person by their first letter on the same tone wherever they appear', () => {
    expect(personInitial('anna')).toBe('A');
    expect(personInitial('Kids’ room')).toBe('K');
    expect(personInitial('“Élise”')).toBe('É');
    expect(personTone('Anna')).toBe(personTone('anna'));
    const tones = new Set(['Anna', 'John', 'Sam', 'Mara', 'Sanne', 'Kids’ room'].map(personTone));
    expect([...tones].every((t) => t >= 1 && t <= 5)).toBe(true);
    expect(tones.size).toBeGreaterThan(1);
  });
});

describe('a chart with its own words (SLT-06)', () => {
  const week: ChartPanel = {
    kind: 'chart',
    id: 'week',
    place: 'chart',
    title: 'This week',
    style: 'bars',
    timestamps: Array.from({ length: 3 }, (_, i) => new Date(Date.UTC(2026, 10, 2 + i)).toISOString()),
    labels: ['Mon', 'Tue', 'Today'],
    series: [{ key: 'plays', label: 'Plays', values: [4, 6, 7] }],
  };

  it('says a bar’s day and value, with the series’ name for a bare count', () => {
    expect(labelledBarWords('Thu', '5', 'Plays', null)).toBe('Thu · 5 plays');
    expect(labelledBarWords('Today', '3 h', 'Watched', 'h')).toBe('Today · 3 h');
  });

  it('puts its words under the points and in the tooltip instead of times', () => {
    const m = chartModel(week, 'Europe/Amsterdam');
    expect(m.ticks).toEqual([
      { index: 0, label: 'Mon' },
      { index: 1, label: 'Tue' },
      { index: 2, label: 'Today' },
    ]);
    expect(m.pointLabel(1)).toBe('Tue');
  });

  it('keeps out of the page’s range picker', () => {
    const cpu: ThingPagePanel = { ...week, id: 'cpu', labels: undefined };
    expect(rangeInTabRow([week])).toBe(false);
    expect(rangeInTabRow([week, cpu])).toBe(true);
  });
});
