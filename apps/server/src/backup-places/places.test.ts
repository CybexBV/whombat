/**
 * Backup places' logic (backup-places.md): the hosts service's `backup_place` read, each kind of place in its state
 * (BPL-04), the list's order and the place in use, the move rule (BPL-06), the repository's address, and the two lines
 * Whombat can watch (BPL-11).
 */
import { BACKUP_PLACE_CLEANUP_HINT, BACKUP_PLACE_SPACE_HINT } from '@whombat/core';
import type { BackupServiceStatus } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { pickAddress } from './drivers/agent';
import { hubBackupPlace, isPrivateIpv4, manageOn } from './hub';
import {
  connectionPlace,
  earlierPlaces,
  foundPlace,
  hostOf,
  placesList,
  type ServerFacts,
  serverPlace,
} from './places';
import type { BackupPlaceRow } from './store';
import { moveNeeded, restRepository } from './use';
import { CLEANUP_LATE_MS, placeHints } from './watch';

const CLIENT = 'whombat-home-3fkq';

const hubRaw = (over: Record<string, unknown> = {}) => ({
  server: { id: 'blackbox', address: '10.100.0.40', remote_control: { manage: true, agent_manage: true } },
  backup_place: {
    supported: true,
    reason: '',
    platform: 'unraid',
    root: '/mnt/user/whombat-backups',
    free_bytes: 1_900_000_000_000,
    total_bytes: 2_000_000_000_000,
    addresses: ['10.100.1.23', '10.100.0.40', '8.8.8.8'],
    nfs: true,
    clients: [
      {
        client: CLIENT,
        port: 8747,
        running: true,
        used_bytes: 123,
        cleanup: { set: true, running: true, keep_within_days: 90, last_run_at: null, last_ok: null },
      },
    ],
    ...over,
  },
});

const server = (over: Partial<ServerFacts> = {}): ServerFacts => ({
  id: 'blackbox',
  name: 'BlackBox',
  self: false,
  unraid: true,
  hub: hubBackupPlace(hubRaw()),
  manage: true,
  address: '10.100.0.40',
  ...over,
});

/** A value the test knows is there. */
function there<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('missing');
  return v;
}

const row = (over: Partial<BackupPlaceRow> = {}): BackupPlaceRow => ({
  id: 'server:blackbox',
  kind: 'unraid',
  name: 'BlackBox',
  client: CLIENT,
  address: '10.100.0.40',
  port: 8747,
  byHand: false,
  repositoryId: 'repo-1',
  cleanupAt: new Date('2026-11-01T00:00:00Z'),
  cleanupKeep: null,
  pendingPasswordEnc: null,
  pendingUntil: null,
  location: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date('2026-11-01T00:00:00Z'),
  ...over,
});

describe('the hosts service’s backup_place', () => {
  it('reads the report, keeping only addresses on the home network', () => {
    const p = hubBackupPlace(hubRaw());
    expect(p).toMatchObject({ supported: true, reason: null, platform: 'unraid', nfs: true });
    expect(p?.addresses).toEqual(['10.100.1.23', '10.100.0.40']);
    expect(p?.clients[0]).toMatchObject({ client: CLIENT, port: 8747, cleanup: { set: true, keepDays: 90 } });
    expect(hubBackupPlace({ server: {} })).toBeNull();
    expect(hubBackupPlace(hubRaw({ supported: false, reason: 'array_stopped' }))?.reason).toBe(
      'array_stopped',
    );
    expect(manageOn(hubRaw())).toBe(true);
    expect(manageOn({ server: { remote_control: { manage: true, agent_manage: false } } })).toBe(false);
    expect(['10.0.0.1', '172.20.1.1', '192.168.1.2'].every(isPrivateIpv4)).toBe(true);
    expect(['8.8.8.8', '172.32.0.1', '10.0.0.256', 'nas.lan'].some(isPrivateIpv4)).toBe(false);
  });

  it('names the address the hosts service knows the server by when the agent reports it', () => {
    expect(pickAddress(['10.100.1.23', '10.100.0.40'], '10.100.0.40')).toBe('10.100.0.40');
    expect(pickAddress(['10.100.1.23'], '10.100.0.40')).toBe('10.100.1.23');
    expect(pickAddress([], null)).toBeNull();
    expect(restRepository('10.100.0.40', 8747, CLIENT)).toBe(`rest:http://10.100.0.40:8747/${CLIENT}/`);
  });
});

