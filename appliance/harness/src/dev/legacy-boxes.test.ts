import { describe, expect, it } from 'vitest';
import { legacyBoxes } from './legacy-boxes.ts';

describe('which Whombats still need the old Hetzner repository (R2 B1)', () => {
  it('goes by where each box’s release is listed, not by how many boxes there are', () => {
    const hetzner = ['whombat-20261001.1', 'whombat-20261002.1'];
    const github = ['whombat-dev-20261119.9', 'whombat-20261120.1'];
    const v = legacyBoxes(
      [
        // Home after its move: on production control, its release from GitHub.
        { device: 'wb-home', state: 'claimed', name: 'Home', status: { release: 'whombat-20261120.1' } },
        {
          device: 'wb-pilot',
          state: 'claimed',
          name: 'Pilot',
          status: { release: 'whombat-20261002.1', managerVersion: '0.270.0' },
        },
        { device: 'wb-quiet', state: 'claimed', name: null, status: null },
        { device: 'wb-other', state: 'registered', status: { release: 'whombat-20260901.4' } },
        { device: 'wb-gone', state: 'retired', status: { release: 'whombat-20261001.1' } },
      ],
      hetzner,
      github,
    );
    expect(v.github).toBe(1);
    expect(v.legacy).toEqual([
      { device: 'wb-pilot', name: 'Pilot', release: 'whombat-20261002.1', managerVersion: '0.270.0' },
    ]);
    expect(v.unknown.map((u) => u.device)).toEqual(['wb-quiet', 'wb-other']);
    // Home alone, on GitHub: the old repository may go although the fleet isn't empty.
    expect(
      legacyBoxes(
        [{ device: 'wb-home', state: 'claimed', status: { release: 'whombat-20261120.1' } }],
        hetzner,
        github,
      ),
    ).toEqual({ legacy: [], unknown: [], github: 1 });
  });
});
