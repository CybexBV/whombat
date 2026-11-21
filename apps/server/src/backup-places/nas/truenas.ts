/**
 * A TrueNAS keeps backups (docs/decisions/backup-places.md BPL-03, BPL-12): a custom app from compose text over the
 * JSON-RPC socket the connection signs in on, its data in datasets of the apps pool.
 *
 * - The folder: the dataset `<pool>/whombat-backups` and one child per Whombat (`…/<client>`), so the NAS counts each
 *   one's space; the cleanup's status goes in `<root>/.whombat` (Docker makes it). The pool is the person's choice
 *   (`pool.query`, BPL-13): the one with most room is recommended; a place set up before there was a choice is in the
 *   apps pool. Another pool starts the app on an empty dataset there (a new repository); the old one stays.
 * - The app: `whombat-backup-<client>` (shortened to TrueNAS's 40 characters), `app.create` or `app.update` with
 *   `custom_compose_config_string`, then `app.start` when it was stopped (an update of a stopped app only saves it).
 *   Each is a job: the call answers its id and Whombat follows it with `core.get_jobs`.
 * - Removing: `app.delete` (a bind-mounted dataset stays); with `deleteData` the client's dataset too.
 * - NFS for a Proxmox server's backups: a dataset `<pool>/<name>`, `sharing.nfs.create` for exactly the server's
 *   addresses with root mapped to root (Proxmox writes as root), and the NFS service on.
 *
 * The calls follow TrueNAS's own documentation and middleware source for 24.10, 25.04 and 25.10 (high confidence);
 * no real TrueNAS has run them yet. What isn't certain: that a bind mount outside the apps dataset is never refused,
 * and the exact texts of a failed job.
 */
import {
  BACKUP_PLACE_KEEP_DAYS,
  BACKUP_PLACE_TEXT,
  type BackupPlaceKept,
  type JsonValue,
} from '@whombat/core';
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
  type NasDriverDeps,
  type NasLook,
  type NasPlaceDriver,
  NasPlaceError,
  type NfsPlaceDriver,
  nasLocation,
  type PlaceEndpoint,
  waitFor,
  waitUntilAnswers,
} from './types';

/** A JSON-RPC error TrueNAS answered. */
export class TrueNasCallError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | string | null,
    readonly errname: string | null,
  ) {
    super(`TrueNAS refused ${method}.`);
    this.name = 'TrueNasCallError';
  }
}

/** One signed-in socket to a TrueNAS. `call` throws `TrueNasCallError` for the service's errors. */
export interface TrueNasRpc {
  call(method: string, params?: JsonValue[]): Promise<unknown>;
  close(): void;
}

/** TrueNAS's app names: a letter first, lowercase letters, digits and dashes, at most 40. */
const APP_NAME_MAX = 40;
/** Ports a backup app never takes on a TrueNAS: its own web pages and SSH. */
const RESERVED_PORTS = [22, 80, 443];

type Row = Record<string, unknown>;

const rec = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null);
const first = (v: unknown): Row | null => (Array.isArray(v) ? rec(v[0]) : null);

/** `used`/`available` as TrueNAS gives them: `{parsed: n}` (or a plain number). */
function bytesOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(rec(v)?.parsed);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** The pool a dataset's folder is in (`/mnt/tank/whombat-backups/…` → `tank`), or null. */
export function poolOfPath(path: string | null | undefined): string | null {
  const m = path ? /^\/mnt\/([^/]+)\//.exec(path) : null;
  return m?.[1] ?? null;
}

/** A pool that can't take data now. */
const POOL_DOWN = new Set(['OFFLINE', 'FAULTED', 'UNAVAIL', 'REMOVED']);