describe('a place’s state (BPL-04)', () => {
  it('a server: ready, Manage first, or why it can’t', () => {
    expect(serverPlace(server(), CLIENT)).toMatchObject({
      id: 'server:blackbox',
      kind: 'unraid',
      state: 'ready',
      address: '10.100.0.40',
      kept: { usedBytes: 123, freeBytes: 1_900_000_000_000, cleanup: { on: true } },
    });
    expect(serverPlace(server({ manage: false }), CLIENT)).toMatchObject({ state: 'manage_first' });
    const stopped = server({ hub: hubBackupPlace(hubRaw({ supported: false, reason: 'array_stopped' })) });
    expect(serverPlace(stopped, CLIENT)).toMatchObject({ state: 'unsupported', reason: expect.any(String) });
    // An older helper on an Unraid box says so; any other server without a report isn't listed.
    expect(serverPlace(server({ hub: null }), CLIENT)?.state).toBe('unsupported');
    expect(serverPlace(server({ hub: null, unraid: false }), CLIENT)).toBeNull();
  });

  it('never the server this Whombat runs on, and a Linux server without Docker isn’t listed', () => {
    expect(serverPlace(server({ self: true }), CLIENT)?.state).toBe('unsupported');
    expect(
      serverPlace(
        server({ self: true, unraid: false, hub: { ...there(server().hub), platform: 'linux' } }),
        CLIENT,
      ),
    ).toBeNull();
    const noDocker = hubBackupPlace(hubRaw({ supported: false, reason: 'no_docker', platform: 'linux' }));
    expect(serverPlace(server({ unraid: false, hub: noDocker }), CLIENT)).toBeNull();
    const dockerDown = hubBackupPlace(hubRaw({ supported: false, reason: 'docker_down', platform: 'linux' }));
    expect(serverPlace(server({ unraid: false, hub: dockerDown }), CLIENT)).toMatchObject({
      kind: 'linux',
      state: 'unsupported',
    });
  });

  it('a NAS connection: connect again, Manage first, ready, or by hand only', () => {
    const c = {
      id: 'con_1',
      kind: 'synology' as const,
      name: 'DiskStation',
      address: '192.168.1.40',
      active: true,
      manage: true,
      status: null,
      kept: null,
    };
    expect(connectionPlace(c)).toMatchObject({ id: 'connection:con_1', state: 'ready' });
    expect(connectionPlace({ ...c, manage: false }).state).toBe('manage_first');
    expect(connectionPlace({ ...c, active: false }).state).toBe('connect_first');
    expect(
      connectionPlace({
        ...c,
        status: { supported: false, reason: 'Not yet.', byHand: true, freeBytes: null },
      }),
    ).toMatchObject({ state: 'unsupported', reason: 'Not yet.', byHand: true });
    expect(hostOf('https://192.168.1.40:5001')).toBe('192.168.1.40');
  });

  it('a NAS the scan found asks to be connected; other finds aren’t places', () => {
    expect(foundPlace({ catalogId: 'truenas', host: '10.0.0.9' })).toMatchObject({
      id: 'found:10.0.0.9',
      kind: 'truenas',
      state: 'connect_first',
      reason: expect.stringContaining('10.0.0.9'),
    });
    expect(foundPlace({ catalogId: 'unraid', host: '10.0.0.8' })?.kind).toBe('unraid');
    expect(foundPlace({ catalogId: 'plex', host: '10.0.0.7' })).toBeNull();
  });
});

describe('the list', () => {
  const small = { ...there(serverPlace(server({ id: 'tiny', name: 'tiny' }), CLIENT)) };
  small.kept = { ...there(small.kept), freeBytes: 5 };

  it('servers with most room first, then connections, then finds; the place in use marked', () => {
    const big = there(serverPlace(server(), CLIENT));
    const found = there(foundPlace({ catalogId: 'qnap', host: '10.0.0.5' }));
    const out = placesList({
      servers: [small, big],
      connections: [],
      found: [found],
      rows: [row()],
      repositoryId: 'repo-1',
    });
    expect(out.places.map((p) => [p.id, p.state])).toEqual([
      ['server:blackbox', 'in_use'],
      ['server:tiny', 'ready'],
      ['found:10.0.0.5', 'connect_first'],
    ]);
    expect(out.currentPlaceId).toBe('server:blackbox');
    expect(
      placesList({ servers: [big], connections: [], found: [], rows: [row()], repositoryId: 'other' })
        .currentPlaceId,
    ).toBeNull();
  });

  it('keeps showing the place in use when it isn’t on the network now', () => {
    const out = placesList({
      servers: [],
      connections: [],
      found: [],
      rows: [row({ byHand: true })],
      repositoryId: 'repo-1',
    });
    expect(out.places).toEqual([
      expect.objectContaining({
        id: 'server:blackbox',
        state: 'in_use',
        kept: expect.objectContaining({ byHand: true }),
      }),
    ]);
  });
});

