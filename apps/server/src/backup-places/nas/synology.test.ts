/**
 * The Synology driver against a fake DSM (backup-places.md BPL-03): the visit's own session with its SynoToken, the
 * folders in the `docker` share, the Container Manager project made empty and then given its compose, built and
 * started, the cleanup, what it keeps and removing it. The fake answers as the open-source clients and DSM's guides
 * say DSM does; no real DSM has run these calls.
 */
import { BACKUP_PLACE_TEXT } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { PLACE_KEEP_90 } from '../keep';
import { readPlaceCompose } from './compose';
import { htpasswdMatches } from './htpasswd';
import { type SynologyAccess, SynologyPlaceDriver } from './synology';
import type { NasDriverDeps, NasRequest } from './types';

const CLIENT = 'whombat-home-3fkq';
const APP = `whombat-backup-${CLIENT}`;
const REST = 'rest-password-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SID = 'sid-123';
const TOKEN = 'syno-token-xyz';

interface Dsm {
  apis: string[];
  dockerShare: boolean;
  folders: string[];
  projects: Map<string, { id: string; name: string; status: string; content: string; share_path: string }>;
  calls: { api: string; method: string; params: Record<string, string>; token: string | undefined }[];
  files: Map<string, string>;
  signedOut: string[];
  buildError: boolean;
  denied: Set<string>;
  /** Shared folders besides `docker`. */
  shares: string[];
}

function dsm(over: Partial<Dsm> = {}): Dsm {
  return {
    apis: ['SYNO.Docker.Project', 'SYNO.Docker.Container', 'SYNO.FileStation.CreateFolder'],
    dockerShare: true,
    folders: [],
    projects: new Map(),
    calls: [],
    files: new Map(),
    signedOut: [],
    buildError: false,
    denied: new Set(),
    shares: ['backup'],
    ...over,
  };
}

const ok = (data: unknown = {}) => ({
  status: 200,
  body: Buffer.from(JSON.stringify({ success: true, data })),
});
const err = (code: number) => ({
  status: 200,
  body: Buffer.from(JSON.stringify({ success: false, error: { code } })),
});
const unq = (v: string | undefined) => (v === undefined ? '' : (JSON.parse(v) as string));

