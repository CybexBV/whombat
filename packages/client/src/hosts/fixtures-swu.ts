/**
 * Operating-system updates in the fixture worlds (Whombat server-updates.md SWU-02, SWU-04, SWU-05, SWU-10; app
 * server-updates-app.md AP-2878): pve-02 with updates waiting (one for security, a new kernel among them, so it needs
 * a restart once they're in), pve-01 too, thetitan installing its updates since the world
 * started, the-falcon done 40 minutes ago and waiting for its restart. `packages.check` and `packages.install` start a `pkg:<16 hex>` task as the
 * hub does: its log grows with the clock, Install can't be stopped, a second one while one runs is refused as busy;
 * when it ends the list and the restart need are read again (SWU-05). `host_reboot` clears the need. The server's
 * report carries `packageTask` and `packageLast` (contracts 0.98.0).
 *
 * `createUpdatesFixtureWorld` is the state, shared by the web's layer (`withUpdatesFixtures`, around the hosts routes)
 * and the phone's demo world. Not imported by production code.
 */
import type {
  HostHint,
  HostInspectResult,
  HostPackageLast,
  HostPackageTask,
  HostServerDetail,
  HostTask,
} from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest } from './fixtures';
import type { PackageOp, PackageTaskOutcome } from './updates';

const MIN = 60_000;
/** A new log line this often. */
const LINE_MS = 1500;

type PackageItem = Extract<HostInspectResult, { kind: 'updates' }>['items'][number];

interface PkgTask {
  id: string;
  op: PackageOp;
  started: number;
  lines: string[];
  packages: string[];
  ended?: number;
  outcome?: PackageTaskOutcome;
  stopped?: boolean;
}

interface ServerUpdates {
  waiting: PackageItem[];
  checkedAt: number;
  reboot: string | null;
  task: PkgTask | null;
  last: HostPackageLast | null;
}

const PVE_LIST: PackageItem[] = [
  { name: 'proxmox-kernel-6.14', current: '6.14.11-2', new: '6.14.11-3', source: 'pve-no-subscription' },
  { name: 'openssl', current: '3.5.1-1', new: '3.5.1-1+deb13u1', security: true, source: 'debian-security' },
  { name: 'pve-manager', current: '9.2.11', new: '9.2.12', source: 'pve-no-subscription' },
  { name: 'zfsutils-linux', current: '2.3.4-pve1', new: '2.3.4-pve2', source: 'pve-no-subscription' },
];

const DEBIAN_LIST: PackageItem[] = [
  { name: 'openssl', current: '3.5.1-1', new: '3.5.1-1+deb13u1', security: true, source: 'debian-security' },
  { name: 'curl', current: '8.14.1-2', new: '8.14.1-2+deb13u1', source: 'debian-security' },
  { name: 'libcurl4t64', current: '8.14.1-2', new: '8.14.1-2+deb13u1', source: 'debian-security' },
  { name: 'tzdata', current: '2025b-4', new: '2025b-4+deb13u1', source: 'trixie-updates' },
];

const PVE01_LIST: PackageItem[] = [
  ...PVE_LIST,
  { name: 'libpve-common-perl', current: '9.0.11', new: '9.0.12', source: 'pve-no-subscription' },
  { name: 'qemu-server', current: '9.0.22', new: '9.0.23', source: 'pve-no-subscription' },
];

/** What apt says while it installs `items` (Proxmox's repositories when `pve`). */
function installLog(items: readonly PackageItem[], pve: boolean): string[] {
  const names = items.map((i) => i.name);
  return [
    'Hit:1 http://deb.debian.org/debian trixie InRelease',
    'Get:2 http://security.debian.org/debian-security trixie-security InRelease [43.4 kB]',
    ...(pve ? ['Hit:3 http://download.proxmox.com/debian/pve trixie InRelease'] : []),
    'Reading package lists...',
    'Building dependency tree...',
    'Reading state information...',
    'Calculating upgrade...',
    'The following packages will be upgraded:',
    `  ${names.join(' ')}`,
    `${names.length} upgraded, 0 newly installed, 0 to remove and 0 not upgraded.`,
    `Need to get ${12 * names.length} MB of archives.`,
    ...items.map((i, n) => `Get:${n + 1} ${i.source ?? 'trixie'} ${i.name} ${i.new}`),
    ...items.map((i) => `Preparing to unpack .../${i.name}_${i.new}_amd64.deb ...`),
    ...items.map((i) => `Unpacking ${i.name} (${i.new}) over (${i.current ?? '?'}) ...`),
    ...items.map((i) => `Setting up ${i.name} (${i.new}) ...`),
    ...(names.some((n) => n.includes('kernel'))
      ? ['Running hook script zz-proxmox-boot..', 'Processing triggers for initramfs-tools ...']
      : []),
    'Processing triggers for man-db ...',
    'Restarting services...',
    'Done.',
  ];
}

