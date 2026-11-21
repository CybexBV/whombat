import type { HostGuest } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { serverGuestList, verdictDot } from './servers';

const guest = (over: Partial<HostGuest>): HostGuest => ({
  id: 'incus:web',
  serverId: 'thetitan',
  name: 'web',
  platform: 'incus',
  kind: 'container',
  image: 'debian',
  state: 'running',
  cpuPct: 1,
  memoryUsedMb: 512,
  memoryLimitMb: 1024,
  uptimeS: 3600,
  console: { available: true },
  ...over,
});

describe('a server’s machines on the phone', () => {
  const list = [
    guest({}),
    guest({ id: 'incus:ci-platform/ci-job-a8791974', name: 'ci-job-a8791974', project: 'ci-platform' }),
    guest({ id: 'incus:ci-platform/ci-template-linux', name: 'ci-template-linux', project: 'ci-platform' }),
    guest({ id: 'docker:postgres', name: 'postgres', platform: 'docker' }),
  ];

  it('leaves temporary machines out, with the row that shows them', () => {
    const hidden = serverGuestList(list, false);
    expect(hidden.rows.map((r) => r.name)).toEqual(['postgres', 'web']);
    expect(hidden.temporary).toEqual({
      text: expect.stringContaining('2 temporary machines'),
      button: 'Show',
    });
    const shown = serverGuestList(list, true);
    expect(shown.rows).toHaveLength(4);
    expect(shown.temporary?.button).toBe('Hide');
    expect(serverGuestList([guest({})], false).temporary).toBeNull();
  });

  it('draws a waiting verdict without a tone', () => {
    expect(verdictDot({ tone: 'mut' })).toBeNull();
    expect(verdictDot({ tone: 'bad' })).toBe('bad');
  });
});
