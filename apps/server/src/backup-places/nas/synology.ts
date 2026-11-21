/**
 * A Synology keeps backups (docs/decisions/backup-places.md BPL-03): a Container Manager project made from compose
 * text through DSM's Web API, as the account the connection signs in with.
 *
 * - Signing in: a session of its own for the visit, with a SynoToken (`enable_syno_token`), since DSM 7.3.2 wants the
 *   `X-SYNO-TOKEN` header on calls that change something; signed out at the end.
 * - The folders: `whombat-backups/<client>` (the backups) and `whombat-backups/.whombat` (the cleanup's status) in the
 *   shared folder the person chose (BPL-13; `list_share`), Container Manager's `docker` recommended and where a place
 *   set up before there was a choice keeps them; the project's own `whombat-backup-<client>` always in `docker`, apart
 *   from the backups so removing the project never touches them. File Station gives their real `/volumeN/…` paths.
 *   Another shared folder than the app's starts it on an empty folder there (a new repository); the old one stays.
 * - The project (`SYNO.Docker.Project`): created empty and then given its compose (as DSM's own page does), `update`
 *   then `build_stream` (an update takes effect only after a build) and `start_stream`; stopped first when it ran.
 *   Built projects are checked by reading their status again: `build` may report an error and still have built.
 * - Removing: `stop_stream`, `clean` (compose down), `delete`, then the project's folder; with `deleteData` the
 *   backups' folder too.
 *
 * Confidence: sign-in, SYNO.API.Info and File Station follow Synology's own guides (high). `SYNO.Docker.Project` isn't
 * documented by Synology: the names and parameters (JSON-quoted strings, raw YAML on update) come from two open-source
 * clients and a DSM 7.3.2 report (medium). No real DSM has run these calls yet: the status values beyond RUNNING and
 * STOPPED, and whether `delete` leaves the project folder, are unconfirmed.
 */
import { BACKUP_PLACE_KEEP_DAYS, BACKUP_PLACE_TEXT, type BackupPlaceKept } from '@whombat/core';
import type { PlaceKeep } from '../keep';
import type { LocationFacts } from '../locations';
import {
  freePlacePort,
  PLACE_ROOT_NAME,
  placeAppName,
  placeCompose,
  readPlaceCompose,
  STATUS_DIR_NAME,
} from './compose';
import { htpasswdLine } from './htpasswd';
import {
  jsonAnswer,
  type NasDriverDeps,
  type NasLook,
  type NasPlaceDriver,
  NasPlaceError,
  type NasSend,
  nasLocation,
  type PlaceEndpoint,
  readCleanupStatus,
  waitFor,
  waitUntilAnswers,
} from './types';

/** How Whombat reaches a Synology. */
export interface SynologyAccess {
  send: NasSend;
  /** Signs in as the connection's account, asking for a SynoToken. Throws `NasPlaceError` when it can't. */
  signIn(): Promise<{ sid: string; synotoken: string | null }>;
  /** Signs the visit's session out (best effort). */
  signOut(sid: string): Promise<void>;
}

/** An error DSM answered (`{"success": false, "error": {"code": n}}`). */
export class SynologyError extends Error {
  constructor(
    readonly api: string,
    readonly code: number | null,
  ) {
    super(`DSM refused ${api} (${code ?? 'no code'}).`);
    this.name = 'SynologyError';
  }
}

/** The share Container Manager makes when it is installed. */
const SHARE = '/docker';
const SHARE_NAME = SHARE.slice(1);

/**
 * The shared folder a backup app's folder is in: `/volume1/<share>/…` → `<share>`; a folder inside the project (a place
 * set up by hand, `./backups`) is in `docker`.
 */
export function shareOfPath(path: string | null | undefined): string | null {
  if (!path) return null;
  if (!path.startsWith('/')) return SHARE_NAME;
  const m = /^\/volume[^/]*\/([^/]+)\//.exec(path);
  return m?.[1] ?? null;
}
/** Calls that pull images and start containers stream for as long as that takes. */
const STREAM_MS = 10 * 60_000;
/** DSM's codes for “you may not”: no permission, or a user that may not use the API. */
const DENIED = new Set([105, 402]);

const q = (s: string) => JSON.stringify(s);
const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** One signed-in visit. */
class Dsm {
  constructor(
    private readonly access: SynologyAccess,
    private readonly session: { sid: string; synotoken: string | null },
  ) {}

