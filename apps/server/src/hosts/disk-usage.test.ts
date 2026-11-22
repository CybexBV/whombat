import { api, catalogEntry, HostDiskUsage, HostServerDetail, SERVERS_TOOLS } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { toHostDiskUsage, toHostServerDetail } from './map';
import { SERVERS_TOOL_ARGS } from './tools';

describe('disk usage contract, mapping and tool schema', () => {
  it('registers server_disk_usage as a read tool with valid schema, guide and allowed args', () => {
    const tool = SERVERS_TOOLS.find((t) => t.name === 'server_disk_usage');
    expect(tool).toBeDefined();
    expect(tool?.access).toBe('read');
    expect(SERVERS_TOOL_ARGS.server_disk_usage).toEqual(['server', 'mount']);
    expect(`${tool?.title} ${tool?.description}`).not.toMatch(/'/);
    expect(tool?.description).toContain('spun_down');
    expect(tool?.description).toContain('standby_unknown');
    const guide = catalogEntry('whombat_servers')?.guide ?? '';
    expect(guide.length).toBeLessThanOrEqual(1500);
    expect(guide).toContain('server_disk_usage');
    expect(guide).not.toMatch(/'/);
    expect(api.hosts.diskUsage.method).toBe('POST');
  });

  it('maps hub disk_usage JSON onto HostDiskUsage and HostServerDetail', () => {
    const now = new Date('2026-11-21T18:00:00Z');
    const rawUsage = {
      server: 'basalt',
      ok: true,
      mount: '/var/lib/docker',
      fs_type: 'ext4',
      device: '/dev/nvme0n1p3',
      measured_at: '2026-11-21T17:55:00Z',
      duration_ms: 420,
      total_bytes: 200_000_000_000,
      used_bytes: 160_000_000_000,
      partial: true,
      categories: [
        {
          key: 'container_images',
          label: 'Container images',
          bytes: 45_000_000_000,
          reclaimable_bytes: 12_000_000_000,
          detail: '11 images, 3 unused',
        },
        { key: 'journal', label: 'System journal', bytes: 4_000_000_000 },
      ],
      folders: [{ path: '/var/lib/docker', bytes: 90_000_000_000, partial: true }],
    };

    const mapped = toHostDiskUsage(rawUsage, now);
    expect(HostDiskUsage.parse(mapped)).toMatchObject({
      mount: '/var/lib/docker',
      fsType: 'ext4',
      device: '/dev/nvme0n1p3',
      measuredAt: '2026-11-21T17:55:00Z',
      totalBytes: 200_000_000_000,
      usedBytes: 160_000_000_000,
      partial: true,
      ok: true,
    });
    expect(mapped.categories).toHaveLength(2);
    expect(mapped.categories[0]?.reclaimableBytes).toBe(12_000_000_000);
    expect(mapped.folders[0]).toEqual({ path: '/var/lib/docker', bytes: 90_000_000_000, partial: true });

    const detail = toHostServerDetail(
      {
        as_of: '2026-11-21T18:00:00Z',
        server: {
          id: 'basalt',
          group: 'homelab',
          status: 'online',
          detail_view: 'standard',
          agent: { connected: true },
          remote_control: { console: false, power: false, diagnose: true },
        },
        sensors: [],
        disks: [],
        hints: [],
        disk_usage: [rawUsage],
      },
      [],
      null,
      now,
    );
    expect(HostServerDetail.parse(detail).diskUsage).toHaveLength(1);
    expect(detail.diskUsage?.[0]?.mount).toBe('/var/lib/docker');
  });

  it('maps spun_down responses cleanly without throwing', () => {
    const now = new Date('2026-11-21T18:00:00Z');
    const mapped = toHostDiskUsage(
      {
        ok: false,
        code: 'spun_down',
        message: 'Skipped /mnt/disk1 because disk1 is spun down.',
        mount: '/mnt/disk1',
        measured_at: '2026-11-21T18:00:00Z',
        skipped_spun_down: ['disk1'],
        categories: [],
        folders: [],
      },
      now,
    );
    expect(HostDiskUsage.parse(mapped)).toMatchObject({
      ok: false,
      code: 'spun_down',
      skippedSpunDown: ['disk1'],
    });
  });

  it('maps standby_unknown responses without marking any disk spun down', () => {
    const now = new Date('2026-11-21T18:00:00Z');
    const mapped = toHostDiskUsage(
      {
        ok: false,
        code: 'standby_unknown',
        message:
          'Skipped / because its backing disks could not be identified, so Whombat cannot tell whether a disk is asleep.',
        mount: '/',
        measured_at: '2026-11-21T18:00:00Z',
        categories: [],
        folders: [],
      },
      now,
    );
    const parsed = HostDiskUsage.parse(mapped);
    expect(parsed).toMatchObject({
      ok: false,
      code: 'standby_unknown',
    });
    expect(parsed.skippedSpunDown).toBeUndefined();
  });
});
