/**
 * A TrueNAS as a backup place end to end (backup-places.md BPL-03, BPL-04, BPL-12): a TrueNAS connected over REST with
 * its key sealed and its certificate pinned, then the places' registry driving it as its connection — the key opened
 * on the server, the socket under the connection's destination rule, the app made and answering HTTP at the NAS's
 * numeric address, the cleanup handed over, what it keeps, the NFS share, the place set up in one step on the pool it is
 * on and another pool starting new backups once the person confirms (BPL-13, BPL-14) — and a connection that only looks
 * refused. Postgres because the connection, its sealed key, the place's record and the home-network list live there.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type AnyEndpoint, api, BACKUP_PLACE_TEXT, buildPath, type JsonValue } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdapterContext } from '../../connections/adapters/types';
import { FAKE_CERT_SHA256, type FakeSocketServer, fakeTrueNas } from '../../connections/socket/testing';
import { catalogConnections, vaultNetworks } from '../../db/schema/index';
import { WHOMBAT_ACTOR } from '../../hosts/service';
import { BACKUP_PLACE_TOOLS } from '../../hosts/tools-backup-places';
import type { BackupPort } from '../../managed/backup';
import { useBoxBackup } from '../../managed/box-backup';
import { IDS } from '../../seed/test-world';
import { useTestServer } from '../../test/harness';
import { accountOf, sessionFor } from '../../test/tokens';
import { useVaultNetForTests } from '../../vault/net';
import { placeDriver } from '../drivers/index';
import { PLACE_KEEP_90 } from '../keep';
import { placesNow } from '../places';
import { loadPlaceRow, savePlaceRow } from '../store';
import { usePlace } from '../use';
import { readPlaceCompose } from './compose';
import { forgetNasLooks } from './place-driver';
import { type FakeState, fakeTrueNasMethods, fakeTrueNasState } from './testing';
import { nasPlaceDriver } from './transport';
import { TrueNasPlaceDriver } from './truenas';

const t = useTestServer({ seed: true, listen: true });

const NET = '192.168.94';
const NAS_ADDRESS = `${NET}.20`;
const KEY = `1-${'b'.repeat(64)}`;
const CLIENT = 'whombat-home-3fkq';
const REST = 'rest-password-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

let nas: FakeSocketServer;
let app: http.Server;
let appPort = 0;
let state: FakeState;
let cookie = '';
let connectionId = '';

/** The backup app's REST server as the NAS would run it: 401 without a user, on the first free port from 8747. */
async function listenFromFirstPort(): Promise<http.Server> {
  for (let port = 8747; port < 8847; port++) {
    const server = http.createServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) return server;
  }
  throw new Error('No free port from 8747.');
}

async function rest(ep: AnyEndpoint, params: Record<string, string>, body?: unknown) {
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', ...params })}`,
    headers: { cookie },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, body: res.json() as { connection: { id: string } } };
}

const target = () => ({
  id: `connection:${connectionId}`,
  ref: { type: 'connection' as const, id: connectionId },
  kind: 'truenas' as const,
  name: 'Vault',
});
const driver = () => placeDriver({ services: t.services, target: target(), actor: WHOMBAT_ACTOR });

