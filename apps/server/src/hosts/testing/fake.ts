/**
 * A fake hosts service for tests and the fixture world (one-whombat-servers.md ONE-DH20): Rackoon's headless API on a
 * unix socket, answering from the hand-off sample data (`fixtures/`, copied from whombat-hosts
 * `docs/handoff/sample-data`, shapes filled in to what the hub serves) with state per instance. It checks the bearer
 * token, records every request with its actor headers, streams events (`emit`), follows guest actions with
 * `action.finished`, keeps guest configurations with digests, and serves console WebSockets that echo. Its Proxmox
 * side — every manage route and read, tasks that end with `task.finished`, backup jobs — is `manage`
 * (`fake-manage.ts`); the servers' own updates are `packages` (`fake-packages.ts`), their agents' are `agents`
 * (`fake-agents.ts`).
 *
 * Tests change answers with `on(method, path, handler)` (exact path, or a pattern with `*` for one segment).
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import { type WebSocket, WebSocketServer } from 'ws';
import { FakeAgents } from './fake-agents';
import { FakeBackupPlaces } from './fake-backup-places';
import { type FakeAnswer, type FakeHandler, type FakeRequest, type Json, ok, problem } from './fake-http';
import { FakeIncus } from './fake-incus';
import { FakeLibvirt } from './fake-libvirt';
import { FakeMacos } from './fake-macos';
import { FakeManage, type GuestConfigState, type ManageHost } from './fake-manage';
import { FakePackages } from './fake-packages';
import { FakeUnraid } from './fake-unraid';

export { type FakeAnswer, type FakeHandler, type FakeRequest, problem } from './fake-http';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function fixture(name: string): Json {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Json;
}

/** The remote-control switches of a fixture server: everything on (tests switch them off). */
function remoteControl(): Json {
  return {
    console: true,
    power: true,
    agent_console: true,
    agent_power: true,
    host_shell: true,
    host_power: false,
    agent_host_shell: true,
    agent_host_power: false,
    manage: true,
    agent_manage: true,
    diagnose: true,
    agent_diagnose: true,
  };
}

/** The hub's role ranks (hosts `store.RoleRank`); a call without `X-Whombat-Role` is the token's admin. */
const ROLE_RANK: Record<string, number> = { viewer: 0, operator: 1, admin: 2 };
const OPERATOR_SWITCHES = ['console', 'power', 'manage', 'diagnose'] as const;
const ADMIN_SWITCHES = ['host_shell', 'host_power'] as const;

/** The fixtures' alerts' entities by rule (hosts HS-191). */
const FIXTURE_ENTITIES: Readonly<Record<string, string>> = {
  'agent.heartbeat_missing': 'host',
  'disk.wear_high': 'nvme1n1',
  'sensor.temp_high': 'coretemp-package',
};

/** The rules a server's watch settings take (hosts `rules.ServerRules`, HS-195). */
const FAKE_SERVER_RULES = new Set([
  'agent.heartbeat_missing',
  'sensor.temp_high',
  'sensor.temp_critical',
  'sensor.fan_failed',
  'disk.wear_high',
  'disk.wear_critical',
  'disk.smart_failing',
  'disk.smart_errors',
  'disk.space_high',
  'disk.full_soon',
  'fs.read_only',
  'fs.inodes_high',
  'pool.degraded',
  'pool.errors',
  'raid.degraded',
  'hypervisor.overcommit',
  'hypervisor.memory_assigned',
  'pve.quorum_lost',
  'pve.replication_failed',
  'backup.failed',
  'ceph.health',
  'time.unsynced',
  'ups.on_battery',
  'net.link_down',
  'host.oom',
  'guest.restart_loop',
  'guest.stopped',
]);
/**
 * A server's switches as the hub works them out for the caller (hosts `model.Perms`; task-feedback.md TF-02):
 * below operator every switch is off with “Requires operator access”, below admin the host's own two are off with
 * “Requires admin access”; the agent's flags stay as they are.
 */
export function switchesAs(stored: Json, role: string | null): Json {
  const rank = role === null ? 2 : (ROLE_RANK[role] ?? -1);
  const out: Json = { ...stored };
  if (rank < 1)
    for (const k of OPERATOR_SWITCHES)
      Object.assign(out, { [k]: false, [`${k}_reason`]: 'Requires operator access' });
  if (rank < 2)
    for (const k of ADMIN_SWITCHES)
      Object.assign(out, { [k]: false, [`${k}_reason`]: 'Requires admin access' });
  return out;
}

/** A server's detail answer for the caller's role (`switchesAs`), the stored one left as it is. */
function detailAs(answer: FakeAnswer, role: string | null): FakeAnswer {
  const d = answer.body as Json | undefined;
  const server = d?.server as Json | undefined;
  if (answer.status !== 200 || !d || !server?.remote_control) return answer;
  return ok({ ...d, server: { ...server, remote_control: switchesAs(server.remote_control as Json, role) } });
}

interface ConsoleSession {
  id: string;
  token: string;
  server: string;
  guest: string | null;
  protocol: string;
  actor: string | null;
  used: boolean;
}

export class FakeHostsService implements ManageHost {
  readonly dir: string;
  readonly socket: string;
  readonly tokenFile: string;
  readonly token: string;
  readonly requests: FakeRequest[] = [];
  /** Console WebSockets opened (protocols offered, the session, the socket once upgraded). */
  readonly consoles: {
    protocols: string[];
    session: string;
    headers: IncomingMessage['headers'];
    ws?: WebSocket;
  }[] = [];
  /** Answer 503 on `/healthz`. */
  unhealthy = false;
  /** Refuse every request with 401 (a token that no longer matches). */
  refuseToken = false;
  fleet: Json;
  details: Record<string, Json>;
  readonly configs = new Map<string, GuestConfigState>();
  /** The open alerts (the fleet's own list: an acknowledgement shows in `GET /fleet` too). */
  get alerts(): Json[] {
    return this.fleet.alerts as Json[];
  }
  /** Rules switched off per server (`GET`/`PUT /servers/{id}/watch`, hosts HS-194…HS-196). */
  readonly watchOffs = new Map<string, Json[]>();
  readonly watchLimits = new Map<string, Json[]>();
  /** Each server's own note while it warns (HS-190: only while an alert asks for attention). */
  readonly #notes = new Map<string, unknown>();
  /** Each detail's banner while its alert asks for attention (the hub's banner is for attention alerts only). */
  readonly #banners = new Map<string, Json>();
  readonly enrollments: Json[] = [];
  /** Enrollment tokens not claimed yet → their enrollment's id. */
  readonly tokens = new Map<string, string>();
  /** What `GET /agent-install.sh` serves (the agent listener's `install.sh`, hosts HS-93…). */
  installScript = '#!/bin/sh\n# Whombat agent installer (fake)\nset -eu\n';
  /**
   * The Tailscale interface's addresses `GET /agent-install.sh?via=` takes, and the agents' URL on the listener's own
   * port each gives; any other address is 400.
   */
  tailnet: Record<string, string> = { '100.64.0.3': 'wss://100.64.0.3:8443' };
  readonly maintenance: Json[] = [];
  readonly checks: Json[] = [];
  readonly sessions = new Map<string, ConsoleSession>();
  /**
   * The hub itself as `GET /hub` answers it (backup-file.md BF-13…BF-16; hosts HS-170…): its certificate
   * authority's pin, the agents' address now and before, when a backup was applied, and why a staged one wasn't.
   */
  readonly hubMeta: {
    ca_sha256: string;
    agents_url: string;
    agent_url_previous: string | null;
    agent_url_changed_at: string | null;
    restored_at: string | null;
    restore_error: { at: string; code: 'bad_backup' | 'newer_schema' | 'failed'; message: string } | null;
    database_bytes: number;
    /** The hold while it reconnects to its servers (network-move.md NM-06); null: none. */
    reconnecting: { since: string; until: string; reason: string; waiting: number } | null;
  } = {
    ca_sha256: createHash('sha256').update(randomBytes(16)).digest('hex'),
    agents_url: 'wss://10.100.0.2:8443',
    agent_url_previous: null,
    agent_url_changed_at: null,
    restored_at: null,
    restore_error: null,
    database_bytes: 253_952,
    reconnecting: null,
  };
  /**
   * The agents asked to move (`POST /hub/agents/move`): the URLs, in order. `moveRoute` false is a hub before
   * it (404).
   */
  readonly moves: string[] = [];
  moveRoute = true;
  /** After `POST /hub/restore` the service restarts: nothing answers for this long (tests keep it short). */
  restartMs = 50;
  /** Backups `POST /hub/restore` took (their bytes). */
  readonly restored: Buffer[] = [];
  /** The next staged backup fails to apply at the restart (it keeps what it had and says `restore_error`). */
  failNextRestore = false;
  #downUntil = 0;
  /** The bulk its backup carries, as a real database's history (fixed per hub, so a backup is the same twice). */
  readonly #history = randomBytes(64 * 1024).toString('base64');
  /** The Proxmox side: manage routes, tasks, backups, content, firewall, HA, replication, backup jobs. */
  readonly manage: FakeManage;
  /** The Incus side (basalt): projects, pools, volumes, images, profiles, networks, backups, operations. */
  readonly incus: FakeIncus;
  /** The unRAID side (blackbox): array, parity, disks, mover, plugins, notifications, Docker the unRAID way. */
  readonly unraid: FakeUnraid;
  /** The libvirt side (kvm-lab, and the VMs of every server): QEMU/KVM VMs, pools, ISO images, networks, backups. */
  readonly libvirt: FakeLibvirt;
  /** The servers' own updates (server-updates.md): what waits, Check and Install as `pkg:` tasks, the report's fields. */
  readonly packages: FakePackages;
  /** The agents' own updates (agent-updates.md): a signed build, the setting, Update now and the last install. */
  readonly agents: FakeAgents;
  /** Backup places (backup-places.md): each server's `backup_place`, the backup app's routes, NFS and Proxmox storage. */
  readonly backupPlaces: FakeBackupPlaces;
  /** Macs (macos-servers.md): `macos.addMac()` puts one in the fleet; its screen steps answer as the Mac's agent. */
  readonly macos: FakeMacos;
  #server: Server;
  #wss = new WebSocketServer({ noServer: true });
  #streams = new Set<ServerResponse>();
  #eventId = 0;
  #overrides: { method: string; parts: string[]; handler: FakeHandler }[] = [];
  #ownDir: boolean;

