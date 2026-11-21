/**
 * The fake hosts service's backup places (Whombat backup-places.md; the build brief §2.1, hosts HS-203…): each
 * server's `backup_place` in its detail, and the routes that make one keep a Whombat's backups — ensure the backup app,
 * set its cleanup, remove it — plus an Unraid share over NFS and a Proxmox NFS storage for the care plan (BPL-12).
 *
 * BlackBox (Unraid, NFS on) can keep backups, in its new `whombat-backups` share or one of its others (`locations`; an
 * ensure with another `location` moves the Whombat's folder there and answers `moved`); basalt runs this Whombat
 * (`self`); shale (Proxmox) has no Docker. The
 * other servers report nothing yet, like an older agent. Tests change a server's `backup_place` through `placeOf` and
 * read what the routes were given in `requests` (the hub's audit has no passwords; this fake keeps them for the tests).
 */
import { type FakeAnswer, type FakeHandler, type FakeRequest, type Json, ok, problem } from './fake-http';
import type { ManageHost } from './fake-manage';

const ROLE_RANK: Record<string, number> = { viewer: 0, operator: 1, admin: 2 };
const CLIENT = /^[a-z0-9][a-z0-9-]{2,62}$/;
const FIRST_PORT = 8747;
const REST_IMAGE = 'restic/rest-server@sha256:fake';

export class FakeBackupPlaces {
  /** The next ensure fails with this problem (once). */
  failNextEnsure: FakeAnswer | null = null;
  /** Folders the ensure route moved to another location. */
  moves = 0;
  /** A helper from before the keep windows: its cleanup reports no `keep` (and ignores the windows). */
  olderHelper = false;
  /** NFS exports made (`<server>/<name>` → the addresses it is shared with). */
  readonly exports = new Map<string, string[]>();

  constructor(readonly host: ManageHost) {}