function checkLog(pve: boolean): string[] {
  return [
    'Hit:1 http://deb.debian.org/debian trixie InRelease',
    'Hit:2 http://security.debian.org/debian-security trixie-security InRelease',
    ...(pve ? ['Hit:3 http://download.proxmox.com/debian/pve trixie InRelease'] : []),
    'Reading package lists...',
    'Done.',
  ];
}

const QUIET_SYSTEM: NonNullable<NonNullable<HostServerDetail['health']>['system']> = {
  packageManager: 'apt',
  updates: 0,
  securityUpdates: 0,
  updatesCheckedAt: null,
  updatesError: null,
  rebootRequired: false,
  rebootReason: null,
  initSystem: 'systemd',
  failedCount: 0,
  failedUnits: [],
  timeSynced: true,
  timeOffsetMs: 2,
  timeSource: 'chrony',
  oomKills: 0,
  processes: 412,
  stealPct: 0,
  pressure: null,
};

export interface UpdatesFixtureWorld {
  /** The servers this world plays (the rest are left as they are). */
  has(serverId: string): boolean;
  /** A server's page with its updates, its running package task, the last one's result and the hints. */
  detail(d: HostServerDetail): HostServerDetail;
  /** The waiting packages (`hosts.inspect` `updates`). */
  inspect(serverId: string): Extract<HostInspectResult, { kind: 'updates' }> | null;
  /** `hosts.manage` for `packages.check`, `packages.install` and `task.stop` of a package task; null for others. */
  manage(serverId: string, body: Record<string, unknown>): HostsFixtureAnswer | null;
  /** `hosts.getTask` of a `pkg:` task. */
  task(serverId: string, taskId: string, logStart: number): HostsFixtureAnswer | null;
  /** The server restarted: no restart needed any more. */
  restarted(serverId: string): void;
  /** A package task runs on one of the servers. */
  running(): boolean;
  /** Ended tasks not told yet (the phone's world sends their `hosts.task` frames). */
  ended(): { serverId: string; taskId: string; op: PackageOp; result: 'ok' | 'error'; message: string }[];
}

function problem(status: number, code: string, message: string): HostsFixtureAnswer {
  const kind = status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'conflict';
  return { status, body: { error: { code: kind, message, details: { code } } } };
}