  constructor(options: { dir?: string; token?: string } = {}) {
    this.#ownDir = !options.dir;
    this.dir = options.dir ?? mkdtempSync(join(tmpdir(), 'whombat-hosts-'));
    this.socket = join(this.dir, 'api.sock');
    this.tokenFile = join(this.dir, 'service-token');
    this.token = options.token ?? `wh_${randomBytes(16).toString('hex')}`;
    writeFileSync(this.tokenFile, `${this.token}\n`, { mode: 0o640 });
    this.fleet = fixture('fleet.json');
    this.details = {
      basalt: fixture('server-basalt.json'),
      shale: fixture('server-shale-proxmox.json'),
      blackbox: fixture('server-blackbox-unraid.json'),
      'kvm-lab': fixture('server-kvm-lab-libvirt.json'),
    };
    this.#fillIn();
    this.manage = new FakeManage(this);
    this.manage.init();
    this.incus = new FakeIncus(this, this.manage);
    this.incus.init();
    this.unraid = new FakeUnraid(this, this.manage);
    this.unraid.init();
    this.libvirt = new FakeLibvirt(this, this.manage);
    this.libvirt.init();
    this.packages = new FakePackages(this, this.manage);
    this.packages.init();
    this.agents = new FakeAgents(this);
    this.agents.init();
    this.backupPlaces = new FakeBackupPlaces(this);
    this.backupPlaces.init();
    this.macos = new FakeMacos(this);
    this.#server = createServer((req, res) => void this.#handle(req, res));
    this.#server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
  }

