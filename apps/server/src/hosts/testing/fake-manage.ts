/**
 * The fake hosts service's Proxmox side (`fake.ts`; hosts/docs/MANAGE.md §3.1 and REST-API “Manage”, the Proxmox
 * build brief §2.1 for backup jobs): every manage route and read with plausible state per server — guests created,
 * cloned, made templates, moved and deleted; backups made, restored, protected, annotated and deleted; ISO images and
 * container templates downloaded and deleted; tasks whose log grows while they run and that end with `task.finished`;
 * a guest's firewall, high availability, replication and snapshots; scheduled backup jobs, whose cover feeds the
 * guests' `backup_job` and the “in no backup job” hint.
 *
 * Like the hub it refuses a body field the route doesn't take, checks the role the route needs, the manage switch,
 * confirmations and digests. Tests steer tasks with `taskOutcome(op, result, message)` (the next task of that op ends
 * so), `holdTasks` (tasks run until `finishTask`) and `taskMs`.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type FakeAnswer, type FakeHandler, type FakeRequest, type Json, ok, problem } from './fake-http';

/** What the manage side needs of the fake service it is part of. */
export interface ManageHost {
  emit(event: string, data: unknown): number;
  serverExists(serverId: string): boolean;
  guestsOf(serverId: string): Json[];
  guest(serverId: string, id: string): Json | null;
  addGuest(serverId: string, guest: Json): void;
  removeGuest(serverId: string, id: string): void;
  /** The server's switches as its detail has them, or null. */
  switchesOf(serverId: string): Json | null;
  /** The server's hand-off detail (Proxmox: `cluster`, `storages`), or null. */
  detailOf(serverId: string): Json | null;
  configOf(serverId: string, guestId: string): GuestConfigState;
  userOf(r: FakeRequest): string;
  asOf(): string;
  /** Replaces one kind of a server's hints (fleet and detail). */
  setHint(serverId: string, kind: string, hint: Json | null): void;
}

export interface GuestConfigState {
  digest: number;
  values: Record<string, string>;
  running: boolean;
}

type Result = 'ok' | 'warning' | 'error';

interface Task {
  id: string;
  type: string;
  op: string;
  server: string;
  guest: string | null;
  /** The guest `task.finished` names (the new one for create, clone and restore). */
  eventGuest: string | null;
  node: string;
  user: string;
  started: string;
  ended: string | null;
  status: 'running' | Result;
  message?: string;
  log: string[];
  plan: string[];
  apply: ((ok: boolean) => void) | null;
  timer: NodeJS.Timeout | null;
  /** Incus operations say whether they may be cancelled (`task.list`, `task.stop`). */
  cancellable?: boolean;
  /** Why it ended early (a package task: `busy`, `timeout`). */
  code?: string;
  /** More fields of the status once it ended (a package task's `packages`). */
  extra?: Json;
  ended_: ((result: Result, message: string, code: string | null) => Json | undefined) | null;
}

/** What a task's id looks like: Proxmox's UPID, an Incus operation, an agent task (unRAID, libvirt, packages). */
export type TaskIdKind = 'pve' | 'incus' | 'unraid' | 'libvirt' | 'pkg';

/** How the Incus and unRAID sides start a task (`FakeManage.startTask`). */
export interface StartTask {
  /** The task's type (`backup`, `parity-check`, `plugin-update`, …). */
  type: string;
  guest?: string | null;
  /** The log lines it writes while it runs (the first at once). */
  plan?: string[];
  /** Runs when the task ends: `true` when it went well. */
  apply?: ((ok: boolean) => void) | null;
  /** More fields of the 202 answer (`new_id`). */
  answer?: Json;
  idKind?: TaskIdKind;
  cancellable?: boolean;
  /** Runs when the task ends (after `apply`): more fields of its status (a package task's `packages`). */
  ended?: ((result: Result, message: string, code: string | null) => Json | undefined) | null;
}

interface Firewall {
  options: Record<string, string>;
  optionsDigest: number;
  rules: Json[];
  rulesDigest: number;
}

const ROLE_RANK: Record<string, number> = { viewer: 0, operator: 1, admin: 2 };
const FIREWALL_OPTIONS = new Set([
  'enable',
  'dhcp',
  'ndp',
  'radv',
  'macfilter',
  'ipfilter',
  'policy_in',
  'policy_out',
  'log_level_in',
  'log_level_out',
]);
const BACKUP_JOB_FIELDS = [
  'enabled',
  'schedule',
  'storage',
  'node',
  'selection',
  'guests',
  'exclude',
  'pool',
  'mode',
  'compress',
  'keep',
  'notes_template',
  'comment',
];
const BACKUP_JOB_CLEARABLE = new Set(['node', 'compress', 'keep', 'notes_template', 'comment', 'exclude']);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
const STORAGE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const DISK_RE = /^(scsi\d+|virtio\d+|sata\d+|ide\d+|efidisk0|tpmstate0|rootfs|mp\d+)$/;

const hex = (n: number) =>
  randomBytes(Math.ceil(n / 2))
    .toString('hex')
    .slice(0, n)
    .toUpperCase();
const audit = () => `au_${randomBytes(6).toString('hex')}`;
const vmidOf = (guestId: string) => guestId.split(':')[1] ?? guestId;

/** The storages of the fixture Proxmox node with what each holds (the hand-off data says it in words). */
const STORAGE_CONTENT: Record<string, string[]> = {
  local: ['iso', 'vztmpl', 'backup', 'import'],
  'local-zfs': ['images', 'rootdir'],
  vmdata: ['images'],
  bulk: ['images', 'rootdir'],
  'pbs-01': ['backup'],
};

const APPLIANCES: Json[] = [
  {
    template: 'debian-13-standard_13.1-2_amd64.tar.zst',
    package: 'debian-13-standard',
    headline: 'Debian 13 (standard)',
    description: 'A small Debian Trixie system including all standard packages.',
    os: 'debian-13',
    version: '13.1-2',
    section: 'system',
  },
  {
    template: 'ubuntu-24.04-standard_24.04-2_amd64.tar.zst',
    package: 'ubuntu-24.04-standard',
    headline: 'Ubuntu 24.04 (standard)',
    description: 'A small Ubuntu 24.04 LTS (Noble Numbat) system.',
    os: 'ubuntu-24.04',
    version: '24.04-2',
    section: 'system',
  },
  {
    template: 'alpine-3.22-default_20250617_amd64.tar.xz',
    package: 'alpine-3.22-default',
    headline: 'Alpine Linux 3.22',
    description: 'A very small Alpine Linux system.',
    os: 'alpine-3.22',
    version: '20250617',
    section: 'system',
  },
  {
    template: 'debian-12-turnkey-nextcloud_18.2-1_amd64.tar.gz',
    package: 'turnkey-nextcloud',
    headline: 'TurnKey Nextcloud',
    description: 'Nextcloud, ready to set up.',
    os: 'debian-12',
    version: '18.2-1',
    section: 'turnkeylinux',
  },
];

/** The steps a task logs, by its Proxmox type (the last line is the outcome's). */
function plan(type: string, vmid: string, extra: Json = {}): string[] {
  switch (type) {
    case 'vzdump':
      return [
        `INFO: starting new backup job: vzdump ${vmid} --storage ${String(extra.storage ?? 'pbs-01')} --mode ${String(extra.mode ?? 'snapshot')}`,
        `INFO: Starting Backup of VM ${vmid} (qemu)`,
        'INFO: status = running',
        'INFO: creating Proxmox Backup Server archive',
        'INFO:  21% (6.7 GiB of 32.0 GiB) in 3s',
        'INFO:  64% (20.5 GiB of 32.0 GiB) in 9s',
        'INFO: 100% (32.0 GiB of 32.0 GiB) in 14s',
        `INFO: Finished Backup of VM ${vmid} (00:00:15)`,
        'INFO: Backup job finished successfully',
      ];
    case 'qmclone':
    case 'vzclone':
      return [
        `create full clone of drive scsi0 (local-zfs:vm-${vmid}-disk-0)`,
        'transferred 32.0 GiB of 32.0 GiB (100.00%)',
      ];
    case 'qmrestore':
    case 'vzrestore':
      return [
        'restore vma archive',
        'progress 25% (read 8.0 GiB)',
        'progress 100% (read 32.0 GiB)',
        'rescan volumes...',
      ];
    case 'qmigrate':
    case 'vzmigrate':
      return [
        `starting migration of VM ${vmid} to node '${String(extra.target ?? 'schist')}'`,
        'migration active, transferred 4.0 GiB of 16.0 GiB VM-state',
        'migration status: completed',
        'migration finished successfully',
      ];
    case 'download':
    case 'aptldr':
      return [
        `downloading ${String(extra.url ?? extra.template ?? 'the file')}`,
        '41% (262.1 MiB of 640.0 MiB)',
        '100% (640.0 MiB of 640.0 MiB)',
        'download of the file finished',
      ];
    default:
      return [`${type} ${vmid}`.trim()];
  }
}

export class FakeManage {
  /** How long a task runs before it ends (ms). */
  taskMs = 60;
  /** Tasks run until `finishTask` ends them. */
  holdTasks = false;
  /** Servers whose helper is from before isolated restores (no `restore_isolate`, `isolate` refused). */
  readonly oldHelpers = new Set<string>();
  /** Servers whose helper is from before it read a backup's own settings (no `backup_config`). */
  readonly noBackupConfig = new Set<string>();
  readonly tasks = new Map<string, Task>();
  readonly backups = new Map<string, Json[]>();
  /** A backup's own settings, by its volume (`backups/config`); without one, the machine's settings now. */
  readonly backupConfigs = new Map<string, Record<string, string>>();
  readonly content = new Map<string, Json[]>();
  readonly jobs = new Map<string, Json[]>();
  readonly firewalls = new Map<string, Firewall>();
  readonly ha = new Map<string, Json>();
  readonly replication = new Map<string, Json[]>();
  readonly snapshots = new Map<string, Json[]>();
  #outcomes = new Map<string, { result: Result; message: string; code: string | null }>();