/** `major.minor` of `system.info`'s version (“25.10.1”, “TrueNAS-SCALE-24.10.2”), or null. */
export function trueNasVersion(text: unknown): [number, number] | null {
  const m = typeof text === 'string' ? /(\d{2})\.(\d{1,2})/.exec(text) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export class TrueNasPlaceDriver implements NasPlaceDriver, NfsPlaceDriver {
  constructor(
    private readonly open: () => Promise<TrueNasRpc>,
    private readonly deps: NasDriverDeps,
    /** The connection's name, as the person calls it. */
    private readonly said: string,
  ) {}

  private async with<T>(fn: (rpc: TrueNasRpc) => Promise<T>): Promise<T> {
    const rpc = await this.open();
    try {
      return await fn(rpc);
    } catch (err) {
      if (err instanceof TrueNasCallError)
        throw new NasPlaceError(
          err.errname === 'EACCES' || err.errname === 'EPERM' ? 'refused' : 'failed',
          err.errname === 'EACCES' || err.errname === 'EPERM'
            ? `${this.said} didn’t let Whombat do that. Its key needs an admin user.`
            : `${this.said} refused a step of setting up the backup app.`,
        );
      throw err;
    } finally {
      rpc.close();
    }
  }

  /** Follows a job to its end (a call that answers a job id), or answers what the call answered. */
  private async job(rpc: TrueNasRpc, method: string, params: JsonValue[]): Promise<unknown> {
    const answer = await rpc.call(method, params);
    if (typeof answer !== 'number') return answer;
    const done = await waitFor(this.deps, this.deps.readyMs ?? 10 * 60_000, async () => {
      const job = first(await rpc.call('core.get_jobs', [[['id', '=', answer]]]));
      const state = job?.state;
      if (state === 'SUCCESS') return { ok: true, result: job?.result };
      if (state === 'FAILED' || state === 'ABORTED') return { ok: false, result: null };
      return null;
    });
    if (!done)
      throw new NasPlaceError(
        'failed',
        `${this.said} is still busy setting up the backup app. Try again in a while.`,
      );
    if (!done.ok) throw new NasPlaceError('failed', `${this.said} couldn’t set up the backup app.`);
    return done.result;
  }

  /** The apps pool, or `NasPlaceError` `unsupported` with the reason. */
  private async poolFor(rpc: TrueNasRpc): Promise<string> {
    const reason = await this.reason(rpc);
    if (reason) throw new NasPlaceError('unsupported', reason);
    const pool = rec(await rpc.call('docker.config', []))?.pool;
    return String(pool);
  }

  private async reason(rpc: TrueNasRpc): Promise<string | null> {
    const version = trueNasVersion(rec(await rpc.call('system.info', []))?.version);
    if (version && (version[0] < 24 || (version[0] === 24 && version[1] < 10)))
      return BACKUP_PLACE_TEXT.reasons.trueNasOld;
    const pool = rec(await rpc.call('docker.config', []))?.pool;
    if (typeof pool !== 'string' || !pool) return BACKUP_PLACE_TEXT.reasons.trueNasNoPool;
    const status = rec(await rpc.call('docker.status', []))?.status;
    if (status !== 'RUNNING') return BACKUP_PLACE_TEXT.reasons.trueNasAppsStopped;
    return null;
  }

  async unsupported(): Promise<string | null> {
    return this.with((rpc) => this.reason(rpc));
  }

  async look(): Promise<NasLook> {
    return this.with(async (rpc) => {
      const reason = await this.reason(rpc);
      if (reason) return { reason, freeBytes: null, locations: [], wasIn: null };
      const apps = String(rec(await rpc.call('docker.config', []))?.pool);
      const locations = await this.pools(rpc, apps);
      const best = locations.find((l) => l.recommended);
      return { reason: null, freeBytes: best?.freeBytes ?? null, locations, wasIn: apps };
    });
  }

  /**
   * The pools the backups can be kept on, with the room their root dataset has; the one with most room recommended.
   * A TrueNAS that doesn't list its pools still has its apps pool.
   */
  private async pools(rpc: TrueNasRpc, apps: string): Promise<LocationFacts[]> {
    const listed = await rpc.call('pool.query', []).catch((err: unknown) => {
      if (err instanceof TrueNasCallError) return [];
      throw err;
    });
    const names = (Array.isArray(listed) ? listed : [])
      .map(rec)
      .filter((p): p is Row => !!p && typeof p.name === 'string' && !POOL_DOWN.has(String(p.status)))
      .map((p) => ({ name: String(p.name), free: bytesOf(p.free) }));
    if (!names.some((p) => p.name === apps)) names.unshift({ name: apps, free: null });
    const out: LocationFacts[] = [];
    for (const p of names) {
      const root = first(await rpc.call('pool.dataset.query', [[['id', '=', p.name]]]));
      out.push(nasLocation(p.name, bytesOf(root?.available) ?? p.free, false));
    }
    const most = [...out].sort((a, b) => (b.freeBytes ?? -1) - (a.freeBytes ?? -1))[0];
    return out.map((l) => (l === most ? { ...l, recommended: true } : l));
  }

  /** The apps pool, or null (a read: a connection that only looks may ask it). */
  async appsPool(): Promise<string | null> {
    return this.with(async (rpc) => {
      const pool = rec(await rpc.call('docker.config', []))?.pool;
      return typeof pool === 'string' && pool ? pool : null;
    });
  }

  private async dataset(rpc: TrueNasRpc, id: string): Promise<{ mountpoint: string; row: Row | null }> {
    const found = first(await rpc.call('pool.dataset.query', [[['id', '=', id]]]));
    if (found) return { mountpoint: String(found.mountpoint ?? `/mnt/${id}`), row: found };
    const made = rec(
      await rpc.call('pool.dataset.create', [{ name: id, type: 'FILESYSTEM', share_type: 'GENERIC' }]),
    );
    return { mountpoint: String(made?.mountpoint ?? `/mnt/${id}`), row: made };
  }

  private async app(rpc: TrueNasRpc, name: string): Promise<Row | null> {
    return first(await rpc.call('app.query', [[['id', '=', name]], { extra: { retrieve_config: false } }]));
  }

  /** Creates or updates the app with `yaml`, starts it when it was stopped, and waits until it runs. */
  private async deploy(rpc: TrueNasRpc, name: string, yaml: string, existing: Row | null): Promise<void> {
    if (!existing)
      await this.job(rpc, 'app.create', [
        { app_name: name, custom_app: true, custom_compose_config_string: yaml },
      ]);
    else {
      await this.job(rpc, 'app.update', [name, { custom_compose_config_string: yaml }]);
      if (existing.state === 'STOPPED') await this.job(rpc, 'app.start', [name]);
    }
    const running = await waitFor(this.deps, this.deps.readyMs ?? 10 * 60_000, async () => {
      const app = await this.app(rpc, name);
      if (app?.state === 'RUNNING') return true;
      if (app?.state === 'STOPPED' || app?.state === 'CRASHED') return false;
      return null;
    });
    if (!running) throw new NasPlaceError('failed', `The backup app on ${this.said} didn’t start.`);
  }

  async ensure(client: string, restPassword: string, location?: string): Promise<PlaceEndpoint> {
    return this.with(async (rpc) => {
      const apps = await this.poolFor(rpc);
      const name = placeAppName(client, APP_NAME_MAX);
      const existing = await this.app(rpc, name);
      const had = existing ? readPlaceCompose(rec(await rpc.call('app.config', [name]))) : null;
      const now = poolOfPath(had?.dataPath);
      let pool = location ?? now;
      if (!pool) pool = (await this.pools(rpc, apps)).find((l) => l.recommended)?.id ?? apps;
      else if (location && location !== now && !(await this.pools(rpc, apps)).some((l) => l.id === location))
        throw new NasPlaceError('failed', BACKUP_PLACE_TEXT.location.gone);
      // Another pool than the app's: an empty folder there, a new repository (the old one stays where it is).
      const kept = had && pool !== now ? { ...had, dataPath: null } : had;
      const root = await this.dataset(rpc, `${pool}/${PLACE_ROOT_NAME}`);
      const data = await this.dataset(rpc, `${pool}/${PLACE_ROOT_NAME}/${client}`);
      let port = kept?.port ?? null;
      if (port === null) {
        const used = await rpc.call('app.used_ports', []);
        port = freePlacePort([...RESERVED_PORTS, ...(Array.isArray(used) ? used.map(Number) : [])]);
      }
      const yaml = placeCompose({
        client,
        port,
        // A folder the app had stays: the repository is in it (an app first set up by hand may use another).
        dataPath: kept?.dataPath ?? data.mountpoint,
        statusPath: `${root.mountpoint}/${STATUS_DIR_NAME}`,
        htpasswd: htpasswdLine(client, restPassword),
        // A cleanup the app had stays: setting the place up again doesn't stop clearing old backups.
        cleanup: kept?.cleanup ?? null,
      });
      await this.deploy(rpc, name, yaml, existing);
      const address = await this.deps.address();
      await waitUntilAnswers(this.deps, address, port, this.said);
      const path = kept?.dataPath ?? data.mountpoint;
      return { address, port, path, location: poolOfPath(path) ?? pool };
    });
  }

  async cleanup(client: string, repositoryPassword: string, keep: PlaceKeep): Promise<void> {
    await this.with(async (rpc) => {
      const apps = await this.poolFor(rpc);
      const name = placeAppName(client, APP_NAME_MAX);
      const existing = await this.app(rpc, name);
      const kept = existing ? readPlaceCompose(rec(await rpc.call('app.config', [name]))) : null;
      if (!existing || !kept?.port || !kept.htpasswd)
        throw new NasPlaceError('failed', `The backup app isn’t on ${this.said} any more. Set it up again.`);
      // The status folder sits beside the backups, in the pool they are in.
      const pool = poolOfPath(kept.dataPath) ?? apps;
      const root = await this.dataset(rpc, `${pool}/${PLACE_ROOT_NAME}`);
      const data = await this.dataset(rpc, `${pool}/${PLACE_ROOT_NAME}/${client}`);
      const yaml = placeCompose({
        client,
        port: kept.port,
        dataPath: kept.dataPath ?? data.mountpoint,
        statusPath: `${root.mountpoint}/${STATUS_DIR_NAME}`,
        htpasswd: kept.htpasswd,
        cleanup: { repositoryPassword, keep },
      });
      await this.deploy(rpc, name, yaml, existing);
    });
  }

  async forget(client: string, deleteData: boolean): Promise<void> {
    await this.with(async (rpc) => {
      const name = placeAppName(client, APP_NAME_MAX);
      const app = await this.app(rpc, name);
      const dataPath = app ? readPlaceCompose(rec(await rpc.call('app.config', [name]))).dataPath : null;
      if (app)
        // The images stay: another Whombat's backup app on this NAS may use them.
        await this.job(rpc, 'app.delete', [name, { remove_images: false, remove_ix_volumes: false }]);
      if (!deleteData) return;
      const apps = rec(await rpc.call('docker.config', []))?.pool;
      const pool = poolOfPath(dataPath) ?? apps;
      if (typeof pool !== 'string' || !pool) return;
      const id = `${pool}/${PLACE_ROOT_NAME}/${client}`;
      if (first(await rpc.call('pool.dataset.query', [[['id', '=', id]]])))
        await this.job(rpc, 'pool.dataset.delete', [id, { recursive: true }]);
    });
  }

  async kept(client: string): Promise<BackupPlaceKept | null> {
    return this.with(async (rpc) => {
      const name = placeAppName(client, APP_NAME_MAX);
      if (!(await this.app(rpc, name))) return null;
      const config = readPlaceCompose(rec(await rpc.call('app.config', [name])));
      const pool = poolOfPath(config.dataPath) ?? rec(await rpc.call('docker.config', []))?.pool;
      const ds =
        typeof pool === 'string' && pool
          ? first(
              await rpc.call('pool.dataset.query', [[['id', '=', `${pool}/${PLACE_ROOT_NAME}/${client}`]]]),
            )
          : null;
      const statusDir = `/mnt/${pool}/${PLACE_ROOT_NAME}/${STATUS_DIR_NAME}`;
      // TrueNAS's API lists files but doesn't read them: the status file's time is the last run, a `.failed` marker
      // beside it says that run failed.
      const ran = config.cleanup ? await this.statTime(rpc, `${statusDir}/${client}.cleanup.json`) : null;
      const failed = ran ? await this.statTime(rpc, `${statusDir}/${client}.cleanup.failed`) : null;
      return {
        usedBytes: bytesOf(ds?.used),
        freeBytes: bytesOf(ds?.available),
        cleanup: {
          on: config.cleanup !== null,
          keepDays: config.cleanup?.keep.allDays ?? BACKUP_PLACE_KEEP_DAYS,
          lastAt: ran,
          ok: ran ? failed === null : null,
        },
        byHand: false,
      };
    });
  }

  /** A file's modification time as ISO text, or null when it isn't there. */
  private async statTime(rpc: TrueNasRpc, path: string): Promise<string | null> {
    try {
      const stat = rec(await rpc.call('filesystem.stat', [path]));
      const mtime = Number(rec(stat?.mtime)?.$date ?? stat?.mtime);
      if (!Number.isFinite(mtime) || mtime <= 0) return null;
      // Seconds, or milliseconds in the `$date` form.
      return new Date(mtime > 1e11 ? mtime : mtime * 1000).toISOString();
    } catch (err) {
      if (err instanceof TrueNasCallError) return null;
      throw err;
    }
  }

  async nfsShare(name: string, clients: readonly string[]): Promise<{ export: string; addresses: string[] }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name))
      throw new NasPlaceError('failed', 'That share name can’t be used.');
    if (!clients.length || clients.some((c) => !/^[0-9a-fA-F:.]+$/.test(c)))
      throw new NasPlaceError('failed', 'The share needs the server’s addresses.');
    return this.with(async (rpc) => {
      const pool = await this.poolFor(rpc);
      const ds = await this.dataset(rpc, `${pool}/${name}`);
      const share = first(await rpc.call('sharing.nfs.query', [[['path', '=', ds.mountpoint]]]));
      if (!share)
        await rpc.call('sharing.nfs.create', [
          {
            path: ds.mountpoint,
            comment: 'Whombat: server backups',
            hosts: [...clients],
            maproot_user: 'root',
            maproot_group: 'root',
          },
        ]);
      else {
        // Adds the servers asked for; the ones it already had stay.
        const had = Array.isArray(share.hosts) ? share.hosts.map(String) : [];
        const hosts = [...new Set([...had, ...clients])];
        if (hosts.length !== had.length || share.enabled === false)
          await rpc.call('sharing.nfs.update', [Number(share.id), { hosts, enabled: true }]);
      }
      const service = first(await rpc.call('service.query', [[['service', '=', 'nfs']]]));
      if (service?.enable !== true) await rpc.call('service.update', ['nfs', { enable: true }]);
      if (service?.state !== 'RUNNING') {
        const started = await this.job(rpc, 'service.start', ['nfs', { silent: false }]);
        if (started === false)
          throw new NasPlaceError('failed', `${this.said} couldn’t start its NFS service.`);
      }
      return { export: ds.mountpoint, addresses: [await this.deps.address()] };
    });
  }
}
