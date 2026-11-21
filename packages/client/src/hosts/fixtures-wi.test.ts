import {
  HostFleet,
  HostGuestDetail,
  HostManageReadResult,
  HostServerDetail,
  HostTask,
} from '@whombat/core/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostsFixtures, type HostsFixtureAnswer } from './fixtures';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const enc = encodeURIComponent;

// The world is seeded at NOW and its wall clock (backups' expiry, tasks' times) is `Date.now()`: the same moment, so a
// backup that expires four days after NOW is still listed whatever today's date is.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function world() {
  const { handle } = createHostsFixtures(NOW);
  const get = (path: string, query: Record<string, string> = {}) =>
    handle({ method: 'GET', path, query, body: {} });
  const read = (query: Record<string, string>) => get('/servers/thetitan/manage', query);
  const manage = (body: Record<string, unknown>) =>
    handle({ method: 'POST', path: '/servers/thetitan/manage', query: {}, body });
  /** Reads a task until it ends. */
  const finish = (a: HostsFixtureAnswer | null): HostTask => {
    const id = (a?.body as { task: { id: string } } | undefined)?.task.id ?? '';
    let last: HostTask | undefined;
    for (let i = 0; i < 12; i++) {
      last = HostTask.parse(get(`/servers/thetitan/tasks/${enc(id)}`, { logStart: '0' })?.body);
      if (last.status !== 'running') break;
    }
    return last as HostTask;
  };
  return { get, read, manage, finish };
}

const parsed = (a: HostsFixtureAnswer | null) => HostManageReadResult.parse(a?.body);

