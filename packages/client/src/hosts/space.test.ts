/** What uses a server's space and the Storage tab's tiles in words (Whombat service-settings.md SST-11). */
import type { HostDisk, HostGuest, HostServerDetail, HostVolume } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { createHostsWorld } from './fixtures';
import { diskHealth, spaceTiles, spaceUse } from './space';

const NOW = Date.parse('2026-11-04T10:00:00Z');
const world = createHostsWorld(NOW);
const base = [...world.details.values()][0] as HostServerDetail;
const someGuest = [...world.guests.values()].flat()[0] as HostGuest;

const guest = (id: string, name: string, platform: HostGuest['platform'], diskUsedGb: number): HostGuest => ({
  ...someGuest,
  id,
  name,
  platform,
  diskUsedGb,
});

const volume = (label: string, usedGb: number, totalGb: number, fullInDays: number | null): HostVolume => ({
  entity: `fs:${label}`,
  kind: 'pool',
  label,
  usedGb,
  totalGb,
  usedPct: (usedGb / totalGb) * 100,
  fullInDays,
});

const disk = (device: string, more: Partial<HostDisk> = {}): HostDisk => ({
  device,
  model: 'Samsung 990 Pro',
  wearPct: 4,
  tempC: 38,
  ...more,
});

const detail = (volumes: HostVolume[], disks: HostDisk[]): HostServerDetail => ({
  ...base,
  proxmox: undefined,
  health: { ...(base.health ?? {}), volumes } as HostServerDetail['health'],
  disks,
});

describe('spaceUse', () => {
  it('lists machines and apps biggest first, and the rest of one volume as Everything else', () => {
    const use = spaceUse({
      guests: [guest('a', 'plex', 'docker', 128), guest('b', 'homeassistant', 'pve', 288)],
      volumes: [volume('default', 1130, 1590, null)],
    });
    expect(use?.parts.map((p) => [p.label, p.kind, Math.round(p.gb)])).toEqual([
      ['homeassistant', 'machine', 288],
      ['plex', 'app', 128],
      ['Everything else', 'rest', 714],
    ]);
    expect(use?.totalGb).toBe(1130);
  });

  it('says nothing when no machine or app reports its disk', () => {
    expect(spaceUse({ guests: [guest('a', 'plex', 'docker', 0)], volumes: [] })).toBeNull();
  });
});

describe('spaceTiles', () => {
  it('says how full, when it fills up and the disks to watch, in words', () => {
    const tiles = spaceTiles({
      detail: detail(
        [volume('default', 1130, 1590, 150), volume('media', 7200, 21800, null)],
        [disk('nvme0'), disk('nvme1'), disk('sda', { health: 'wear_high' })],
      ),
      now: NOW,
      timeZone: 'Europe/Amsterdam',
    });
    expect(tiles.map((t) => [t.key, t.label, t.value, t.tone])).toEqual([
      ['space', 'Space', 'Plenty free', null],
      ['full', 'Full in', 'About 5 months', null],
      ['disks', 'Disks', '1 to watch', 'warn'],
    ]);
    expect(tiles[0]?.sub).toContain('‘default’');
    expect(tiles[1]?.sub).toBe('‘default’ first');
    expect(tiles[2]?.sub).toBe('2 healthy');
  });

  it('names a date when it is full within 60 days, and says so when nothing fills up', () => {
    const soon = spaceTiles({ detail: detail([volume('default', 1500, 1590, 20)], []), now: NOW });
    expect(soon.find((t) => t.key === 'full')).toMatchObject({ label: 'Full by', tone: 'warn' });
    expect(soon.find((t) => t.key === 'full')?.value).toMatch(/^About \d+ \w{3}$/);
    expect(soon.some((t) => t.key === 'disks')).toBe(false);
    const calm = spaceTiles({ detail: detail([volume('default', 100, 1590, null)], []), now: NOW });
    expect(calm.find((t) => t.key === 'full')?.value).toBe('Not filling up');
  });

  it('counts failing disks first', () => {
    expect(diskHealth(disk('sda', { smart: { passed: false } as HostDisk['smart'] })).text).toBe('Failing');
    const tiles = spaceTiles({
      detail: detail([], [disk('sda', { health: 'failing' }), disk('sdb')]),
      now: NOW,
    });
    expect(tiles.find((t) => t.key === 'disks')).toMatchObject({ value: '1 failing', tone: 'bad' });
  });
});