function access(s: Dsm): SynologyAccess {
  let nextId = 1;
  return {
    signIn: async () => ({ sid: SID, synotoken: TOKEN }),
    signOut: async (sid) => {
      s.signedOut.push(sid);
    },
    send: async (req: NasRequest) => {
      const params = Object.fromEntries(new URLSearchParams(req.body ?? ''));
      const { api = '', method = '' } = params;
      s.calls.push({ api, method, params, token: req.headers?.['X-SYNO-TOKEN'] });
      if (params._sid !== SID) return err(119);
      if (s.denied.has(`${api}.${method}`)) return err(105);
      if (req.path === '/webapi/query.cgi')
        return ok(Object.fromEntries(s.apis.map((a) => [a, { path: 'entry.cgi', maxVersion: 1 }])));
      const id = params.id ? unq(params.id) : '';
      const project = [...s.projects.values()].find((p) => p.id === id);
      switch (`${api}.${method}`) {
        case 'SYNO.FileStation.List.getinfo': {
          const path = (JSON.parse(params.path ?? '[]') as string[])[0] ?? '';
          const there = path === '/docker' ? s.dockerShare : s.shares.includes(path.slice(1));
          return there
            ? ok({ files: [{ path, additional: { real_path: `/volume1${path}` } }] })
            : ok({ files: [{ path, code: 408 }] });
        }
        case 'SYNO.FileStation.List.list_share':
          return ok({
            shares: [...(s.dockerShare ? ['docker'] : []), ...s.shares].map((name, i) => ({
              name,
              path: `/${name}`,
              additional: { volume_status: { freespace: 999 + i } },
            })),
          });
        case 'SYNO.FileStation.CreateFolder.create': {
          const paths = JSON.parse(params.folder_path ?? '[]') as string[];
          const names = JSON.parse(params.name ?? '[]') as string[];
          for (const [i, p] of paths.entries()) s.folders.push(`${p}/${names[i]}`);
          return ok({ folders: [] });
        }
        case 'SYNO.FileStation.Download.download': {
          const path = (JSON.parse(params.path ?? '[]') as string[])[0] ?? '';
          const text = s.files.get(path);
          return text === undefined
            ? { status: 404, body: Buffer.from('') }
            : { status: 200, body: Buffer.from(text) };
        }
        case 'SYNO.FileStation.DirSize.start':
          return ok({ taskid: 'T1' });
        case 'SYNO.FileStation.DirSize.status':
          return ok({ finished: true, total_size: 4321 });
        case 'SYNO.FileStation.Delete.delete':
          for (const p of JSON.parse(params.path ?? '[]') as string[])
            s.folders = s.folders.filter((f) => f !== p);
          return ok();
        case 'SYNO.Docker.Project.list':
          return ok(
            Object.fromEntries([...s.projects.values()].map((p) => [p.id, { ...p, content: undefined }])),
          );
        case 'SYNO.Docker.Project.get':
          return project ? ok(project) : err(2001);
        case 'SYNO.Docker.Project.create': {
          const p = {
            id: `uuid-${nextId++}`,
            name: unq(params.name),
            status: 'STOPPED',
            content: unq(params.content),
            share_path: unq(params.share_path),
          };
          s.projects.set(p.name, p);
          return ok({ id: p.id });
        }
        case 'SYNO.Docker.Project.update':
          if (!project) return err(2001);
          if (project.status === 'RUNNING') return err(2002);
          // Raw YAML on update.
          project.content = params.content ?? '';
          return ok();
        case 'SYNO.Docker.Project.build_stream':
          if (!project) return err(2001);
          // DSM may report an error for a build that worked.
          return { status: 200, body: Buffer.from(`Pulling…\nExit Code: ${s.buildError ? 1 : 0}\n`) };
        case 'SYNO.Docker.Project.start_stream':
          if (project) project.status = 'RUNNING';
          return { status: 200, body: Buffer.from('Started\nExit Code: 0\n') };
        case 'SYNO.Docker.Project.stop_stream':
          if (project) project.status = 'STOPPED';
          return { status: 200, body: Buffer.from('Exit Code: 0\n') };
        case 'SYNO.Docker.Project.clean':
          return ok();
        case 'SYNO.Docker.Project.delete':
          if (project) s.projects.delete(project.name);
          return ok();
        default:
          return err(103);
      }
    },
  };
}

