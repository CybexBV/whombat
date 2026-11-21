import { describe, expect, it } from 'vitest';
import { loadPins } from '../manifest/pins.ts';
import { gateCoverage } from './gate-coverage.ts';

describe('root Go gate coverage', () => {
  it('covers backup and provisioning with the same root check without changing the pins', () => {
    const components = loadPins().components;
    expect([...gateCoverage(components, null)]).toEqual([
      ['appliance-backup:go-vet', { component: 'appliance-manager', gate: 'go-vet' }],
      ['appliance-backup:go-test', { component: 'appliance-manager', gate: 'go-test' }],
      ['appliance-provisioning:go-test', { component: 'appliance-manager', gate: 'go-test' }],
    ]);
    expect(components.find((c) => c.id === 'appliance-backup')?.gates).toHaveLength(2);
  });

  it('cannot cover a selected subset with an unselected root check', () => {
    expect(gateCoverage(loadPins().components, ['appliance-backup']).size).toBe(0);
    expect([
      ...gateCoverage(loadPins().components, ['appliance-manager:go-test', 'appliance-backup']),
    ]).toEqual([['appliance-backup:go-test', { component: 'appliance-manager', gate: 'go-test' }]]);
  });

  it('cannot cover different commits, repositories, flags, environment or timeouts', () => {
    for (const change of ['commit', 'repository', 'run', 'env', 'timeoutS']) {
      const components = structuredClone(loadPins().components);
      const backup = components.find((c) => c.id === 'appliance-backup');
      if (!backup) throw new Error('missing backup fixture');
      if (change === 'commit') backup.commit = '0'.repeat(40);
      if (change === 'repository') backup.repository = 'Whombat';
      for (const g of backup.gates) {
        if (change === 'run') g.run = [...g.run.slice(0, -1), '-race', './...'];
        if (change === 'env') g.env = { WB_REST_SERVER: '/different' };
        if (change === 'timeoutS') g.timeoutS = 1;
      }
      expect(
        [...gateCoverage(components, null).keys()].some((key) => key.startsWith('appliance-backup:')),
      ).toBe(false);
    }
  });
});
