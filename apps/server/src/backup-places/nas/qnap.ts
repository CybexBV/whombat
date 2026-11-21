/**
 * A QNAP keeps backups (docs/decisions/backup-places.md BPL-03): a Container Station 3 application made from compose
 * text, as the account the connection signs in with (QTS's session, which Container Station 3 takes as a bearer token).
 *
 * - The folders, through File Station in the shared folder the person chose (BPL-13; `get_tree`), Container Station's
 *   `Container` recommended and where a place set up before there was a choice keeps them: `whombat-backups/<client>`
 *   and `whombat-backups/.whombat`; the compose names them by their host paths, `/share/<share>/…`. Another shared
 *   folder than the app's starts it on an empty folder there (a new repository); the old one stays.
 * - The application `whombat-backup-<client>` (shortened to Container Station's 32 characters): created from the
 *   compose; one that is there already is removed (its backups stay: they are a folder, not a volume) and created
 *   again with the new compose, since replacing it in place isn't known to work. Each change answers a task Whombat
 *   follows until it is done, then the application's status decides.
 * - Removing: the application; with `deleteData` the backups' folder too.
 *
 * Confidence: QTS sign-in and File Station follow QNAP's File Station API v5 (high). Container Station 3's
 * `/container-station/api/v3` isn't documented by QNAP: the calls come from one open-source client tested on Container
 * Station 3.0.7 (2024), and the QTS session as a bearer token from another (medium-low). No real QNAP has run them yet;
 * task states other than `completed` are unknown.
 */
import { BACKUP_PLACE_KEEP_DAYS, BACKUP_PLACE_TEXT, type BackupPlaceKept } from '@whombat/core';
import type { PlaceKeep } from '../keep';
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
  type NasAnswer,
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

/** How Whombat reaches a QNAP: requests signed with the connection's session (`sid`, and as a bearer token). */
export interface QnapAccess {
  send: NasSend;
}

/** Container Station's share, as File Station and the host name it. */
const SHARE = 'Container';
const CS3 = '/container-station/api/v3';
const FILES = '/cgi-bin/filemanager/utilRequest.cgi';
/** Container Station's application names: at most 32 characters. */
const APP_NAME_MAX = 32;

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The shared folder a backup app's folder is in: `/share/<share>/…` → `<share>`. */
export function shareOfPath(path: string | null | undefined): string | null {
  const m = path ? /^\/share\/([^/]+)\//.exec(path) : null;
  return m?.[1] ?? null;
}

/** A call Container Station or QTS refused. */
class QnapRefused extends Error {
  constructor(readonly status: number) {
    super(`QNAP answered ${status}.`);
    this.name = 'QnapRefused';
  }
}

export class QnapPlaceDriver implements NasPlaceDriver {
  constructor(
    private readonly access: QnapAccess,
    private readonly deps: NasDriverDeps,
    private readonly said: string,
  ) {}

