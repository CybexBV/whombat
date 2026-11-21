import { describe, expect, it } from 'vitest';
import type { HomeSection } from './sections';
import { connectionsTabs } from './tabs';

const server = (status: string) => ({ status }) as never;
const row = (tone: string) => ({ tone }) as never;

describe('Connections’ tabs (CN-11)', () => {
  const sections: HomeSection[] = [
    { kind: 'needsYou', count: 1, items: [], rows: [] },
    { kind: 'servers', servers: [server('ok'), server('offline'), server('warn')] },
    { kind: 'things', rows: [row('ok'), row('learning'), row('warn')], add: true },
    { kind: 'panels', widgets: [{} as never] },
  ];

  it('counts each and marks the worst', () => {
    const tabs = connectionsTabs(sections);
    expect(tabs.map((t) => [t.key, t.count, t.tone])).toEqual([
      ['servers', 3, 'bad'],
      ['services', 3, 'warn'],
      ['pinned', 1, null],
    ]);
    expect(tabs[1]?.spoken).toContain('Connections, 3');
  });

  it('leaves out what isn’t there and learning isn’t trouble', () => {
    const tabs = connectionsTabs([{ kind: 'things', rows: [row('learning')], add: false }]);
    expect(tabs.map((t) => [t.key, t.tone])).toEqual([['services', null]]);
  });

  it('says whether what a section holds is broken or only needs a look', () => {
    const tabs = connectionsTabs([{ kind: 'things', rows: [row('bad')], add: false }]);
    expect(tabs[0]?.tone).toBe('bad');
    expect(tabs[0]?.spoken).toContain('isn’t working');
    expect(connectionsTabs(sections)[1]?.spoken).toContain('needs a look');
  });
});