  init(): void {
    this.#set('blackbox', {
      supported: true,
      reason: '',
      platform: 'unraid',
      root: '/mnt/user/whombat-backups',
      free_bytes: 1_900_000_000_000,
      total_bytes: 2_000_000_000_000,
      addresses: ['10.100.0.40'],
      nfs: true,
      clients: [],
      locations: [
        {
          id: 'whombat-backups',
          name: 'whombat-backups',
          free_bytes: 1_900_000_000_000,
          is_new: true,
          smb: '',
          nfs: '',
          primary: 'array',
          path: '/mnt/user/whombat-backups',
        },
        {
          id: 'backups',
          name: 'backups',
          free_bytes: 1_900_000_000_000,
          is_new: false,
          smb: 'private',
          nfs: '',
          primary: 'array',
          path: '/mnt/user/backups',
        },
        {
          id: 'appdata',
          name: 'appdata',
          free_bytes: 400_000_000_000,
          is_new: false,
          smb: '',
          nfs: '',
          primary: 'cache',
          path: '/mnt/user/appdata',
        },
      ],
    });
    this.#set('basalt', {
      supported: false,
      reason: 'self',
      platform: 'linux',
      root: '/srv/whombat-backups',
      free_bytes: null,
      total_bytes: null,
      addresses: ['10.20.0.11'],
      nfs: false,
      clients: [],
    });
    this.#set('shale', {
      supported: false,
      reason: 'no_docker',
      platform: 'linux',
      root: '/srv/whombat-backups',
      free_bytes: null,
      total_bytes: null,
      addresses: ['10.20.0.15'],
      nfs: false,
      clients: [],
    });
  }

  /** A server's `backup_place` as its detail has it (null: the agent reports none). */
  placeOf(server: string): Json | null {
    return (this.host.detailOf(server)?.backup_place as Json | null | undefined) ?? null;
  }

  /** The client a place keeps, or null. */
  clientOf(server: string, client: string): Json | null {
    const clients = (this.placeOf(server)?.clients as Json[] | undefined) ?? [];
    return clients.find((c) => c.client === client) ?? null;
  }

  #set(server: string, place: Json | null): void {
    const d = this.host.detailOf(server);
    if (d) d.backup_place = place;
  }

  routes(): { method: string; path: string; handler: FakeHandler }[] {
    const S = '/api/v1/servers/*';
    const s = (p: string[]) => p[0] as string;
    return [
      { method: 'POST', path: `${S}/backup-place/ensure`, handler: (r, p) => this.#ensure(r, s(p)) },
      { method: 'PUT', path: `${S}/backup-place/*/cleanup`, handler: (r, p) => this.#cleanup(r, s(p), p[1]) },
      { method: 'POST', path: `${S}/backup-place/nfs`, handler: (r, p) => this.#nfs(r, s(p)) },
      { method: 'DELETE', path: `${S}/backup-place/*`, handler: (r, p) => this.#remove(r, s(p), p[1]) },
      { method: 'POST', path: `${S}/proxmox/storages`, handler: (r, p) => this.#storage(r, s(p)) },
    ];
  }

  /** The common checks: the server, the role, the manage switch, this Whombat's own server, a place at all. */
  #check(r: FakeRequest, server: string, role: 'operator' | 'admin'): { place: Json } | FakeAnswer {
    if (!this.host.serverExists(server)) return problem(404, 'server_not_found', 'No such server.');
    if ((ROLE_RANK[r.role ?? 'viewer'] ?? 0) < (ROLE_RANK[role] ?? 1))
      return problem(403, 'insufficient_role', `This needs the ${role} role.`);
    const rc = this.host.switchesOf(server);
    if (rc && (rc.manage === false || rc.agent_manage === false))
      return problem(403, 'manage_disabled', 'Managing is turned off for this server');
    const place = this.placeOf(server);
    if (place?.reason === 'self')
      return problem(409, 'self', 'Whombat runs on this server, so it can’t keep its backups.');
    if (!place) return problem(502, 'agent_error', 'The agent on this server is too old for backup places.');
    return { place };
  }

  #body(r: FakeRequest): Json {
    return r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? (r.body as Json) : {};
  }

  #ensure(r: FakeRequest, server: string): FakeAnswer {
    const checked = this.#check(r, server, 'operator');
    if ('status' in checked) return checked;
    const { place } = checked;
    const b = this.#body(r);
    const client = String(b.client ?? '');
    const password = String(b.rest_password ?? '');
    if (!CLIENT.test(client)) return problem(422, 'invalid', 'client: lowercase letters, digits and dashes.');
    if (!/^[\x21-\x7e]{24,200}$/.test(password))
      return problem(422, 'invalid', 'rest_password: 24 to 200 printable characters.');
    if (!place.supported)
      return problem(409, 'unsupported', 'This server can’t keep backups.', { reason: place.reason });
    if (this.failNextEnsure) {
      const fail = this.failNextEnsure;
      this.failNextEnsure = null;
      return fail;
    }
    const clients = (place.clients as Json[]) ?? [];
    const locations = (place.locations as Json[] | undefined) ?? [];
    const location = b.location === undefined ? null : String(b.location);
    if (location !== null && !locations.some((l) => l.id === location))
      return problem(422, 'invalid', 'location: one of the place’s locations.');
    let row = clients.find((c) => c.client === client);
    const created = !row;
    if (!row) {
      const used = new Set(clients.map((c) => Number(c.port)));
      let port = Number(b.port) || FIRST_PORT;
      while (used.has(port)) port += 1;
      row = {
        client,
        port,
        running: true,
        location: location ?? (locations.length ? 'whombat-backups' : null),
        image: REST_IMAGE,
        used_bytes: 0,
        cleanup: {
          set: false,
          running: false,
          keep_within_days: 0,
          last_run_at: null,
          last_ok: null,
          last_error: '',
        },
      };
      clients.push(row);
      place.clients = clients;
    }
    // Another location: the agent moves the Whombat's folder there (the app keeps its port and user).
    const moved = !created && location !== null && row.location !== location;
    if (moved) {
      row.location = location;
      this.moves += 1;
    }
    row.running = true;
    // Every ensure gives the backup app the kit user (backup-passkey.md), as the hosts service does.
    row.kit = true;
    return ok({
      client,
      port: row.port,
      addresses: place.addresses,
      path: `${place.root}/${client}`,
      created,
      location: row.location ?? null,
      moved,
      kit: true,
    });
  }

  #cleanup(r: FakeRequest, server: string, client: string | undefined): FakeAnswer {
    const checked = this.#check(r, server, 'operator');
    if ('status' in checked) return checked;
    const b = this.#body(r);
    const row = this.clientOf(server, String(client));
    if (!row) return problem(404, 'not_found', 'This server doesn’t keep that Whombat’s backups.');
    if (typeof b.repository_password !== 'string' || !b.repository_password)
      return problem(422, 'invalid', 'repository_password: required.');
    const days = Number(b.keep_within_days ?? 90);
    // A helper with the keep windows (HS-251) reports them as its cleanup container's label; an older one doesn't.
    const windows = b.keep_daily_days !== undefined;
    const keep = windows
      ? [days, b.keep_daily_days, b.keep_weekly_days, b.keep_monthly_months, b.limit_bytes ?? 0].join(',')
      : String(days);
    row.cleanup = {
      set: true,
      running: true,
      keep_within_days: days,
      last_run_at: null,
      last_ok: null,
      last_error: '',
      ...(this.olderHelper ? {} : { keep }),
    };
    return ok({ set: true });
  }

  #remove(r: FakeRequest, server: string, client: string | undefined): FakeAnswer {
    const b = this.#body(r);
    const checked = this.#check(r, server, b.delete_data === true ? 'admin' : 'operator');
    if ('status' in checked) return checked;
    if (b.delete_data === true && b.confirm !== true)
      return problem(422, 'invalid', 'Deleting the backups needs confirm: true.');
    const clients = (checked.place.clients as Json[]) ?? [];
    checked.place.clients = clients.filter((c) => c.client !== client);
    return ok({ removed: clients.length !== (checked.place.clients as Json[]).length });
  }

  #nfs(r: FakeRequest, server: string): FakeAnswer {
    const checked = this.#check(r, server, 'operator');
    if ('status' in checked) return checked;
    const { place } = checked;
    if (place.platform !== 'unraid' || !place.nfs)
      return problem(409, 'unsupported', 'Only an Unraid server with NFS on shares a folder for backups.');
    const b = this.#body(r);
    const name = String(b.name ?? '');
    const clients = Array.isArray(b.clients) ? b.clients.map(String) : [];
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name) || !clients.length)
      return problem(422, 'invalid', 'name and clients are required.');
    const key = `${server}/${name}`;
    this.exports.set(key, [...new Set([...(this.exports.get(key) ?? []), ...clients])]);
    return ok({ export: `/mnt/user/${name}`, addresses: place.addresses });
  }

  #storage(r: FakeRequest, server: string): FakeAnswer {
    if (!this.host.serverExists(server)) return problem(404, 'server_not_found', 'No such server.');
    if ((ROLE_RANK[r.role ?? 'viewer'] ?? 0) < 1)
      return problem(403, 'insufficient_role', 'This needs the operator role.');
    const rc = this.host.switchesOf(server);
    if (rc && (rc.manage === false || rc.agent_manage === false))
      return problem(403, 'manage_disabled', 'Managing is turned off for this server');
    const d = this.host.detailOf(server);
    if (!d || !Array.isArray(d.storages) || (d.server as Json | undefined)?.detail_view !== 'proxmox')
      return problem(409, 'unsupported', 'Only a Proxmox VE server takes a storage.');
    const b = this.#body(r);
    const id = String(b.storage ?? '');
    if (!/^[a-z][a-z0-9._-]{1,39}$/.test(id) || b.type !== 'nfs' || !b.server || !b.export)
      return problem(422, 'invalid', 'storage, type nfs, server and export are required.');
    const storages = d.storages as Json[];
    const had = storages.find((st) => st.id === id);
    if (had && (had.nfs_server !== b.server || had.export !== b.export))
      return problem(409, 'conflict', `A storage called ${id} is there already.`);
    if (!had)
      storages.push({
        id,
        type: 'nfs',
        content: 'Backups · NFS',
        content_types: ['backup'],
        nfs_server: b.server,
        export: b.export,
        used_gb: 0,
        capacity_gb: 2000,
      });
    return ok({ storage: id });
  }
}
