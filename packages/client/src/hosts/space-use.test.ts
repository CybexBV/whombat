import type { HostGuest, HostVolume } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { spaceUse } from './space';

const guest = (id: string, gb: number | undefined, platform: HostGuest['platform'] = 'docker') =>
  ({ id, name: id, platform, kind: 'container', diskUsedGb: gb }) as unknown as HostGuest;
const volume = (usedGb: number) =>
  ({ entity: 'v', kind: 'pool', label: 'default', usedGb, totalGb: 1600, usedPct: 50 }) as HostVolume;

describe('spaceUse (service-settings.md SST-11)', () => {
  it('lists machines and apps biggest first, then the rest of one volume', () => {
    const use = spaceUse({
      guests: [guest('plex', 128), guest('vm1', 288, 'pve'), guest('tiny', 0.01)],
      volumes: [volume(1130)],
    });
    expect(use?.parts.map((p) => [p.label, p.kind, Math.round(p.gb)])).toEqual([
      ['vm1', 'machine', 288],
      ['plex', 'app', 128],
      ['Everything else', 'rest', 714],
    ]);
    expect(use?.totalGb).toBeCloseTo(1130, 0);
  });

  it('folds the rest after eight into “N more”, and says no rest over several volumes', () => {
    const many = Array.from({ length: 11 }, (_, i) => guest(`app${i}`, 100 - i));
    const use = spaceUse({ guests: many, volumes: [volume(2000), volume(100)] });
    expect(use?.parts).toHaveLength(9);
    expect(use?.parts.at(-1)?.label).toBe('3 more apps');
    expect(use?.parts.some((p) => p.kind === 'rest')).toBe(false);
  });

  it('is nothing when no disk is reported, and leaves temporary machines out', () => {
    expect(spaceUse({ guests: [guest('a', undefined)], volumes: [] })).toBeNull();
    expect(spaceUse({ guests: [guest('ci-job-12', 50)], volumes: [] })).toBeNull();
  });
});
