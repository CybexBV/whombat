/** Worth a look on the final connection page: current problems first, heads-ups folded and uncounted. */
import type { ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { foldHeadsUps, noticesBadge, problemsFirst } from './thingPage';

const n = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, title: id, tone: 'warn', nature: 'problem', ...over }) as never;

describe('Worth a look (overview-server-connection-final.md)', () => {
  const items = [
    n('disk'),
    n('update', { nature: 'fyi', tone: 'info', action: { label: 'See updates' } }),
    n('battery', { nature: 'fyi', tone: 'info' }),
    n('modbus', { tone: 'bad' }),
    n('old', { quiet: { state: 'acknowledged' } }),
  ];

  it('shows the current problems and folds every heads-up, one with a button too', () => {
    const g = foldHeadsUps(items);
    expect(g.shown.map((x: { id: string }) => x.id)).toEqual(['disk', 'modbus']);
    expect(g.folded.map((x: { id: string }) => x.id)).toEqual(['update', 'battery', 'old']);
    expect(g.foldLabel).toContain('2 heads-ups');
    expect(g.foldLabel).toContain('1 ignored');
  });

  it('doesn’t count the heads-ups', () => {
    const panel = { kind: 'notices', id: 'worth', items } as unknown as Extract<
      ThingPagePanel,
      { kind: 'notices' }
    >;
    expect(noticesBadge(panel)?.text).toBe('2');
  });

  it('puts Worth a look before the controls, the rest in their order', () => {
    const panels = [
      { kind: 'controls', id: 'controls' },
      { kind: 'kpis', id: 'figures' },
      { kind: 'notices', id: 'worth' },
    ] as unknown as ThingPagePanel[];
    expect(problemsFirst(panels).map((p) => p.id)).toEqual(['worth', 'controls', 'figures']);
    expect(problemsFirst(panels.slice(1)).map((p) => p.id)).toEqual(['figures', 'worth']);
  });
});
