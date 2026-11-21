/**
 * The QNAP driver against a fake QTS with Container Station 3 (backup-places.md BPL-03): the folders through File
 * Station, the application made from compose (removed and made again to change it), its tasks followed, the cleanup,
 * what it keeps and removing it. The fake answers as the one open-source Container Station 3 client says CS 3.0.7
 * does; no real QNAP has run these calls.
 */
import { BACKUP_PLACE_TEXT } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { PLACE_KEEP_90 } from '../keep';
import { readPlaceCompose } from './compose';
import { htpasswdMatches } from './htpasswd';
import { type QnapAccess, QnapPlaceDriver } from './qnap';
import type { NasDriverDeps, NasRequest } from './types';

const CLIENT = 'whombat-home-3fkq';
const APP = `whombat-backup-${CLIENT}`;
const REST = 'rest-password-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

interface Qts {
  containerStation: boolean;
  shares: string[];
  folders: Set<string>;
  apps: Map<string, { status: string; yml: string }>;
  tasks: Map<string, { polls: number; done: () => void; fail: boolean }>;
  requests: NasRequest[];
  files: Map<string, string>;
  failNext: boolean;
  startsStopped: boolean;
}

function qts(over: Partial<Qts> = {}): Qts {
  return {
    containerStation: true,
    shares: ['Public', 'Container'],
    folders: new Set(),
    apps: new Map(),
    tasks: new Map(),
    requests: [],
    files: new Map(),
    failNext: false,
    startsStopped: false,
    ...over,
  };
}

const json = (status: number, value: unknown) => ({ status, body: Buffer.from(JSON.stringify(value)) });

function access(s: Qts): QnapAccess {
  let next = 1;
  const task = (done: () => void) => {
    const id = `task-${next++}`;
    s.tasks.set(id, { polls: 0, done, fail: s.failNext });
    s.failNext = false;
    return json(200, { data: { taskID: id } });
  };
  return {
    send: async (req) => {
      s.requests.push(req);
      const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
      if (req.path === '/cgi-bin/filemanager/utilRequest.cgi') {
        const q = req.query ?? {};
        switch (q.func) {
          case 'get_tree':
            return json(
              200,
              s.shares.map((name) => ({ id: `/${name}`, text: name, iconCls: 'folder' })),
            );
          case 'createdir': {
            const path = `${q.dest_path}/${q.dest_folder}`;
            const had = s.folders.has(path);
            s.folders.add(path);
            return json(200, { status: had ? 33 : 1, success: 'true' });
          }
          case 'delete': {
            const path = `${q.path}/${q.file_name}`;
            const had = s.folders.delete(path);
            return json(200, { status: had ? 1 : 5, success: 'true' });
          }
          case 'get_file_size':
            return json(200, { status: 1, size: '2468', folderCnt: '3', fileCnt: '9' });
          case 'download': {
            const text = s.files.get(`${q.source_path}/${q.source_file}`);
            return text === undefined ? json(200, { status: 5 }) : { status: 200, body: Buffer.from(text) };
          }
          default:
            return json(200, { status: 0 });
        }
      }
      if (!s.containerStation) return { status: 404, body: Buffer.from('<html></html>') };
      const path = req.path.replace('/container-station/api/v3', '');
      if (req.method === 'GET' && path === '/overview')
        return json(200, {
          data: { app: [...s.apps].map(([name, a]) => ({ name, status: a.status })), container: [] },
        });
      const inspect = /^\/apps\/([^/]+)\/inspect$/.exec(path);
      if (req.method === 'GET' && inspect) {
        const app = s.apps.get(decodeURIComponent(inspect[1] ?? ''));
        return app
          ? json(200, { data: { yml: app.yml, containers: [] } })
          : json(404, { error: 'not found' });
      }
      if (req.method === 'POST' && path === '/apps/compose') {
        const name = String(body.name);
        if (s.apps.has(name)) return json(409, { error: 'exists' });
        return task(() =>
          s.apps.set(name, { status: s.startsStopped ? 'stopped' : 'running', yml: String(body.yml) }),
        );
      }
      if (req.method === 'PUT' && path === '/apps/start')
        return task(() => {
          for (const n of body.apps as string[]) {
            const app = s.apps.get(n);
            if (app) app.status = 'running';
          }
        });
      if (req.method === 'DELETE' && path === '/apps')
        return task(() => {
          for (const n of body.apps as string[]) s.apps.delete(n);
        });
      if (req.method === 'GET' && path === '/tasks')
        return json(200, {
          data: {
            items: [...s.tasks].map(([id, t]) => {
              t.polls++;
              if (t.polls < 2) return { id, state: 'running', progress: 40 };
              if (t.fail) return { id, state: 'failed' };
              t.done();
              return { id, state: 'completed', progress: 100 };
            }),
          },
        });
      return json(404, {});
    },
  };
}