function deps(over: Partial<NasDriverDeps> = {}): NasDriverDeps & { probed: string[] } {
  let now = 0;
  const probed: string[] = [];
  return {
    address: async () => '192.168.1.20',
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

const methods = (s: Dsm) => s.calls.map((c) => `${c.api.replace('SYNO.', '')}.${c.method}`);

describe('Synology ensure', () => {
  it('makes the folders and the project, gives it the compose, builds and starts it, then signs out', async () => {
    const s = dsm();
    const d = deps();
    const out = await new SynologyPlaceDriver(access(s), d, 'DiskStation').ensure(CLIENT, REST);
    expect(out).toEqual({
      address: '192.168.1.20',
      port: 8747,
      path: `/volume1/docker/whombat-backups/${CLIENT}`,
      location: 'docker',
    });
    expect(s.folders).toEqual([
      `/docker/whombat-backups/${CLIENT}`,
      '/docker/whombat-backups/.whombat',
      `/docker/${APP}`,
    ]);
    const project = s.projects.get(APP);
    expect(project).toMatchObject({ status: 'RUNNING', share_path: `/docker/${APP}` });
    const read = readPlaceCompose(project?.content);
    expect(read.dataPath).toBe(`/volume1/docker/whombat-backups/${CLIENT}`);
    expect(htpasswdMatches(read.htpasswd ?? '', REST)).toBe(true);
    const order = methods(s).filter((m) => m.startsWith('Docker.Project.') && !m.endsWith('.list'));
    expect(order).toEqual([
      'Docker.Project.create',
      'Docker.Project.update',
      'Docker.Project.build_stream',
      'Docker.Project.start_stream',
    ]);
    // Every call carries the SynoToken, strings JSON-quoted.
    expect(s.calls.every((c) => c.token === TOKEN)).toBe(true);
    expect(s.calls.find((c) => c.method === 'create' && c.api === 'SYNO.Docker.Project')?.params.name).toBe(
      `"${APP}"`,
    );
    expect(s.signedOut).toEqual([SID]);
    expect(d.probed).toEqual(['http://192.168.1.20:8747/']);
    expect(JSON.stringify(s.calls)).not.toContain(REST);
  });

  it('again: stops the running project before its compose changes, keeps port, folder and cleanup', async () => {
    const s = dsm();
    const driver = new SynologyPlaceDriver(access(s), deps(), 'DiskStation');
    await driver.ensure(CLIENT, REST);
    await driver.cleanup(CLIENT, 'repo', PLACE_KEEP_90);
    // Another Whombat's app on 8748; this one keeps 8747.
    s.projects.set('whombat-backup-other-whombat', {
      id: 'uuid-9',
      name: 'whombat-backup-other-whombat',
      status: 'RUNNING',
      content: 'services:\n  server:\n    ports: ["8748:8000"]\n',
      share_path: '/docker/x',
    });
    s.calls.length = 0;
    await driver.ensure(CLIENT, 'second-rest-password-ccccccccccccccccccccccc');
    const read = readPlaceCompose(s.projects.get(APP)?.content);
    expect(read.port).toBe(8747);
    expect(read.cleanup).toEqual({ repositoryPassword: 'repo', keep: PLACE_KEEP_90 });
    const order = methods(s).filter((m) =>
      /Project\.(update|stop_stream|build_stream|start_stream)$/.test(m),
    );
    expect(order).toEqual([
      'Docker.Project.stop_stream',
      'Docker.Project.update',
      'Docker.Project.build_stream',
      'Docker.Project.start_stream',
    ]);
  });

  it('a new Whombat on a NAS that has one takes the next port', async () => {
    const s = dsm();
    s.projects.set('whombat-backup-other-whombat', {
      id: 'uuid-9',
      name: 'whombat-backup-other-whombat',
      status: 'RUNNING',
      content: 'services:\n  server:\n    ports: ["8747:8000"]\n',
      share_path: '/docker/x',
    });
    const out = await new SynologyPlaceDriver(access(s), deps(), 'DiskStation').ensure(CLIENT, REST);
    expect(out.port).toBe(8748);
  });

  it('says why a Synology can’t: older DSM, no Container Manager', async () => {
    const old = dsm({ apis: ['SYNO.Docker.Container'] });
    expect(await new SynologyPlaceDriver(access(old), deps(), 'DS').unsupported()).toBe(
      BACKUP_PLACE_TEXT.reasons.synologyOld,
    );
    const none = dsm({ apis: [] });
    expect(await new SynologyPlaceDriver(access(none), deps(), 'DS').unsupported()).toBe(
      BACKUP_PLACE_TEXT.reasons.synologyNoContainerManager,
    );
    const noShare = dsm({ dockerShare: false });
    await expect(
      new SynologyPlaceDriver(access(noShare), deps(), 'DS').ensure(CLIENT, REST),
    ).rejects.toMatchObject({
      reason: 'unsupported',
    });
    expect(await new SynologyPlaceDriver(access(dsm()), deps(), 'DS').unsupported()).toBeNull();
  });

  it('a user that may not is told to be an administrator, and the session still ends', async () => {
    const s = dsm({ denied: new Set(['SYNO.Docker.Project.list']) });
    await expect(new SynologyPlaceDriver(access(s), deps(), 'DS').ensure(CLIENT, REST)).rejects.toMatchObject(
      {
        reason: 'refused',
        message: /administrators/,
      },
    );
    expect(s.signedOut).toEqual([SID]);
  });

  it('a project that never runs fails in one sentence', async () => {
    const s = dsm();
    const a = access(s);
    const send = a.send;
    a.send = async (req) => {
      if (String(req.body).includes('method=start_stream'))
        return { status: 200, body: Buffer.from('Exit Code: 1\n') };
      return send(req);
    };
    await expect(new SynologyPlaceDriver(a, deps(), 'DS').ensure(CLIENT, REST)).rejects.toMatchObject({
      reason: 'failed',
    });
  });
});

describe('Synology shared folders (BPL-13)', () => {
  it('lists the shared folders with their room, docker recommended and where backups went before', async () => {
    const look = await new SynologyPlaceDriver(access(dsm()), deps(), 'DS').look();
    expect(look.locations.map((l) => [l.id, l.freeBytes, l.recommended])).toEqual([
      ['docker', 999, true],
      ['backup', 1000, false],
    ]);
    expect(look).toMatchObject({ reason: null, freeBytes: 999, wasIn: 'docker' });
  });

  it('keeps the backups in the chosen folder; another one later starts the app on an empty folder there', async () => {
    const s = dsm();
    const driver = new SynologyPlaceDriver(access(s), deps(), 'DS');
    expect(await driver.ensure(CLIENT, REST)).toMatchObject({ location: 'docker' });
    await driver.cleanup(CLIENT, 'repo', PLACE_KEEP_90);
    const out = await driver.ensure(CLIENT, REST, 'backup');
    expect(out).toMatchObject({
      location: 'backup',
      path: `/volume1/backup/whombat-backups/${CLIENT}`,
      port: 8747,
    });
    // The project stays in docker; the backups and the status folder go to the new place, the old folder stays.
    expect(s.folders).toEqual(
      expect.arrayContaining([
        `/backup/whombat-backups/${CLIENT}`,
        '/backup/whombat-backups/.whombat',
        `/docker/whombat-backups/${CLIENT}`,
      ]),
    );
    const read = readPlaceCompose(s.projects.get(APP)?.content);
    expect(read.dataPath).toBe(`/volume1/backup/whombat-backups/${CLIENT}`);
    expect(read.cleanup).toEqual({ repositoryPassword: 'repo', keep: PLACE_KEEP_90 });
    // What it keeps is read where the backups are now.
    s.files.set(
      `/backup/whombat-backups/.whombat/${CLIENT}.cleanup.json`,
      '{"last_run_at":"2026-11-03T13:00:00Z","last_ok":true}',
    );
    expect(await driver.kept(CLIENT)).toMatchObject({ freeBytes: 1000, cleanup: { ok: true } });
    await expect(driver.ensure(CLIENT, REST, 'nowhere')).rejects.toMatchObject({
      reason: 'failed',
      message: BACKUP_PLACE_TEXT.location.gone,
    });
  });
});

describe('Synology cleanup, kept and forget', () => {
  it('kept: space, free space, and the cleanup’s status file', async () => {
    const s = dsm();
    const driver = new SynologyPlaceDriver(access(s), deps(), 'DS');
    expect(await driver.kept(CLIENT)).toBeNull();
    await driver.ensure(CLIENT, REST);
    await driver.cleanup(CLIENT, 'repo', PLACE_KEEP_90);
    s.files.set(
      `/docker/whombat-backups/.whombat/${CLIENT}.cleanup.json`,
      '{"last_run_at":"2026-11-03T13:00:00Z","last_ok":true,"last_error":"","keep_within_days":90}',
    );
    expect(await driver.kept(CLIENT)).toEqual({
      usedBytes: 4321,
      freeBytes: 999,
      cleanup: { on: true, keepDays: 90, lastAt: '2026-11-03T13:00:00Z', ok: true },
      byHand: false,
    });
  });

  it('forget: stops, cleans and deletes the project and its folder; deleteData the backups too', async () => {
    const s = dsm();
    const driver = new SynologyPlaceDriver(access(s), deps(), 'DS');
    await driver.ensure(CLIENT, REST);
    await driver.forget(CLIENT, false);
    expect(s.projects.has(APP)).toBe(false);
    expect(s.folders).toContain(`/docker/whombat-backups/${CLIENT}`);
    expect(s.folders).not.toContain(`/docker/${APP}`);
    await driver.forget(CLIENT, true);
    expect(s.folders).not.toContain(`/docker/whombat-backups/${CLIENT}`);
    expect(methods(s)).toEqual(expect.arrayContaining(['Docker.Project.clean', 'Docker.Project.delete']));
  });
});
