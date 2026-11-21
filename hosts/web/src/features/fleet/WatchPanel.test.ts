import { describe, expect, it } from 'vitest';
import type { Hint } from '../../api/types';
import { groupHints } from './WatchPanel';

const h = (server: string, kind: string, detail = '', severity: Hint['severity'] = 'info'): Hint => ({ server, kind, severity, entity: 'host', title: kind, detail, link: '' });

describe('groupHints', () => {
  it('folds routine hints of several hosts into one row per kind', () => {
    const { rows, groups } = groupHints([
      h('a', 'sensor.near_limit', '', 'warning'),
      h('a', 'system.updates', '2 security updates · From apt'),
      h('b', 'system.updates', 'From apt'),
      h('b', 'system.reboot', 'Kernel'),
      h('c', 'system.updates', '1 security update · From dnf'),
    ]);
    expect(rows.map((r) => `${r.server}/${r.kind}`)).toEqual(['a/sensor.near_limit', 'b/system.reboot']);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe('Updates on 3 hosts');
    expect(groups[0]?.note).toBe('2 with security updates');
  });
});