  private async post(path: string, values: Record<string, string>, deadlineMs?: number) {
    const body = new URLSearchParams({ ...values, _sid: this.session.sid }).toString();
    return this.access.send({
      method: 'POST',
      path,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(this.session.synotoken ? { 'X-SYNO-TOKEN': this.session.synotoken } : {}),
      },
      body,
      ...(deadlineMs ? { deadlineMs } : {}),
    });
  }

  /** One JSON method: its `data`, or `SynologyError`. */
  async call(
    api: string,
    version: number,
    method: string,
    params: Record<string, string> = {},
  ): Promise<unknown> {
    const answer = await this.post('/webapi/entry.cgi', { api, version: String(version), method, ...params });
    const json = rec(jsonAnswer(answer));
    if (json?.success === true) return json.data ?? null;
    const code = Number(rec(json?.error)?.code);
    throw new SynologyError(api, Number.isFinite(code) ? code : null);
  }

  /** A `*_stream` method: its output ends with `Exit Code: n` (the last one counts); null when it said none. */
  async stream(api: string, method: string, params: Record<string, string>): Promise<number | null> {
    const answer = await this.post('/webapi/entry.cgi', { api, version: '1', method, ...params }, STREAM_MS);
    const text = answer.body.toString('utf8');
    if (text.trimStart().startsWith('{')) {
      const json = rec(jsonAnswer(answer));
      if (json?.success === false) throw new SynologyError(api, Number(rec(json.error)?.code) || null);
      return null;
    }
    const codes = [...text.matchAll(/Exit Code:\s*(-?\d+)/g)];
    const last = codes.at(-1);
    return last ? Number(last[1]) : null;
  }

  /** A file's content, or null (DSM answers an error as JSON, or 404 in `open` mode). */
  async download(path: string): Promise<string | null> {
    const answer = await this.post('/webapi/entry.cgi', {
      api: 'SYNO.FileStation.Download',
      version: '2',
      method: 'download',
      path: JSON.stringify([path]),
      mode: q('open'),
    });
    if (answer.status !== 200) return null;
    const text = answer.body.toString('utf8');
    const json = rec(jsonAnswer(answer));
    if (json && json.success === false) return null;
    return text;
  }

  /** Which of these APIs DSM has (`SYNO.API.Info`, at `query.cgi`). */
  async apis(names: string[]): Promise<Set<string>> {
    const answer = await this.post('/webapi/query.cgi', {
      api: 'SYNO.API.Info',
      version: '1',
      method: 'query',
      query: names.join(','),
    });
    return new Set(Object.keys(rec(rec(jsonAnswer(answer))?.data) ?? {}));
  }
}

interface Project {
  id: string;
  name: string;
  status: string;
}

export class SynologyPlaceDriver implements NasPlaceDriver {
  constructor(
    private readonly access: SynologyAccess,
    private readonly deps: NasDriverDeps,
    private readonly said: string,
  ) {}

  private async with<T>(fn: (dsm: Dsm) => Promise<T>): Promise<T> {
    const session = await this.access.signIn();
    try {
      return await fn(new Dsm(this.access, session));
    } catch (err) {
      if (err instanceof SynologyError)
        throw DENIED.has(err.code ?? 0)
          ? new NasPlaceError(
              'refused',
              `${this.said} didn’t let Whombat do that. The user Whombat signs in as needs to be in the administrators group.`,
            )
          : new NasPlaceError('failed', `${this.said} refused a step of setting up the backup app.`);
      throw err;
    } finally {
      await this.access.signOut(session.sid);
    }
  }

  private async reason(dsm: Dsm): Promise<string | null> {
    const apis = await dsm.apis(['SYNO.Docker.Project', 'SYNO.Docker.Container']);
    if (!apis.has('SYNO.Docker.Project'))
      return apis.has('SYNO.Docker.Container')
        ? BACKUP_PLACE_TEXT.reasons.synologyOld
        : BACKUP_PLACE_TEXT.reasons.synologyNoContainerManager;
    if (!(await this.shareRealPath(dsm))) return BACKUP_PLACE_TEXT.reasons.synologyNoContainerManager;
    return null;
  }

  async unsupported(): Promise<string | null> {
    return this.with((dsm) => this.reason(dsm));
  }

