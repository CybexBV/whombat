/**
 * The slots' builders and their check (docs/decisions/service-slots.md): each builder gives its slot's kind, look,
 * place and width; `slotPanels` orders them; `slotProblems` says what is out of place.
 */
import type { ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  addedNote,
  countByDay,
  countLine,
  daysWith,
  inventory,
  lastDays,
  liveRows,
  people,
  pointsByDay,
  shelf,
  slotPanels,
  slotProblems,
  trend,
  weekChange,
} from './slots';

const NOW = new Date('2026-11-04T15:00:00Z');
const TZ = 'Europe/Amsterdam';

function full() {
  const days = lastDays(NOW, TZ);
  return slotPanels({
    live: liveRows({ id: 'queue', title: 'Downloading now', items: [], empty: 'Nothing downloads.' }),
    inventory: inventory({
      id: 'cats',
      title: 'Categories',
      items: [countLine({ id: 'tv', title: 'TV', value: '12', note: '+3 this week', noteTone: 'ok' })],
    }),
    shelf: shelf({ id: 'done', title: 'Finished today', items: [] }),
    trend: trend({
      id: 'week',
      title: 'This week',
      days,
      values: [1, 2, 3, 4, 5, 6, 7],
      label: 'Downloads',
      figure: { value: '28', rest: 'downloads this week' },
      change: weekChange(28, 20),
    }),
    people: people({
      title: 'Who asks',
      items: [
        { name: 'Anna', n: 4 },
        { name: 'Sam', n: 2 },
      ],
      unit: ['request'],
    }),
    more: [{ kind: 'list', id: 'failed', title: 'Failed', items: [] }],
    machine: [{ id: 'version', label: 'SABnzbd', value: '4.5', pct: null }],
  });
}

describe('service slots', () => {
  it('gives every slot its look, place and width, in order, with the kind’s own panels after them', () => {
    const view = full();
    expect(view.panels.map((p) => [p.id, p.kind, p.place, p.span ?? null])).toEqual([
      ['queue', 'gallery', 'chart', 2],
      ['cats', 'list', 'chart', 1],
      ['done', 'gallery', 'chart', 3],
      ['week', 'chart', 'chart', 1],
      ['people', 'bars', 'chart', 1],
      ['failed', 'list', 'main', null],
    ]);
    expect(view.slots?.machine.map((b) => b.label)).toEqual(['SABnzbd']);
    expect(slotProblems(view)).toEqual([]);
  });

  it('words a count for clients with and without counts, people against the busiest, the week’s days', () => {
    const line = countLine({ id: 'x', title: 'Movies', value: '1,284', ...addedNote(9) });
    expect([line.right, line.figure]).toEqual([
      '1,284',
      { value: '1,284', note: '+9 this week', tone: 'ok' },
    ]);
    expect(addedNote(1, ['episode', 'episodes'])?.note).toBe('+1 episode');
    expect(addedNote(0)?.note).toBe('Nothing new');
    const p = full().panels.find((x) => x.id === 'people') as Extract<ThingPagePanel, { kind: 'bars' }>;
    expect(p.items.map((b) => [b.label, b.value, b.pct, b.person])).toEqual([
      ['Anna', '4 requests', 1, true],
      ['Sam', '2 requests', 0.5, true],
    ]);
    expect(people({ title: 'Nobody', items: [] })).toBeNull();
    const days = lastDays(NOW, TZ);
    expect(days.labels.at(-1)).toBe('Today');
    expect(days.labels.at(-2)).toBe('Tue');
    expect(countByDay([NOW, NOW, new Date(NOW.getTime() - 86_400_000)], days.keys, TZ)).toEqual([
      0, 0, 0, 0, 0, 1, 2,
    ]);
    expect([weekChange(28, 20), weekChange(5, 10), weekChange(3, 0)]).toEqual(['+40 %', '−50 %', null]);
  });

  it('says what is out of place', () => {
    const view = full();
    const [live, inv, ...rest] = view.panels;
    const swapped = { ...view, panels: [inv, live, ...rest] as ThingPagePanel[] };
    expect(slotProblems(swapped)).toContain('queue (live) is out of order');
    const wide = { ...view, panels: view.panels.map((p) => (p.id === 'cats' ? { ...p, span: 2 } : p)) };
    expect(slotProblems(wide)).toContain('cats (inventory) spans 2, not 1');
    expect(slotProblems({ ...view, slots: undefined })).toContain('the view doesn’t say it is in slots');
    expect(slotProblems({ ...view, kpis: [{ key: 'a', label: 'A', value: '1' }] })).toHaveLength(1);
    const strip = {
      ...view,
      panels: [
        { kind: 'notices', id: 'n', title: 'Worth a look', items: [] },
        ...view.panels,
      ] as ThingPagePanel[],
    };
    expect(slotProblems(strip)).toContain('n: Worth a look is the page’s own strip');
    const chart = trend({
      id: 'speed',
      title: 'Speed',
      days: lastDays(NOW, TZ, 2),
      values: [1, 2],
      label: 'MB/s',
      figure: { value: '2' },
    });
    expect(slotProblems({ ...view, charts: [chart] })).toEqual([
      'speed is a chart card: in slots it goes in more',
    ]);
    const loose = { ...view, panels: [...view.panels, { ...chart, labels: undefined, id: 'loose' }] };
    expect(slotProblems(loose)).toContain("loose sits in the slots' rows but fills no slot");
  });

  it('turns Whombat’s own readings into days, each day’s last, sum, max or mean', () => {
    const days = lastDays(NOW, TZ, 3);
    const at = (h: number) => new Date(NOW.getTime() - h * 3600_000);
    const points = [
      { at: at(49), value: 10 },
      { at: at(48), value: 30 },
      { at: at(25), value: null },
      { at: at(1), value: 4 },
      { at: at(0), value: 2 },
    ];
    expect(pointsByDay(points, days.keys, TZ, 'last')).toEqual([30, null, 2]);
    expect(pointsByDay(points, days.keys, TZ, 'sum')).toEqual([40, null, 6]);
    expect(pointsByDay(points, days.keys, TZ, 'max')).toEqual([30, null, 4]);
    expect(pointsByDay(points, days.keys, TZ, 'mean')).toEqual([20, null, 3]);
    expect(daysWith([30, null, 2])).toBe(2);
  });

  it('marks a person with a colour and why', () => {
    const p = people({
      title: 'Who uses most space',
      items: [
        { name: 'Anna', n: 290, value: '290 GB', tone: 'warn', sub: 'Quota 300 GB' },
        { name: 'Ben', n: 40, value: '40 GB' },
      ],
    });
    expect(p?.items[0]).toMatchObject({ tone: 'warn', sub: 'Quota 300 GB', subTone: 'warn', person: true });
    expect(p?.items[1]?.tone).toBeUndefined();
    expect(p?.items[1]?.sub).toBeUndefined();
  });
});