describe('the places that kept backups before', () => {
  const nas = row({
    id: 'connection:con_syn',
    kind: 'synology',
    name: 'Attic NAS',
    repositoryId: 'repo-0',
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  });
  const older = row({
    id: 'server:old',
    name: 'Old box',
    repositoryId: 'repo-00',
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  });
  const big = there(serverPlace(server(), CLIENT));

  it('names the other places with a repository, the latest first, as the network names them now', () => {
    const rows = [row(), older, nas, row({ id: 'server:never', repositoryId: null })];
    const now = placesList({ servers: [big], connections: [], found: [], rows, repositoryId: 'repo-1' });
    const renamed = { ...now, places: [...now.places, { ...big, id: 'connection:con_syn', name: 'Attic' }] };
    expect(earlierPlaces({ ...renamed, rows, statusKnown: true })).toEqual([
      { placeId: 'connection:con_syn', name: 'Attic' },
      { placeId: 'server:old', name: 'Old box' },
    ]);
  });

  it('says nothing while where backups go isn’t known, or when there was no other place', () => {
    const rows = [row(), nas];
    const now = placesList({ servers: [big], connections: [], found: [], rows, repositoryId: 'repo-1' });
    expect(earlierPlaces({ ...now, rows, statusKnown: false })).toEqual([]);
    expect(earlierPlaces({ ...now, rows: [row()], statusKnown: true })).toEqual([]);
    // The same repository under another record (an address followed) isn't an earlier place.
    expect(
      earlierPlaces({ ...now, rows: [row(), row({ id: 'found:10.0.0.9' })], statusKnown: true }),
    ).toEqual([]);
  });
});

describe('moving backups (BPL-06)', () => {
  const status = (destination: Partial<BackupServiceStatus['destination']>) =>
    ({ destination: { configured: true, ...destination } }) as BackupServiceStatus;

  it('from nothing or the box’s own disk, to the place in use, or once the person said move', () => {
    expect(moveNeeded(status({ configured: false }), null, 'server:blackbox', false)).toBeNull();
    expect(moveNeeded(status({ kind: 'local' }), null, 'server:blackbox', false)).toBeNull();
    expect(moveNeeded(status({ kind: 'rest' }), 'server:blackbox', 'server:blackbox', false)).toBeNull();
    expect(moveNeeded(status({ kind: 'sftp', display: 'nas-01' }), null, 'server:blackbox', true)).toBeNull();
    expect(moveNeeded(status({ kind: 'sftp', display: 'nas-01' }), null, 'server:blackbox', false)).toEqual({
      from: 'nas-01',
    });
    // Not known where backups go: moving is the person's.
    expect(moveNeeded(null, null, 'server:blackbox', false)).toEqual({ from: '' });
  });
});

describe('what Whombat can watch (BPL-11)', () => {
  const now = new Date('2026-11-03T12:00:00Z');

  it('a cleanup that failed, never ran or stopped; a place running out of room', () => {
    expect(placeHints([server()], [row()], CLIENT, now)).toEqual([]);
    const late = new Date(there(row().cleanupAt).getTime() + CLEANUP_LATE_MS + 1);
    expect(placeHints([server()], [row()], CLIENT, late).map((h) => h.kind)).toEqual([
      BACKUP_PLACE_CLEANUP_HINT,
    ]);
    const failed = there(hubBackupPlace(hubRaw()));
    there(failed.clients[0]).cleanup.ok = false;
    const hints = placeHints([server({ hub: failed })], [row()], CLIENT, now);
    expect(hints).toEqual([
      expect.objectContaining({
        serverId: 'blackbox',
        kind: BACKUP_PLACE_CLEANUP_HINT,
        entity: CLIENT,
        id: `${BACKUP_PLACE_CLEANUP_HINT}:${CLIENT}`,
        title: expect.stringContaining('BlackBox'),
      }),
    ]);
    const full = hubBackupPlace(hubRaw({ free_bytes: 100_000_000_000 }));
    expect(placeHints([server({ hub: full })], [row()], CLIENT, now).map((h) => h.kind)).toEqual([
      BACKUP_PLACE_SPACE_HINT,
    ]);
    // Not a place of this Whombat's: nothing.
    expect(placeHints([server({ hub: full })], [], CLIENT, now)).toEqual([]);
  });
});