  async look(): Promise<NasLook> {
    return this.with(async (dsm) => {
      const reason = await this.reason(dsm);
      if (reason) return { reason, freeBytes: null, locations: [], wasIn: null };
      const locations = await this.shares(dsm);
      const free = locations.find((l) => l.recommended)?.freeBytes ?? (await this.free(dsm));
      return { reason, freeBytes: free, locations, wasIn: SHARE_NAME };
    });
  }

  /** The shared folders the backups can be kept in, with their volume's room; `docker` recommended. */
  private async shares(dsm: Dsm): Promise<LocationFacts[]> {
    try {
      const data = rec(
        await dsm.call('SYNO.FileStation.List', 2, 'list_share', {
          additional: JSON.stringify(['real_path', 'volume_status']),
        }),
      );
      const list = (Array.isArray(data?.shares) ? data.shares : [])
        .map(rec)
        .filter((sh): sh is Record<string, unknown> => !!sh && typeof sh.name === 'string' && !!sh.name)
        .map((sh) => {
          const free = Number(rec(rec(sh.additional)?.volume_status)?.freespace);
          return nasLocation(String(sh.name), Number.isFinite(free) && free >= 0 ? free : null, false);
        });
      const pick = list.find((l) => l.id === SHARE_NAME) ?? list[0];
      return list.map((l) => (l === pick ? { ...l, recommended: true } : l));
    } catch (err) {
      if (err instanceof SynologyError && !DENIED.has(err.code ?? 0)) return [];
      throw err;
    }
  }

  /** `/volume1/docker` (or another shared folder's real path), or null when the share isn't there. */
  private async shareRealPath(dsm: Dsm, share = SHARE): Promise<string | null> {
    try {
      const data = rec(
        await dsm.call('SYNO.FileStation.List', 2, 'getinfo', {
          path: JSON.stringify([share]),
          additional: JSON.stringify(['real_path']),
        }),
      );
      const file = rec(Array.isArray(data?.files) ? data.files[0] : null);
      const real = rec(file?.additional)?.real_path;
      return typeof real === 'string' && real.startsWith('/') && !rec(file?.code) ? real : null;
    } catch (err) {
      if (err instanceof SynologyError && !DENIED.has(err.code ?? 0)) return null;
      throw err;
    }
  }

  /**
   * Makes the folders in shared folder `name` (idempotent: `force_parent`) and answers their real paths. The support
   * check comes first, so ensure and cleanup refuse a NAS that can't keep backups before anything is made.
   */
  private async folders(
    dsm: Dsm,
    client: string,
    name: string = SHARE_NAME,
  ): Promise<{ data: string; status: string; project: string }> {
    const reason = await this.reason(dsm);
    if (reason) throw new NasPlaceError('unsupported', reason);
    const share = await this.shareRealPath(dsm, `/${name}`);
    if (!share) throw new NasPlaceError('failed', BACKUP_PLACE_TEXT.location.gone);
    const root = `/${name}/${PLACE_ROOT_NAME}`;
    await dsm.call('SYNO.FileStation.CreateFolder', 2, 'create', {
      folder_path: JSON.stringify([root, root, SHARE]),
      name: JSON.stringify([client, STATUS_DIR_NAME, placeAppName(client)]),
      force_parent: 'true',
    });
    return {
      data: `${share}/${PLACE_ROOT_NAME}/${client}`,
      status: `${share}/${PLACE_ROOT_NAME}/${STATUS_DIR_NAME}`,
      project: `${SHARE}/${placeAppName(client)}`,
    };
  }

  private async projects(dsm: Dsm): Promise<Project[]> {
    const data = await dsm.call('SYNO.Docker.Project', 1, 'list');
    const list = Array.isArray(data) ? data : Object.values(rec(data) ?? {});
    return list
      .map(rec)
      .filter((p): p is Record<string, unknown> => p !== null)
      .map((p) => ({ id: String(p.id ?? ''), name: String(p.name ?? ''), status: String(p.status ?? '') }));
  }

  private async project(dsm: Dsm, client: string): Promise<Project | null> {
    const name = placeAppName(client);
    return (await this.projects(dsm)).find((p) => p.name === name) ?? null;
  }

