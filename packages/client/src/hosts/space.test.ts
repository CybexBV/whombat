/** What uses a server's space and the Storage tab's tiles in words (Whombat service-settings.md SST-11). */
import type { HostDisk, HostGuest, HostServerDetail, HostVolume } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { createHostsWorld } from './fixtures';
import { diskHealth, diskUsageSkipNote, spaceTiles, spaceUse } from './space';

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

  it('replaces Everything else with a recent breakdown and records when it was measured', () => {
    const measuredAt = new Date(NOW - 10 * 60_000).toISOString();
    const use = spaceUse({
      guests: [guest('b', 'homeassistant', 'pve', 288), guest('a', 'plex', 'docker', 128)],
      volumes: [volume('/', 1130, 1590, null)],
      now: NOW,
      diskUsage: [
        {
          mount: '/',
          measuredAt,
          totalBytes: 1590e9,
          usedBytes: 1130e9,
          categories: [
            {
              key: 'container_images',
              label: 'Container images',
              bytes: 180e9,
              reclaimableBytes: 40e9,
              detail: '14 images, 4 unused',
            },
            { key: 'container_build_cache', label: 'Container build cache', bytes: 60e9 },
            { key: 'journal', label: 'System journal', bytes: 12e9 },
            // Already represented by the listed VM above, so omitted to avoid double-counting.
            { key: 'vm_disks', label: 'VM disks', bytes: 288e9 },
          ],
          folders: [
            // Overlaps Docker categories -> omitted.
            { path: '/var/lib/docker', bytes: 240e9 },
            // Separate large folder -> kept.
            { path: '/srv/backups', bytes: 320e9 },
          ],
        },
      ],
    });
    expect(use?.measuredAt).toBe(measuredAt);
    expect(use?.measuredMount).toBe('/');
    expect(use?.parts.map((p) => [p.label, p.kind, Math.round(p.gb)])).toEqual([
      ['homeassistant', 'machine', 288],
      ['plex', 'app', 128],
      ['/srv/backups', 'folder', 320],
      ['Container images', 'category', 180],
      ['Container build cache', 'category', 60],
      ['System journal', 'category', 12],
      ['Other', 'rest', 142],
    ]);
    expect(use?.parts.find((p) => p.id === 'cat:container_images')?.detail).toContain('reclaimable');
  });

  it('ignores stale breakdowns older than 24 h and falls back to Everything else', () => {
    const staleAt = new Date(NOW - 25 * 60 * 60_000).toISOString();
    const use = spaceUse({
      guests: [guest('b', 'homeassistant', 'pve', 288)],
      volumes: [volume('/', 1130, 1590, null)],
      now: NOW,
      diskUsage: [
        {
          mount: '/',
          measuredAt: staleAt,
          totalBytes: 1590e9,
          usedBytes: 1130e9,
          categories: [{ key: 'journal', label: 'System journal', bytes: 50e9 }],
          folders: [],
        },
      ],
    });
    expect(use?.measuredAt).toBeUndefined();
    expect(use?.parts.map((p) => p.label)).toEqual(['homeassistant', 'Everything else']);
  });

  it('shows a recent breakdown even on servers with no guest disk figures', () => {
    const measuredAt = new Date(NOW - 5 * 60_000).toISOString();
    const use = spaceUse({
      guests: [],
      volumes: [volume('/', 200, 500, null)],
      now: NOW,
      diskUsage: [
        {
          mount: '/',
          measuredAt,
          totalBytes: 500e9,
          usedBytes: 200e9,
          partial: true,
          categories: [
            { key: 'vm_disks', label: 'VM disks', bytes: 90e9 },
            { key: 'package_cache', label: 'Package caches', bytes: 5e9, detail: 'apt' },
          ],
          folders: [{ path: '/srv/media', bytes: 80e9 }],
        },
      ],
    });
    expect(use?.partial).toBe(true);
    expect(use?.parts.map((p) => [p.label, p.kind])).toEqual([
      ['VM disks', 'category'],
      ['/srv/media', 'folder'],
      ['Package caches', 'category'],
      ['Other', 'rest'],
    ]);
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

describe('diskUsageSkipNote', () => {
  it('returns null when the scan ran, and reports the true skip reason otherwise', () => {
    expect(diskUsageSkipNote({ ok: true })).toBeNull();
    expect(
      diskUsageSkipNote({
        ok: false,
        code: 'standby_unknown',
        message: 'Skipped / because its backing disks could not be identified.',
      }),
    ).toBe('Skipped / because its backing disks could not be identified.');
    const unknownFallback = diskUsageSkipNote({ ok: false, code: 'standby_unknown' });
    expect(unknownFallback).toContain('can’t tell');
    expect(unknownFallback).not.toContain('spun down');
    expect(diskUsageSkipNote({ ok: false, code: 'spun_down', skippedSpunDown: ['disk1'] })).toContain(
      'disk1',
    );
    expect(diskUsageSkipNote({ ok: false, code: 'spun_down' })).toContain('asleep');
    expect(diskUsageSkipNote({ ok: false, code: 'failed' })).toContain('Could not check');
  });
});