beforeAll(async () => {
  app = await listenFromFirstPort();
  appPort = (app.address() as AddressInfo).port;
  // Every port before the app's is taken on the NAS, so the driver picks the app's.
  state = fakeTrueNasState({
    jobPolls: 1,
    usedPorts: Array.from({ length: appPort - 8747 }, (_, i) => 8747 + i),
  });
  nas = await fakeTrueNas({ apiKey: KEY, tls: true, methods: fakeTrueNasMethods(state) });
  useVaultNetForTests(t.services, {
    resolve: async (host) => {
      if (host !== 'vault.bp.test')
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return [{ address: NAS_ADDRESS, family: 4 }];
    },
    dialAddress: (address) => (address.startsWith(`${NET}.`) ? '127.0.0.1' : address),
    deadlineMs: 5000,
  });
  await t.services.db.insert(vaultNetworks).values({
    id: 'vnw_backup_places_nas',
    cidr: `${NET}.0/24`,
    ports: [nas.port, appPort].sort((a, b) => a - b),
    note: 'Backup places NAS fakes',
    addedAt: t.services.clock(),
  });
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  const res = await rest(
    api.connections.create,
    {},
    {
      catalogId: 'truenas',
      label: 'Vault',
      fields: { url: nas.url.replace('127.0.0.1', 'vault.bp.test'), fingerprint: FAKE_CERT_SHA256 },
      secret: KEY,
    },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  connectionId = res.body.connection.id;
});

afterAll(async () => {
  await nas?.close();
  await new Promise<void>((resolve) => (app ? app.close(() => resolve()) : resolve()));
});

describe('a TrueNAS keeps this Whombat’s backups', () => {
  it('says it can, with the room its pool has', async () => {
    state.datasets.set('tank', { used: 1e12, available: 3e12 });
    expect(await driver().status?.()).toMatchObject({
      supported: true,
      reason: null,
      byHand: false,
      freeBytes: 3e12,
      wasIn: 'tank',
    });
  });

  it('installs the app as the connection and waits until it answers at the NAS’s numeric address', async () => {
    const out = await driver().ensure(CLIENT, REST);
    expect(out).toEqual({
      address: NAS_ADDRESS,
      port: appPort,
      path: `/mnt/tank/whombat-backups/${CLIENT}`,
      location: 'tank',
    });
    expect(state.apps.get(`whombat-backup-${CLIENT}`)?.state).toBe('RUNNING');
    expect(await driver().addresses?.()).toEqual([NAS_ADDRESS]);
    // Signed in with the sealed key; the REST password never left the server.
    expect(nas.received[0]).toMatchObject({ method: 'auth.login_with_api_key' });
    expect(JSON.stringify(nas.received)).not.toContain(REST);
  });

  it('hands over the cleanup and reports what it keeps', async () => {
    await driver().cleanup(CLIENT, 'repo-password', PLACE_KEEP_90);
    const read = readPlaceCompose(state.apps.get(`whombat-backup-${CLIENT}`)?.yaml);
    expect(read.cleanup).toEqual({ repositoryPassword: 'repo-password', keep: PLACE_KEEP_90 });
    state.datasets.set(`tank/whombat-backups/${CLIENT}`, { used: 42, available: 3e12 });
    expect(await driver().kept(CLIENT)).toMatchObject({ usedBytes: 42, cleanup: { on: true, keepDays: 90 } });
  });

  it('shares a folder over NFS for a Proxmox server’s backups', async () => {
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    if (!row) throw new Error('no connection');
    const d = nasPlaceDriver(t.services, row);
    expect(d).toBeInstanceOf(TrueNasPlaceDriver);
    expect(await (d as TrueNasPlaceDriver).nfsShare('whombat-pve-01', ['192.168.1.5'])).toEqual({
      export: '/mnt/tank/whombat-pve-01',
      addresses: [NAS_ADDRESS],
    });
    expect(state.nfs[0]).toMatchObject({ hosts: ['192.168.1.5'], maproot_user: 'root' });
  });

  it('the care plan’s backup_place_nfs takes the TrueNAS as connection:<id>', async () => {
    const [row] = await t.services.db
      .select()
      .from(catalogConnections)
      .where(eq(catalogConnections.id, connectionId));
    const ctx: AdapterContext = {
      baseUrl: '',
      fields: {},
      bases: {},
      send: () => Promise.reject(new Error('no')),
      call: {
        services: t.services,
        burrowId: row?.burrowId ?? '',
        agentId: IDS.dusty,
        connectionId: 'servers',
        callId: 'call-1',
        conversationId: null,
        personId: IDS.mara,
      },
    };
    const tool = BACKUP_PLACE_TOOLS.backup_place_nfs;
    if (!tool) throw new Error('no tool');
    const out = await tool(ctx, {
      server: `connection:${connectionId}`,
      name: 'whombat-pve-02',
      clients: ['192.168.1.7'],
    });
    expect(out.isError, out.content).toBe(false);
    expect(JSON.parse(out.content)).toEqual({
      export: '/mnt/tank/whombat-pve-02',
      nfsServer: NAS_ADDRESS,
      addresses: [NAS_ADDRESS],
    });
    // Another burrow's connection id is refused.
    await expect(
      tool(
        { ...ctx, call: { ...ctx.call, burrowId: 'bur_other' } as AdapterContext['call'] },
        {
          server: `connection:${connectionId}`,
          name: 'whombat-pve-02',
          clients: ['192.168.1.7'],
        },
      ),
    ).rejects.toThrow();
  });

  it('sets the place up on its pool; another pool starts new backups there once the person confirms', async () => {
    // The backup service: a destination at a time, a new repository for every set without adoptPassword.
    const svc = {
      destination: null as null | Record<string, JsonValue>,
      puts: [] as Record<string, JsonValue>[],
    };
    const port: BackupPort = {
      async call(method, path, body) {
        const d = svc.destination;
        if (method === 'GET' && path === '/v1/status')
          return {
            status: 200,
            body: {
              kind: 'whombat.backup-status/1',
              state: d ? 'pending' : 'unprotected',
              protected: false,
              destination: d
                ? { configured: true, kind: 'rest', display: 'x', appendOnly: 'verified', repositoryId: d.id }
                : { configured: false },
              lastSuccess: null,
              lastFailure: null,
              lastAttemptOk: null,
              coverage: [],
              recoverability: { lastDrill: null },
              kitGeneration: 0,
              running: null,
              updatedAt: new Date().toISOString(),
            },
          };
        if (method === 'PUT' && path === '/v1/destination') {
          const b = body as Record<string, JsonValue>;
          svc.puts.push(b);
          const id = (b.adoptPassword && d?.id) || `repo-${svc.puts.length}`;
          svc.destination = { ...b, id };
          return {
            status: 200,
            body: {
              repositoryId: id,
              appendOnly: 'verified',
              generation: svc.puts.length,
              kind: 'rest',
            },
          };
        }
        if (method === 'GET' && path === '/v1/recovery-material')
          return d
            ? {
                status: 200,
                body: {
                  kind: 'whombat.backup-recovery-material/1',
                  applianceId: 'box-1',
                  generation: svc.puts.length,
                  createdAt: '2026-11-03T12:00:00Z',
                  repository: d.repository,
                  restUser: d.restUser,
                  restPassword: d.restPassword,
                  repositoryPassword: 'repo-password',
                  repositoryId: d.id,
                  manifestKey: `ed25519:${Buffer.alloc(32, 7).toString('base64')}`,
                },
              }
            : { status: 412, body: null };
        if (method === 'POST' && path === '/v1/checkpoints')
          return { status: 200, body: { ok: true, ref: 'ck-1', verified: false, id: 'ck-1', seq: 1 } };
        return { status: 404, body: null };
      },
    };
    useBoxBackup(t.services, { port, status: () => null });
    state.pools = [
      { name: 'tank', status: 'ONLINE', free: 1 },
      { name: 'big', status: 'ONLINE', free: 2 },
    ];
    state.datasets.set('big', { used: 1, available: 5e12 });
    forgetNasLooks(t.services, connectionId);
    const id = `connection:${connectionId}`;
    // The app made above is this Whombat's (its client name).
    await savePlaceRow(t.services, id, { kind: 'truenas', name: 'Vault', client: CLIENT });
    const by = { accountId: await accountOf(t.services, IDS.mara), endpointId: null, actor: WHOMBAT_ACTOR };

    const listed = (await placesNow(t.services, { fresh: true })).places.find((p) => p.id === id);
    expect(listed?.locations.map((l) => [l.id, l.recommended])).toEqual([
      ['big', true],
      ['tank', false],
    ]);
    // Without a location the app stays on the pool it is on.
    const first = await usePlace(t.services, port, { placeId: id }, by);
    expect(first).toMatchObject({ locationName: 'the pool tank', firstBackup: true });
    expect((await loadPlaceRow(t.services.db, id))?.location).toBe('tank');
    expect((await placesNow(t.services, { fresh: true })).places.find((p) => p.id === id)).toMatchObject({
      state: 'in_use',
      location: 'tank',
    });

    // Another pool on the place in use: new backups, which the person confirms first.
    await expect(usePlace(t.services, port, { placeId: id, location: 'big' }, by)).rejects.toMatchObject({
      extra: { details: { code: 'move_needed', from: 'tank' } },
    });
    expect(svc.puts.length).toBe(1);
    const out = await usePlace(t.services, port, { placeId: id, location: 'big', move: true }, by);
    expect(out).toMatchObject({ locationName: 'the pool big', firstBackup: true });
    const put = svc.puts.at(-1);
    // The same address and user, a new repository there (never the old one joined); the old dataset stays.
    expect(put).toMatchObject({
      repository: `rest:http://${NAS_ADDRESS}:${appPort}/${CLIENT}/`,
      allowInit: true,
    });
    expect(put?.adoptPassword).toBeUndefined();
    expect(svc.destination?.id).toBe('repo-2');
    expect(readPlaceCompose(state.apps.get(`whombat-backup-${CLIENT}`)?.yaml).dataPath).toBe(
      `/mnt/big/whombat-backups/${CLIENT}`,
    );
    expect(state.datasets.has(`tank/whombat-backups/${CLIENT}`)).toBe(true);
    expect((await loadPlaceRow(t.services.db, id))?.location).toBe('big');
  });

  it('a connection that only looks: Turn on Manage first, and nothing is changed', async () => {
    await t.services.db
      .update(catalogConnections)
      .set({ access: 'read' })
      .where(eq(catalogConnections.id, connectionId));
    const before = nas.received.length;
    await expect(driver().ensure(CLIENT, REST)).rejects.toMatchObject({
      name: 'PlaceError',
      message: BACKUP_PLACE_TEXT.reasons.manage,
    });
    expect(nas.received.length).toBe(before);
  });
});