  private async content(dsm: Dsm, id: string): Promise<string | null> {
    const got = rec(await dsm.call('SYNO.Docker.Project', 1, 'get', { id: q(id) }));
    return typeof got?.content === 'string' ? got.content : null;
  }

  /** Ports other Whombats' backup apps on this NAS use. */
  private async otherPorts(dsm: Dsm, mine: string, projects: Project[]): Promise<number[]> {
    const out: number[] = [];
    for (const p of projects)
      if (p.name.startsWith('whombat-backup-') && p.name !== mine) {
        const port = readPlaceCompose(await this.content(dsm, p.id)).port;
        if (port !== null) out.push(port);
      }
    return out;
  }

  /** Gives the project `yaml`, builds and starts it, and waits until DSM says it runs. */
  private async deploy(dsm: Dsm, project: Project, yaml: string): Promise<void> {
    const id = q(project.id);
    if (project.status === 'RUNNING') await dsm.stream('SYNO.Docker.Project', 'stop_stream', { id });
    await dsm.call('SYNO.Docker.Project', 1, 'update', { id, content: yaml });
    // Its exit code is only a hint: DSM may report an error for a build that worked (the status below decides).
    try {
      await dsm.stream('SYNO.Docker.Project', 'build_stream', { id });
    } catch (err) {
      if (!(err instanceof SynologyError) || DENIED.has(err.code ?? 0)) throw err;
    }
    let status = await this.statusOf(dsm, project.id);
    if (status !== 'RUNNING') {
      await dsm.stream('SYNO.Docker.Project', 'start_stream', { id });
      status = await waitFor(this.deps, this.deps.readyMs ?? 10 * 60_000, async () => {
        const now = await this.statusOf(dsm, project.id);
        return now === 'RUNNING' ? now : null;
      });
    }
    if (status !== 'RUNNING')
      throw new NasPlaceError('failed', `The backup app on ${this.said} didn’t start.`);
  }

  private async statusOf(dsm: Dsm, id: string): Promise<string | null> {
    return (await this.projects(dsm)).find((p) => p.id === id)?.status ?? null;
  }

  async ensure(client: string, restPassword: string, location?: string): Promise<PlaceEndpoint> {
    return this.with(async (dsm) => {
      const name = placeAppName(client);
      const projects = await this.projects(dsm);
      let project = projects.find((p) => p.name === name) ?? null;
      const had = project ? readPlaceCompose(await this.content(dsm, project.id)) : null;
      const now = shareOfPath(had?.dataPath);
      const share = location ?? now ?? SHARE_NAME;
      const paths = await this.folders(dsm, client, share);
      // Another shared folder than the app's: an empty folder there, a new repository (the old one stays where it is).
      const kept = had && share !== now ? { ...had, dataPath: null } : had;
      const port = kept?.port ?? freePlacePort(await this.otherPorts(dsm, name, projects));
      const yaml = placeCompose({
        client,
        port,
        // A folder the app had stays: the repository is in it (an app first set up by hand may use another).
        dataPath: kept?.dataPath ?? paths.data,
        statusPath: paths.status,
        htpasswd: htpasswdLine(client, restPassword),
        cleanup: kept?.cleanup ?? null,
      });
      if (!project) {
        // Empty first, then the compose: what DSM's own page does.
        await dsm.call('SYNO.Docker.Project', 1, 'create', {
          name: q(name),
          share_path: q(paths.project),
          content: q(''),
          enable_service_portal: 'false',
          service_portal_name: q(''),
          service_portal_port: '0',
          service_portal_protocol: q(''),
        });
        project = await this.project(dsm, client);
        if (!project) throw new NasPlaceError('failed', `${this.said} didn’t make the backup app’s project.`);
      }
      await this.deploy(dsm, project, yaml);
      const address = await this.deps.address();
      await waitUntilAnswers(this.deps, address, port, this.said);
      const path = kept?.dataPath ?? paths.data;
      return { address, port, path, location: shareOfPath(path) ?? share };
    });
  }