function deps(over: Partial<NasDriverDeps> = {}): NasDriverDeps {
  let now = 0;
  return {
    address: async () => '192.168.1.21',
    probe: async () => 401,
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    readyMs: 60_000,
    ...over,
  };
}

describe('QNAP ensure', () => {
  it('makes the folders and the application from compose with host paths under /share', async () => {
    const s = qts();
    const out = await new QnapPlaceDriver(access(s), deps(), 'TS-464').ensure(CLIENT, REST);
    expect(out).toEqual({
      address: '192.168.1.21',
      port: 8747,
      path: `/share/Container/whombat-backups/${CLIENT}`,
      location: 'Container',
    });
    expect([...s.folders]).toEqual([
      '/Container/whombat-backups',
      `/Container/whombat-backups/${CLIENT}`,
      '/Container/whombat-backups/.whombat',
    ]);
    const app = s.apps.get(APP);
    expect(app?.status).toBe('running');
    const read = readPlaceCompose(app?.yml);
    expect(read.dataPath).toBe(`/share/Container/whombat-backups/${CLIENT}`);
    expect(htpasswdMatches(read.htpasswd ?? '', REST)).toBe(true);
    expect(app?.yml).toMatch(/^version:/m);
    expect(JSON.stringify(s.requests)).not.toContain(REST);
  });

  it('again: removes the application and makes it with the new compose, keeping port and cleanup', async () => {
    const s = qts();
    const driver = new QnapPlaceDriver(access(s), deps(), 'TS-464');
    await driver.ensure(CLIENT, REST);
    await driver.cleanup(CLIENT, 'repo', PLACE_KEEP_90);
    s.requests.length = 0;
    await driver.ensure(CLIENT, 'second-rest-password-ccccccccccccccccccccccc');
    const read = readPlaceCompose(s.apps.get(APP)?.yml);
    expect(read.port).toBe(8747);
    expect(read.cleanup).toEqual({ repositoryPassword: 'repo', keep: PLACE_KEEP_90 });
    const changes = s.requests
      .filter((r) => r.method !== 'GET')
      .map((r) => `${r.method} ${r.path.split('/v3')[1]}`);
    expect(changes).toEqual(['DELETE /apps', 'POST /apps/compose']);
    const del = s.requests.find((r) => r.method === 'DELETE');
    expect(JSON.parse(String(del?.body))).toEqual({ apps: [APP], removeVolume: false });
  });

  it('starts an application that came up stopped', async () => {
    const s = qts({ startsStopped: true });
    await new QnapPlaceDriver(access(s), deps(), 'TS-464').ensure(CLIENT, REST);
    expect(s.apps.get(APP)?.status).toBe('running');
    expect(s.requests.some((r) => r.method === 'PUT' && r.path.endsWith('/apps/start'))).toBe(true);
  });

  it('says why a QNAP can’t: no Container Station 3, or no Container share', async () => {
    expect(
      await new QnapPlaceDriver(access(qts({ containerStation: false })), deps(), 'Q').unsupported(),
    ).toBe(BACKUP_PLACE_TEXT.reasons.qnapNoContainerStation);
    expect(await new QnapPlaceDriver(access(qts({ shares: ['Public'] })), deps(), 'Q').unsupported()).toBe(
      BACKUP_PLACE_TEXT.reasons.qnapNoContainerStation,
    );
    expect(await new QnapPlaceDriver(access(qts()), deps(), 'Q').unsupported()).toBeNull();
  });

  it('a failed task is one plain sentence', async () => {
    const s = qts({ failNext: true });
    await expect(new QnapPlaceDriver(access(s), deps(), 'Q').ensure(CLIENT, REST)).rejects.toMatchObject({
      reason: 'failed',
    });
  });

  it('keeps the application name within Container Station’s 32 characters', async () => {
    const s = qts();
    const long = 'whombat-living-room-server-3fkq';
    await new QnapPlaceDriver(access(s), deps(), 'Q').ensure(long, REST);
    const [name] = [...s.apps.keys()];
    expect(name?.length).toBeLessThanOrEqual(32);
    expect(name?.startsWith('whombat-backup-')).toBe(true);
  });
});