  constructor(private readonly host: ManageHost) {}

  /** The fixture world's Proxmox state (after the fake filled in its data). */
  init(): void {
    for (const server of this.#pveServers()) {
      const guests = this.host.guestsOf(server);
      this.backups.set(
        server,
        guests
          .filter((g) => g.last_backup)
          .map((g) => {
            const at = String((g.last_backup as Json).at ?? this.host.asOf());
            return this.#volume(server, g, 'pbs-01', at, String(g.name ?? ''), false);
          }),
      );
      this.content.set(server, [
        this.#contentItem('local', 'iso', 'debian-13.1.0-amd64-netinst.iso', 754_974_720),
        this.#contentItem('local', 'iso', 'virtio-win-0.1.271.iso', 739_016_704),
        this.#contentItem('local', 'vztmpl', 'debian-13-standard_13.1-2_amd64.tar.zst', 129_761_280),
      ]);
      const node = this.#node(server);
      this.jobs.set(server, [
        this.#digested({
          id: 'backup-1d7e5a2c-0f3b',
          enabled: true,
          schedule: '00:00',
          storage: 'pbs-01',
          node: null,
          selection: 'all',
          guests: [],
          exclude: guests.filter((g) => g.name === 'win11-lab').map((g) => g.id),
          pool: null,
          mode: 'snapshot',
          compress: 'zstd',
          keep: { last: 3, daily: 7, weekly: 4, monthly: 6 },
          notes_template: '{{guestname}}',
          comment: 'Every night',
          next_run: '2026-10-18T00:00:00Z',
        }),
      ]);
      const pg = guests.find((g) => g.name === 'postgres-prod');
      if (pg)
        this.snapshots.set(`${server}/${pg.id}`, [
          {
            Name: 'before-pg17',
            Created: '2026-08-20T21:04:00Z',
            Description: 'Before the PostgreSQL 17 upgrade',
          },
        ]);
      for (const g of guests) {
        g.tags = g.name === 'postgres-prod' ? ['prod', 'db'] : [];
        g.pending_changes = 0;
        g.guest_agent = g.kind === 'vm' && g.state === 'running' ? 'running' : '';
        g.ha_state = '';
        g.template = false;
        g.node = g.node ?? node;
      }
      const at = this.host.asOf();
      this.#task(server, 'backup.create', 'vzdump', null, 'root@pam', { ended: at, status: 'ok' });
      this.#coverage(server);
    }
  }

  /** The next task of an op ends this way (once); `code`: a package task's `busy` or `timeout`. */
  taskOutcome(op: string, result: Result, message = '', code: string | null = null): void {
    this.#outcomes.set(op, { result, message, code });
  }

  /** Ends a running task now (`code`: a package task's `busy` or `timeout`). */
  finishTask(id: string, result: Result = 'ok', message?: string, code: string | null = null): void {
    const t = this.tasks.get(id);
    if (t && t.status === 'running') this.#finish(t, result, message ?? (result === 'ok' ? 'OK' : ''), code);
  }

  /** A snapshot action on a guest (`fake.ts`'s guest actions). */
  snapshotAction(server: string, guestId: string, action: string, body: Json): void {
    const key = `${server}/${guestId}`;
    const list = this.snapshots.get(key) ?? [];
    if (action === 'snapshot_create')
      list.push({
        Name:
          typeof body.snapshot === 'string' && body.snapshot
            ? body.snapshot
            : `rackoon-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
        Created: new Date().toISOString(),
        Description: typeof body.description === 'string' ? body.description : '',
        WithMemory: body.memory === true,
      });
    if (action === 'snapshot_delete') {
      const i = list.findIndex((s) => s.Name === body.snapshot);
      if (i >= 0) list.splice(i, 1);
    }
    this.snapshots.set(key, list);
  }

  routes(): { method: string; path: string; handler: FakeHandler }[] {
    const S = '/api/v1/servers/*';
    const G = `${S}/guests/*`;
    const s = (p: string[]) => p[0] as string;
    const g = (p: string[]) => p[1] as string;
    return [
      { method: 'GET', path: `${G}/config`, handler: (r, p) => this.#getConfig(r, s(p), g(p)) },
      { method: 'PUT', path: `${G}/config`, handler: (r, p) => this.#setConfig(r, s(p), g(p)) },
      {
        method: 'POST',
        path: `${G}/disks/*/resize`,
        handler: (r, p) => this.#resize(r, s(p), g(p), p[2] as string),
      },
      {
        method: 'POST',
        path: `${G}/disks/*/move`,
        handler: (r, p) => this.#moveDisk(r, s(p), g(p), p[2] as string),
      },
      { method: 'GET', path: `${S}/manage/choices`, handler: (r, p) => this.#choices(r, s(p)) },
      { method: 'POST', path: `${S}/guests`, handler: (r, p) => this.#create(r, s(p)) },
      { method: 'POST', path: `${G}/clone`, handler: (r, p) => this.#clone(r, s(p), g(p)) },
      { method: 'POST', path: `${G}/template`, handler: (r, p) => this.#template(r, s(p), g(p)) },
      { method: 'POST', path: `${G}/migrate`, handler: (r, p) => this.#migrate(r, s(p), g(p)) },
      { method: 'DELETE', path: G, handler: (r, p) => this.#delete(r, s(p), g(p)) },
      { method: 'GET', path: `${G}/backups`, handler: (r, p) => this.#listBackups(r, s(p), g(p)) },
      { method: 'POST', path: `${G}/backups`, handler: (r, p) => this.#backup(r, s(p), g(p)) },
      { method: 'POST', path: `${S}/backups/restore`, handler: (r, p) => this.#restore(r, s(p)) },
      { method: 'GET', path: `${S}/backups/config`, handler: (r, p) => this.#backupConfig(r, s(p)) },
      { method: 'PATCH', path: `${S}/backups`, handler: (r, p) => this.#updateBackup(r, s(p)) },
      { method: 'DELETE', path: `${S}/backups`, handler: (r, p) => this.#deleteBackup(r, s(p)) },
      { method: 'GET', path: `${S}/storage/*/content`, handler: (r, p) => this.#listContent(r, s(p), g(p)) },
      { method: 'POST', path: `${S}/storage/*/download`, handler: (r, p) => this.#download(r, s(p), g(p)) },
      { method: 'DELETE', path: `${S}/storage/content`, handler: (r, p) => this.#deleteContent(r, s(p)) },
      { method: 'GET', path: `${S}/appliances`, handler: (r, p) => this.#appliances(r, s(p)) },
      {
        method: 'POST',
        path: `${S}/storage/*/appliances`,
        handler: (r, p) => this.#getAppliance(r, s(p), g(p)),
      },
      { method: 'GET', path: `${G}/tasks`, handler: (r, p) => this.#listTasks(r, s(p), g(p)) },
      { method: 'GET', path: `${S}/tasks`, handler: (r, p) => this.#listTasks(r, s(p), null) },
      { method: 'GET', path: `${S}/tasks/*`, handler: (r, p) => this.#taskStatus(r, s(p), g(p)) },
      { method: 'DELETE', path: `${S}/tasks/*`, handler: (r, p) => this.#stopTask(r, s(p), g(p)) },
      { method: 'GET', path: `${G}/firewall`, handler: (r, p) => this.#getFirewall(r, s(p), g(p)) },
      {
        method: 'PUT',
        path: `${G}/firewall/options`,
        handler: (r, p) => this.#firewallOptions(r, s(p), g(p)),
      },
      { method: 'POST', path: `${G}/firewall/rules`, handler: (r, p) => this.#addRule(r, s(p), g(p)) },
      {
        method: 'PUT',
        path: `${G}/firewall/rules/*`,
        handler: (r, p) => this.#updateRule(r, s(p), g(p), p[2] as string),
      },
      {
        method: 'DELETE',
        path: `${G}/firewall/rules/*`,
        handler: (r, p) => this.#deleteRule(r, s(p), g(p), p[2] as string),
      },
      { method: 'PUT', path: `${G}/ha`, handler: (r, p) => this.#setHa(r, s(p), g(p)) },
      { method: 'DELETE', path: `${G}/ha`, handler: (r, p) => this.#removeHa(r, s(p), g(p)) },
      { method: 'POST', path: `${G}/replication`, handler: (r, p) => this.#addReplication(r, s(p), g(p)) },
      {
        method: 'DELETE',
        path: `${G}/replication/*`,
        handler: (r, p) => this.#deleteReplication(r, s(p), g(p), p[2] as string),
      },
      { method: 'GET', path: `${G}/snapshots`, handler: (r, p) => this.#listSnapshots(r, s(p), g(p)) },
      { method: 'GET', path: `${S}/backup-jobs`, handler: (r, p) => this.#listJobs(r, s(p)) },
      { method: 'POST', path: `${S}/backup-jobs`, handler: (r, p) => this.#createJob(r, s(p)) },
      { method: 'PUT', path: `${S}/backup-jobs/*`, handler: (r, p) => this.#updateJob(r, s(p), g(p)) },
      { method: 'DELETE', path: `${S}/backup-jobs/*`, handler: (r, p) => this.#deleteJob(r, s(p), g(p)) },
      { method: 'POST', path: `${S}/backup-jobs/*/run`, handler: (r, p) => this.#runJob(r, s(p), g(p)) },
      { method: 'POST', path: `${S}/actions`, handler: (r, p) => this.#hostAction(r, s(p)) },
    ];
  }

  /* Checks ---------------------------------------------------------------------------------------------------------- */

  #pveServers(): string[] {
    return ['shale', 'basalt'].filter(
      (id) => this.host.serverExists(id) && this.host.guestsOf(id).some((g) => g.platform === 'pve'),
    );
  }

  #platform(server: string, asked?: unknown): 'pve' | 'incus' | null {
    const guests = this.host.guestsOf(server);
    if (asked === 'pve') return guests.some((g) => g.platform === 'pve') ? 'pve' : null;
    if (asked === 'incus') return guests.some((g) => g.platform === 'incus') ? 'incus' : null;
    if (guests.some((g) => g.platform === 'pve')) return 'pve';
    if (guests.some((g) => g.platform === 'incus')) return 'incus';
    return null;
  }

  #node(server: string): string {
    const nodes = (this.host.detailOf(server)?.cluster as Json | undefined)?.nodes as Json[] | undefined;
    return String(nodes?.find((n) => n.this_node)?.name ?? server);
  }

  #otherNodes(server: string): string[] {
    const nodes =
      ((this.host.detailOf(server)?.cluster as Json | undefined)?.nodes as Json[] | undefined) ?? [];
    return nodes.filter((n) => !n.this_node).map((n) => String(n.name));
  }

  #storages(server: string): { id: string; type: string; content: string[]; avail: number; total: number }[] {
    const list = (this.host.detailOf(server)?.storages as Json[] | undefined) ?? [];
    return list.map((st) => ({
      id: String(st.id),
      type: String(st.type ?? 'dir'),
      content: STORAGE_CONTENT[String(st.id)] ?? ['images', 'rootdir'],
      total: Math.round(Number(st.capacity_gb ?? 100) * 1e9),
      avail: Math.round((Number(st.capacity_gb ?? 100) - Number(st.used_gb ?? 0)) * 1e9),
    }));
  }

  #holds(server: string, storage: unknown, content: string): boolean {
    return this.#storages(server).some((st) => st.id === storage && st.content.includes(content));
  }

  /** The common checks of a manage route: server, role, the manage switch; null when they pass. */
  #check(r: FakeRequest, server: string, role: 'operator' | 'admin'): FakeAnswer | null {
    if (!this.host.serverExists(server)) return problem(404, 'server_not_found', 'No such server.');
    if ((ROLE_RANK[r.role ?? 'viewer'] ?? 0) < (ROLE_RANK[role] ?? 1))
      return problem(403, 'insufficient_role', `This needs the ${role} role.`);
    const rc = this.host.switchesOf(server);
    if (rc && rc.manage === false)
      return problem(403, 'manage_disabled', 'Managing guests is turned off for this server');
    if (rc && rc.agent_manage === false)
      return problem(403, 'manage_disabled', 'This host’s agent does not allow managing guests yet');
    return null;
  }

  /** A guest route's checks; the guest when they pass. */
  #guestCheck(
    r: FakeRequest,
    server: string,
    guestId: string,
    role: 'operator' | 'admin',
  ): { guest: Json } | FakeAnswer {
    const refused = this.#check(r, server, role);
    if (refused) return refused;
    const guest = this.host.guest(server, guestId);
    if (!guest) return problem(404, 'guest_not_found', 'No such guest.');
    if (guest.platform !== 'pve' && guest.platform !== 'incus')
      return problem(501, 'unsupported', 'Docker and libvirt guests are not managed.');
    return { guest };
  }

  /** The body's fields, when it has only those the route takes. */
  #body(r: FakeRequest, allowed: readonly string[]): { fields: Json } | FakeAnswer {
    if (r.body === undefined || r.body === '') return { fields: {} };
    if (!r.body || typeof r.body !== 'object' || Array.isArray(r.body))
      return problem(400, 'bad_request', 'Invalid JSON body: a JSON object is required.');
    for (const k of Object.keys(r.body as Json))
      if (!allowed.includes(k)) return problem(400, 'bad_request', `Invalid JSON body: unknown field "${k}"`);
    return { fields: r.body as Json };
  }

  #invalid(fields: Record<string, string>): FakeAnswer {
    return problem(400, 'invalid_value', Object.values(fields)[0] ?? 'Invalid value.', {
      field_errors: fields,
    });
  }

  /* Tasks ----------------------------------------------------------------------------------------------------------- */

  #task(
    server: string,
    op: string,
    type: string,
    guest: string | null,
    user: string,
    done?: { ended: string; status: Result },
    idKind: TaskIdKind = guest?.startsWith('incus:') ? 'incus' : 'pve',
  ): Task {
    const node = this.#node(server);
    const vmid = guest ? vmidOf(guest) : '';
    const id =
      idKind === 'incus'
        ? `incus:${randomUUID()}`
        : idKind === 'unraid' || idKind === 'libvirt' || idKind === 'pkg'
          ? `${idKind}:${randomBytes(8).toString('hex')}`
          : `UPID:${node}:${hex(8)}:${hex(8)}:${hex(8)}:${type}:${vmid}:${user}:`;
    const t: Task = {
      id,
      type,
      op,
      server,
      guest,
      eventGuest: guest,
      node,
      user,
      started: done ? '2026-10-11T00:00:00Z' : new Date().toISOString(),
      ended: done?.ended ?? null,
      status: done?.status ?? 'running',
      log: [],
      plan: [],
      apply: null,
      ended_: null,
      timer: null,
    };
    this.tasks.set(id, t);
    return t;
  }

  /* For the Incus and unRAID sides (`fake-incus.ts`, `fake-unraid.ts`) ---------------------------------------------- */

  /** The common checks of a manage route (server, role, the manage switch); null when they pass. */
  check(r: FakeRequest, server: string, role: 'operator' | 'admin'): FakeAnswer | null {
    return this.#check(r, server, role);
  }

  /** The body's fields, when it has only those the route takes. */
  body(r: FakeRequest, allowed: readonly string[]): { fields: Json } | FakeAnswer {
    return this.#body(r, allowed);
  }

  /** A 400 `invalid_value` with field errors. */
  invalid(fields: Record<string, string>): FakeAnswer {
    return this.#invalid(fields);
  }

  /** The hub's user name for the request's actor. */
  user(r: FakeRequest): string {
    return this.host.userOf(r);
  }

  /** Starts a task (Incus operation, unRAID agent task, …) that ends like the Proxmox ones: 202 with its id. */
  startTask(r: FakeRequest, server: string, op: string, t: StartTask): FakeAnswer {
    const kind = t.idKind ?? (t.guest?.startsWith('incus:') ? 'incus' : 'pve');
    const task = this.#task(server, op, t.type, t.guest ?? null, this.host.userOf(r), undefined, kind);
    task.plan = t.plan?.length ? t.plan : [`${t.type} ${t.guest ?? ''}`.trim()];
    task.log = task.plan.slice(0, 1);
    task.apply = t.apply ?? null;
    task.ended_ = t.ended ?? null;
    if (t.cancellable !== undefined) task.cancellable = t.cancellable;
    if (typeof t.answer?.new_id === 'string') task.eventGuest = t.answer.new_id;
    this.#arm(task, op);
    return ok({ ok: true, task: { id: task.id }, ...(t.answer ?? {}), audit_id: audit() }, 202);
  }

  /** A finished task in the list (the fixture's history). */
  pastTask(
    server: string,
    op: string,
    type: string,
    guest: string | null,
    idKind: TaskIdKind,
    status: Result,
    message = '',
  ): void {
    const t = this.#task(server, op, type, guest, 'root', { ended: this.host.asOf(), status }, idKind);
    if (message) t.message = message;
  }

  /** Ends the task after `taskMs`, with the outcome a test asked for (`taskOutcome`), unless tasks are held. */
  #arm(t: Task, op: string): void {
    if (this.holdTasks) return;
    t.timer = setTimeout(() => {
      const outcome = this.#outcomes.get(op);
      if (outcome) this.#outcomes.delete(op);
      this.#finish(t, outcome?.result ?? 'ok', outcome?.message ?? 'OK', outcome?.code ?? null);
    }, this.taskMs);
  }

  /** Starts a task that ends after `taskMs` (or at `finishTask`) and runs `apply` when it went well. */
  #start(
    r: FakeRequest,
    server: string,
    op: string,
    type: string,
    guest: string | null,
    extra: Json,
    apply: ((ok: boolean) => void) | null,
    answer: Json = {},
  ): FakeAnswer {
    const t = this.#task(server, op, type, guest, `${this.host.userOf(r)}`);
    t.plan = plan(type, guest ? vmidOf(guest) : '', extra);
    t.log = t.plan.slice(0, 1);
    t.apply = apply;
    if (typeof answer.new_id === 'string') t.eventGuest = answer.new_id;
    if (t.id.startsWith('incus:')) t.cancellable = false;
    this.#arm(t, op);
    return ok({ ok: true, task: { id: t.id }, ...answer, audit_id: audit() }, 202);
  }

  #finish(t: Task, result: Result, message: string, code: string | null = null): void {
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    t.status = result;
    t.ended = new Date().toISOString();
    t.message = result === 'ok' ? 'OK' : message;
    if (code) t.code = code;
    const last =
      result === 'ok'
        ? 'TASK OK'
        : result === 'warning'
          ? `TASK ${message || 'WARNINGS: 1'}`
          : `TASK ERROR: ${message}`;
    t.log = [...t.plan, last];
    t.apply?.(result !== 'error');
    const extra = t.ended_?.(result, t.message ?? '', code);
    if (extra) t.extra = extra;
    this.host.emit('task.finished', {
      server: t.server,
      guest: t.eventGuest,
      task: t.id,
      op: t.op,
      result,
      message: t.message ?? '',
      ...(code ? { code } : {}),
    });
  }

  #taskJson(t: Task, logStart: number | null): Json {
    return {
      id: t.id,
      type: t.type,
      ...(t.guest ? { guest: t.guest } : {}),
      node: t.node,
      user: t.user,
      started: t.started,
      ...(t.ended ? { ended: t.ended } : {}),
      status: t.status,
      ...(t.message ? { message: t.message } : {}),
      ...(t.cancellable !== undefined ? { cancellable: t.cancellable && t.status === 'running' } : {}),
      ...(t.code ? { code: t.code } : {}),
      ...(t.status !== 'running' && t.extra ? t.extra : {}),
      ...(logStart !== null && logStart >= 0 ? { log: t.log.slice(logStart), log_next: t.log.length } : {}),
    };
  }

  #listTasks(r: FakeRequest, server: string, guestId: string | null): FakeAnswer {
    if (guestId) {
      const gc = this.#guestCheck(r, server, guestId, 'operator');
      if (!('guest' in gc)) return gc;
    } else {
      const refused = this.#check(r, server, 'operator');
      if (refused) return refused;
    }
    const platform = r.query.get('platform');
    const kindOf = (id: string) => {
      const kind = /^(incus|unraid|libvirt|pkg):/.exec(id)?.[1] ?? 'pve';
      return kind === 'pkg' ? 'host' : kind;
    };
    const items = [...this.tasks.values()]
      .filter((t) => t.server === server && (!guestId || t.guest === guestId))
      .filter((t) => !platform || kindOf(t.id) === platform)
      .sort((a, b) => b.started.localeCompare(a.started))
      .slice(0, 50)
      .map((t) => this.#taskJson(t, null));
    return ok({ items });
  }

  #taskStatus(r: FakeRequest, server: string, id: string): FakeAnswer {
    const refused = this.#check(r, server, 'operator');
    if (refused) return refused;
    const t = this.tasks.get(id);
    if (!t || t.server !== server) {
      if (!/^(UPID|incus|unraid|libvirt|pkg):/.test(id))
        return problem(400, 'invalid_value', 'Not a task id.', { field_errors: { task: 'Not a task id.' } });
      return problem(404, 'not_found', 'No such task.');
    }
    // A running task's log grows with every look, as Proxmox's does.
    if (t.status === 'running' && t.log.length < t.plan.length) t.log.push(t.plan[t.log.length] as string);
    const start = Number(r.query.get('log_start') ?? 0);
    return ok(this.#taskJson(t, Number.isFinite(start) ? start : 0));
  }

  #stopTask(r: FakeRequest, server: string, id: string): FakeAnswer {
    const refused = this.#check(r, server, 'operator');
    if (refused) return refused;
    const t = this.tasks.get(id);
    if (!t || t.server !== server) return problem(404, 'not_found', 'No such task.');
    if (t.status === 'running' && t.cancellable === false)
      return problem(409, 'busy', 'This operation can’t be cancelled.');
    if (t.status === 'running') {
      t.apply = null;
      this.#finish(t, 'error', 'interrupted by signal');
    }
    return ok({ ok: true, audit_id: audit() });
  }

  /* Configuration --------------------------------------------------------------------------------------------------- */

  #getConfig(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'operator');
    if (!('guest' in gc)) return gc;
    const guest = gc.guest;
    const c = this.host.configOf(server, guestId);
    const key = `${server}/${guestId}`;
    const ha = this.ha.get(key);
    return ok({
      platform: String(guest.platform),
      kind: guest.kind,
      digest: `d${c.digest}`,
      running: c.running,
      values: c.values,
      pending: {},
      restricted: [],
      disks: [],
      ...(ha ? { ha: { ...ha, status: ha.state } } : {}),
      ...(this.replication.get(key)?.length ? { replication: this.replication.get(key) } : {}),
    });
  }

  #setConfig(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'operator');
    if (!('guest' in gc)) return gc;
    const bc = this.#body(r, ['digest', 'set', 'delete', 'revert', 'confirm']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    const c = this.host.configOf(server, guestId);
    const body = b as { digest?: string; set?: Record<string, string>; delete?: string[]; confirm?: boolean };
    if (body.digest !== undefined && body.digest !== `d${c.digest}`)
      return problem(409, 'digest_mismatch', 'The configuration changed meanwhile.');
    if ((body.delete ?? []).some((k) => /^unused\d+$/.test(k)) && body.confirm !== true)
      return problem(400, 'confirm_required', 'Deleting an unused disk destroys it: send "confirm": true.');
    const changes: Json[] = [];
    for (const [key, value] of Object.entries(body.set ?? {})) {
      if (key === 'smbios1') return problem(403, 'not_allowed', 'smbios1 isn’t allowed here.');
      changes.push({ key, old: c.values[key] ?? null, new: value, pending: c.running && key !== 'name' });
      c.values[key] = value;
    }
    for (const key of body.delete ?? []) {
      changes.push({ key, old: c.values[key] ?? null, new: null, pending: false });
      delete c.values[key];
    }
    c.digest += 1;
    return ok({ ok: true, changes, audit_id: audit() });
  }

  #resize(r: FakeRequest, server: string, guestId: string, disk: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'operator');
    if (!('guest' in gc)) return gc;
    const guest = gc.guest;
    const bc = this.#body(r, ['size']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    if (!DISK_RE.test(disk)) return this.#invalid({ disk: 'Not a disk of this guest.' });
    if (typeof b.size !== 'string' || !/^\+?\d+(\.\d+)?[KMGT]?$/.test(b.size))
      return this.#invalid({ size: 'A size like +8G or 64G.' });
    return this.#start(
      r,
      server,
      'disk.resize',
      guest.kind === 'vm' ? 'qmresize' : 'vzresize',
      guestId,
      {},
      null,
    );
  }

  #moveDisk(r: FakeRequest, server: string, guestId: string, disk: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'operator');
    if (!('guest' in gc)) return gc;
    const guest = gc.guest;
    const bc = this.#body(r, ['storage', 'delete_source']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    if (!DISK_RE.test(disk)) return this.#invalid({ disk: 'Not a disk of this guest.' });
    if (!this.#holds(server, b.storage, guest.kind === 'vm' ? 'images' : 'rootdir'))
      return this.#invalid({ storage: 'That storage doesn’t hold guest disks.' });
    return this.#start(
      r,
      server,
      'disk.move',
      guest.kind === 'vm' ? 'qmmove' : 'move_volume',
      guestId,
      {},
      null,
    );
  }

  #choices(r: FakeRequest, server: string): FakeAnswer {
    const refused = this.#check(r, server, 'operator');
    if (refused) return refused;
    const platform = this.#platform(server, r.query.get('platform') ?? undefined);
    if (!platform) return problem(501, 'unsupported', 'This server runs neither Proxmox VE nor Incus.');
    if (platform === 'incus')
      return ok({
        platform,
        storages: [{ id: 'default', type: 'zfs', content: ['images', 'rootdir'] }],
        bridges: ['incusbr0'],
        profiles: ['default'],
        images: [{ fingerprint: 'a1b2c3', aliases: ['debian/13'], type: 'container' }],
      });
    const content = this.content.get(server) ?? [];
    const guests = this.host.guestsOf(server);
    const ids = guests.map((g) => Number(vmidOf(String(g.id)))).filter(Number.isFinite);
    return ok({
      platform,
      node: this.#node(server),
      cluster: this.#otherNodes(server).length > 0,
      next_id: Math.max(99, ...ids) + 1,
      storages: this.#storages(server).map((st) => ({
        id: st.id,
        type: st.type,
        content: st.content,
        avail_bytes: st.avail,
        total_bytes: st.total,
        ...(st.type === 'zfspool' ? { thin: true } : {}),
        ...(st.type === 'pbs' ? { shared: true } : {}),
      })),
      bridges: ['vmbr0', 'vmbr1'],
      isos: content.filter((c) => c.content === 'iso'),
      ct_templates: content.filter((c) => c.content === 'vztmpl'),
      templates: guests
        .filter((g) => g.template === true)
        .map((g) => ({ id: vmidOf(String(g.id)), name: g.name, kind: g.kind, node: this.#node(server) })),
      cpu_types: ['host', 'x86-64-v2-AES', 'x86-64-v3', 'x86-64-v4', 'kvm64'],
      nodes: this.#otherNodes(server),
      download: true,
      ...(this.oldHelpers.has(server) ? {} : { restore_isolate: true }),
    });
  }

  /* Guests ---------------------------------------------------------------------------------------------------------- */

  #create(r: FakeRequest, server: string): FakeAnswer {
    const refused = this.#check(r, server, 'admin');
    if (refused) return refused;
    const bc = this.#body(r, ['platform', 'kind', 'new_id', 'name', 'set', 'start', 'image', 'profiles']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    const platform = this.#platform(server, b.platform);
    if (!platform) return problem(501, 'unsupported', 'This server runs neither Proxmox VE nor Incus.');
    if (b.kind !== 'vm' && b.kind !== 'container') return this.#invalid({ kind: 'vm or container.' });
    if (b.name !== undefined && (typeof b.name !== 'string' || !NAME_RE.test(b.name)))
      return this.#invalid({ name: 'Up to 63 letters, digits, dots and dashes.' });
    const set = (b.set ?? {}) as Record<string, string>;
    if (platform === 'pve' && b.kind === 'container') {
      if (!set.ostemplate) return this.#invalid({ ostemplate: 'A container needs a template.' });
      if (set.unprivileged !== undefined && set.unprivileged !== '1')
        return problem(403, 'not_allowed', 'Privileged containers are not created here.');
    }
    if (platform === 'incus' && typeof b.image !== 'string')
      return this.#invalid({ image: 'An image is needed.' });
    const guests = this.host.guestsOf(server);
    const ids = guests.map((x) => Number(vmidOf(String(x.id)))).filter(Number.isFinite);
    const vmid = platform === 'pve' ? Number(b.new_id) || Math.max(99, ...ids) + 1 : null;
    const id = platform === 'pve' ? `pve:${vmid}` : `incus:${String(b.name)}`;
    if (this.host.guest(server, id)) return problem(409, 'exists', `${id} already exists.`);
    const name = String(b.name ?? (vmid ? `VM${vmid}` : 'guest'));
    return this.#start(
      r,
      server,
      'guest.create',
      b.kind === 'vm' ? 'qmcreate' : 'vzcreate',
      id,
      {},
      (good) => {
        if (!good) return;
        const state = b.start === true ? 'running' : 'stopped';
        this.host.addGuest(server, this.#newGuest(server, id, name, String(b.kind), state, set));
        const c = this.host.configOf(server, id);
        for (const [k, v] of Object.entries(set))
          if (!['password', 'ssh-public-keys', 'cipassword'].includes(k)) c.values[k] = v;
        c.values[b.kind === 'vm' ? 'name' : 'hostname'] = name;
        this.host.emit('guest.state_changed', { server, id, state });
        this.#coverage(server);
      },
      { new_id: id },
    );
  }

  #newGuest(
    server: string,
    id: string,
    name: string,
    kind: string,
    state: string,
    set: Record<string, string>,
  ): Json {
    return {
      id,
      name,
      platform: id.split(':')[0],
      kind,
      image:
        kind === 'vm'
          ? 'other'
          : String(set.ostemplate ?? '')
              .split('/')
              .pop()
              ?.split('_')[0] || 'container',
      state,
      vcpu: Number(set.cores ?? 1),
      cpu_pct: state === 'running' ? 0.5 : null,
      memory_used_mb: null,
      memory_limit_mb: Number(set.memory ?? 2048),
      snapshots: null,
      uptime_s: state === 'running' ? 1 : null,
      console: {
        available: true,
        protocols: kind === 'vm' ? ['vnc', 'serial'] : ['shell', 'tty'],
        default_protocol: kind === 'vm' ? 'vnc' : 'shell',
      },
      vmid: Number(vmidOf(id)) || undefined,
      node: this.#node(server),
      last_backup: null,
      tags: [],
      pending_changes: 0,
      guest_agent: '',
      ha_state: '',
      template: false,
      backup_job: false,
    };
  }

  #clone(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'admin');
    if (!('guest' in gc)) return gc;
    const guest = gc.guest;
    const bc = this.#body(r, ['new_id', 'name', 'full', 'storage']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    if (typeof b.name !== 'string' || !NAME_RE.test(b.name))
      return this.#invalid({ name: 'Up to 63 letters, digits, dots and dashes.' });
    if (guest.template !== true && b.full !== true)
      return this.#invalid({ full: 'Only a template can be linked: send "full": true.' });
    if (b.storage !== undefined && b.full !== true)
      return this.#invalid({ storage: 'Only a full copy takes a storage.' });
    if (
      b.storage !== undefined &&
      !this.#holds(server, b.storage, guest.kind === 'vm' ? 'images' : 'rootdir')
    )
      return this.#invalid({ storage: 'That storage doesn’t hold guest disks.' });
    const ids = this.host
      .guestsOf(server)
      .map((x) => Number(vmidOf(String(x.id))))
      .filter(Number.isFinite);
    const id =
      guest.platform === 'pve' ? `pve:${Number(b.new_id) || Math.max(99, ...ids) + 1}` : `incus:${b.name}`;
    if (this.host.guest(server, id)) return problem(409, 'exists', `${id} already exists.`);
    const values = { ...this.host.configOf(server, guestId).values };
    return this.#start(
      r,
      server,
      'guest.clone',
      guest.kind === 'vm' ? 'qmclone' : 'vzclone',
      guestId,
      {},
      (good) => {
        if (!good) return;
        const copy = {
          ...this.#newGuest(server, id, String(b.name), String(guest.kind), 'stopped', {}),
          image: guest.image,
          vcpu: guest.vcpu,
          memory_limit_mb: guest.memory_limit_mb,
        };
        this.host.addGuest(server, copy);
        Object.assign(this.host.configOf(server, id).values, values, { name: String(b.name) });
        this.#coverage(server);
      },
      { new_id: id },
    );
  }

  #template(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'admin');
    if (!('guest' in gc)) return gc;
    const guest = gc.guest;
    const bc = this.#body(r, ['confirm']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    if (b.confirm !== true)
      return problem(
        400,
        'confirm_required',
        'Converting to a template can’t be undone: send "confirm": true.',
      );
    if (guest.state !== 'stopped') return problem(409, 'guest_running', 'The guest has to be stopped first.');
    if (guest.platform !== 'pve') return problem(501, 'unsupported', 'Only Proxmox VE has templates.');
    return this.#start(
      r,
      server,
      'guest.template',
      guest.kind === 'vm' ? 'qmtemplate' : 'vztemplate',
      guestId,
      {},
      (good) => {
        if (good) guest.template = true;
      },
    );
  }

  #migrate(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'admin');
    if (!('guest' in gc)) return gc;
    const guest = gc.guest;
    const bc = this.#body(r, ['target', 'storage', 'digest', 'confirm']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    if (b.confirm !== true) return problem(400, 'confirm_required', 'Confirm this first.');
    if (typeof b.target !== 'string') return this.#invalid({ target: 'A target node is needed.' });
    const nodes = this.#otherNodes(server);
    if (nodes.length && !nodes.includes(b.target))
      return this.#invalid({ target: 'Not another node of this cluster.' });
    if (b.storage !== undefined && (typeof b.storage !== 'string' || !STORAGE_RE.test(b.storage)))
      return this.#invalid({ storage: 'Not a storage.' });
    return this.#start(
      r,
      server,
      'guest.migrate',
      guest.kind === 'vm' ? 'qmigrate' : 'vzmigrate',
      guestId,
      { target: b.target },
      (good) => {
        if (good) guest.node = b.target;
      },
    );
  }

  #delete(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'admin');
    if (!('guest' in gc)) return gc;
    const guest = gc.guest;
    for (const k of r.query.keys())
      if (k !== 'confirm_name' && k !== 'purge')
        return problem(400, 'bad_request', `Unknown query parameter "${k}"`);
    if (r.query.get('confirm_name') !== String(guest.name ?? guestId))
      return problem(400, 'confirm_required', 'Type the guest’s name to delete it.');
    if (guest.state !== 'stopped') return problem(409, 'guest_running', 'The guest has to be stopped first.');
    if (this.host.configOf(server, guestId).values.protection === '1')
      return problem(409, 'protected', 'The guest is protected.');
    const purge = r.query.get('purge') === '1';
    return this.#start(
      r,
      server,
      'guest.delete',
      guest.kind === 'vm' ? 'qmdestroy' : 'vzdestroy',
      guestId,
      {},
      (good) => {
        if (!good) return;
        this.host.removeGuest(server, guestId);
        const key = `${server}/${guestId}`;
        this.firewalls.delete(key);
        this.snapshots.delete(key);
        if (purge) {
          this.ha.delete(key);
          this.replication.delete(key);
          for (const j of this.jobs.get(server) ?? []) {
            j.guests = (j.guests as string[]).filter((x) => x !== guestId);
            j.exclude = (j.exclude as string[]).filter((x) => x !== guestId);
            this.#digested(j);
          }
        }
        this.host.emit('guest.state_changed', { server, id: guestId, state: 'stopped' });
        this.#coverage(server);
      },
    );
  }

  /* Backups --------------------------------------------------------------------------------------------------------- */

  #volume(server: string, g: Json, storage: string, at: string, notes: string, protectedFlag: boolean): Json {
    const vmid = vmidOf(String(g.id));
    const kind = g.kind === 'container' ? 'ct' : 'vm';
    const volume =
      storage === 'pbs-01' || this.#storages(server).find((st) => st.id === storage)?.type === 'pbs'
        ? `${storage}:backup/${kind}/${vmid}/${at.replace(/\.\d+Z$/, 'Z')}`
        : `${storage}:backup/vzdump-${kind === 'vm' ? 'qemu' : 'lxc'}-${vmid}-${at.slice(0, 19).replace(/[-:]/g, '_').replace('T', '-')}.${kind === 'vm' ? 'vma' : 'tar'}.zst`;
    return {
      volume,
      storage,
      guest: vmid,
      kind: g.kind,
      size_bytes: Math.round(Number(g.memory_limit_mb ?? 2048) * 1_200_000),
      created: at,
      format: volume.includes(':backup/vzdump-') ? (kind === 'vm' ? 'vma.zst' : 'tar.zst') : `pbs-${kind}`,
      notes,
      protected: protectedFlag,
      verified: 'ok',
    };
  }

  #listBackups(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'operator');
    if (!('guest' in gc)) return gc;
    const vmid = vmidOf(guestId);
    return ok({ items: (this.backups.get(server) ?? []).filter((v) => v.guest === vmid) });
  }

  #backup(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'operator');
    if (!('guest' in gc)) return gc;
    const guest = gc.guest;
    const bc = this.#body(r, ['storage', 'mode', 'compress', 'notes', 'protected']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    if (!this.#holds(server, b.storage, 'backup'))
      return this.#invalid({ storage: 'That storage doesn’t hold backups.' });
    if (b.mode !== undefined && !['snapshot', 'suspend', 'stop'].includes(String(b.mode)))
      return this.#invalid({ mode: 'snapshot, suspend or stop.' });
    return this.#start(
      r,
      server,
      'backup.create',
      'vzdump',
      guestId,
      { storage: b.storage, mode: b.mode },
      (good) => {
        if (!good) return;
        const at = new Date().toISOString();
        const notes =
          typeof b.notes === 'string'
            ? b.notes.replace('{{guestname}}', String(guest.name))
            : String(guest.name);
        this.backups
          .get(server)
          ?.push(this.#volume(server, guest, String(b.storage), at, notes, b.protected === true));
        guest.last_backup = { result: 'ok', at };
      },
    );
  }

  /** A Proxmox backup's own settings, read without restoring it (helpers that can: not the old ones). */
  #backupConfig(r: FakeRequest, server: string): FakeAnswer {
    const refused = this.#check(r, server, 'operator');
    if (refused) return refused;
    if (r.query.get('platform') !== 'pve')
      return problem(501, 'unsupported', 'Only a Proxmox VE backup’s settings can be read.');
    if (this.noBackupConfig.has(server))
      return problem(409, 'agent_outdated', "This server's agent can't read a backup's settings yet.");
    const volume = r.query.get('volume') ?? '';
    const vol = (this.backups.get(server) ?? []).find((v) => v.volume === volume);
    if (!vol) return problem(404, 'not_found', 'No such backup.');
    const values = this.backupConfigs.get(volume) ?? {
      ...this.host.configOf(server, `pve:${String(vol.guest)}`).values,
    };
    return ok({ platform: 'pve', kind: vol.kind, digest: '', running: false, values });
  }

  #restore(r: FakeRequest, server: string): FakeAnswer {
    const refused = this.#check(r, server, 'admin');
    if (refused) return refused;
    const bc = this.#body(r, [
      'platform',
      'volume',
      'new_id',
      'guest',
      'storage',
      'start',
      'unique',
      'isolate',
      'confirm',
    ]);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    if (typeof b.volume !== 'string' || !b.volume) return this.#invalid({ volume: 'Which backup?' });
    const iso = b.isolate && typeof b.isolate === 'object' ? (b.isolate as Record<string, unknown>) : null;
    if (iso) {
      if (this.oldHelpers.has(server))
        return problem(409, 'agent_outdated', "This server's agent can't restore a copy cut off yet.");
      if (b.new_id === undefined || b.guest !== undefined || b.start === true)
        return this.#invalid({ isolate: "An isolated restore makes a new guest that doesn't start." });
      if (typeof iso.name !== 'string' || typeof iso.marker !== 'string' || !/^[\w-]+$/.test(iso.marker))
        return this.#invalid({ 'isolate.marker': 'Not a marker.' });
    }
    const vol = (this.backups.get(server) ?? []).find((v) => v.volume === b.volume);
    if (!vol) return problem(404, 'not_found', 'No such backup.');
    if (b.guest !== undefined && b.new_id !== undefined)
      return this.#invalid({ guest: 'Restore over a guest or as a new one, not both.' });
    const source = this.host.guestsOf(server).find((g) => vmidOf(String(g.id)) === vol.guest);
    let target: string;
    if (typeof b.guest === 'string') {
      const over = this.host.guest(server, b.guest);
      if (!over) return problem(404, 'guest_not_found', 'No such guest.');
      if (b.confirm !== true)
        return problem(
          400,
          'confirm_required',
          'Restoring over a guest replaces its disks: send "confirm": true.',
        );
      if (over.state !== 'stopped')
        return problem(409, 'guest_running', 'The guest has to be stopped first.');
      target = b.guest;
    } else {
      const ids = this.host
        .guestsOf(server)
        .map((x) => Number(vmidOf(String(x.id))))
        .filter(Number.isFinite);
      target = `pve:${Number(b.new_id) || Math.max(99, ...ids) + 1}`;
      if (this.host.guest(server, target)) return problem(409, 'exists', `${target} already exists.`);
    }
    const isNew = typeof b.guest !== 'string';
    return this.#start(
      r,
      server,
      'backup.restore',
      vol.kind === 'container' ? 'vzrestore' : 'qmrestore',
      target,
      {},
      (good) => {
        if (!good) return;
        const state = b.start === true ? 'running' : 'stopped';
        if (isNew) {
          const copy = {
            ...this.#newGuest(
              server,
              target,
              String(iso?.name ?? source?.name ?? `restored-${vmidOf(target)}`),
              String(vol.kind ?? 'vm'),
              state,
              {},
            ),
            image: source?.image ?? 'other',
            vcpu: source?.vcpu ?? 1,
            memory_limit_mb: source?.memory_limit_mb ?? 2048,
          };
          this.host.addGuest(server, copy);
          // As the agent asks Proxmox: the backup's own settings (a test sets them beforehand) with the copy's
          // isolation written over them by the restore itself.
          if (iso) {
            const c = this.host.configOf(server, target);
            for (const [k, v] of Object.entries(c.values))
              if (/^net\d+$/.test(k))
                c.values[k] = `${v
                  .split(',')
                  .filter((p) => p && !p.startsWith('link_down='))
                  .join(',')},link_down=1`;
            Object.assign(c.values, {
              [vol.kind === 'container' ? 'hostname' : 'name']: String(iso.name),
              onboot: '0',
              description: String(iso.marker),
            });
            if (c.values.protection && c.values.protection !== '0') c.values.protection = '0';
            if (typeof iso.tag === 'string' && iso.tag)
              c.values.tags = [...(c.values.tags ?? '').split(/[;, ]+/).filter(Boolean), iso.tag].join(';');
            c.digest += 1;
          }
          this.#coverage(server);
        } else {
          const over = this.host.guest(server, target);
          if (over) over.state = state;
        }
        this.host.emit('guest.state_changed', { server, id: target, state });
      },
      { new_id: target },
    );
  }

  #updateBackup(r: FakeRequest, server: string): FakeAnswer {
    const refused = this.#check(r, server, 'operator');
    if (refused) return refused;
    const bc = this.#body(r, ['platform', 'volume', 'notes', 'protected']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    const vol = (this.backups.get(server) ?? []).find((v) => v.volume === b.volume);
    if (!vol) return problem(404, 'not_found', 'No such backup.');
    const changes: Json[] = [];
    if (typeof b.notes === 'string') {
      changes.push({ key: 'notes', old: String(vol.notes ?? ''), new: b.notes });
      vol.notes = b.notes;
    }
    if (typeof b.protected === 'boolean') {
      changes.push({ key: 'protected', old: vol.protected ? '1' : '0', new: b.protected ? '1' : '0' });
      vol.protected = b.protected;
    }
    return ok({ ok: true, changes, audit_id: audit() });
  }

  #deleteBackup(r: FakeRequest, server: string): FakeAnswer {
    const refused = this.#check(r, server, 'admin');
    if (refused) return refused;
    const list = this.backups.get(server) ?? [];
    const i = list.findIndex((v) => v.volume === r.query.get('volume'));
    if (i < 0) return problem(404, 'not_found', 'No such backup.');
    if (list[i]?.protected) return problem(409, 'protected', 'The backup is protected.');
    list.splice(i, 1);
    return ok({ ok: true, audit_id: audit() });
  }

  /* Storage content ------------------------------------------------------------------------------------------------- */

  #contentItem(storage: string, content: string, name: string, size: number): Json {
    return {
      volume: `${storage}:${content}/${name}`,
      storage,
      content,
      name,
      size_bytes: size,
      created: '2026-09-02T10:12:00Z',
    };
  }

  #listContent(r: FakeRequest, server: string, storage: string): FakeAnswer {
    const refused = this.#check(r, server, 'operator');
    if (refused) return refused;
    if (!this.#storages(server).some((st) => st.id === storage))
      return problem(404, 'not_found', 'No such storage.');
    const content = r.query.get('content');
    return ok({
      items: (this.content.get(server) ?? []).filter(
        (c) => c.storage === storage && (!content || c.content === content),
      ),
    });
  }

  #download(r: FakeRequest, server: string, storage: string): FakeAnswer {
    const refused = this.#check(r, server, 'admin');
    if (refused) return refused;
    const bc = this.#body(r, ['platform', 'content', 'url', 'filename', 'checksum', 'checksum_algorithm']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    const content = String(b.content ?? '');
    if (!['iso', 'vztmpl', 'import'].includes(content))
      return this.#invalid({ content: 'iso, vztmpl or import.' });
    if (!this.#holds(server, storage, content))
      return this.#invalid({ storage: `That storage doesn’t hold ${content}.` });
    if (typeof b.url !== 'string' || !/^https?:\/\/[^/@\s]+/.test(b.url))
      return this.#invalid({ url: 'An http(s) address without a user name or password.' });
    const ext = { iso: /\.(iso|img)$/, vztmpl: /\.tar\.(gz|xz|zst)$/, import: /\.(ova|qcow2|vmdk|raw|img)$/ }[
      content
    ] as RegExp;
    if (
      typeof b.filename !== 'string' ||
      !/^[A-Za-z0-9._-]{1,200}$/.test(b.filename) ||
      !ext.test(b.filename)
    )
      return this.#invalid({ filename: 'A file name with the content’s extension.' });
    if ((b.checksum === undefined) !== (b.checksum_algorithm === undefined))
      return this.#invalid({ checksum: 'A checksum and its algorithm, or neither.' });
    return this.#start(r, server, 'content.download', 'download', null, { url: b.url }, (good) => {
      if (good)
        this.content
          .get(server)
          ?.push(this.#contentItem(storage, content, String(b.filename), 640 * 1024 * 1024));
    });
  }

  #deleteContent(r: FakeRequest, server: string): FakeAnswer {
    const refused = this.#check(r, server, 'admin');
    if (refused) return refused;
    const list = this.content.get(server) ?? [];
    const i = list.findIndex((c) => c.volume === r.query.get('volume'));
    if (i < 0) return problem(404, 'not_found', 'No such volume.');
    list.splice(i, 1);
    return ok({ ok: true, audit_id: audit() });
  }

  #appliances(r: FakeRequest, server: string): FakeAnswer {
    const refused = this.#check(r, server, 'operator');
    if (refused) return refused;
    if (this.#platform(server) !== 'pve')
      return problem(501, 'unsupported', 'Only Proxmox VE offers templates.');
    return ok({ items: APPLIANCES });
  }

  #getAppliance(r: FakeRequest, server: string, storage: string): FakeAnswer {
    const refused = this.#check(r, server, 'admin');
    if (refused) return refused;
    const bc = this.#body(r, ['platform', 'template']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    const a = APPLIANCES.find((x) => x.template === b.template);
    if (!a) return this.#invalid({ template: 'Not a template Proxmox offers.' });
    if (!this.#holds(server, storage, 'vztmpl'))
      return this.#invalid({ storage: 'That storage doesn’t hold templates.' });
    return this.#start(r, server, 'appliance.download', 'aptldr', null, { template: a.template }, (good) => {
      if (good)
        this.content
          .get(server)
          ?.push(this.#contentItem(storage, 'vztmpl', String(a.template), 120 * 1024 * 1024));
    });
  }

  /* Firewall, HA, replication, snapshots ---------------------------------------------------------------------------- */

  #firewall(server: string, guestId: string): Firewall {
    const key = `${server}/${guestId}`;
    let f = this.firewalls.get(key);
    if (!f) {
      f = {
        options: {
          enable: '0',
          dhcp: '1',
          ndp: '1',
          radv: '0',
          macfilter: '1',
          ipfilter: '0',
          policy_in: 'DROP',
          policy_out: 'ACCEPT',
          log_level_in: 'nolog',
          log_level_out: 'nolog',
        },
        optionsDigest: 1,
        rules: [
          {
            pos: 0,
            type: 'in',
            action: 'ACCEPT',
            enable: true,
            macro: 'SSH',
            source: '10.20.0.0/24',
            comment: 'SSH from the LAN',
          },
          { pos: 1, type: 'in', action: 'ACCEPT', enable: true, proto: 'tcp', dport: '443', comment: 'Web' },
        ],
        rulesDigest: 1,
      };
      this.firewalls.set(key, f);
    }
    return f;
  }

  #getFirewall(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'operator');
    if (!('guest' in gc)) return gc;
    const guest = gc.guest;
    if (guest.platform !== 'pve')
      return problem(501, 'unsupported', 'Only Proxmox VE guests have a firewall here.');
    const f = this.#firewall(server, guestId);
    return ok({
      options: f.options,
      options_digest: `o${f.optionsDigest}`,
      rules: f.rules,
      rules_digest: `r${f.rulesDigest}`,
      groups: ['webservers', 'management'],
      cluster_enabled: true,
    });
  }

  #firewallOptions(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'operator');
    if (!('guest' in gc)) return gc;
    const bc = this.#body(r, ['digest', 'set', 'delete']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    const f = this.#firewall(server, guestId);
    if (b.digest !== undefined && b.digest !== `o${f.optionsDigest}`)
      return problem(409, 'digest_mismatch', 'The firewall changed meanwhile.');
    const set = (b.set ?? {}) as Record<string, string>;
    for (const k of [...Object.keys(set), ...((b.delete as string[] | undefined) ?? [])])
      if (!FIREWALL_OPTIONS.has(k)) return this.#invalid({ [k]: 'Not a firewall option.' });
    const changes: Json[] = [];
    for (const [k, v] of Object.entries(set)) {
      changes.push({ key: k, old: f.options[k], new: v });
      f.options[k] = String(v);
    }
    for (const k of (b.delete as string[] | undefined) ?? []) {
      changes.push({ key: k, old: f.options[k] });
      delete f.options[k];
    }
    f.optionsDigest += 1;
    return ok({ ok: true, changes, audit_id: audit() });
  }

  #rule(raw: unknown, partial: boolean): { rule: Json } | FakeAnswer {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return this.#invalid({ rule: 'A rule is needed.' });
    const rule = raw as Json;
    const allowed = [
      'pos',
      'type',
      'action',
      'enable',
      'macro',
      'proto',
      'source',
      'dest',
      'sport',
      'dport',
      'iface',
      'log',
      'comment',
    ];
    for (const k of Object.keys(rule))
      if (!allowed.includes(k)) return this.#invalid({ [`rule.${k}`]: 'Not a rule field.' });
    if (!partial || rule.type !== undefined)
      if (!['in', 'out', 'group'].includes(String(rule.type)))
        return this.#invalid({ 'rule.type': 'in, out or group.' });
    if (!partial || rule.action !== undefined)
      if (typeof rule.action !== 'string' || !rule.action)
        return this.#invalid({ 'rule.action': 'ACCEPT, DROP or REJECT.' });
    return { rule };
  }

  #addRule(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'operator');
    if (!('guest' in gc)) return gc;
    const bc = this.#body(r, ['rule']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    const rc = this.#rule(b.rule, false);
    if (!('rule' in rc)) return rc;
    const rule = rc.rule;
    const f = this.#firewall(server, guestId);
    const at = Math.min(Number(rule.pos ?? 0) || 0, f.rules.length);
    const { pos: _pos, ...fields } = rule;
    f.rules.splice(at, 0, { enable: true, ...fields });
    f.rules.forEach((x, i) => {
      x.enable = x.enable === true || x.enable === 1;
      x.pos = i;
    });
    f.rulesDigest += 1;
    return ok({ ok: true, audit_id: audit() });
  }

  #updateRule(r: FakeRequest, server: string, guestId: string, posRaw: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'operator');
    if (!('guest' in gc)) return gc;
    const bc = this.#body(r, ['digest', 'rule', 'move_to']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    const f = this.#firewall(server, guestId);
    if (b.digest !== undefined && b.digest !== `r${f.rulesDigest}`)
      return problem(409, 'digest_mismatch', 'The rules changed meanwhile.');
    const pos = Number(posRaw);
    const rule = f.rules[pos];
    if (!rule) return problem(404, 'not_found', 'No rule at that position.');
    if (b.rule === undefined && b.move_to === undefined)
      return this.#invalid({ rule: 'A rule or move_to is needed.' });
    if (b.rule !== undefined) {
      const pc = this.#rule(b.rule, true);
      if (!('rule' in pc)) return pc;
      const { pos: _pos, ...fields } = pc.rule;
      Object.assign(rule, fields);
      rule.enable = rule.enable === true || rule.enable === 1;
    }
    if (typeof b.move_to === 'number') {
      f.rules.splice(pos, 1);
      f.rules.splice(Math.min(b.move_to, f.rules.length), 0, rule);
    }
    f.rules.forEach((x, i) => {
      x.pos = i;
    });
    f.rulesDigest += 1;
    return ok({ ok: true, audit_id: audit() });
  }

  #deleteRule(r: FakeRequest, server: string, guestId: string, posRaw: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'operator');
    if (!('guest' in gc)) return gc;
    const f = this.#firewall(server, guestId);
    const digest = r.query.get('digest');
    if (digest !== null && digest !== `r${f.rulesDigest}`)
      return problem(409, 'digest_mismatch', 'The rules changed meanwhile.');
    const pos = Number(posRaw);
    if (!f.rules[pos]) return problem(404, 'not_found', 'No rule at that position.');
    f.rules.splice(pos, 1);
    f.rules.forEach((x, i) => {
      x.pos = i;
    });
    f.rulesDigest += 1;
    return ok({ ok: true, audit_id: audit() });
  }

  #setHa(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'admin');
    if (!('guest' in gc)) return gc;
    const guest = gc.guest;
    const bc = this.#body(r, ['state', 'max_restart', 'max_relocate', 'comment']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    if (!this.#otherNodes(server).length)
      return problem(501, 'unsupported', 'High availability needs a cluster.');
    if (!['started', 'stopped', 'ignored', 'disabled'].includes(String(b.state ?? 'started')))
      return this.#invalid({ state: 'started, stopped, ignored or disabled.' });
    for (const k of ['max_restart', 'max_relocate'])
      if (b[k] !== undefined && !(Number.isInteger(b[k]) && Number(b[k]) >= 0 && Number(b[k]) <= 10))
        return this.#invalid({ [k]: '0 to 10.' });
    const key = `${server}/${guestId}`;
    const before = this.ha.get(key);
    const next = { ...(before ?? {}), state: b.state ?? 'started', ...b } as Json;
    this.ha.set(key, next);
    guest.ha_state = String(next.state);
    return ok({
      ok: true,
      changes: Object.keys(next).map((k) => ({
        key: k,
        ...(before?.[k] !== undefined ? { old: String(before[k]) } : {}),
        new: String(next[k]),
      })),
      audit_id: audit(),
    });
  }

  #removeHa(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'admin');
    if (!('guest' in gc)) return gc;
    const guest = gc.guest;
    const key = `${server}/${guestId}`;
    if (!this.ha.has(key)) return problem(404, 'not_found', 'The guest has no high availability.');
    this.ha.delete(key);
    guest.ha_state = '';
    return ok({ ok: true, audit_id: audit() });
  }

  #addReplication(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'operator');
    if (!('guest' in gc)) return gc;
    const bc = this.#body(r, ['target', 'schedule', 'rate', 'comment']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    const nodes = this.#otherNodes(server);
    if (!nodes.length) return problem(501, 'unsupported', 'Replication needs a cluster.');
    if (!nodes.includes(String(b.target)))
      return this.#invalid({ target: 'Not another node of this cluster.' });
    const key = `${server}/${guestId}`;
    const list = this.replication.get(key) ?? [];
    let n = 0;
    while (list.some((j) => j.id === `${vmidOf(guestId)}-${n}`)) n += 1;
    const job = {
      id: `${vmidOf(guestId)}-${n}`,
      target: b.target,
      schedule: b.schedule ?? '*/15',
      ...(b.rate ? { rate: b.rate } : {}),
      ...(b.comment ? { comment: b.comment } : {}),
    };
    list.push(job);
    this.replication.set(key, list);
    return ok({ ok: true, audit_id: audit() });
  }

  #deleteReplication(r: FakeRequest, server: string, guestId: string, job: string): FakeAnswer {
    const gc = this.#guestCheck(r, server, guestId, 'operator');
    if (!('guest' in gc)) return gc;
    const list = this.replication.get(`${server}/${guestId}`) ?? [];
    const i = list.findIndex((j) => j.id === job);
    if (i < 0) return problem(404, 'not_found', 'No such replication job.');
    list.splice(i, 1);
    return ok({ ok: true, audit_id: audit() });
  }

  #listSnapshots(r: FakeRequest, server: string, guestId: string): FakeAnswer {
    if (!this.host.serverExists(server)) return problem(404, 'server_not_found', 'No such server.');
    if (!this.host.guest(server, guestId)) return problem(404, 'guest_not_found', 'No such guest.');
    void r;
    return ok({
      kind: 'snapshots',
      as_of: this.host.asOf(),
      truncated: false,
      items: this.snapshots.get(`${server}/${guestId}`) ?? [],
    });
  }

  /* Backup jobs ----------------------------------------------------------------------------------------------------- */

  /** Sets a job's digest from what it holds (the hub's sha256 of the job as read). */
  #digested(job: Json): Json {
    const { digest: _d, next_run: _n, ...rest } = job;
    job.digest = createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 40);
    return job;
  }

  /** Which guests the enabled jobs cover → each guest's `backup_job` and the “in no backup job” hint. */
  #coverage(server: string): void {
    const jobs = (this.jobs.get(server) ?? []).filter((j) => j.enabled === true);
    const node = this.#node(server);
    const uncovered: string[] = [];
    for (const g of this.host.guestsOf(server)) {
      if (g.platform !== 'pve') continue;
      const covered = jobs.some(
        (j) =>
          (j.node === null || j.node === node) &&
          ((j.selection === 'all' && !(j.exclude as string[]).includes(String(g.id))) ||
            (j.selection === 'guests' && (j.guests as string[]).includes(String(g.id)))),
      );
      g.backup_job = covered;
      if (!covered && g.template !== true) uncovered.push(String(g.name ?? g.id));
    }
    this.host.setHint(
      server,
      'guest.no_backup_job',
      uncovered.length
        ? {
            server,
            kind: 'guest.no_backup_job',
            severity: 'info',
            entity: 'pve',
            title: `${uncovered.length === 1 ? '1 guest' : `${uncovered.length} guests`} in no backup job`,
            detail: uncovered.length > 5 ? `${uncovered.slice(0, 5).join(', ')}, …` : uncovered.join(', '),
            link: '#guests',
          }
        : null,
    );
  }

  #jobFields(r: FakeRequest, server: string, update: boolean): { fields: Json } | FakeAnswer {
    const bc = this.#body(r, update ? [...BACKUP_JOB_FIELDS, 'digest'] : BACKUP_JOB_FIELDS);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    const fe: Record<string, string> = {};
    for (const [k, v] of Object.entries(b)) {
      if (v === null && !BACKUP_JOB_CLEARABLE.has(k)) fe[k] = `${k} cannot be removed.`;
      if (v === null) continue;
      if (k === 'schedule' && (typeof v !== 'string' || !/^[A-Za-z0-9 :,.*/~-]{1,128}$/.test(v)))
        fe.schedule = 'A Proxmox schedule: 04:00, sat 02:00.';
      if (k === 'storage' && !this.#holds(server, v, 'backup'))
        fe.storage = 'That storage doesn’t hold backups.';
      if (k === 'selection' && !['all', 'guests', 'pool'].includes(String(v)))
        fe.selection = 'all, guests or pool.';
      if (k === 'mode' && !['snapshot', 'suspend', 'stop'].includes(String(v)))
        fe.mode = 'snapshot, suspend or stop.';
      if (k === 'compress' && !['zstd', 'lzo', 'gzip', '0'].includes(String(v)))
        fe.compress = 'zstd, lzo, gzip or 0.';
      if (
        (k === 'guests' || k === 'exclude') &&
        (!Array.isArray(v) || v.some((x) => !/^pve:[1-9]\d{2,8}$/.test(String(x))))
      )
        fe[k] = 'Guest ids like pve:101.';
      if (k === 'enabled' && typeof v !== 'boolean') fe.enabled = 'true or false.';
    }
    return Object.keys(fe).length ? this.#invalid(fe) : { fields: b };
  }

  #listJobs(r: FakeRequest, server: string): FakeAnswer {
    const refused = this.#check(r, server, 'operator');
    if (refused) return refused;
    if (this.#platform(server) !== 'pve')
      return problem(
        501,
        'unsupported',
        'Backup jobs are a Proxmox VE feature, and this server does not run it.',
      );
    return ok({ items: this.jobs.get(server) ?? [] });
  }

  #createJob(r: FakeRequest, server: string): FakeAnswer {
    const refused = this.#check(r, server, 'admin');
    if (refused) return refused;
    if (this.#platform(server) !== 'pve')
      return problem(
        501,
        'unsupported',
        'Backup jobs are a Proxmox VE feature, and this server does not run it.',
      );
    const bc = this.#jobFields(r, server, false);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    if (typeof b.schedule !== 'string') return this.#invalid({ schedule: 'When should it run?' });
    if (typeof b.storage !== 'string') return this.#invalid({ storage: 'Where do the backups go?' });
    const selection = String(b.selection ?? 'all');
    if (selection === 'guests' && !(b.guests as unknown[] | undefined)?.length)
      return this.#invalid({ guests: 'Which guests?' });
    if (selection === 'pool' && typeof b.pool !== 'string') return this.#invalid({ pool: 'Which pool?' });
    const job = this.#digested({
      id: `backup-${randomBytes(4).toString('hex')}-${randomBytes(2).toString('hex')}`,
      enabled: b.enabled ?? true,
      schedule: b.schedule,
      storage: b.storage,
      node: b.node ?? null,
      selection,
      guests: b.guests ?? [],
      exclude: b.exclude ?? [],
      pool: b.pool ?? null,
      mode: b.mode ?? 'snapshot',
      compress: b.compress ?? 'zstd',
      keep: b.keep ?? null,
      notes_template: b.notes_template ?? '{{guestname}}',
      comment: b.comment ?? null,
      next_run: '2026-10-18T02:00:00Z',
    });
    const list = this.jobs.get(server) ?? [];
    list.push(job);
    this.jobs.set(server, list);
    this.#coverage(server);
    return ok({ ok: true, id: job.id, audit_id: audit() });
  }

  #updateJob(r: FakeRequest, server: string, id: string): FakeAnswer {
    const refused = this.#check(r, server, 'admin');
    if (refused) return refused;
    const job = (this.jobs.get(server) ?? []).find((j) => j.id === id);
    if (!job) return problem(404, 'not_found', 'No such backup job.');
    const bc = this.#jobFields(r, server, true);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    if (b.digest !== undefined && b.digest !== job.digest)
      return problem(409, 'digest_mismatch', 'The job changed meanwhile.');
    const changes: Json[] = [];
    for (const [k, v] of Object.entries(b)) {
      if (k === 'digest') continue;
      const next = v === null ? (k === 'exclude' ? [] : null) : v;
      const show = (x: unknown) =>
        x === null || x === undefined ? undefined : typeof x === 'string' ? x : JSON.stringify(x);
      if (JSON.stringify(job[k]) === JSON.stringify(next)) continue;
      changes.push({
        key: k,
        ...(show(job[k]) !== undefined ? { old: show(job[k]) } : {}),
        ...(show(next) !== undefined ? { new: show(next) } : {}),
      });
      job[k] = next;
    }
    this.#digested(job);
    this.#coverage(server);
    return ok({ ok: true, changes, audit_id: audit() });
  }

  #deleteJob(r: FakeRequest, server: string, id: string): FakeAnswer {
    const refused = this.#check(r, server, 'admin');
    if (refused) return refused;
    const list = this.jobs.get(server) ?? [];
    const i = list.findIndex((j) => j.id === id);
    if (i < 0) return problem(404, 'not_found', 'No such backup job.');
    if (r.query.get('confirm') !== '1' && r.query.get('confirm') !== 'true')
      return problem(
        400,
        'confirm_required',
        'Deleting a backup job stops its scheduled backups: send confirm=1.',
      );
    list.splice(i, 1);
    this.#coverage(server);
    return ok({ ok: true, audit_id: audit() });
  }

  #runJob(r: FakeRequest, server: string, id: string): FakeAnswer {
    const refused = this.#check(r, server, 'operator');
    if (refused) return refused;
    const bc = this.#body(r, []);
    if (!('fields' in bc)) return bc;
    const job = (this.jobs.get(server) ?? []).find((j) => j.id === id);
    if (!job) return problem(404, 'not_found', 'No such backup job.');
    return this.#start(
      r,
      server,
      'backupjob.run',
      'vzdump',
      null,
      { storage: job.storage, mode: job.mode },
      (good) => {
        if (!good) return;
        const at = new Date().toISOString();
        for (const g of this.host.guestsOf(server))
          if (g.backup_job === true && g.template !== true) {
            this.backups
              .get(server)
              ?.push(this.#volume(server, g, String(job.storage), at, String(g.name ?? ''), false));
            g.last_backup = { result: 'ok', at };
          }
      },
    );
  }

  /* The host's own power -------------------------------------------------------------------------------------------- */

  #hostAction(r: FakeRequest, server: string): FakeAnswer {
    if (!this.host.serverExists(server)) return problem(404, 'server_not_found', 'No such server.');
    if ((ROLE_RANK[r.role ?? 'viewer'] ?? 0) < 2)
      return problem(403, 'insufficient_role', 'This needs the admin role.');
    const bc = this.#body(r, ['action', 'confirm']);
    if (!('fields' in bc)) return bc;
    const b = bc.fields;
    if (b.action !== 'host_reboot' && b.action !== 'host_shutdown')
      return problem(400, 'invalid_action', 'host_reboot or host_shutdown.');
    if (b.confirm !== true) return problem(400, 'confirm_required', 'Confirm this action.');
    const rc = this.host.switchesOf(server);
    if (rc && (rc.host_power !== true || rc.agent_host_power !== true))
      return problem(403, 'host_power_disabled', 'Restarting this host is switched off.');
    const actionId = `act_${randomBytes(6).toString('hex')}`;
    setTimeout(() => {
      this.host.emit('action.finished', {
        action_id: actionId,
        server,
        guest: 'host:host',
        action: b.action,
        result: 'ok',
        message: '',
        state: '',
        noop: false,
        code: null,
      });
    }, 20);
    return ok({ action_id: actionId, audit_id: audit() }, 202);
  }
}