  private async with<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof QnapRefused)
        throw err.status === 401 || err.status === 403
          ? new NasPlaceError(
              'refused',
              `${this.said} didn’t let Whombat do that. The user Whombat signs in as needs to be in the administrators group.`,
            )
          : new NasPlaceError('failed', `${this.said} refused a step of setting up the backup app.`);
      throw err;
    }
  }

  private async cs(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    deadlineMs?: number,
  ) {
    const answer = await this.access.send({
      method,
      path: `${CS3}${path}`,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(deadlineMs ? { deadlineMs } : {}),
    });
    return answer;
  }

  private static dataOf(answer: NasAnswer): unknown {
    if (answer.status >= 400) throw new QnapRefused(answer.status);
    return rec(jsonAnswer(answer))?.data ?? null;
  }

  /** A File Station call: `status` 1 is fine (33: it exists already, for a new folder). */
  private async files(query: Record<string, string>): Promise<Record<string, unknown> | unknown[] | null> {
    const answer = await this.access.send({ method: 'GET', path: FILES, query });
    if (answer.status >= 400) throw new QnapRefused(answer.status);
    const json = jsonAnswer(answer);
    const status = Number(rec(json)?.status);
    if (status === 4) throw new QnapRefused(403);
    return (json as Record<string, unknown> | unknown[] | null) ?? null;
  }

  /** The shared folders File Station lists (`get_tree` of `share_root`), by name. */
  private async shareNames(): Promise<string[]> {
    const tree = await this.files({ func: 'get_tree', is_iso: '0', node: 'share_root' });
    const nodes = Array.isArray(tree)
      ? tree
      : Array.isArray(rec(tree)?.datas)
        ? (rec(tree)?.datas as unknown[])
        : [];
    return nodes.flatMap((n) => {
      const node = rec(n);
      const name = typeof node?.text === 'string' ? node.text : String(node?.id ?? '').replace(/^\//, '');
      return name ? [name] : [];
    });
  }

  private async reasonAndShares(): Promise<{ reason: string | null; shares: string[] }> {
    const overview = await this.cs('GET', '/overview');
    const none = { reason: BACKUP_PLACE_TEXT.reasons.qnapNoContainerStation, shares: [] };
    if (overview.status === 404) return none;
    if (overview.status === 401 || overview.status === 403) throw new QnapRefused(overview.status);
    if (overview.status >= 400) return none;
    const shares = await this.shareNames();
    return shares.includes(SHARE) ? { reason: null, shares } : none;
  }

  private async reason(): Promise<string | null> {
    return (await this.reasonAndShares()).reason;
  }

  async unsupported(): Promise<string | null> {
    return this.with(() => this.reason());
  }

  async look(): Promise<NasLook> {
    return this.with(async () => {
      const { reason, shares } = await this.reasonAndShares();
      if (reason) return { reason, freeBytes: null, locations: [], wasIn: null };
      // File Station tells a volume's free space only in a unit it rounds to: none here.
      const locations = shares.map((name) => nasLocation(name, null, name === SHARE));
      return { reason: null, freeBytes: null, locations, wasIn: SHARE };
    });
  }

  /**
   * Makes the folders in shared folder `share`; the support check comes first, so nothing is made on a QNAP that can't
   * keep backups.
   */
  private async folders(client: string, share: string = SHARE): Promise<{ data: string; status: string }> {
    const { reason, shares } = await this.reasonAndShares();
    if (reason) throw new NasPlaceError('unsupported', reason);
    if (!shares.includes(share)) throw new NasPlaceError('failed', BACKUP_PLACE_TEXT.location.gone);
    const root = `/${share}/${PLACE_ROOT_NAME}`;
    for (const [dest_path, dest_folder] of [
      [`/${share}`, PLACE_ROOT_NAME],
      [root, client],
      [root, STATUS_DIR_NAME],
    ] as const) {
      const out = rec(await this.files({ func: 'createdir', dest_path, dest_folder }));
      const status = Number(out?.status);
      if (status !== 1 && status !== 33)
        throw new NasPlaceError('failed', `${this.said} didn’t make the backups’ folder.`);
    }
    const host = `/share/${share}/${PLACE_ROOT_NAME}`;
    return { data: `${host}/${client}`, status: `${host}/${STATUS_DIR_NAME}` };
  }

  /** The application's compose, or null when there is no such application. */
  private async inspect(name: string): Promise<string | null> {
    const answer = await this.cs('GET', `/apps/${encodeURIComponent(name)}/inspect`);
    if (answer.status === 404 || answer.status === 400) return null;
    const yml = rec(QnapPlaceDriver.dataOf(answer))?.yml;
    return typeof yml === 'string' ? yml : null;
  }

  private async apps(): Promise<{ name: string; status: string }[]> {
    const data = rec(QnapPlaceDriver.dataOf(await this.cs('GET', '/overview')));
    const apps = Array.isArray(data?.app) ? data.app.map(rec) : [];
    return apps
      .filter((a): a is Record<string, unknown> => a !== null)
      .map((a) => ({ name: String(a.name ?? ''), status: String(a.status ?? '') }));
  }

  /** Follows a change's task until it is done. */
  private async task(answer: NasAnswer): Promise<void> {
    const id = rec(QnapPlaceDriver.dataOf(answer))?.taskID;
    if (id === undefined || id === null) return;
    const done = await waitFor(this.deps, this.deps.readyMs ?? 10 * 60_000, async () => {
      const data = rec(QnapPlaceDriver.dataOf(await this.cs('GET', '/tasks')));
      const items = Array.isArray(data?.items) ? data.items.map(rec) : [];
      const task = items.find((t) => String(t?.id) === String(id));
      // A task that left the list is over; the application's status says how it went.
      if (!task || task.state === 'completed') return 'done';
      if (task.state === 'failed' || task.state === 'error') return 'failed';
      return null;
    });
    if (done !== 'done') throw new NasPlaceError('failed', `${this.said} couldn’t set up the backup app.`);
  }

  private async remove(name: string): Promise<void> {
    await this.task(await this.cs('DELETE', '/apps', { apps: [name], removeVolume: false }));
  }

  /** Puts the application up with `yaml` (removing the one there first) and waits until it runs. */
  private async deploy(name: string, yaml: string, exists: boolean): Promise<void> {
    if (exists) await this.remove(name);
    await this.task(
      await this.cs(
        'POST',
        '/apps/compose',
        {
          name,
          yml: yaml,
          default_url: { port: 0, service: '' },
          cpu_limit: 0,
          mem_limit: 0,
          mem_reservation: 0,
        },
        10 * 60_000,
      ),
    );
    let status = (await this.apps()).find((a) => a.name === name)?.status;
    if (status !== 'running') {
      await this.task(await this.cs('PUT', '/apps/start', { apps: [name] }));
      status =
        (await waitFor(this.deps, this.deps.readyMs ?? 10 * 60_000, async () => {
          const now = (await this.apps()).find((a) => a.name === name)?.status;
          return now === 'running' ? now : null;
        })) ?? undefined;
    }
    if (status !== 'running')
      throw new NasPlaceError('failed', `The backup app on ${this.said} didn’t start.`);
  }

  /** Ports other Whombats' backup apps on this NAS use. */
  private async otherPorts(mine: string): Promise<number[]> {
    const out: number[] = [];
    for (const app of await this.apps())
      if (app.name.startsWith('whombat-backup-') && app.name !== mine) {
        const port = readPlaceCompose(await this.inspect(app.name)).port;
        if (port !== null) out.push(port);
      }
    return out;
  }

  async ensure(client: string, restPassword: string, location?: string): Promise<PlaceEndpoint> {
    return this.with(async () => {
      const name = placeAppName(client, APP_NAME_MAX);
      const existing = await this.inspect(name);
      const had = existing !== null ? readPlaceCompose(existing) : null;
      const now = shareOfPath(had?.dataPath);
      const share = location ?? now ?? SHARE;
      const paths = await this.folders(client, share);
      // Another shared folder than the app's: an empty folder there, a new repository (the old one stays where it is).
      const kept = had && share !== now ? { ...had, dataPath: null } : had;
      const port = kept?.port ?? freePlacePort(await this.otherPorts(name));
      const yaml = placeCompose({
        client,
        port,
        // A folder the app had stays: the repository is in it (an app first set up by hand may use another).
        dataPath: kept?.dataPath ?? paths.data,
        statusPath: paths.status,
        htpasswd: htpasswdLine(client, restPassword),
        cleanup: kept?.cleanup ?? null,
        withVersion: true,
      });
      await this.deploy(name, yaml, existing !== null);
      const address = await this.deps.address();
      await waitUntilAnswers(this.deps, address, port, this.said);
      const path = kept?.dataPath ?? paths.data;
      return { address, port, path, location: shareOfPath(path) ?? share };
    });
  }

  async cleanup(client: string, repositoryPassword: string, keep: PlaceKeep): Promise<void> {
    await this.with(async () => {
      const name = placeAppName(client, APP_NAME_MAX);
      const existing = await this.inspect(name);
      const kept = existing !== null ? readPlaceCompose(existing) : null;
      if (!kept?.port || !kept.htpasswd)
        throw new NasPlaceError('failed', `The backup app isn’t on ${this.said} any more. Set it up again.`);
      // The status folder sits beside the backups, in the shared folder they are in.
      const paths = await this.folders(client, shareOfPath(kept.dataPath) ?? SHARE);
      const yaml = placeCompose({
        client,
        port: kept.port,
        dataPath: kept.dataPath ?? paths.data,
        statusPath: paths.status,
        htpasswd: kept.htpasswd,
        cleanup: { repositoryPassword, keep },
        withVersion: true,
      });
      await this.deploy(name, yaml, true);
    });
  }

  async forget(client: string, deleteData: boolean): Promise<void> {
    await this.with(async () => {
      const name = placeAppName(client, APP_NAME_MAX);
      const yml = await this.inspect(name);
      const share = shareOfPath(readPlaceCompose(yml).dataPath) ?? SHARE;
      if (yml !== null) await this.remove(name);
      if (!deleteData) return;
      const out = rec(
        await this.files({
          func: 'delete',
          path: `/${share}/${PLACE_ROOT_NAME}`,
          file_total: '1',
          file_name: client,
          force: '1',
        }),
      );
      // 5: it isn't there.
      const status = Number(out?.status);
      if (status !== 1 && status !== 5)
        throw new NasPlaceError('failed', `${this.said} didn’t remove the backups’ folder.`);
    });
  }

  async kept(client: string): Promise<BackupPlaceKept | null> {
    return this.with(async () => {
      const yml = await this.inspect(placeAppName(client, APP_NAME_MAX));
      if (yml === null) return null;
      const config = readPlaceCompose(yml);
      const share = shareOfPath(config.dataPath) ?? SHARE;
      const status = config.cleanup ? readCleanupStatus(await this.download(client, share)) : null;
      const size = rec(
        await this.files({
          func: 'get_file_size',
          path: `/${share}/${PLACE_ROOT_NAME}`,
          total: '1',
          name: client,
        }),
      );
      const used = Number(size?.size);
      return {
        usedBytes: Number(size?.status) === 1 && Number.isFinite(used) ? used : null,
        // File Station tells a volume's free space only in a unit it rounds to; not worth showing as bytes.
        freeBytes: null,
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

  /** The cleanup's status file, or null. */
  private async download(client: string, share: string): Promise<string | null> {
    const answer = await this.access.send({
      method: 'GET',
      path: FILES,
      query: {
        func: 'download',
        isfolder: '0',
        source_path: `/${share}/${PLACE_ROOT_NAME}/${STATUS_DIR_NAME}`,
        source_file: `${client}.cleanup.json`,
        source_total: '1',
      },
    });
    if (answer.status !== 200) return null;
    const text = answer.body.toString('utf8');
    // File Station answers a missing file with its own status JSON.
    return readCleanupStatus(text) ? text : null;
  }
}
