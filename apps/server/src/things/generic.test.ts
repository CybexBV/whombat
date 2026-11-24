/**
 * The page of a connection without a kind, in slots: how it answers Whombat's checks and its answer time per day; and
 * the machine card every page in slots gets (the known machine, the service's own figures, or its lines alone).
 */
import { describe, expect, it } from 'vitest';
import { genericSlots } from './generic';
import { slotProblems } from './kinds/slots';
import { bareView, slotCard } from './page';

const NOW = new Date('2026-11-04T15:00:00Z');
const TZ = 'Europe/Amsterdam';
const HOUR = 3600_000;

/** A check an hour for `hours` hours: `ms` answered, or null for one that failed. */
function checks(hours: number, ms: (h: number) => number | null) {
  return Array.from({ length: hours }, (_, i) => ({
    at: new Date(NOW.getTime() - i * HOUR),
    value: ms(i),
  })).reverse();
}

describe('the page of a connection without a kind', () => {
  it('says how it answers and its answer time per day, in slots', () => {
    // This week about 200 ms with two checks unanswered; the week before about 100 ms.
    const rtt = checks(14 * 24, (h) => (h === 5 || h === 30 ? null : h < 7 * 24 ? 200 : 100));
    const view = genericSlots({ status: 'active', glance: null }, rtt, NOW, TZ);
    expect(slotProblems(view)).toEqual([]);
    const [answers, week] = view.panels;
    expect(answers?.kind === 'list' && answers.items.map((i) => [i.title, i.figure])).toEqual([
      ['Answers', { value: '98.8 %', note: 'Didn’t answer for 2 h', tone: 'warn' }],
      ['Answers in', { value: '200 ms', note: '+100 % on last week' }],
    ]);
    expect(week?.kind === 'chart' && week.series[0]?.values).toEqual([200, 200, 200, 200, 200, 200, 200]);
    expect(week?.kind === 'chart' && week.stats?.[0]?.[0]).toMatchObject({ text: '+100 %' });
  });

  it('takes whether its checks answered from `up` once there are such points', () => {
    // Older hours by their response time; the last day by `up`, where two hours answered half the time.
    const rtt = checks(7 * 24, () => 200);
    const up = checks(24, (h) => (h === 3 || h === 4 ? 0.5 : 1));
    const view = genericSlots({ status: 'active', glance: null }, rtt, NOW, TZ, up);
    const [answers] = view.panels;
    expect(answers?.kind === 'list' && answers.items[0]?.figure).toMatchObject({
      value: '99.4 %',
      tone: 'warn',
    });
  });

  it('leaves out what it has no readings for, and says when it is signed out', () => {
    expect(genericSlots({ status: 'active', glance: null }, [], NOW, TZ).panels).toEqual([]);
    // Today's checks only: no Trend yet, and no change without a week before.
    const day = genericSlots(
      { status: 'needs_reauth', glance: null },
      checks(10, () => 150),
      NOW,
      TZ,
    );
    expect(day.panels.map((p) => p.id)).toEqual(['answers']);
    const [answers] = day.panels;
    expect(answers?.kind === 'list' && answers.items.map((i) => i.figure)).toEqual([
      { value: '100 %', note: 'Signed out', tone: 'bad' },
      { value: '150 ms' },
    ]);
  });

  it('says when Whombat last used it, also before any check answered', () => {
    const used = genericSlots(
      { status: 'active', glance: null, lastUsedAt: new Date(NOW.getTime() - 3 * HOUR) },
      [],
      NOW,
      TZ,
    );
    expect(slotProblems(used)).toEqual([]);
    const [panel] = used.panels;
    expect(panel?.kind === 'list' && panel.items.map((i) => [i.id, i.figure?.value])).toEqual([
      ['last-used', '3 h ago'],
    ]);
    const never = genericSlots({ status: 'active', glance: null, lastUsedAt: null }, [], NOW, TZ);
    expect(never.panels[0]?.kind === 'list' && never.panels[0].items[0]?.figure?.value).toBe('Not yet');
  });

  it('takes a kind whose read gave nothing for one without a kind', () => {
    expect(bareView({ panels: [], charts: [] })).toBe(true);
    expect(bareView({ panels: [], kpis: [{ key: 'a', label: 'A', value: '1' }] })).toBe(false);
    expect(bareView({ panels: [], slots: { machine: [] } })).toBe(false);
  });
});

describe('the machine card in slots', () => {
  const version = [{ id: 'version', label: 'Version', value: '6.1.2' }];
  const figures = {
    cores: 4,
    series: null,
    cpuPct: 12,
    memoryUsedGb: 4,
    memoryTotalGb: 16,
    diskUsedGb: 920,
    diskTotalGb: 1000,
  };

  it('is the machine Whombat knows, linked to its page', () => {
    const card = slotCard(
      { machine: version },
      { figures, at: { name: 'nas', href: '/servers/nas' } },
      null,
      NOW,
      'X',
    );
    expect(card).toMatchObject({ title: 'The machine', meta: 'nas', link: { href: '/servers/nas' } });
    expect(card?.kind === 'bars' && card.items.map((i) => i.id)).toEqual([
      'cpu',
      'memory',
      'disk',
      'version',
    ]);
    expect(card?.kind === 'bars' && card.items[2]?.tone).toBe('bad');
  });

  it('is the service’s own figures without a link when it is itself the machine', () => {
    const card = slotCard(
      { machine: version, own: { figures, name: 'DS920+' } },
      null,
      null,
      NOW,
      'Synology',
    );
    expect(card).toMatchObject({ title: 'The machine', meta: 'DS920+' });
    expect(card && 'link' in card && card.link).toBeFalsy();
  });

  it('is the service itself with only its lines when Whombat knows no machine', () => {
    const card = slotCard({ machine: version }, null, null, NOW, 'Protect');
    expect(card).toMatchObject({
      kind: 'bars',
      id: 'machine',
      title: 'Protect itself',
      span: 1,
      place: 'chart',
    });
    expect(card?.kind === 'bars' && card.items).toEqual(version);
    expect(slotCard({ machine: [] }, null, null, NOW, 'Protect')).toBeNull();
  });
});