  async cleanup(client: string, repositoryPassword: string, keep: PlaceKeep): Promise<void> {
    await this.with(async (dsm) => {
      const project = await this.project(dsm, client);
      const kept = project ? readPlaceCompose(await this.content(dsm, project.id)) : null;
      if (!project || !kept?.port || !kept.htpasswd)
        throw new NasPlaceError('failed', `The backup app isn’t on ${this.said} any more. Set it up again.`);
      // The status folder sits beside the backups, in the shared folder they are in.
      const paths = await this.folders(dsm, client, shareOfPath(kept.dataPath) ?? SHARE_NAME);
      const yaml = placeCompose({
        client,
        port: kept.port,
        dataPath: kept.dataPath ?? paths.data,
        statusPath: paths.status,
        htpasswd: kept.htpasswd,
        cleanup: { repositoryPassword, keep },
      });
      await this.deploy(dsm, project, yaml);
    });
  }

  async forget(client: string, deleteData: boolean): Promise<void> {
    await this.with(async (dsm) => {
      const project = await this.project(dsm, client);
      const share = project
        ? shareOfPath(readPlaceCompose(await this.content(dsm, project.id)).dataPath)
        : null;
      if (project) {
        const id = q(project.id);
        await dsm.stream('SYNO.Docker.Project', 'stop_stream', { id });
        await dsm.call('SYNO.Docker.Project', 1, 'clean', { id });
        await dsm.call('SYNO.Docker.Project', 1, 'delete', { id });
      }
      const gone = [`${SHARE}/${placeAppName(client)}`];
      if (deleteData) gone.push(`/${share ?? SHARE_NAME}/${PLACE_ROOT_NAME}/${client}`);
      try {
        await dsm.call('SYNO.FileStation.Delete', 2, 'delete', {
          path: JSON.stringify(gone),
          recursive: 'true',
        });
      } catch (err) {
        // 408: it was never there (or is gone already).
        if (!(err instanceof SynologyError) || err.code !== 408) throw err;
      }
    });
  }

  async kept(client: string): Promise<BackupPlaceKept | null> {
    return this.with(async (dsm) => {
      const project = await this.project(dsm, client);
      if (!project) return null;
      const config = readPlaceCompose(await this.content(dsm, project.id));
      const share = `/${shareOfPath(config.dataPath) ?? SHARE_NAME}`;
      const status = config.cleanup
        ? readCleanupStatus(
            await dsm.download(`${share}/${PLACE_ROOT_NAME}/${STATUS_DIR_NAME}/${client}.cleanup.json`),
          )
        : null;
      return {
        usedBytes: await this.used(dsm, `${share}/${PLACE_ROOT_NAME}/${client}`),
        freeBytes: await this.free(dsm, share),
        cleanup: {
          on: config.cleanup !== null,
          keepDays: config.cleanup?.keep.allDays ?? BACKUP_PLACE_KEEP_DAYS,
          lastAt: status?.lastAt ?? null,
          ok: status?.ok ?? null,
        },
        byHand: false,
      };
    });
  }

  /** The backups' size (File Station counts it in the background), or null when it takes too long. */
  private async used(dsm: Dsm, path: string): Promise<number | null> {
    try {
      const task = rec(
        await dsm.call('SYNO.FileStation.DirSize', 2, 'start', { path: JSON.stringify([path]) }),
      );
      const taskid = typeof task?.taskid === 'string' ? task.taskid : null;
      if (!taskid) return null;
      const size = await waitFor(
        this.deps,
        20_000,
        async () => {
          const s = rec(await dsm.call('SYNO.FileStation.DirSize', 2, 'status', { taskid: q(taskid) }));
          return s?.finished === true && typeof s.total_size === 'number' ? s.total_size : null;
        },
        1000,
      );
      if (size === null) await dsm.call('SYNO.FileStation.DirSize', 2, 'stop', { taskid: q(taskid) });
      return size;
    } catch (err) {
      if (err instanceof SynologyError) return null;
      throw err;
    }
  }

  /** Free space on a shared folder's volume (`docker`'s by default). */
  private async free(dsm: Dsm, path = SHARE): Promise<number | null> {
    try {
      const data = rec(
        await dsm.call('SYNO.FileStation.List', 2, 'list_share', {
          additional: JSON.stringify(['volume_status']),
        }),
      );
      const shares = Array.isArray(data?.shares) ? data.shares.map(rec) : [];
      const share = shares.find((s) => s?.path === path || s?.name === path.slice(1));
      const free = Number(rec(rec(share?.additional)?.volume_status)?.freespace);
      return Number.isFinite(free) && free >= 0 ? free : null;
    } catch (err) {
      if (err instanceof SynologyError) return null;
      throw err;
    }
  }
}