export function createUpdatesFixtureWorld(opts: { now: number; clock?: () => number }): UpdatesFixtureWorld {
  const clock = opts.clock ?? (() => Date.now());
  const start = clock();
  let seq = 0;
  const told = new Set<string>();
  const newId = () => `pkg:${(0x5a17c0de00 + ++seq).toString(16).padStart(16, '0')}`;
  const pve = (id: string) => id.startsWith('pve-');
  const servers = new Map<string, ServerUpdates>([
    [
      'pve-02',
      { waiting: PVE_LIST, checkedAt: opts.now - 3 * 60 * MIN, reboot: null, task: null, last: null },
    ],
    [
      'pve-01',
      { waiting: PVE01_LIST, checkedAt: opts.now - 2 * 60 * MIN, reboot: null, task: null, last: null },
    ],
    [
      'thetitan',
      {
        waiting: DEBIAN_LIST,
        checkedAt: opts.now - 5 * 60 * MIN,
        reboot: null,
        // Started as the world did: long enough to watch (and screenshot), short enough to see it end.
        task: {
          id: newId(),
          op: 'install',
          started: start,
          lines: installLog(DEBIAN_LIST, false),
          packages: [],
        },
        last: {
          op: 'install',
          status: 'ok',
          finishedAt: new Date(opts.now - 9 * 24 * 60 * MIN).toISOString(),
          installed: 3,
          message: null,
          code: null,
        },
      },
    ],
    [
      'the-falcon',
      {
        waiting: [],
        checkedAt: opts.now - 40 * MIN,
        reboot: 'a new kernel (6.12.48+deb13)',
        task: null,
        last: {
          op: 'install',
          status: 'ok',
          finishedAt: new Date(opts.now - 40 * MIN).toISOString(),
          installed: 12,
          message: null,
          code: null,
        },
      },
    ],
  ]);
  // thetitan's install writes a line every 4.5 s (about two minutes), the others every 1.5 s.
  const pace = (t: PkgTask) => (t.started === start && t.op === 'install' ? 3 * LINE_MS : LINE_MS);

  /** Where a task is now: lines shown, and its end once all are (the world changes then, once). */
  const advance = (serverId: string, s: ServerUpdates) => {
    const t = s.task;
    if (!t || t.ended !== undefined) return;
    const shown = Math.floor((clock() - t.started) / pace(t)) + 1;
    if (shown < t.lines.length) return;
    finish(serverId, s, t, false);
  };

  const finish = (serverId: string, s: ServerUpdates, t: PkgTask, stopped: boolean) => {
    const at = clock();
    t.ended = at;
    t.stopped = stopped;
    if (stopped) {
      s.last = {
        op: t.op,
        status: 'failed',
        finishedAt: new Date(at).toISOString(),
        installed: null,
        message: 'Stopped.',
        code: null,
      };
    } else if (t.op === 'install') {
      const installed = t.packages.length ? s.waiting.filter((p) => t.packages.includes(p.name)) : s.waiting;
      s.waiting = s.waiting.filter((p) => !installed.includes(p));
      if (installed.some((p) => p.name.includes('kernel'))) s.reboot = 'a new kernel';
      t.outcome = { installed: installed.length, keptBack: [], warning: null };
      s.last = {
        op: 'install',
        status: 'ok',
        finishedAt: new Date(at).toISOString(),
        installed: installed.length,
        message: null,
        code: null,
      };
    } else {
      t.outcome = { installed: 0, keptBack: [], warning: null };
      s.last = {
        op: 'check',
        status: 'ok',
        finishedAt: new Date(at).toISOString(),
        installed: null,
        message: null,
        code: null,
      };
    }
    s.checkedAt = at;
    s.task = null;
    // The ended task stays readable by its id.
    ended.set(t.id, { serverId, task: t });
  };
  const ended = new Map<string, { serverId: string; task: PkgTask }>();

  const report = (
    s: ServerUpdates,
  ): { packageTask: HostPackageTask | null; packageLast: HostPackageLast | null } => ({
    packageTask: s.task
      ? { id: s.task.id, op: s.task.op, startedAt: new Date(s.task.started).toISOString() }
      : null,
    packageLast: s.last,
  });

  const hintsFor = (serverId: string, s: ServerUpdates): HostHint[] => {
    const out: HostHint[] = [];
    const sec = s.waiting.filter((p) => p.security).length;
    if (s.waiting.length)
      out.push({
        serverId,
        kind: 'system.updates',
        severity: 'info',
        entity: 'host',
        title: `${s.waiting.length} update${s.waiting.length === 1 ? '' : 's'} available`,
        // The hosts service says only the security updates, never the package manager.
        detail: sec ? `${sec} security update${sec === 1 ? '' : 's'}` : '',
        section: 'system',
      });
    if (s.reboot)
      out.push({
        serverId,
        kind: 'system.reboot',
        severity: 'info',
        entity: 'host',
        title: 'Restart needed',
        detail: 'To finish installing updates',
        section: 'system',
      });
    return out;
  };

  const status = (serverId: string, t: PkgTask, logStart: number): HostTask => {
    const total = t.lines.length;
    const shown =
      t.ended !== undefined
        ? Math.min(total, Math.floor((t.ended - t.started) / pace(t)) + 1)
        : Math.min(total, Math.floor((clock() - t.started) / pace(t)) + 1);
    const all = t.ended !== undefined && !t.stopped ? total : shown;
    const from = logStart < 0 ? all : Math.max(0, Math.min(logStart, all));
    return {
      id: t.id,
      type: `packages.${t.op}`,
      platform: 'host',
      node: serverId,
      user: 'whombat',
      started: new Date(t.started).toISOString(),
      ended: t.ended !== undefined ? new Date(t.ended).toISOString() : null,
      status: t.ended === undefined ? 'running' : t.stopped ? 'error' : 'ok',
      ...(t.ended !== undefined ? { message: t.stopped ? 'Stopped.' : 'OK' } : {}),
      log: t.lines.slice(from, all),
      logNext: all,
      cancellable: t.op === 'check',
      ...(t.outcome ? { packages: t.outcome } : {}),
    } as HostTask;
  };

  return {
    has: (id) => servers.has(id),
    detail(d) {
      const s = servers.get(d.server.id);
      if (!s) return d;
      // A page without the agent's system report (the dashboards' donors) gets a quiet one.
      const sys = d.health?.system ?? QUIET_SYSTEM;
      advance(d.server.id, s);
      return {
        ...d,
        hints: [
          ...d.hints.filter((h) => h.kind !== 'system.updates' && h.kind !== 'system.reboot'),
          ...hintsFor(d.server.id, s),
        ],
        health: {
          ...d.health,
          system: {
            ...sys,
            packageManager: 'apt',
            updates: s.waiting.length,
            securityUpdates: s.waiting.filter((p) => p.security).length,
            updatesCheckedAt: new Date(s.checkedAt).toISOString(),
            updatesError: null,
            rebootRequired: !!s.reboot,
            rebootReason: s.reboot,
            ...report(s),
          },
        },
      };
    },
    inspect(serverId) {
      const s = servers.get(serverId);
      if (!s) return null;
      advance(serverId, s);
      return { kind: 'updates', asOf: new Date(clock()).toISOString(), truncated: false, items: s.waiting };
    },
    manage(serverId, body) {
      const s = servers.get(serverId);
      const op = String(body.op ?? '');
      const params = (body.params ?? {}) as Record<string, unknown>;
      if (!s) return null;
      if (op === 'task.stop' && typeof params.task === 'string' && params.task.startsWith('pkg:')) {
        const t = s.task;
        if (!t || t.id !== params.task) return problem(404, 'task_not_found', 'That task has already ended.');
        if (t.op === 'install')
          return problem(409, 'not_allowed', 'Installing updates can’t be stopped once it started.');
        finish(serverId, s, t, true);
        return { status: 200, body: { ok: true } };
      }
      if (op !== 'packages.check' && op !== 'packages.install') return null;
      advance(serverId, s);
      if (s.task)
        return problem(
          409,
          'busy',
          `Another program is installing packages on ${serverId} right now. Try again in a few minutes.`,
        );
      const which = Array.isArray(params.packages) ? params.packages.map(String) : [];
      const items = which.length ? s.waiting.filter((p) => which.includes(p.name)) : s.waiting;
      const t: PkgTask = {
        id: newId(),
        op: op === 'packages.install' ? 'install' : 'check',
        started: clock(),
        lines: op === 'packages.install' ? installLog(items, pve(serverId)) : checkLog(pve(serverId)),
        packages: which,
      };
      s.task = t;
      return { status: 202, body: { ok: true, task: { id: t.id } } };
    },
    task(serverId, taskId, logStart) {
      const s = servers.get(serverId);
      if (!s || !taskId.startsWith('pkg:')) return null;
      advance(serverId, s);
      const t = s.task?.id === taskId ? s.task : ended.get(taskId)?.task;
      return t
        ? { status: 200, body: status(serverId, t, logStart) }
        : problem(404, 'task_not_found', 'That task isn’t there any more.');
    },
    restarted(serverId) {
      const s = servers.get(serverId);
      if (s) s.reboot = null;
    },
    running() {
      for (const [id, s] of servers) advance(id, s);
      return [...servers.values()].some((s) => s.task !== null);
    },
    ended() {
      for (const [id, s] of servers) advance(id, s);
      const out: ReturnType<UpdatesFixtureWorld['ended']> = [];
      for (const [taskId, { serverId, task }] of ended) {
        if (told.has(taskId)) continue;
        told.add(taskId);
        out.push({
          serverId,
          taskId,
          op: task.op,
          result: task.stopped ? 'error' : 'ok',
          message: task.stopped ? 'Stopped.' : 'OK',
        });
      }
      return out;
    },
  };
}