  async start(): Promise<this> {
    if (existsSync(this.socket)) rmSync(this.socket);
    await new Promise<void>((resolve) => this.#server.listen(this.socket, resolve));
    chmodSync(this.socket, 0o660);
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.#streams) s.destroy();
    this.#streams.clear();
    for (const c of this.#wss.clients) c.terminate();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    this.#server.closeAllConnections();
    if (this.#ownDir) rmSync(this.dir, { recursive: true, force: true });
  }

  /** Replaces the answer of one route (`/api/v1/servers/*` matches one segment). */
  on(method: string, path: string, handler: FakeHandler): void {
    this.#overrides.unshift({ method, parts: path.split('/'), handler });
  }

  /** Sends one event to every open stream. */
  emit(event: string, data: unknown): number {
    this.#eventId += 1;
    const frame = `id: ${this.#eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of this.#streams) s.write(frame);
    return this.#eventId;
  }

  /** Closes the open event streams (the next connect resumes with `Last-Event-ID`). */
  dropStreams(): void {
    for (const s of this.#streams) s.destroy();
    this.#streams.clear();
  }

  get streams(): number {
    return this.#streams.size;
  }

  /** The requests to a path (exact), newest last. */
  calls(method: string, path: string): FakeRequest[] {
    return this.requests.filter((r) => r.method === method && r.path === path);
  }

  /** Every guest of a server (from its detail, or none). */
  guestsOf(server: string): Json[] {
    const d = this.details[server];
    if (!d) return [];
    const groups = (d.workloads ?? d.guests ?? {}) as Record<string, { guests?: Json[] }>;
    return Object.values(groups).flatMap((g) => g.guests ?? []);
  }

  guest(server: string, id: string): Json | null {
    return this.guestsOf(server).find((g) => g.id === id) ?? null;
  }

  /* What the manage side reads and changes (`ManageHost`) ------------------------------------------------------------ */

  serverExists(id: string): boolean {
    return this.#exists(id);
  }

  /** Puts a guest in a server's detail, in the group of its platform and kind. */
  addGuest(server: string, guest: Json): void {
    const d = this.details[server];
    if (!d) return;
    const groups = (d.workloads ?? d.guests ?? {}) as Record<string, { guests?: Json[]; total?: number }>;
    const group =
      groups[String(guest.kind)] && guest.platform === 'pve'
        ? groups[String(guest.kind)]
        : (groups[String(guest.platform)] ?? Object.values(groups)[0]);
    if (!group) return;
    group.guests = [...(group.guests ?? []), guest];
    if (typeof group.total === 'number') group.total += 1;
  }

  removeGuest(server: string, id: string): void {
    const d = this.details[server];
    if (!d) return;
    for (const group of Object.values(
      (d.workloads ?? d.guests ?? {}) as Record<string, { guests?: Json[]; total?: number }>,
    )) {
      const before = group.guests?.length ?? 0;
      group.guests = (group.guests ?? []).filter((g) => g.id !== id);
      if (group.guests.length < before && typeof group.total === 'number') group.total -= 1;
    }
    this.configs.delete(`${server}/${id}`);
  }

  switchesOf(server: string): Json | null {
    return ((this.details[server]?.server as Json | undefined)?.remote_control as Json | undefined) ?? null;
  }

  detailOf(server: string): Json | null {
    return this.details[server] ?? null;
  }

  configOf(server: string, guestId: string): GuestConfigState {
    return this.#config(server, guestId);
  }

  userOf(r: FakeRequest): string {
    return this.#user(r);
  }

  asOf(): string {
    return String(this.fleet.as_of);
  }

  setHint(server: string, kind: string, hint: Json | null): void {
    const keep = (h: Json) => !(h.server === server && h.kind === kind);
    if (hint) hint.id ??= `${hint.kind}:${hint.entity}`;
    this.fleet.hints = [...(this.fleet.hints as Json[]).filter(keep), ...(hint ? [hint] : [])];
    const d = this.details[server];
    if (d) d.hints = (this.fleet.hints as Json[]).filter((h) => h.server === server);
  }

  /** The fixtures' gaps filled in as the hub serves them (hostname, agent and console flags, hints, switches). */
  #fillIn(): void {
    const servers = this.fleet.servers as Json[];
    for (const s of servers) {
      s.hostname = s.id;
      s.agent_connected = s.status !== 'offline';
      s.open_alerts = (this.fleet.alerts as Json[]).filter((a) => a.server === s.id).length;
      s.console_on = true;
      s.maintenance = null;
      s.parent = null;
    }
    this.fleet.hints = [
      {
        id: 'disk.space:fs:/srv',
        server: 'basalt',
        kind: 'disk.space',
        severity: 'warning',
        entity: 'fs:/srv',
        title: 'Disk “srv” full in about 9 days',
        detail: '910 GB of 1 TB used',
        link: '#storage',
      },
    ];
    this.fleet.agents_connected = servers.filter((s) => s.agent_connected).length;
    this.fleet.pending_enrollments = 0;
    for (const a of this.fleet.alerts as Json[]) {
      const entity = FIXTURE_ENTITIES[String(a.rule)] ?? 'host';
      Object.assign(a, {
        state: 'open',
        resolved_at: null,
        link: null,
        acknowledged: null,
        muted: false,
        suppressed_by: null,
        attention: true,
        entity,
        key: `${a.rule}:${entity}`,
      });
    }
    for (const s of servers) this.#notes.set(String(s.id), s.status_note);
    // The banner names its alert (rule, alert_id; HS-190).
    for (const [id, d] of Object.entries(this.details)) {
      const banner = d.banner as Json | null;
      const alert = (this.fleet.alerts as Json[]).find((a) => a.server === id);
      if (!banner || !alert) continue;
      Object.assign(banner, { rule: alert.rule, alert_id: alert.id });
      this.#banners.set(id, banner);
    }
    for (const [id, d] of Object.entries(this.details)) {
      const card = servers.find((s) => s.id === id);
      const server = d.server as Json;
      server.detail_view = card?.detail_view ?? 'standard';
      if (card?.hosts_this_whombat === true) server.hosts_this_whombat = true;
      server.remote_control = remoteControl();
      server.collectors = [{ name: 'host', ok: true, error: null }];
      server.maintenance = null;
      server.parent = null;
      (server.agent as Json).connected = true;
      d.range = '24h';
      d.hints = (this.fleet.hints as Json[]).filter((h) => h.server === id);
      d.system = {
        package_manager: 'apt',
        updates: 3,
        security_updates: 1,
        updates_checked_at: d.as_of,
        updates_error: null,
        reboot_required: false,
        reboot_reason: null,
        init_system: 'systemd',
        failed_count: 0,
        failed_units: [],
        time_synced: true,
        time_offset_ms: 2,
        time_source: 'chrony',
        oom_kills: 0,
        processes: 412,
        steal_pct: null,
        pressure: null,
      };
    }
  }

  #config(server: string, guestId: string) {
    const key = `${server}/${guestId}`;
    let c = this.configs.get(key);
    if (!c) {
      const g = this.guest(server, guestId);
      c = {
        digest: 1,
        running: g?.state === 'running',
        values: {
          name: String(g?.name ?? guestId),
          cores: String(g?.vcpu ?? 2),
          memory: String(g?.memory_limit_mb ?? 2048),
          onboot: '1',
        },
      };
      this.configs.set(key, c);
    }
    return c;
  }

  #routes(): { method: string; path: string; handler: FakeHandler }[] {
    const api = '/api/v1';
    return [
      { method: 'GET', path: '/healthz', handler: () => this.#health() },
      { method: 'GET', path: `${api}/fleet`, handler: () => ok(this.fleet) },
      { method: 'GET', path: `${api}/fleet/series`, handler: (r) => ok(this.#fleetSeries(r)) },
      {
        method: 'GET',
        path: `${api}/servers`,
        handler: () =>
          ok(
            (this.fleet.servers as Json[]).map((s) => ({
              id: s.id,
              hostname: s.hostname,
              group: s.group,
              status: s.status,
              status_note: s.status_note,
              os: s.os,
              detail_view: s.detail_view,
              last_seen: s.last_seen,
              agent_connected: s.agent_connected,
              open_alerts: s.open_alerts,
            })),
          ),
      },
      {
        method: 'GET',
        path: `${api}/servers/*`,
        handler: (r, [id]) => detailAs(this.#detail(id as string), r.role),
      },
      { method: 'PATCH', path: `${api}/servers/*`, handler: (r, [id]) => this.#patchServer(id as string, r) },
      { method: 'DELETE', path: `${api}/servers/*`, handler: (_r, [id]) => this.#deleteServer(id as string) },
      {
        method: 'GET',
        path: `${api}/servers/*/settings`,
        handler: (_r, [id]) => this.#settings(id as string),
      },
      {
        method: 'GET',
        path: `${api}/servers/*/metrics`,
        handler: (r, [id]) => this.#metrics(id as string, r),
      },
      {
        method: 'GET',
        path: `${api}/servers/*/guests`,
        handler: (_r, [id]) => {
          if (!this.#exists(id as string)) return problem(404, 'server_not_found', 'No such server.');
          const guests = this.guestsOf(id as string);
          return ok({ guests, total: guests.length, next_cursor: null });
        },
      },
      {
        method: 'GET',
        path: `${api}/servers/*/guests/*`,
        handler: (_r, [id, g]) => {
          if (!this.#exists(id as string)) return problem(404, 'server_not_found', 'No such server.');
          const guest = this.guest(id as string, g as string);
          return guest ? ok(guest) : problem(404, 'guest_not_found', 'No such guest.');
        },
      },
      {
        method: 'GET',
        path: `${api}/servers/*/guests/*/metrics`,
        handler: (r, [id, g]) => {
          const m = this.#metrics(id as string, r);
          return m.status === 200 ? ok({ ...(m.body as Json), guest: g }) : m;
        },
      },
      { method: 'GET', path: `${api}/guests`, handler: (r) => ok(this.#allGuests(r)) },
      {
        method: 'POST',
        path: `${api}/servers/*/guests/*/actions`,
        handler: (r, [id, g]) => this.#action(id as string, g as string, r),
      },
      // The waiting updates and the package ops before the other inspect views.
      ...this.packages.routes(),
      ...this.agents.routes(),
      {
        method: 'GET',
        path: `${api}/servers/*/inspect/*`,
        handler: (_r, [, kind]) =>
          ok({
            kind,
            as_of: this.fleet.as_of,
            truncated: false,
            items:
              kind === 'services'
                ? [{ Name: 'nginx.service', Description: 'nginx', Active: 'active', Sub: 'running' }]
                : [],
          }),
      },
      {
        method: 'POST',
        path: `${api}/servers/*/diagnose`,
        handler: (r, [id]) => this.#diagnose(id as string, r),
      },
      {
        method: 'GET',
        path: `${api}/servers/*/diagnose`,
        handler: (r, [id]) => this.#diagnose(id as string, r),
      },
      {
        method: 'GET',
        path: `${api}/servers/*/disk-usage`,
        handler: (r, [id]) => this.#diskUsage(id as string, r),
      },
      {
        method: 'POST',
        path: `${api}/servers/*/disk-usage`,
        handler: (r, [id]) => this.#diskUsage(id as string, r),
      },
      { method: 'GET', path: `${api}/hub`, handler: () => ok(this.#hubInfo()) },
      { method: 'GET', path: `${api}/hub/backup`, handler: (r) => this.#hubBackup(r) },
      { method: 'POST', path: `${api}/hub/agents/move`, handler: (r) => this.#moveAgents(r) },
      { method: 'POST', path: `${api}/hub/restore`, handler: (r) => this.#hubRestore(r) },
      { method: 'POST', path: `${api}/servers/*/exec`, handler: (r, [id]) => this.#exec(id as string, r) },
      {
        method: 'POST',
        path: `${api}/servers/*/guests/*/console-sessions`,
        handler: (r, [id, g]) => this.#console(id as string, g as string, r),
      },
      {
        method: 'POST',
        path: `${api}/servers/*/console-sessions`,
        handler: (r, [id]) => this.#console(id as string, null, r),
      },
      {
        method: 'DELETE',
        path: `${api}/console-sessions/*`,
        handler: (_r, [sid]) => {
          this.sessions.delete(sid as string);
          return { status: 204 };
        },
      },
      ...this.backupPlaces.routes(),
      ...this.macos.routes(),
      // The Incus and unRAID sides first: they pass what isn't theirs on to the Proxmox side.
      ...this.incus.routes(),
      ...this.unraid.routes(),
      ...this.libvirt.routes(),
      ...this.manage.routes(),
      { method: 'GET', path: `${api}/servers/*/watch`, handler: (_r, [id]) => this.#watch(id as string) },
      {
        method: 'PUT',
        path: `${api}/servers/*/watch`,
        handler: (r, [id]) => this.#setWatch(id as string, r),
      },
      { method: 'GET', path: `${api}/alerts`, handler: (r) => ok(this.#alerts(r)) },
      { method: 'POST', path: `${api}/alerts/*/ack`, handler: (r, [id]) => this.#ack(id as string, r, true) },
      {
        method: 'DELETE',
        path: `${api}/alerts/*/ack`,
        handler: (r, [id]) => this.#ack(id as string, r, false),
      },
      { method: 'GET', path: `${api}/maintenance`, handler: () => ok(this.maintenance) },
      { method: 'POST', path: `${api}/maintenance`, handler: (r) => this.#addMaintenance(r) },
      {
        method: 'DELETE',
        path: `${api}/maintenance/*`,
        handler: (_r, [id]) => this.#remove(this.maintenance, id as string),
      },
      { method: 'GET', path: `${api}/checks`, handler: () => ok(this.checks) },
      { method: 'POST', path: `${api}/checks`, handler: (r) => this.#addCheck(r) },
      {
        method: 'GET',
        path: `${api}/checks/*`,
        handler: (r, [id]) => {
          const check = this.checks.find((c) => c.id === id);
          if (!check) return problem(404, 'not_found', 'Not found.');
          return ok(r.role === 'admin' ? check : { ...check, ping_url: null });
        },
      },
      {
        method: 'DELETE',
        path: `${api}/checks/*`,
        handler: (_r, [id]) => this.#remove(this.checks, id as string),
      },
      { method: 'POST', path: `${api}/enrollments`, handler: (r) => this.#enroll(r) },
      {
        method: 'GET',
        path: `${api}/agent-install.sh`,
        handler: (r) => {
          const via = r.query.get('via');
          const agentUrl = via ? this.tailnet[via] : this.hubMeta.agents_url;
          if (!agentUrl)
            return problem(
              400,
              'bad_request',
              "via must be an address of this machine's Tailscale interface.",
            );
          return {
            status: 200,
            body: this.installScript,
            headers: { 'content-type': 'text/x-shellscript; charset=utf-8', 'x-whombat-agent-url': agentUrl },
          };
        },
      },
      {
        method: 'GET',
        path: `${api}/enrollments`,
        handler: (r) => {
          const state = r.query.get('state') ?? 'pending';
          return ok(this.enrollments.filter((e) => state === 'all' || e.state === state));
        },
      },
      {
        method: 'POST',
        path: `${api}/enrollments/*/approve`,
        handler: (r, [id]) => this.#decideEnrollment(id as string, r, true),
      },
      {
        method: 'POST',
        path: `${api}/enrollments/*/reject`,
        handler: (r, [id]) => this.#decideEnrollment(id as string, r, false),
      },
    ];
  }

  /* The hub itself (backup-file.md BF-13…BF-16) ------------------------------------------------------------------ */

  #hubInfo(): Json {
    return {
      version: 'dev',
      schema: 12,
      headless: true,
      started_at: this.fleet.as_of,
      servers: (this.fleet.servers as Json[]).length,
      agents_connected: (this.fleet.servers as Json[]).filter((s) => s.agent_connected).length,
      database_bytes: this.hubMeta.database_bytes,
      database_free_bytes: 0,
      agents_url: this.hubMeta.agents_url,
      agent_url: this.hubMeta.agents_url,
      agent_url_previous: this.hubMeta.agent_url_previous,
      agent_url_changed_at: this.hubMeta.agent_url_changed_at,
      restored_at: this.hubMeta.restored_at,
      restore_error: this.hubMeta.restore_error,
      reconnecting: this.hubMeta.reconnecting,
      tls_pin: 'sha256//AAAA',
      ca_sha256: this.hubMeta.ca_sha256,
    };
  }

  /**
   * `POST /hub/agents/move {url}`: every connected agent not already connected through the URL's address is
   * asked; a hub before it answers 404.
   */
  #moveAgents(r: FakeRequest): FakeAnswer {
    if (!this.moveRoute) return problem(404, 'not_found', 'Not found.');
    const url = typeof (r.body as Json | undefined)?.url === 'string' ? ((r.body as Json).url as string) : '';
    const m = /^wss:\/\/(\[[^\]]+\]|[^:/]+):(\d+)$/.exec(url);
    if (!m) return problem(400, 'bad_request', 'url must be a wss URL with a port.');
    this.moves.push(url);
    const host = (m[1] as string).replace(/^\[|\]$/g, '');
    const connected = (this.fleet.servers as Json[]).filter((s) => s.agent_connected);
    const already = connected.filter((s) => s.via === host).length;
    return ok({ asked: connected.length - already, already });
  }

  /** The hub's backup as `GET /hub/backup` gives it (a fake's own `.tar.gz`: gzipped JSON of what it holds). */
  hubBackupBytes(): Buffer {
    return gzipSync(
      Buffer.from(
        JSON.stringify({
          format: 'fake-hub-backup/1',
          ca_sha256: this.hubMeta.ca_sha256,
          agent_url: this.hubMeta.agents_url,
          servers: this.fleet.servers,
          details: this.details,
          // Bulk, as a real database has: the file must stream it, never hold it whole.
          history: this.#history,
        }),
      ),
    );
  }

  #hubBackup(r: FakeRequest): FakeAnswer {
    if (r.role !== null && r.role !== 'admin') return problem(403, 'forbidden', 'Admins only.');
    return {
      status: 200,
      body: this.hubBackupBytes(),
      headers: {
        'content-type': 'application/gzip',
        'content-disposition': 'attachment; filename="rackoon-backup.tar.gz"',
      },
    };
  }

