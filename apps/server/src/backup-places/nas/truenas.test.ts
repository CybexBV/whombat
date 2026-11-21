/**
 * The TrueNAS driver against a fake TrueNAS over the real JSON-RPC socket (backup-places.md BPL-03, BPL-12): datasets,
 * the custom app made and updated as jobs, the cleanup handed over, what it keeps, removing it, the NFS share. The fake
 * follows TrueNAS's documented answers (24.10…25.10); no real TrueNAS has run these calls.
 */
import { BACKUP_PLACE_TEXT, catalogEntry } from '@whombat/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  behind,
  FAKE_CERT_SHA256,
  type FakeSocketServer,
  fakeHomePolicy,
  fakeTrueNas,
} from '../../connections/socket/testing';
import { PLACE_KEEP_90 } from '../keep';
import { readPlaceCompose } from './compose';
import { htpasswdMatches } from './htpasswd';
import { type FakeState, fakeTrueNasMethods as methods, fakeTrueNasState as state } from './testing';
import { openTrueNasSocket } from './transport';
import { TrueNasPlaceDriver } from './truenas';
import { type NasDriverDeps, NasPlaceError } from './types';

const KEY = '1-tRuEnAsApIkEy0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP';
const CLIENT = 'whombat-home-3fkq';
const APP = `whombat-backup-${CLIENT}`;
const REST = 'rest-password-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

let fake: FakeSocketServer | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