describe('QNAP shared folders (BPL-13)', () => {
  it('lists the shared folders, Container recommended and where backups went before', async () => {
    const look = await new QnapPlaceDriver(access(qts()), deps(), 'Q').look();
    expect(look.locations.map((l) => [l.id, l.recommended])).toEqual([
      ['Public', false],
      ['Container', true],
    ]);
    expect(look).toMatchObject({ reason: null, wasIn: 'Container' });
  });

  it('keeps the backups in the chosen folder; another one later starts the app on an empty folder there', async () => {
    const s = qts();
    const driver = new QnapPlaceDriver(access(s), deps(), 'Q');
    expect(await driver.ensure(CLIENT, REST, 'Public')).toMatchObject({
      location: 'Public',
      path: `/share/Public/whombat-backups/${CLIENT}`,
    });
    expect(await driver.ensure(CLIENT, REST)).toMatchObject({ location: 'Public' });
    const out = await driver.ensure(CLIENT, REST, 'Container');
    expect(out).toMatchObject({ location: 'Container', path: `/share/Container/whombat-backups/${CLIENT}` });
    expect(s.folders.has(`/Public/whombat-backups/${CLIENT}`)).toBe(true);
    expect(readPlaceCompose(s.apps.get(APP)?.yml).dataPath).toBe(
      `/share/Container/whombat-backups/${CLIENT}`,
    );
    await expect(driver.ensure(CLIENT, REST, 'Nowhere')).rejects.toMatchObject({
      reason: 'failed',
      message: BACKUP_PLACE_TEXT.location.gone,
    });
  });
});

describe('QNAP cleanup, kept and forget', () => {
  it('kept: the backups’ size and the cleanup’s status file', async () => {
    const s = qts();
    const driver = new QnapPlaceDriver(access(s), deps(), 'Q');
    expect(await driver.kept(CLIENT)).toBeNull();
    await driver.ensure(CLIENT, REST);
    expect(await driver.kept(CLIENT)).toMatchObject({ usedBytes: 2468, cleanup: { on: false, ok: null } });
    await driver.cleanup(CLIENT, 'repo', PLACE_KEEP_90);
    s.files.set(
      `/Container/whombat-backups/.whombat/${CLIENT}.cleanup.json`,
      '{"last_run_at":"2026-11-03T13:00:00Z","last_ok":false,"last_error":"x","keep_within_days":90}',
    );
    expect(await driver.kept(CLIENT)).toEqual({
      usedBytes: 2468,
      freeBytes: null,
      cleanup: { on: true, keepDays: 90, lastAt: '2026-11-03T13:00:00Z', ok: false },
      byHand: false,
    });
  });

  it('forget removes the application; deleteData the backups’ folder too', async () => {
    const s = qts();
    const driver = new QnapPlaceDriver(access(s), deps(), 'Q');
    await driver.ensure(CLIENT, REST);
    await driver.forget(CLIENT, false);
    expect(s.apps.has(APP)).toBe(false);
    expect(s.folders.has(`/Container/whombat-backups/${CLIENT}`)).toBe(true);
    await driver.forget(CLIENT, true);
    expect(s.folders.has(`/Container/whombat-backups/${CLIENT}`)).toBe(false);
    // Again: nothing there any more, nothing fails.
    await driver.forget(CLIENT, true);
  });
});
