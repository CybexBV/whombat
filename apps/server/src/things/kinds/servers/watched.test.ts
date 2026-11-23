/**
 * A Proxmox VE or Unraid connection whose server Whombat watches: its page from the hosts service's own answers (the
 * sample data its fake serves: shale, a Proxmox node in a cluster; blackbox, an Unraid server), through Whombat's mappers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arr, guestsOfDetail, obj, toHostServer, toHostServerDetail } from '../../../hosts/map';
import { machineHref } from '../../runs-on';
import { slotProblems } from '../slots';
import { checked, panel } from '../storage/test-helpers';
import { type WatchedServer, watchedView } from './watched';

const FIXTURES = join(import.meta.dirname, '../../../hosts/testing/fixtures');
const raw = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
const now = new Date('2026-10-11T14:00:00Z');
const fleet = raw('fleet.json');

function server(
  id: string,
  file: string,
  change: (d: Record<string, unknown>) => void = () => {},
): WatchedServer {
  const card = arr(fleet.servers).find((s) => obj(s).id === id);
  const row = toHostServer(card, arr(fleet.alerts));
  const detailRaw = raw(file);
  change(detailRaw);
  const detail = toHostServerDetail(detailRaw, [], null, now);
  return {
    id,
    name: row.name,
    href: machineHref(id, null),
    row,
    detail,
    guests: guestsOfDetail(detail),
    readAt: now,
  };
}

describe('a Proxmox VE connection to a server Whombat watches', () => {
  const shale = server('shale', 'server-shale-proxmox.json');

  it('shows the server’s guests, what is on it and its system, with no lines of its own', () => {
    const v = checked(watchedView({ server: shale, now, timeZone: 'UTC', linked: true }));
    expect(slotProblems(v)).toEqual([]);
    expect(v.notices).toEqual([]);
    const live = panel(v, 'guests', 'gallery');
    expect(live?.title).toBe('Guests now');
    // The busiest first, each opening on the server's page.
    expect(live?.items[0]).toMatchObject({
      title: 'k3s-node-2',
      note: '44 % processor',
      progress: 0.44,
      href: machineHref('shale', 'pve:100'),
    });
    expect(live?.items.length).toBeLessThanOrEqual(6);
    const inv = panel(v, 'inventory', 'list');
    expect(inv?.title).toBe('On shale');
    expect(inv?.link).toBeUndefined();
    expect(inv?.items.map((i) => i.id)).toEqual([
      'vms',
      'containers',
      'storage-vmdata',
      'storage-pbs-01',
      'backups',
      'nodes',
    ]);
    const backups = inv?.items.find((i) => i.id === 'backups');
    expect(backups?.figure).toMatchObject({ value: '22 of 22', tone: 'ok' });
    expect(inv?.items.find((i) => i.id === 'nodes')?.figure).toMatchObject({
      value: '3',
      note: 'All online',
    });
    expect(inv?.items.find((i) => i.id === 'storage-vmdata')?.figure?.value).toBe('83 %');
    expect(v.slots?.own).toBeUndefined();
    expect(v.slots?.machine.map((b) => b.id)).toEqual(['system', 'up']);
    expect(v.facts[0]?.map((p) => p.text).join('')).toBe('Part of shale');
  });

  it('links the server from Inventory and draws its figures when the page doesn’t know it as the machine', () => {
    const v = checked(watchedView({ server: shale, now, timeZone: 'UTC', linked: false }));
    expect(panel(v, 'inventory', 'list')?.link).toEqual({
      kind: 'href',
      label: 'See shale',
      href: machineHref('shale', null),
    });
    expect(v.slots?.own?.name).toBe('shale');
    expect(v.slots?.own?.figures.cpuPct).not.toBeNull();
  });

  it('marks a failed backup and an offline node', () => {
    const broken = server('shale', 'server-shale-proxmox.json', (d) => {
      const backups = obj(d.backups);
      obj(backups.last_job).guests_ok = 20;
      const nodes = arr(obj(d.cluster).nodes);
      obj(nodes[2]).status = 'offline';
    });
    const inv = panel(
      checked(watchedView({ server: broken, now, timeZone: 'UTC', linked: true })),
      'inventory',
      'list',
    );
    expect(inv?.items.find((i) => i.id === 'backups')).toMatchObject({
      tone: 'bad',
      figure: { value: '20 of 22', tone: 'bad' },
      detail: expect.stringContaining('2 guests failed last time'),
    });
    expect(inv?.items.find((i) => i.id === 'nodes')?.figure).toMatchObject({
      note: '1 offline',
      tone: 'bad',
    });
  });
});

describe('an Unraid connection to a server Whombat watches', () => {
  const blackbox = server('blackbox', 'server-blackbox-unraid.json');

  it('shows its containers and VMs, the array, its pools and shares, and its Unraid version', () => {
    const DAY = 86_400_000;
    const space = [0, 1, 2].map((i) => ({
      at: new Date(now.getTime() - (2 - i) * DAY),
      value: 1200 + 4 * i,
    }));
    const v = checked(watchedView({ server: blackbox, now, timeZone: 'UTC', linked: true, space }));
    expect(slotProblems(v)).toEqual([]);
    expect(v.panels.map((p) => p.id)).toEqual(['guests', 'inventory', 'week']);
    const inv = panel(v, 'inventory', 'list');
    expect(inv?.title).toBe('On blackbox');
    // The two fullest of its three pools; storage, 93 % full, amber.
    expect(inv?.items.map((i) => i.id)).toEqual([
      'vms',
      'containers',
      'array',
      'pool-storage',
      'pool-data',
      'shares',
    ]);
    expect(inv?.items.find((i) => i.id === 'array')?.figure?.value).toBe('61 %');
    expect(inv?.items.find((i) => i.id === 'pool-storage')).toMatchObject({
      tone: 'warn',
      figure: { value: '93 %' },
    });
    expect(v.slots?.machine[0]).toMatchObject({ id: 'system', label: 'Unraid' });
    expect(v.notices).toEqual([]);
  });

  it('puts a parity check that runs first, and says the array is stopped', () => {
    const busy = server('blackbox', 'server-blackbox-unraid.json', (d) => {
      const array = obj(obj(d.unraid).array);
      Object.assign(obj(array.parity), {
        state: 'running',
        action: 'check',
        pct: 37,
        eta_s: 7200,
        errors: 0,
      });
    });
    const live = panel(
      checked(watchedView({ server: busy, now, timeZone: 'UTC', linked: true })),
      'guests',
      'gallery',
    );
    expect(live?.items[0]).toMatchObject({
      id: 'parity',
      title: 'Parity check',
      note: '37 %',
      noteEnd: 'about 2 h left',
    });
    const stopped = server('blackbox', 'server-blackbox-unraid.json', (d) => {
      Object.assign(obj(obj(d.unraid).array), { state: 'stopped', state_raw: 'STOPPED' });
    });
    const inv = panel(
      checked(watchedView({ server: stopped, now, timeZone: 'UTC', linked: true })),
      'inventory',
      'list',
    );
    expect(inv?.items.find((i) => i.id === 'array')).toMatchObject({
      tone: 'bad',
      figure: { value: 'Stopped' },
    });
  });
});