function fakeDeps(over: Partial<NasDriverDeps> = {}): NasDriverDeps & { probed: string[] } {
  let now = 0;
  const probed: string[] = [];
  return {
    address: async () => '192.168.1.30',
    probe: async (url) => {
      probed.push(url);
      return 401;
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    readyMs: 60_000,
    probed,
    ...over,
  };
}

async function driver(s: FakeState, deps = fakeDeps()) {
  fake = await fakeTrueNas({ apiKey: KEY, tls: true, version: s.version, methods: methods(s) });
  const spec = catalogEntry('truenas')?.socket;
  if (!spec) throw new Error('no spec');
  const server = fake;
  const open = () =>
    openTrueNasSocket({
      baseUrl: behind(server, 'nas.home.test'),
      spec,
      login: { secret: KEY, fields: {} },
      policy: fakeHomePolicy('nas.home.test', '192.168.90.30', { pinnedCertSha256: FAKE_CERT_SHA256 }),
    });
  return { d: new TrueNasPlaceDriver(open, deps, 'Vault'), deps, server };
}

const sent = (server: FakeSocketServer) => server.received.map((m) => String(m.method));

describe('TrueNAS ensure', () => {
  it('makes the datasets and the app as jobs, on the first free port, and waits until it answers', async () => {
    const s = state();
    const { d, deps, server } = await driver(s);
    const out = await d.ensure(CLIENT, REST);
    expect(out).toEqual({
      address: '192.168.1.30',
      port: 8748,
      path: `/mnt/tank/whombat-backups/${CLIENT}`,
      location: 'tank',
    });
    expect([...s.datasets.keys()]).toEqual(['tank/whombat-backups', `tank/whombat-backups/${CLIENT}`]);
    const app = s.apps.get(APP);
    expect(app?.state).toBe('RUNNING');
    const read = readPlaceCompose(app?.yaml);
    expect(read.port).toBe(8748);
    expect(read.dataPath).toBe(`/mnt/tank/whombat-backups/${CLIENT}`);
    expect(read.cleanup).toBeNull();
    expect(htpasswdMatches(read.htpasswd ?? '', REST)).toBe(true);
    expect(sent(server)).toContain('core.get_jobs');
    expect(deps.probed).toEqual(['http://192.168.1.30:8748/']);
    // The REST password itself never goes to the NAS: only its bcrypt line.
    expect(JSON.stringify(server.received)).not.toContain(REST);
  });

  it('again: updates the app on its port, keeps its cleanup, and starts it when it was stopped', async () => {
    const s = state();
    const { d } = await driver(s);
    await d.ensure(CLIENT, REST);
    await d.cleanup(CLIENT, 'repo-pass', PLACE_KEEP_90);
    const app = s.apps.get(APP);
    if (app) app.state = 'STOPPED';
    s.usedPorts = [8747, 8748, 8749];
    await d.ensure(CLIENT, 'another-rest-password-bbbbbbbbbbbbbbbbbbbbbbbb');
    const read = readPlaceCompose(s.apps.get(APP)?.yaml);
    expect(read.port).toBe(8748);
    expect(read.cleanup).toEqual({ repositoryPassword: 'repo-pass', keep: PLACE_KEEP_90 });
    expect(htpasswdMatches(read.htpasswd ?? '', 'another-rest-password-bbbbbbbbbbbbbbbbbbbbbbbb')).toBe(true);
    expect(s.apps.get(APP)?.state).toBe('RUNNING');
  });

  it('says why a TrueNAS can’t: too old, no apps pool, apps stopped', async () => {
    for (const [over, reason] of [
      [{ version: 'TrueNAS-SCALE-24.04.2' }, BACKUP_PLACE_TEXT.reasons.trueNasOld],
      [{ pool: null }, BACKUP_PLACE_TEXT.reasons.trueNasNoPool],
      [{ docker: 'STOPPED' }, BACKUP_PLACE_TEXT.reasons.trueNasAppsStopped],
    ] as const) {
      const { d } = await driver(state(over));
      expect(await d.unsupported()).toBe(reason);
      await expect(d.ensure(CLIENT, REST)).rejects.toMatchObject({ reason: 'unsupported', message: reason });
      await fake?.close();
      fake = null;
    }
    const { d } = await driver(state());
    expect(await d.unsupported()).toBeNull();
  });

  it('a failed job is one plain sentence', async () => {
    const s = state({ failNextJob: true });
    const { d } = await driver(s);
    const err = await d.ensure(CLIENT, REST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NasPlaceError);
    expect(err).toMatchObject({ reason: 'failed' });
  });

  it('lists its pools, the one with most room recommended, and says the apps pool was where backups went before', async () => {
    const s = state({
      pools: [
        { name: 'tank', status: 'ONLINE', free: 10 },
        { name: 'big', status: 'ONLINE', free: 50 },
        { name: 'dead', status: 'OFFLINE', free: 99 },
      ],
    });
    s.datasets.set('tank', { used: 1, available: 1_000 });
    s.datasets.set('big', { used: 1, available: 9_000 });
    const { d } = await driver(s);
    const look = await d.look();
    expect(look.locations.map((l) => [l.id, l.freeBytes, l.recommended])).toEqual([
      ['tank', 1_000, false],
      ['big', 9_000, true],
    ]);
    expect(look).toMatchObject({ reason: null, freeBytes: 9_000, wasIn: 'tank' });
  });

  it('a new place goes on the recommended pool; another pool later starts the app on an empty dataset there', async () => {
    const s = state({
      pools: [
        { name: 'tank', status: 'ONLINE', free: 10 },
        { name: 'big', status: 'ONLINE', free: 50 },
      ],
    });
    s.datasets.set('tank', { used: 1, available: 1_000 });
    s.datasets.set('big', { used: 1, available: 9_000 });
    const { d } = await driver(s);
    expect(await d.ensure(CLIENT, REST)).toMatchObject({ location: 'big' });
    await d.cleanup(CLIENT, 'repo-pass', PLACE_KEEP_90);
    // Again without a location: where it is.
    expect(await d.ensure(CLIENT, REST)).toMatchObject({
      location: 'big',
      path: `/mnt/big/whombat-backups/${CLIENT}`,
    });
    const moved = await d.ensure(CLIENT, REST, 'tank');
    expect(moved).toMatchObject({
      location: 'tank',
      path: `/mnt/tank/whombat-backups/${CLIENT}`,
      port: 8748,
    });
    const read = readPlaceCompose(s.apps.get(APP)?.yaml);
    expect(read.dataPath).toBe(`/mnt/tank/whombat-backups/${CLIENT}`);
    // The old dataset stays; the cleanup goes on, now beside the new folder.
    expect(s.datasets.has(`big/whombat-backups/${CLIENT}`)).toBe(true);
    expect(read.cleanup).toEqual({ repositoryPassword: 'repo-pass', keep: PLACE_KEEP_90 });
    await expect(d.ensure(CLIENT, REST, 'nowhere')).rejects.toMatchObject({
      reason: 'failed',
      message: BACKUP_PLACE_TEXT.location.gone,
    });
  });

  it('an app that never answers HTTP fails with the port', async () => {
    const { d } = await driver(state(), fakeDeps({ probe: async () => null }));
    await expect(d.ensure(CLIENT, REST)).rejects.toMatchObject({ reason: 'failed', message: /8748/ });
  });
});

describe('TrueNAS cleanup, kept and forget', () => {
  it('hands the repository password to the cleanup, keeping the user and the port', async () => {
    const s = state();
    const { d } = await driver(s);
    await d.ensure(CLIENT, REST);
    const before = readPlaceCompose(s.apps.get(APP)?.yaml);
    await d.cleanup(CLIENT, 'repo$pass', { ...PLACE_KEEP_90, allDays: 30 });
    const after = readPlaceCompose(s.apps.get(APP)?.yaml);
    expect(after.cleanup).toEqual({
      repositoryPassword: 'repo$pass',
      keep: { ...PLACE_KEEP_90, allDays: 30 },
    });
    expect(after.htpasswd).toBe(before.htpasswd);
    expect(after.port).toBe(before.port);
  });

  it('cleanup of an app that is gone says to set it up again', async () => {
    const { d } = await driver(state());
    await expect(d.cleanup(CLIENT, 'x', PLACE_KEEP_90)).rejects.toMatchObject({ reason: 'failed' });
  });

  it('kept: space from the dataset, the cleanup’s last run from its status file and marker', async () => {
    const s = state();
    const { d } = await driver(s);
    expect(await d.kept(CLIENT)).toBeNull();
    await d.ensure(CLIENT, REST);
    expect(await d.kept(CLIENT)).toMatchObject({
      cleanup: { on: false, lastAt: null, ok: null },
      byHand: false,
    });
    await d.cleanup(CLIENT, 'repo', PLACE_KEEP_90);
    s.datasets.set(`tank/whombat-backups/${CLIENT}`, { used: 1234, available: 5678 });
    const status = `/mnt/tank/whombat-backups/.whombat/${CLIENT}.cleanup`;
    s.files.set(`${status}.json`, 1_793_000_000);
    expect(await d.kept(CLIENT)).toEqual({
      usedBytes: 1234,
      freeBytes: 5678,
      cleanup: { on: true, keepDays: 90, lastAt: new Date(1_793_000_000_000).toISOString(), ok: true },
      byHand: false,
    });
    s.files.set(`${status}.failed`, 1_793_000_000);
    expect((await d.kept(CLIENT))?.cleanup.ok).toBe(false);
  });

  it('forget removes the app, and with deleteData the backups’ dataset', async () => {
    const s = state();
    const { d, server } = await driver(s);
    await d.ensure(CLIENT, REST);
    await d.forget(CLIENT, false);
    expect(s.apps.has(APP)).toBe(false);
    expect(s.datasets.has(`tank/whombat-backups/${CLIENT}`)).toBe(true);
    await d.forget(CLIENT, true);
    expect(s.datasets.has(`tank/whombat-backups/${CLIENT}`)).toBe(false);
    const del = server.received.find((m) => m.method === 'app.delete');
    expect((del?.params as unknown[] | undefined)?.[1]).toMatchObject({ remove_images: false });
  });
});

describe('TrueNAS NFS share for a server’s backups', () => {
  it('makes a dataset shared to exactly the server’s addresses, root as root, and turns NFS on', async () => {
    const s = state();
    const { d } = await driver(s);
    const out = await d.nfsShare('whombat-pve-01', ['192.168.1.5']);
    expect(out).toEqual({ export: '/mnt/tank/whombat-pve-01', addresses: ['192.168.1.30'] });
    expect(s.nfs).toEqual([
      expect.objectContaining({
        path: '/mnt/tank/whombat-pve-01',
        hosts: ['192.168.1.5'],
        maproot_user: 'root',
      }),
    ]);
    expect(s.nfsService).toEqual({ enable: true, state: 'RUNNING' });
    await d.nfsShare('whombat-pve-01', ['192.168.1.6']);
    expect(s.nfs).toHaveLength(1);
    expect(s.nfs[0]?.hosts).toEqual(['192.168.1.5', '192.168.1.6']);
  });

  it('refuses a share without addresses', async () => {
    const { d } = await driver(state());
    await expect(d.nfsShare('whombat-pve-01', [])).rejects.toBeInstanceOf(NasPlaceError);
  });
});
