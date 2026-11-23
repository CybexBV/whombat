/** Proxmox VE's page from its API, when Whombat doesn't watch the server, and its health pass either way. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import { slotProblems } from '../slots';
import { checked, fakeServices, panel } from '../storage/test-helpers';
import { PVE_CLUSTER_RESOURCES, PVE_NOT_BACKED_UP, PVE_RESOURCES, PVE_VERSION } from './fixtures/proxmox';
import {
  PROXMOX_CHECKS,
  PROXMOX_KIND,
  parseNotBackedUp,
  parseResources,
  proxmoxNotices,
  proxmoxSkipped,
  proxmoxView,
  versionOf,
} from './proxmox';

const http = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('../../../connections/http', async (orig) => ({
  ...(await orig<typeof import('../../../connections/http')>()),
  signedConnectionFetch: async (_s: unknown, _r: unknown, req: { url: string }) => {
    const path = new URL(req.url).pathname;
    http.paths.push(path);
    const body = path.endsWith('/version') ? PVE_VERSION : PVE_RESOURCES;
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)) };
  },
}));
const watched = vi.hoisted(() => ({ server: null as string | null }));
vi.mock('./watched', async (orig) => ({
  ...(await orig<typeof import('./watched')>()),
  watchedServerId: async () => watched.server,
}));

const now = new Date('2026-11-23T12:00:00Z');
const url = 'https://pve.home.example:8006';
const one = () => parseResources(PVE_RESOURCES, now, versionOf(PVE_VERSION));
const cluster = () => parseResources(PVE_CLUSTER_RESOURCES, now, '9.0.10');

afterEach(() => {
  http.paths = [];
  watched.server = null;
});

describe('reading Proxmox VE', () => {
  it('reads nodes, guests without templates and each storage once', () => {
    const s = one();
    expect(s.version).toBe('9.0.10');
    expect(s.nodes).toEqual([expect.objectContaining({ name: 'pve', online: true, cores: 16 })]);
    expect(s.nodes[0]?.cpuPct).toBeCloseTo(18.7);
    expect(s.guests.map((g) => [g.id, g.name, g.kind, g.state])).toEqual([
      ['qemu/100', 'homeassistant', 'vm', 'running'],
      ['qemu/101', 'win-build', 'vm', 'running'],
      ['lxc/120', 'paperless', 'container', 'running'],
      ['lxc/121', 'old-wiki', 'container', 'stopped'],
    ]);
    expect(s.storages.map((st) => st.id)).toEqual(['local', 'local-zfs', 'nas-backups']);
    // In a cluster a shared storage counts once; one that isn't available isn't counted.
    expect(cluster().storages.map((st) => [st.id, st.node])).toEqual([
      ['ceph-pool', 'pve-a'],
      ['local', 'pve-a'],
      ['local', 'pve-c'],
    ]);
    expect(parseNotBackedUp(PVE_NOT_BACKED_UP).map((g) => g.vmid)).toEqual([101, 121]);
    expect(parseResources({ errors: 'nope' }, now).guests).toEqual([]);
  });
});

describe('Proxmox VE’s page in slots', () => {
  it('shows its guests busiest first, what is in it, and its one node as the machine', () => {
    const v = checked(proxmoxView({ snapshot: one(), url }));
    expect(slotProblems(v)).toEqual([]);
    expect(v.notices).toEqual([]);
    const live = panel(v, 'guests', 'gallery');
    expect(live?.title).toBe('Guests now');
    expect(live?.meta).toBe('3 of 4 running');
    expect(live?.items.map((i) => [i.title, i.sub, i.note])).toEqual([
      ['win-build', 'VM · 14 of 16 GB', '61 % processor'],
      ['homeassistant', 'VM · 3.1 of 4.0 GB', '4 % processor'],
      ['paperless', 'Container · 0.9 of 2.0 GB', '1 % processor'],
      ['old-wiki', 'Container', 'Off'],
    ]);
    expect(live?.items[3]?.muted).toBe(true);
    const inv = panel(v, 'inventory', 'list');
    expect(inv?.title).toBe('In Proxmox');
    expect(inv?.items.map((i) => [i.id, i.figure?.value, i.figure?.note])).toEqual([
      ['vms', '2', 'All running'],
      ['containers', '2', '1 running'],
      ['storage-pve-local-zfs', '71 %', undefined],
      ['storage-pve-nas-backups', '53 %', undefined],
    ]);
    expect(v.slots?.own?.name).toBe('pve');
    expect(v.slots?.own?.figures.cores).toBe(16);
    expect(v.slots?.machine.map((b) => [b.label, b.value])).toEqual([
      ['Proxmox VE', '9.0.10'],
      ['Up', '3 weeks'],
    ]);
    expect(v.status).toEqual({ status: 'ok', badge: '3 of 4 guests running' });
    expect(v.verdict).toBe('Proxmox VE is fine: 3 of 4 guests running.');
  });

  it('says a node is offline and a storage nearly full, and names the node of each guest in a cluster', () => {
    const s = cluster();
    const v = checked(proxmoxView({ snapshot: s, url }));
    expect(slotProblems(v)).toEqual([]);
    expect(v.notices.map((n) => [n.check, n.tone, n.title])).toEqual([
      ['proxmox.node_offline', 'bad', 'pve-b is offline'],
      ['proxmox.storage_full', 'bad', 'ceph-pool is 97 % full'],
    ]);
    expect(v.status?.status).toBe('bad');
    expect(panel(v, 'guests', 'gallery')?.items[0]?.sub).toBe('VM · pve-a · 6.0 of 8.0 GB');
    const nodes = panel(v, 'inventory', 'list')?.items.find((i) => i.id === 'nodes');
    expect(nodes?.figure).toEqual({ value: '3', note: '1 offline', tone: 'bad' });
    // Several nodes: no one machine, only its lines.
    expect(v.slots?.own).toBeUndefined();
  });

  it('names the guests no backup job covers only when it could read them, and that starts off', () => {
    const input = { snapshot: one(), url, outside: parseNotBackedUp(PVE_NOT_BACKED_UP) };
    const lines = proxmoxNotices(input);
    expect(lines.map((n) => [n.check, n.nature, n.title])).toEqual([
      ['proxmox.no_backup_job', 'you', '2 guests are in no backup job'],
    ]);
    expect(lines[0]?.detail).toContain('win-build, old-wiki');
    const jobs = panel(checked(proxmoxView(input)), 'inventory', 'list')?.items.find(
      (i) => i.id === 'backup-jobs',
    );
    expect(jobs?.figure).toEqual({ value: '2', note: '2 left out', tone: 'warn' });
    expect(proxmoxSkipped({ snapshot: one(), url })).toEqual(['proxmox.no_backup_job']);
    expect(PROXMOX_CHECKS.find((c) => c.check === 'proxmox.no_backup_job')?.startsOn).toBe(false);
    // Every line's check is one What Whombat watches lists.
    const known = new Set(PROXMOX_CHECKS.map((c) => c.check));
    for (const n of [...lines, ...proxmoxNotices({ snapshot: cluster(), url })])
      expect(known.has(n.check)).toBe(true);
  });
});

describe('Proxmox VE’s health pass', () => {
  const row = {
    id: 'con_pve',
    burrowId: 'b1',
    catalogId: 'proxmox',
    baseUrl: url,
    fields: { url },
    credentialVersion: 1,
    updatedAt: new Date('2026-11-01T00:00:00Z'),
  } as unknown as CatalogConnectionRow;

  it('reads Proxmox when Whombat doesn’t watch the server', async () => {
    const seen = await PROXMOX_KIND.seen?.(fakeServices(now), row, now, 'UTC');
    expect(http.paths).toContain('/api2/json/cluster/resources');
    expect(seen?.glance.facts?.map((f) => [f.label, f.value])).toEqual([['Guests running', '3 of 4']]);
    expect(seen?.glance.line).toBe('Proxmox VE 9.0.10');
    expect(seen?.notices).toEqual([]);
    expect(seen?.skipped).toEqual(['proxmox.no_backup_job']);
  });

  it('asks Proxmox nothing when Whombat watches the server: that page raises what is wrong', async () => {
    watched.server = 'pve-02';
    const seen = await PROXMOX_KIND.seen?.(fakeServices(now), { ...row, id: 'con_pve_watched' }, now, 'UTC');
    expect(http.paths).toEqual([]);
    expect(seen?.glance.line).toBe('Part of pve-02');
    expect(seen?.notices).toEqual([]);
    expect(seen?.skipped).toEqual(PROXMOX_CHECKS.map((c) => c.check));
  });
});