/**
 * The web's layer around the hosts routes: a server's page, its `updates` look inside, the two ops and `task.stop`
 * of a package task, its task, and Restart clearing the need.
 */
export function withUpdatesFixtures(
  next: (req: HostsFixtureRequest) => HostsFixtureAnswer | null,
  opts: { now: number; clock?: () => number },
): (req: HostsFixtureRequest) => HostsFixtureAnswer | null {
  const world = createUpdatesFixtureWorld(opts);
  return (req) => {
    const seg = req.path.split('/').filter(Boolean).map(decodeURIComponent);
    const id = seg[0] === 'servers' ? (seg[1] ?? '') : '';
    if (id && world.has(id)) {
      if (req.method === 'POST' && seg[2] === 'manage' && seg.length === 3) {
        const out = world.manage(id, req.body);
        if (out) return out;
      }
      if (req.method === 'GET' && seg[2] === 'tasks' && seg[3]?.startsWith('pkg:'))
        return world.task(id, seg[3], Number(req.query.logStart ?? 0));
      if (req.method === 'GET' && seg[2] === 'inspect' && seg[3] === 'updates') {
        const items = world.inspect(id);
        if (items) return { status: 200, body: items };
      }
      if (req.method === 'POST' && seg[2] === 'actions' && req.body.action === 'host_reboot')
        world.restarted(id);
    }
    const out = next(req);
    if (id && world.has(id) && req.method === 'GET' && seg.length === 2 && out?.status === 200)
      return { ...out, body: world.detail(out.body as HostServerDetail) };
    return out;
  };
}