describe('stream WI fixtures (The Titan as an Incus server)', () => {
  it('show thetitan as an Incus server that runs this Whombat, in the contracts’ shapes', () => {
    const { get } = world();
    const d = HostServerDetail.parse(get('/servers/thetitan')?.body);
    expect(d.server.platform).toBe('incus');
    expect(d.server.hostsThisWhombat).toBe(true);
    expect(d.incus?.version).toBe('6.0.4');
    expect(d.incus?.projects.map((p) => p.name)).toEqual(['default', 'ci-platform']);
    expect(d.incus?.pools.map((p) => p.name)).toEqual(['default', 'ci-nvme', 'demo']);
    expect(d.incus?.profiles.find((p) => p.name === 'default')?.usedBy).toBe(4);
    const self = d.workloads?.incus?.guests.filter((g) => g.self);
    expect(self?.map((g) => g.name)).toEqual(['whombat-dev-box']);
    const fleet = HostFleet.parse(get('/fleet')?.body);
    expect(fleet.servers.find((s) => s.id === 'thetitan')?.platform).toBe('incus');
    expect(
      HostGuestDetail.parse(get(`/servers/thetitan/guests/${enc('incus:whombat-dev-box')}`)?.body).self,
    ).toBe(true);
  });

  it('answer the Incus reads: configuration, choices, profile, leases, log, backups, tasks', () => {
    const { read } = world();
    const cfg = parsed(read({ op: 'config.get', guestId: 'incus:whombat-dev-box' }));
    if (cfg.op !== 'config.get') throw new Error('not a config');
    expect(cfg.config.restricted).toEqual(expect.arrayContaining(['raw.qemu', 'device.eth0']));
    expect(cfg.config.inherited).toContain('snapshots.expiry');
    expect(cfg.config.values['device.root']).toBe(
      'type=disk,boot.priority=20,path=/,pool=default,size=128GiB',
    );
    const choices = parsed(read({ op: 'choices', platform: 'incus' }));
    expect(choices.op === 'choices' && choices.choices.projects).toEqual(['default', 'ci-platform']);
    const prof = parsed(read({ op: 'profile.get', profile: 'default' }));
    expect(prof.op === 'profile.get' && prof.profile.usedBy.length).toBe(4);
    const leases = parsed(read({ op: 'network.leases', network: 'incusbr0' }));
    expect(
      leases.op === 'network.leases' && leases.items.find((l) => l.hostname === 'dashboard')?.address,
    ).toBe('10.62.52.73');
    const log = parsed(read({ op: 'log.get', guestId: 'incus:dashboard', lines: '5' }));
    expect(log.op === 'log.get' && [log.file, log.lines.length]).toEqual(['lxc.log', 5]);
    const backups = parsed(read({ op: 'backup.list', guestId: 'incus:dashboard', platform: 'incus' }));
    expect(backups.op === 'backup.list' && backups.items.map((b) => b.volume)).toEqual([
      'whombat-20261014-0210',
      'before-homepage-1.4',
    ]);
    const tasks = parsed(read({ op: 'task.list', platform: 'incus' }));
    expect(tasks.op === 'task.list' && tasks.items.length).toBeGreaterThan(2);
  });

  it('refuse what would change the guest Whombat runs in, and allow its backups', () => {
    const { manage, get } = world();
    const self = 'incus:whombat-dev-box';
    const set = manage({ op: 'config.set', guestId: self, params: { set: { 'limits.cpu': '8' } } });
    expect(set?.status).toBe(409);
    const stop = get('/servers/thetitan');
    expect(stop?.status).toBe(200);
    expect(manage({ op: 'guest.rename', guestId: self, params: { name: 'x' } })?.status).toBe(409);
    expect(manage({ op: 'backup.create', guestId: self, params: { platform: 'incus' } })?.status).toBe(200);
  });

  it('keep the allowlist: restricted keys, keys from a profile, digests', () => {
    const { manage, read } = world();
    const cfg = parsed(read({ op: 'config.get', guestId: 'incus:dashboard' }));
    if (cfg.op !== 'config.get') throw new Error('not a config');
    const digest = cfg.config.digest;
    expect(
      manage({ op: 'config.set', guestId: 'incus:dashboard', digest, params: { set: { 'raw.lxc': 'x' } } })
        ?.status,
    ).toBe(403);
    expect(
      manage({
        op: 'config.set',
        guestId: 'incus:dashboard',
        digest,
        params: { set: { 'snapshots.expiry': '' } },
      })?.status,
    ).toBe(400);
    const ok = manage({
      op: 'config.set',
      guestId: 'incus:dashboard',
      digest,
      params: { set: { 'limits.memory': '4GiB', 'user.note': 'hi' } },
    });
    expect(ok?.status).toBe(200);
    expect(
      manage({ op: 'config.set', guestId: 'incus:dashboard', digest, params: { set: {} } })?.status,
    ).toBe(409);
  });

  it('rename and move only stopped instances, and run them as Incus operations', () => {
    const { manage, finish, get } = world();
    expect(manage({ op: 'guest.rename', guestId: 'incus:dashboard', params: { name: 'home' } })?.status).toBe(
      409,
    );
    const rename = manage({ op: 'guest.rename', guestId: 'incus:rackoon', params: { name: 'rackoon-old' } });
    expect((rename?.body as { newId?: string } | undefined)?.newId).toBe('incus:rackoon-old');
    expect(finish(rename).status).toBe('ok');
    expect(get(`/servers/thetitan/guests/${enc('incus:rackoon-old')}`)?.status).toBe(200);
    const move = manage({
      op: 'guest.move',
      guestId: 'incus:rackoon-old',
      confirm: true,
      params: { project: 'ci-platform' },
    });
    expect(finish(move).status).toBe('ok');
    expect(get(`/servers/thetitan/guests/${enc('incus:ci-platform/rackoon-old')}`)?.status).toBe(200);
  });

  it('download an image, and fail one the images server lacks', () => {
    const { manage, finish, get } = world();
    const before = HostServerDetail.parse(get('/servers/thetitan')?.body).incus?.images.length ?? 0;
    expect(
      finish(manage({ op: 'image.download', params: { alias: 'alpine/3.22', type: 'container' } })).status,
    ).toBe('ok');
    expect(HostServerDetail.parse(get('/servers/thetitan')?.body).incus?.images.length).toBe(before + 1);
    const bad = finish(manage({ op: 'image.download', params: { alias: 'plan9/4', type: 'container' } }));
    expect(bad.status).toBe('error');
  });

  it('refuse to delete a profile or a volume in use', () => {
    const { manage } = world();
    expect(manage({ op: 'profile.delete', params: { profile: 'default' }, confirm: true })?.status).toBe(409);
    expect(
      manage({ op: 'profile.delete', params: { profile: 'demo-workstation' }, confirm: true })?.status,
    ).toBe(200);
    expect(
      manage({
        op: 'volume.delete',
        params: { pool: 'default', volume: 'whombat-dev-box-backup' },
        confirm: true,
      })?.status,
    ).toBe(409);
    expect(
      manage({
        op: 'volume.delete',
        params: { pool: 'default', volume: 'whombat-dev-box-installer' },
        confirm: true,
      })?.status,
    ).toBe(200);
  });
});