  /** Whether it has servers or servers waiting (a restore refuses: `hub_not_empty`). */
  hubEmpty(): boolean {
    return (
      (this.fleet.servers as Json[]).length === 0 &&
      !this.enrollments.some((e) => e.state === 'pending' || e.state === 'issued')
    );
  }

  /** Forgets every server (a fresh box's hub). */
  clearServers(): void {
    this.fleet.servers = [];
    this.fleet.alerts = [];
    this.fleet.hints = [];
    for (const id of Object.keys(this.details)) delete this.details[id];
  }

  #hubRestore(r: FakeRequest): FakeAnswer {
    if (r.role !== null && r.role !== 'admin') return problem(403, 'forbidden', 'Admins only.');
    let backup: Json;
    try {
      backup = JSON.parse(gunzipSync(r.raw).toString('utf8')) as Json;
      if (backup.format !== 'fake-hub-backup/1' || typeof backup.ca_sha256 !== 'string')
        throw new Error('format');
    } catch {
      return problem(400, 'bad_backup', 'That isn’t a backup of a hub.');
    }
    if (backup.ca_sha256 === this.hubMeta.ca_sha256)
      return problem(409, 'same_hub', 'That backup is of this hub.');
    if (!this.hubEmpty()) return problem(409, 'hub_not_empty', 'This hub already has servers.');
    this.restored.push(Buffer.from(r.raw));
    if (this.failNextRestore) {
      this.failNextRestore = false;
      this.hubMeta.restore_error = {
        at: new Date().toISOString(),
        code: 'failed',
        message: 'The staged backup could not be applied.',
      };
      this.#downUntil = Date.now() + this.restartMs;
      return ok(
        { ca_sha256: backup.ca_sha256, servers: (backup.servers as Json[]).length, agent_url: null },
        202,
      );
    }
    const servers = (backup.servers as Json[]).map((s) => ({
      ...s,
      agent_connected: false,
      status: 'offline',
    }));
    const now = new Date().toISOString();
    // As the real one at its next start: the backup's data and authority, this box's address; the backup's address
    // kept as the one before when they differ.
    this.fleet.servers = servers;
    for (const [id, d] of Object.entries(backup.details as Record<string, Json>)) this.details[id] = d;
    this.hubMeta.ca_sha256 = backup.ca_sha256 as string;
    this.hubMeta.restored_at = now;
    this.hubMeta.restore_error = null;
    if (typeof backup.agent_url === 'string' && backup.agent_url !== this.hubMeta.agents_url) {
      this.hubMeta.agent_url_previous = backup.agent_url;
      this.hubMeta.agent_url_changed_at = now;
    }
    this.#downUntil = Date.now() + this.restartMs;
    setTimeout(() => this.dropStreams(), 0).unref?.();
    return ok(
      { ca_sha256: backup.ca_sha256, servers: servers.length, agent_url: this.hubMeta.agents_url },
      202,
    );
  }

  /** The agents' address changes, as `--agent-url auto` finds another one at start (BF-16). */
  moveHub(agentsUrl: string, at = new Date()): void {
    this.hubMeta.agent_url_previous = this.hubMeta.agents_url;
    this.hubMeta.agents_url = agentsUrl;
    this.hubMeta.agent_url_changed_at = at.toISOString();
  }

  /** Puts a pending enrollment in the list, as an agent that ran the install command does. */
  requestEnrollment(hostname: string): Json {
    const e = this.enrollments.find((x) => x.state === 'issued') ?? {
      id: `en_${randomBytes(6).toString('hex')}`,
      created_at: this.fleet.as_of,
      expires_at: this.fleet.as_of,
    };
    Object.assign(e, {
      state: 'pending',
      hostname,
      os: 'Debian GNU/Linux 13',
      address: '10.100.0.42',
      agent_version: '0.1.0',
      requested_at: this.fleet.as_of,
      server_id: null,
    });
    if (!this.enrollments.includes(e)) this.enrollments.push(e);
    this.fleet.pending_enrollments = this.enrollments.filter((x) => x.state === 'pending').length;
    this.emit('enrollment.pending', { id: e.id, hostname });
    return e;
  }

  #health(): FakeAnswer {
    return this.unhealthy
      ? { status: 503, body: 'unhealthy: database', headers: { 'content-type': 'text/plain' } }
      : { status: 200, body: 'ok', headers: { 'content-type': 'text/plain' } };
  }

  #exists(id: string): boolean {
    return (this.fleet.servers as Json[]).some((s) => s.id === id);
  }

  #detail(id: string): FakeAnswer {
    const d = this.details[id];
    if (d) return ok(d);
    const card = (this.fleet.servers as Json[]).find((s) => s.id === id);
    if (!card) return problem(404, 'server_not_found', 'No such server.');
    // A server without a hand-off detail: the parts its card has.
    return ok({
      as_of: this.fleet.as_of,
      range: '24h',
      server: {
        id,
        group: card.group,
        status: card.status,
        status_note: card.status_note,
        roles: [],
        os: { name: String(card.os ?? 'Linux'), version: '', kernel: '' },
        cpu: card.cpu ?? { model: 'Unknown', cores: 1, threads: 1 },
        memory: { total_gb: card.memory_total_gb ?? 0, type: null },
        uptime_s: null,
        last_boot: null,
        address: null,
        location: null,
        agent: { version: '0.14.2', last_sync_s_ago: 10, connected: card.agent_connected },
        detail_view: card.detail_view,
        remote_control: remoteControl(),
        collectors: [],
        maintenance: null,
        parent: null,
      },
      live: {
        refresh_interval_s: 10,
        cpu_pct: (card.current as Json | null)?.cpu_pct ?? null,
        cpu_user_pct: null,
        cpu_system_pct: null,
        cpu_iowait_pct: null,
        load_avg: null,
        mem_pct: (card.current as Json | null)?.mem_pct ?? null,
        mem_used_gb: null,
        mem_free_gb: null,
        swap_used_gb: null,
        swap_total_gb: null,
      },
      banner: null,
      sensors: [],
      virtualization: null,
      disks: [],
      workloads: {},
      hints: [],
    });
  }

  #settings(id: string): FakeAnswer {
    if (!this.#exists(id)) return problem(404, 'server_not_found', 'No such server.');
    const card = (this.fleet.servers as Json[]).find((s) => s.id === id) as Json;
    const rc = (this.details[id]?.server as Json | undefined)?.remote_control as Json | undefined;
    const toggles = (src: Json | undefined, prefix: string) => ({
      console: src?.[`${prefix}console`] ?? true,
      power: src?.[`${prefix}power`] ?? true,
      host_shell: src?.[`${prefix}host_shell`] ?? false,
      host_power: src?.[`${prefix}host_power`] ?? false,
      manage: src?.[`${prefix}manage`] ?? false,
      diagnose: src?.[`${prefix}diagnose`] ?? true,
    });
    return ok({
      id,
      group: card.group,
      location: null,
      remote_control: toggles(rc, ''),
      agent_policy: toggles(rc, 'agent_'),
      parent: '',
      detected_parent: null,
    });
  }

  #patchServer(id: string, r: FakeRequest): FakeAnswer {
    if (!this.#exists(id)) return problem(404, 'server_not_found', 'No such server.');
    const body = (r.body ?? {}) as Json;
    const card = (this.fleet.servers as Json[]).find((s) => s.id === id) as Json;
    if (typeof body.group === 'string') card.group = body.group;
    const rc = (this.details[id]?.server as Json | undefined)?.remote_control as Json | undefined;
    if (rc && body.remote_control && typeof body.remote_control === 'object')
      Object.assign(rc, body.remote_control);
    this.emit('server.settings_changed', { id });
    return this.#settings(id);
  }

  #deleteServer(id: string): FakeAnswer {
    if (!this.#exists(id)) return problem(404, 'server_not_found', 'No such server.');
    this.fleet.servers = (this.fleet.servers as Json[]).filter((s) => s.id !== id);
    delete this.details[id];
    this.emit('server.deleted', { id });
    return { status: 204 };
  }

  #metrics(id: string, r: FakeRequest): FakeAnswer {
    if (!this.#exists(id)) return problem(404, 'server_not_found', 'No such server.');
    const base = fixture('timeseries-basalt-24h.json');
    const wanted = r.query.get('series');
    const series = base.series as Record<string, unknown[]>;
    const picked: Record<string, unknown[]> = {};
    for (const name of wanted ? wanted.split(',') : Object.keys(series))
      picked[name] = series[name] ?? new Array((base.timestamps as unknown[]).length).fill(null);
    return ok({ ...base, server: id, range: r.query.get('range') ?? '24h', series: picked });
  }

  #fleetSeries(r: FakeRequest): Json {
    const servers: Record<string, Json> = {};
    const heat: Record<string, (number | null)[]> = {};
    for (const s of this.fleet.servers as Json[]) {
      const cpu = Number((s.current as Json | null)?.cpu_pct ?? 0);
      const points = Array.from({ length: 60 }, (_, i) =>
        s.status === 'offline' ? null : Math.round((cpu + Math.sin(i / 5) * 4) * 10) / 10,
      );
      servers[s.id as string] = {
        step_s: 1440,
        cpu_pct: points,
        mem_pct: points.map((p) => (p === null ? null : 50)),
      };
      heat[s.id as string] = Array.from({ length: 48 }, (_, i) =>
        s.status === 'offline' ? null : Math.round((cpu + Math.cos(i / 4) * 5) * 10) / 10,
      );
    }
    return {
      range: r.query.get('range') ?? '24h',
      as_of: this.fleet.as_of,
      kpi: { step_s: 1440, timestamps: [], cpu_pct: [], mem_pct: [] },
      servers,
      heatmap: { buckets: 48, bucket_s: 1800, timestamps: [], cpu_pct: heat },
    };
  }

  #allGuests(r: FakeRequest): Json {
    const server = r.query.get('server');
    const q = r.query.get('q')?.toLowerCase() ?? '';
    const guests = (this.fleet.servers as Json[])
      .filter((s) => !server || s.id === server)
      .flatMap((s) =>
        this.guestsOf(s.id as string).map(
          (g): Json => ({ ...g, server: s.id, server_online: s.status !== 'offline' }),
        ),
      )
      .filter((g) => !q || String(g.name).toLowerCase().includes(q) || String(g.id).includes(q));
    const count = (state: string) => guests.filter((g) => g.state === state).length;
    return {
      guests,
      total: guests.length,
      next_cursor: null,
      counts: {
        all: guests.length,
        running: count('running'),
        stopped: count('stopped'),
        unhealthy: count('unhealthy'),
      },
      platforms: {},
      tags: {},
    };
  }

  #action(id: string, guestId: string, r: FakeRequest): FakeAnswer {
    if (!this.#exists(id)) return problem(404, 'server_not_found', 'No such server.');
    const guest = this.guest(id, guestId);
    if (!guest) return problem(404, 'guest_not_found', 'No such guest.');
    const body = (r.body ?? {}) as {
      action?: string;
      confirm?: boolean;
      snapshot?: string;
      description?: string;
    };
    const action = body.action ?? '';
    const destructive = [
      'force_stop',
      'stop',
      'reboot',
      'shutdown',
      'restart',
      'snapshot_restore',
      'snapshot_delete',
    ];
    if (destructive.includes(action) && body.confirm !== true)
      return problem(400, 'confirm_required', 'Confirm this action.');
    // The guest this Whombat runs in (the Incus and unRAID build brief §2.1): only snapshots and consoles.
    const selfRefused = ['stop', 'shutdown', 'force_stop', 'restart', 'reboot', 'pause', 'destroy', 'kill'];
    if (guest.self === true && (selfRefused.includes(action) || action === 'snapshot_restore'))
      return problem(409, 'self_guest', 'That’s this Whombat itself.');
    const actionId = `act_${randomBytes(6).toString('hex')}`;
    const state =
      action === 'start' || action === 'reboot' || action === 'restart' || action === 'resume'
        ? 'running'
        : action === 'pause'
          ? 'paused'
          : action.startsWith('snapshot')
            ? (guest.state as string)
            : 'stopped';
    if (action.startsWith('snapshot_')) this.manage.snapshotAction(id, guestId, action, body as Json);
    setTimeout(() => {
      guest.state = state;
      this.emit('action.finished', {
        action_id: actionId,
        server: id,
        guest: guestId,
        action,
        result: 'ok',
        message: '',
        state,
        noop: false,
        code: null,
      });
      this.emit('guest.state_changed', { server: id, id: guestId, state });
    }, 20);
    return ok({ action_id: actionId, audit_id: `au_${randomBytes(6).toString('hex')}` }, 202);
  }

  #diagnose(id: string, r: FakeRequest): FakeAnswer {
    if (!this.#exists(id)) return problem(404, 'server_not_found', 'No such server.');
    const checks = ['system', 'services', 'logs', 'smart'];
    if (r.method === 'GET')
      return ok({
        server: id,
        checks: checks.map((name) => ({ name, description: `The ${name} check`, args: [] })),
      });
    const body = (r.body ?? {}) as { check?: string; args?: Json };
    if (!body.check || !checks.includes(body.check)) return problem(404, 'unknown_check', 'No such check.');
    return ok({
      server: id,
      check: body.check,
      ok: true,
      commands: [`${body.check} --now`],
      output: `${body.check} on ${id}: all good`,
      truncated: false,
    });
  }

  #diskUsage(id: string, r: FakeRequest): FakeAnswer {
    if (!this.#exists(id)) return problem(404, 'server_not_found', 'No such server.');
    const detail = this.details[id];
    if (r.method === 'GET') {
      const items = Array.isArray(detail?.disk_usage) ? detail.disk_usage : [];
      return ok({ server: id, items });
    }
    const role = r.role;
    if (role === 'viewer') return problem(403, 'insufficient_role', 'Requires operator access.');
    const rc = (detail?.server as Json | undefined)?.remote_control as Json | undefined;
    if (rc && (rc.diagnose === false || rc.agent_diagnose === false))
      return problem(403, 'diagnose_disabled', 'Diagnostics are turned off for this server.');
    const body = (r.body ?? {}) as { mount?: string };
    const mount = typeof body.mount === 'string' && body.mount.trim() ? body.mount.trim() : '/';
    const measuredAt = new Date().toISOString();
    const result: Json = {
      mount,
      fs_type: 'ext4',
      device: '/dev/nvme0n1p2',
      measured_at: measuredAt,
      duration_ms: 340,
      total_bytes: 500_000_000_000,
      used_bytes: 380_000_000_000,
      categories: [
        {
          key: 'container_images',
          label: 'Container images',
          bytes: 42_000_000_000,
          reclaimable_bytes: 12_000_000_000,
          detail: '14 images, 4 unused',
        },
        {
          key: 'container_build_cache',
          label: 'Container build cache',
          bytes: 18_000_000_000,
          reclaimable_bytes: 18_000_000_000,
        },
        { key: 'container_volumes', label: 'Container volumes', bytes: 24_000_000_000 },
        { key: 'container_logs', label: 'Container logs', bytes: 3_500_000_000 },
        { key: 'journal', label: 'System journal', bytes: 6_200_000_000 },
        { key: 'package_cache', label: 'Package caches', bytes: 2_100_000_000, detail: 'apt' },
      ],
      folders: [
        { path: '/var/lib/docker', bytes: 87_500_000_000 },
        { path: '/var/backups', bytes: 64_000_000_000 },
        { path: '/var/log/journal', bytes: 6_200_000_000 },
      ],
    };
    if (detail) {
      const existing = Array.isArray(detail.disk_usage) ? (detail.disk_usage as Json[]) : [];
      detail.disk_usage = [result, ...existing.filter((x) => x.mount !== mount)];
    }
    this.emit('server.disk_usage', { id, mount });
    return ok({ server: id, ok: true, ...result });
  }

  #exec(id: string, r: FakeRequest): FakeAnswer {
    if (!this.#exists(id)) return problem(404, 'server_not_found', 'No such server.');
    const body = (r.body ?? {}) as Json;
    for (const k of Object.keys(body))
      if (k !== 'command' && k !== 'timeout_s') return problem(400, 'bad_request', `Unknown field ${k}.`);
    if (typeof body.command !== 'string' || !body.command)
      return problem(400, 'invalid_value', 'A command is needed.');
    return ok({
      server: id,
      exit_code: 0,
      timed_out: false,
      output: `ran: ${body.command}\n`,
      truncated: false,
      duration_ms: 30,
      audit_id: `au_${randomBytes(6).toString('hex')}`,
    });
  }

  #console(id: string, guestId: string | null, r: FakeRequest): FakeAnswer {
    if (!this.#exists(id)) return problem(404, 'server_not_found', 'No such server.');
    if (guestId && !this.guest(id, guestId)) return problem(404, 'guest_not_found', 'No such guest.');
    const body = (r.body ?? {}) as { protocol?: string };
    const s: ConsoleSession = {
      id: `cs_${randomBytes(6).toString('hex')}`,
      token: randomBytes(16).toString('hex'),
      server: id,
      guest: guestId,
      // A Mac's own console is its screen (macos-servers.md).
      protocol: body.protocol ?? (guestId || this.macos.macs.has(id) ? 'vnc' : 'logs'),
      actor: r.actor,
      used: false,
    };
    this.sessions.set(s.id, s);
    return ok(
      {
        session_id: s.id,
        url: `/api/v1/console/${s.id}`,
        token: s.token,
        protocol: s.protocol,
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        idle_timeout_s: 900,
        requires_confirmation: false,
      },
      201,
    );
  }

  #alerts(r: FakeRequest): Json[] {
    const state = r.query.get('state') ?? 'open';
    const server = r.query.get('server');
    const since = r.query.get('since');
    const overlapsSince = r.query.get('overlaps_since');
    return this.alerts.filter((a) => {
      if ((state !== 'all' && a.state !== state) || (server && a.server !== server)) return false;
      if (state === 'open') return true;
      if (since && Date.parse(String(a.opened_at)) < Date.parse(since)) return false;
      return (
        !overlapsSince || !a.resolved_at || Date.parse(String(a.resolved_at)) >= Date.parse(overlapsSince)
      );
    });
  }

  #ack(id: string, r: FakeRequest, on: boolean): FakeAnswer {
    const a = this.alerts.find((x) => x.id === id && x.state === 'open');
    if (!a) return problem(404, 'alert_not_open', 'That alert isn’t open.');
    const body = (r.body ?? {}) as { minutes?: number; note?: string };
    a.acknowledged = on
      ? {
          at: this.fleet.as_of,
          by: this.#user(r),
          note: body.note ?? '',
          until: body.minutes ? new Date(Date.now() + body.minutes * 60_000).toISOString() : null,
        }
      : null;
    a.attention = !on && !a.muted && !a.suppressed_by;
    this.emit('alert.updated', a);
    this.#restatus(String(a.server));
    return ok(a);
  }

  /**
   * A server's status and note as the hub works them out (hosts HS-190): `warning` with its own note while one
   * of its alerts asks for attention, else `online`; `offline` stays. Sends `server.updated` when it changed.
   */
  #restatus(serverId: string): void {
    const card = (this.fleet.servers as Json[]).find((s) => s.id === serverId);
    if (!card || card.status === 'offline') return;
    const warn = (this.fleet.alerts as Json[]).some((a) => a.server === serverId && a.attention === true);
    const status = warn ? 'warning' : 'online';
    const note = warn ? (this.#notes.get(serverId) ?? 'needs a look') : null;
    card.open_alerts = (this.fleet.alerts as Json[]).filter((a) => a.server === serverId).length;
    const d = this.details[serverId];
    if (d) {
      Object.assign(d.server as Json, { status, status_note: note });
      const banner = this.#banners.get(serverId);
      const shown = banner
        ? (this.fleet.alerts as Json[]).find((a) => a.id === banner.alert_id && a.attention === true)
        : undefined;
      d.banner = shown ? banner : null;
    }
    if (card.status === status && card.status_note === note) return;
    Object.assign(card, { status, status_note: note });
    this.emit('server.updated', { id: serverId, status, status_note: note });
  }

  /** Adds an open alert as the engine opens one (`alert.opened`, the server's status after it). */
  openAlert(alert: Json): Json {
    const entity = String(alert.entity ?? 'host');
    const a: Json = {
      state: 'open',
      opened_at: this.fleet.as_of,
      detail: '',
      resolved_at: null,
      link: null,
      acknowledged: null,
      muted: false,
      suppressed_by: null,
      attention: true,
      ...alert,
      entity,
      key: `${alert.rule}:${entity}`,
    };
    (this.fleet.alerts as Json[]).push(a);
    this.emit('alert.opened', a);
    this.#restatus(String(a.server));
    return a;
  }

  /** Resolves an open alert (`alert.resolved`). */
  resolveAlert(id: string): void {
    const list = this.fleet.alerts as Json[];
    const i = list.findIndex((a) => a.id === id);
    if (i < 0) return;
    const [a] = list.splice(i, 1) as [Json];
    Object.assign(a, { state: 'resolved', resolved_at: this.fleet.as_of, attention: false });
    this.emit('alert.resolved', a);
    this.#restatus(String(a.server));
  }

  /** `GET /servers/{id}/watch`: what is switched off, the whole rule first. */
  #watch(serverId: string): FakeAnswer {
    if (!this.#exists(serverId)) return problem(404, 'server_not_found', 'No such server.');
    const rows = [...(this.watchOffs.get(serverId) ?? [])].sort(
      (a, b) =>
        String(a.rule).localeCompare(String(b.rule)) ||
        String(a.entity ?? '').localeCompare(String(b.entity ?? '')),
    );
    return ok({ rules: rows, limits: this.watchLimits.get(serverId) ?? [] });
  }

  /** `PUT /servers/{id}/watch` (operator): one rule off or on again; an open alert of it resolves (HS-196). */
  #setWatch(serverId: string, r: FakeRequest): FakeAnswer {
    if (!this.#exists(serverId)) return problem(404, 'server_not_found', 'No such server.');
    if (r.role === 'viewer') return problem(403, 'forbidden', 'Operators only.');
    const body = (r.body ?? {}) as Json;
    const rule = String(body.rule ?? '');
    if (!FAKE_SERVER_RULES.has(rule)) return problem(400, 'invalid_rule', 'Not a server rule.');
    const entity = typeof body.entity === 'string' ? body.entity : '';
    if (Object.hasOwn(body, 'limit')) {
      const limits = this.watchLimits.get(serverId) ?? [];
      const index = limits.findIndex((l) => l.rule === rule && (l.entity ?? '') === entity);
      if (Object.hasOwn(body, 'expected_limit') && (limits[index]?.value ?? null) !== body.expected_limit)
        return problem(409, 'limit_changed', 'The limit changed meanwhile.');
      if (index >= 0) limits.splice(index, 1);
      if (body.limit !== null) limits.push({ rule, ...(entity ? { entity } : {}), value: body.limit });
      this.watchLimits.set(serverId, limits);
      this.emit('watch.changed', {
        server: serverId,
        rule,
        ...(entity ? { entity } : {}),
        limit: body.limit,
      });
      return this.#watch(serverId);
    }
    if (typeof body.off !== 'boolean') return problem(400, 'invalid_value', 'Say off: true or false.');
    const rows = this.watchOffs.get(serverId) ?? [];
    const at = rows.findIndex((o) => o.rule === rule && (o.entity ?? '') === entity);
    if (body.off && at < 0) {
      rows.push({ rule, ...(entity ? { entity } : {}), off: true, by: this.#user(r), at: this.fleet.as_of });
      for (const a of [...(this.fleet.alerts as Json[])])
        if (a.server === serverId && a.rule === rule && (!entity || a.entity === entity))
          this.resolveAlert(String(a.id));
    } else if (!body.off && at >= 0) rows.splice(at, 1);
    else return this.#watch(serverId);
    this.watchOffs.set(serverId, rows);
    this.emit('watch.changed', { server: serverId, rule, ...(entity ? { entity } : {}), off: body.off });
    this.emit('server.updated', { id: serverId });
    return this.#watch(serverId);
  }

  #addMaintenance(r: FakeRequest): FakeAnswer {
    const body = (r.body ?? {}) as Json;
    if (!['server', 'group', 'all'].includes(String(body.scope)))
      return problem(400, 'invalid_scope', 'scope');
    const w = {
      id: `mw_${randomBytes(6).toString('hex')}`,
      scope: body.scope,
      target: body.target ?? '',
      starts_at: body.starts_at ?? this.fleet.as_of,
      ends_at: body.ends_at ?? null,
      weekdays: body.weekdays ?? [],
      start_time: body.start_time ?? '',
      duration_min: body.duration_min ?? 0,
      tz: body.tz ?? 'UTC',
      note: body.note ?? '',
      created_by: this.#user(r),
      created_at: this.fleet.as_of,
      active: true,
      active_until: body.ends_at ?? null,
      next_start: null,
    };
    this.maintenance.push(w);
    this.emit('maintenance.changed', {});
    return ok(w, 201);
  }

  #addCheck(r: FakeRequest): FakeAnswer {
    const body = (r.body ?? {}) as Json;
    if (!body.name) return problem(400, 'invalid_name', 'A name is needed.');
    const c = {
      id: `ck_${randomBytes(6).toString('hex')}`,
      name: body.name,
      kind: body.kind ?? 'http',
      target: body.target ?? '',
      runner: body.runner ?? 'hub',
      interval_s: body.interval_s ?? 60,
      timeout_s: body.timeout_s ?? 10,
      grace_s: body.grace_s ?? 0,
      options: body.options ?? {},
      enabled: body.enabled ?? true,
      status: 'pending',
      stale: false,
      ...(typeof body.owner === 'string' ? { owner: body.owner } : {}),
      since: null,
      last: null,
      last_ping: null,
      uptime_24h: null,
      latency_24h: [],
      ping_url: null,
      created_by: this.#user(r),
    };
    this.checks.push(c);
    this.emit('checks.changed', { id: c.id });
    return ok(c, 201);
  }

  #remove(list: Json[], id: string): FakeAnswer {
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return problem(404, 'not_found', 'Not found.');
    list.splice(i, 1);
    return { status: 204 };
  }

  #enroll(r: FakeRequest): FakeAnswer {
    // Since 0.85 (hosts HS-93…): `{approve?, control?, name?, group?}`; an empty body is the old behaviour.
    const body = (r.body && typeof r.body === 'object' ? r.body : {}) as Json;
    const control = typeof body.control === 'string' ? body.control : null;
    const e: Json = {
      id: `en_${randomBytes(6).toString('hex')}`,
      state: 'issued',
      hostname: null,
      os: null,
      address: null,
      agent_version: null,
      requested_at: null,
      created_at: this.fleet.as_of,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      server_id: null,
      control,
      approve: body.approve === true,
      name: typeof body.name === 'string' ? body.name : null,
      group: typeof body.group === 'string' ? body.group : null,
    };
    this.enrollments.push(e);
    const token = randomBytes(12).toString('hex');
    this.tokens.set(token, String(e.id));
    return ok(
      {
        id: e.id,
        token,
        expires_at: e.expires_at,
        install_command: ` curl -fsSL --pinnedpubkey 'sha256//AAAA' https://10.100.0.2:8443/install.sh | sudo sh -s -- --token ${token}${control ? ` --control ${control}` : ''}`,
        install_url: 'https://10.100.0.2:8443/install.sh',
        tls_pin: 'sha256//AAAA',
        agent_url: this.hubMeta.agents_url,
        ca_sha256: 'e57c',
        approve: e.approve,
        control,
        name: e.name,
      },
      201,
    );
  }

  /**
   * An agent claiming a token (the installer's `whombat-agent enroll`): a pre-approved one is added at once (named as
   * asked, else after its host, `-2`, `-3`, … when taken) with its level's switches and `enrollment.approved`; any other
   * waits for the person. Answers the server id (null while it waits). The server reports at once unless `report: false`.
   */
  claim(token: string, hostname: string, options: { os?: string; report?: boolean } = {}): string | null {
    const id = this.tokens.get(token);
    const e = this.enrollments.find((x) => x.id === id);
    if (e?.state !== 'issued') throw new Error('token not valid');
    this.tokens.delete(token);
    Object.assign(e, {
      hostname,
      os: options.os ?? 'Debian GNU/Linux 13 (trixie)',
      address: '10.100.0.42',
      agent_version: '0.2.0',
      requested_at: new Date().toISOString(),
    });
    if (e.approve !== true) {
      e.state = 'pending';
      this.fleet.pending_enrollments = this.enrollments.filter((x) => x.state === 'pending').length;
      this.emit('enrollment.pending', { id: e.id, hostname });
      return null;
    }
    const base = String(e.name ?? hostname)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    let serverId = base;
    for (let n = 2; this.#exists(serverId); n++) serverId = `${base}-${n}`;
    this.#addServer(
      serverId,
      e,
      typeof e.control === 'string' ? e.control : 'full',
      options.report !== false,
    );
    this.emit('enrollment.approved', { id: e.id, server_id: serverId, hostname });
    return serverId;
  }

  /** A server's agent reports (its `last_seen` now, connected). */
  report(serverId: string): void {
    const card = (this.fleet.servers as Json[]).find((s) => s.id === serverId);
    if (!card) return;
    card.last_seen = new Date().toISOString();
    card.agent_connected = true;
    this.emit('server.updated', {
      id: serverId,
      status: 'online',
      last_seen: card.last_seen,
      agent_connected: true,
    });
  }

  /** The hub switches of a control level (hosts HS-93…, Whombat SI-06), with the agent's lock the same. */
  static levelSwitches(level: string): Json {
    const on = {
      watch: ['diagnose'],
      operate: ['console', 'power', 'diagnose'],
      full: ['console', 'power', 'host_shell', 'host_power', 'manage', 'diagnose'],
    }[level] ?? ['diagnose'];
    const out: Json = {};
    for (const k of ['console', 'power', 'host_shell', 'host_power', 'manage', 'diagnose']) {
      out[k] = on.includes(k);
      out[`agent_${k}`] = on.includes(k);
    }
    return out;
  }

  #addServer(serverId: string, e: Json, level: string, reported: boolean): void {
    e.state = 'approved';
    e.server_id = serverId;
    const now = new Date().toISOString();
    (this.fleet.servers as Json[]).push({
      id: serverId,
      hostname: e.hostname,
      group: e.group ?? 'Ungrouped',
      status: reported ? 'online' : 'unknown',
      status_note: null,
      os: e.os,
      cpu: null,
      memory_total_gb: null,
      storage_capacity_tb: null,
      last_seen: reported ? now : null,
      current: null,
      last_known: null,
      workloads: {
        docker: { running: 0, stopped: 0, unhealthy: 0 },
        incus: { containers_running: 0, vms_running: 0, stopped: 0 },
        qemu: { running: 0, stopped: 0 },
      },
      hypervisor: null,
      detail_view: 'standard',
      agent_connected: reported,
      open_alerts: 0,
      console_on: false,
      maintenance: null,
      parent: null,
    });
    const detail = this.#detail(serverId).body as Json;
    (detail.server as Json).remote_control = FakeHostsService.levelSwitches(level);
    this.details[serverId] = detail;
    this.fleet.pending_enrollments = this.enrollments.filter((x) => x.state === 'pending').length;
    this.emit('server.online', { id: serverId, at: now });
  }

  #decideEnrollment(id: string, r: FakeRequest, approve: boolean): FakeAnswer {
    const e = this.enrollments.find((x) => x.id === id);
    if (!e) return problem(404, 'not_found', 'Not found.');
    // A token nobody used yet can be turned away too (whombat-hosts: issued or pending).
    if (!approve && e.state === 'issued') {
      e.state = 'rejected';
      for (const [token, of] of this.tokens) if (of === id) this.tokens.delete(token);
      return { status: 204 };
    }
    if (e.state !== 'pending') return problem(409, 'not_pending', 'It isn’t waiting any more.');
    if (!approve) {
      e.state = 'rejected';
      return { status: 204 };
    }
    const body = (r.body ?? {}) as { name?: string; group?: string };
    const serverId = String(body.name ?? e.hostname ?? 'server')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
    if (this.#exists(serverId)) return problem(409, 'server_exists', 'A server with that name exists.');
    // A level stored with the enrollment (0.85) applies when it is approved by hand too.
    if (typeof e.control === 'string') {
      this.#addServer(serverId, { ...e, group: body.group ?? e.group }, e.control, true);
      Object.assign(e, { state: 'approved', server_id: serverId });
      return ok({ server_id: serverId });
    }
    e.state = 'approved';
    e.server_id = serverId;
    (this.fleet.servers as Json[]).push({
      id: serverId,
      hostname: e.hostname,
      group: body.group ?? 'Ungrouped',
      status: 'online',
      status_note: null,
      os: e.os,
      cpu: null,
      memory_total_gb: null,
      storage_capacity_tb: null,
      last_seen: this.fleet.as_of,
      current: null,
      last_known: null,
      workloads: {
        docker: { running: 0, stopped: 0, unhealthy: 0 },
        incus: { containers_running: 0, vms_running: 0, stopped: 0 },
        qemu: { running: 0, stopped: 0 },
      },
      hypervisor: null,
      detail_view: 'standard',
      agent_connected: true,
      open_alerts: 0,
      console_on: false,
      maintenance: null,
      parent: null,
    });
    this.fleet.pending_enrollments = this.enrollments.filter((x) => x.state === 'pending').length;
    this.emit('server.online', { id: serverId, at: this.fleet.as_of });
    return ok({ server_id: serverId });
  }

  /** Every route that matches, in the order they are tried (overrides, exact routes, then patterns). */
  #match(method: string, path: string): { handler: FakeHandler; params: string[] }[] {
    const parts = path.split('/');
    const tryOne = (m: string, pattern: string[], handler: FakeHandler) => {
      if (m !== method || pattern.length !== parts.length) return null;
      const params: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (pattern[i] === '*') params.push(decodeURIComponent(parts[i] as string));
        else if (pattern[i] !== parts[i]) return null;
      }
      return { handler, params };
    };
    const hits: { handler: FakeHandler; params: string[] }[] = [];
    for (const o of this.#overrides) {
      const hit = tryOne(o.method, o.parts, o.handler);
      if (hit) hits.push(hit);
    }
    // Exact routes before patterns, so `/servers/*/settings` doesn't lose to `/servers/*/*`-like ones.
    const routes = this.#routes();
    for (const exactFirst of [true, false])
      for (const r of routes) {
        if (r.path.includes('*') === exactFirst) continue;
        const hit = tryOne(r.method, r.path.split('/'), r.handler);
        if (hit) hits.push(hit);
      }
    return hits;
  }

  #record(req: IncomingMessage, url: URL, body: unknown, raw: Buffer): FakeRequest {
    const actorRaw = req.headers['x-whombat-actor'];
    const decoded = typeof actorRaw === 'string' ? Buffer.from(actorRaw, 'latin1').toString('utf8') : null;
    const r: FakeRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body,
      raw,
      actor: decoded,
      role: typeof req.headers['x-whombat-role'] === 'string' ? req.headers['x-whombat-role'] : null,
      clientIp:
        typeof req.headers['x-whombat-client-ip'] === 'string' ? req.headers['x-whombat-client-ip'] : null,
    };
    this.requests.push(r);
    return r;
  }

  /** The hub's user name for an actor: `<name> (<id>)`, or the id (WHOMBAT.md §2). */
  #user(r: FakeRequest): string {
    const [id, name] = (r.actor ?? 'whombat|Whombat').split('|');
    return name ? `${name} (${id})` : (id as string);
  }

  #authorized(req: IncomingMessage): boolean {
    return !this.refuseToken && req.headers.authorization === `Bearer ${this.token}`;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://hosts.local');
    // Restarting after a restore: nothing answers (the socket is there, the process isn't yet).
    if (Date.now() < this.#downUntil) {
      req.socket.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bytes = Buffer.concat(chunks);
    const isJson = !/gzip|octet-stream/.test(String(req.headers['content-type'] ?? ''));
    const raw = isJson ? bytes.toString('utf8') : '';
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const r = this.#record(req, url, body, bytes);
    const send = (a: FakeAnswer) => {
      const payload =
        a.body === undefined
          ? ''
          : typeof a.body === 'string' || Buffer.isBuffer(a.body)
            ? a.body
            : JSON.stringify(a.body);
      res.writeHead(a.status, { 'content-type': 'application/json', ...(a.headers ?? {}) });
      res.end(payload);
    };
    if (url.pathname !== '/healthz' && !this.#authorized(req)) {
      send(problem(401, 'unauthenticated', 'Sign in first.'));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write('retry: 5000\n\n');
      const last = req.headers['last-event-id'];
      if (typeof last === 'string' && Number(last) < this.#eventId - 4096)
        res.write('event: resync\ndata: {}\n\n');
      this.#streams.add(res);
      res.on('close', () => this.#streams.delete(res));
      return;
    }
    try {
      // A handler that answers null leaves the request to the next route that matches.
      for (const hit of this.#match(r.method, url.pathname)) {
        const answer = await hit.handler(r, hit.params);
        if (answer) {
          send(answer);
          return;
        }
      }
      send(problem(404, 'not_found', 'No such route.'));
    } catch (err) {
      send(problem(500, 'internal', err instanceof Error ? err.message : 'failed'));
    }
  }

  #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://hosts.local');
    const m = /^\/api\/v1\/console\/([^/]+)$/.exec(url.pathname);
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const refuse = (status: number, code: string) => {
      socket.write(
        `HTTP/1.1 ${status} Refused\r\ncontent-type: application/problem+json\r\n\r\n{"code":"${code}"}`,
      );
      socket.destroy();
    };
    if (!m) {
      refuse(404, 'not_found');
      return;
    }
    if (!this.#authorized(req)) {
      refuse(401, 'unauthenticated');
      return;
    }
    const s = this.sessions.get(m[1] as string);
    const tokenProto = protocols.find((p) => p.startsWith('rackoon.token.'));
    if (!protocols.includes('rackoon.console.v1') || !tokenProto) {
      refuse(400, 'subprotocol');
      return;
    }
    if (!s || tokenProto !== `rackoon.token.${s.token}`) {
      refuse(403, 'invalid_token');
      return;
    }
    if (s.used) {
      refuse(403, 'token_used');
      return;
    }
    s.used = true;
    const opened: (typeof this.consoles)[number] = { protocols, session: s.id, headers: req.headers };
    this.consoles.push(opened);
    this.#wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      opened.ws = ws;
      const status = Buffer.from(
        JSON.stringify({ type: 'status', state: 'connected', protocol: s.protocol, resolution: null }),
      );
      ws.send(Buffer.concat([Buffer.from([1, 0, 0]), status]));
      ws.on('message', (data: Buffer) => {
        // Data frames come back as they went (an echo terminal); control frames are answered when they ask.
        if (data[0] === 0) ws.send(data);
        else if (data[0] === 1) {
          try {
            const msg = JSON.parse(data.subarray(3).toString('utf8')) as { type?: string; id?: unknown };
            if (msg.type === 'ping')
              ws.send(
                Buffer.concat([
                  Buffer.from([1, 0, 0]),
                  Buffer.from(JSON.stringify({ type: 'pong', id: msg.id })),
                ]),
              );
          } catch {
            // ignore
          }
        }
      });
    });
  }
}

/** The hub ending a console as it does (WHOMBAT.md §5): a `closed` control with the reason, then a normal close. */
export function endFakeConsole(ws: WebSocket, reason: string): void {
  ws.send(Buffer.concat([Buffer.from([1, 0, 0]), Buffer.from(JSON.stringify({ type: 'closed', reason }))]));
  ws.close(1000, reason);
}

/** A started fake (a fresh directory with its socket and token file). */
export async function startFakeHosts(
  options: { dir?: string; token?: string } = {},
): Promise<FakeHostsService> {
  return new FakeHostsService(options).start();
}
