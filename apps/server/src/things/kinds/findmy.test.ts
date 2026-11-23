/**
 * A Find My connection's page and card (docs/decisions/findmy-connection.md): Find My is its first tab and names the
 * Mac, the card says how many people and how long ago or why not, and its one check starts off. Made-up names only.
 */
import { FIND_MY_TIMELINE_TAB, type HostFindMy } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { orderTabs, SUMMARY_TAB } from '../panels';
import { FIND_MY_CHECKS, FIND_MY_KIND, findMyGlanceLine, findMyNotices, findMyView } from './findmy';
import { KIND_MODULES } from './index';

const NOW = new Date('2026-11-23T10:00:00.000Z');
const read = (over: Partial<HostFindMy> = {}): HostFindMy => ({
  server: 'studio',
  reading: false,
  readAt: '2026-11-23T09:55:00.000Z',
  problem: null,
  people: ['Mara Visser', 'Ruben Visser', 'Noor Visser'].map((name, i) => ({
    id: `0123456789a${i}`,
    name,
    place: i === 2 ? null : 'Home',
    address: null,
    when: 'Now',
    nearby: false,
    location: null,
  })),
  exact: null,
  ...over,
});

describe('the Find My kind', () => {
  it('is registered, with one check that starts off', () => {
    expect(KIND_MODULES.findmy).toBe(FIND_MY_KIND);
    expect(FIND_MY_CHECKS.map((c) => [c.check, c.startsOn])).toEqual([['findmy.read', false]]);
  });

  it('opens on Find My, then the Timeline, tabs that name the Mac and have no panels of their own', () => {
    const view = findMyView('studio', read());
    expect(view.tabs).toEqual([
      { key: 'findmy', label: 'Find My', server: 'studio', panels: [] },
      { key: FIND_MY_TIMELINE_TAB, label: 'Timeline', server: 'studio', panels: [] },
    ]);
    expect(view.charts).toEqual([]);
    expect(view.readAt?.toISOString()).toBe('2026-11-23T09:55:00.000Z');
    expect(findMyView(null, null).tabs).toEqual([]);
  });

  it('opens on its map: the page puts Find My first and the Summary last', () => {
    const view = findMyView('studio', read());
    const summary = { ...SUMMARY_TAB, panels: [] };
    expect(orderTabs(summary, view.tabs, view.lead ?? null).map((t) => t.key)).toEqual([
      'findmy',
      FIND_MY_TIMELINE_TAB,
      'overview',
    ]);
    // Without a Mac there is no map to open on.
    expect(findMyView(null, null).lead).toBeUndefined();
  });

  it('says how many people and how long ago, never where', () => {
    const line = findMyGlanceLine(read(), NOW);
    expect(line).toContain('3 people');
    expect(line).toContain('5 min');
    expect(line).not.toContain('Home');
    expect(findMyGlanceLine(read({ readAt: '2026-11-23T09:59:40.000Z' }), NOW)).toContain('just now');
    expect(findMyGlanceLine(null, NOW)).toBe('Not read yet');
  });

  it('says the read’s problem in a few words, and as a line its check can quiet', () => {
    const failed = read({ problem: { code: 'in_use' } });
    expect(findMyGlanceLine(failed, NOW)).toContain('in use');
    const [notice] = findMyNotices(failed, 'Studio');
    expect(notice).toMatchObject({ check: 'findmy.read', nature: 'problem' });
    expect(findMyNotices(read(), 'Studio')).toEqual([]);
  });
});
