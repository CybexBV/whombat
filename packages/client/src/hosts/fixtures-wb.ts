/**
 * Stream WB's part of the servers' fixture world (Proxmox build, PX-01/PX-03/PX-05): a guest's lifecycle, backups,
 * backup jobs, firewall, replication and tasks answered the way the hub does, so the web's fake world can do them.
 * `withWb(handle, ctx)` wraps `createHostsFixtures`' handler: it seeds the world once (two backup jobs on pve-02 and
 * one on pve-01; pve-02's nightly leaves out what WC's world has in no job: minecraft, old-wp-staging, test-ct; an old snapshot, a guest agent that's down, an old
 * backup, HA and replication on arnica-prod-nest-01, a protected guest, a template), answers its own routes and passes
 * the rest on. Tasks grow their log a few lines per read and end after a set number of reads (deterministic; their
 * times are the wall clock's, so a dialog's duration reads right): backups to `local` end with a warning, a restore
 * as a new guest under a taken ID fails, as Proxmox's would.
 */
import type {
  HostBackupJob,
  HostBackupVolume,
  HostFirewall,
  HostGuest,
  HostGuestConfig,
  HostSeries,
  HostTask,
} from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest, HostsFixtureWorld } from './fixtures';
import { backupJobIncludes } from './lifecycle';

const DAY = 86_400_000;

export interface WbFixtureContext {
  world: HostsFixtureWorld;
  now: number;
  /** Rebuilds a server's page after its guests changed. */
  refreshServer: (serverId: string) => void;
  /** The wall clock for tasks (tests pass a fixed one). */
  clock?: () => number;
}

type Handle = (req: HostsFixtureRequest) => HostsFixtureAnswer | null;

interface FakeTask {
  id: string;
  serverId: string;
  guestId?: string;
  type: string;
  started: number;
  reads: number;
  /** Reads until it ends. */
  steps: number;
  lines: string[];
  result: 'ok' | 'warning' | 'error';
  message: string;
  ended?: number;
  onDone?: () => void;
}

function problem(status: number, code: string, message: string): HostsFixtureAnswer {
  return {
    status,
    body: {
      error: {
        code: status === 404 ? 'not_found' : status === 400 ? 'bad_request' : 'conflict',
        message,
        details: { code },
      },
    },
  };
}

const ok = (body: Record<string, unknown> = {}): HostsFixtureAnswer => ({
  status: 200,
  body: { ok: true, auditId: 'aud_wb', ...body },
});

function wave(seed: number, n: number, base: number, amp: number): number[] {
  return Array.from({ length: n }, (_, k) => {
    const t = k / Math.max(1, n - 1);
    const v = base + amp * (0.5 + 0.5 * Math.sin(t * 11 + seed)) + amp * 0.2 * Math.sin(t * 47 + seed * 3);
    return Math.round(Math.max(0, v) * 10) / 10;
  });
}

const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 997, 7);

/** Wrap the hosts fixtures' handler with stream WB's routes (see the file's comment). */
export function withWb(next: Handle, ctx: WbFixtureContext): Handle {
  const { world, now, refreshServer } = ctx;
  const clock = ctx.clock ?? (() => Date.now());
  const jobs = new Map<string, HostBackupJob[]>();
  const tasks = new Map<string, FakeTask>();
  let seq = 0;

  const guestsOf = (serverId: string) => world.guests.get(serverId) ?? [];
  const findGuest = (serverId: string, id: string) => guestsOf(serverId).find((g) => g.id === id);
  const patchGuest = (serverId: string, id: string, patch: Partial<HostGuest>) =>
    world.guests.set(
      serverId,
      guestsOf(serverId).map((g) => (g.id === id ? { ...g, ...patch } : g)),
    );
  const cfgKey = (serverId: string, id: string) => `${serverId}/${id}`;
  const patchConfig = (serverId: string, id: string, patch: (c: HostGuestConfig) => HostGuestConfig) => {
    const c = world.configs.get(cfgKey(serverId, id));
    if (c) world.configs.set(cfgKey(serverId, id), { ...patch(c), digest: `${c.digest}+` });
  };

  /** Which guests a server's enabled jobs cover (the hub's `backup_job`). */
  const coverage = (serverId: string) => {
    const list = jobs.get(serverId) ?? [];
    world.guests.set(
      serverId,
      guestsOf(serverId).map((g) =>
        g.platform === 'pve'
          ? { ...g, backupJob: list.some((j) => j.enabled && backupJobIncludes(j, g.id, g.node)) }
          : g,
      ),
    );
    refreshServer(serverId);
  };

  /* The seed ---------------------------------------------------------------------------------------- */

  const at = (ms: number) => new Date(ms).toISOString();
  jobs.set('pve-02', [
    {
      id: 'backup-dc316015-ac2c',
      enabled: true,
      schedule: '02:00',
      storage: 'pbs',
      node: null,
      selection: 'all',
      // WC's guests in no backup job (minecraft, old-wp-staging, test-ct), so both streams' worlds agree.
      exclude: ['pve:124', 'pve:144', 'pve:145'],
      mode: 'snapshot',
      compress: null,
      keep: { last: 3, daily: 7, weekly: 4, monthly: 6 },
      notesTemplate: '{{guestname}} nightly',
      comment: 'Nightly',
      nextRun: at(now + 14 * 3_600_000),
      digest: 'job-a1',
    },
    {
      id: 'backup-7a1b2c3d-9e8f',
      enabled: false,
      schedule: 'sun 03:00',
      storage: 'local',
      node: 'pve-02',
      selection: 'guests',
      guests: ['pve:118', 'pve:140'],
      mode: 'stop',
      compress: 'zstd',
      keep: { last: 2 },
      notesTemplate: null,
      comment: 'Weekly copy on the local disk',
      nextRun: null,
      digest: 'job-b1',
    },
  ]);
  jobs.set('pve-01', [
    {
      id: 'backup-5e6f7a8b-1c2d',
      enabled: true,
      schedule: 'sat 02:00',
      storage: 'pbs',
      node: 'pve-01',
      selection: 'all',
      exclude: [],
      mode: 'snapshot',
      compress: null,
      keep: null,
      notesTemplate: '{{guestname}}',
      comment: null,
      nextRun: at(now + 3 * DAY),
      digest: 'job-c1',
    },
  ]);
  patchGuest('pve-02', 'pve:118', {
    oldestSnapshot: at(now - 45 * DAY),
    haState: 'started',
  });
  world.snapshots.set(
    cfgKey('pve-02', 'pve:118'),
    (world.snapshots.get(cfgKey('pve-02', 'pve:118')) ?? []).map((s) =>
      s.name === 'before-upgrade' ? { ...s, created: at(now - 45 * DAY) } : s,
    ),
  );
  patchGuest('pve-02', 'pve:123', { guestAgent: 'not_running' });
  patchGuest('pve-02', 'pve:133', { lastBackup: { result: 'ok', at: at(now - 11 * DAY) } });
  patchConfig('pve-02', 'pve:118', (c) => ({
    ...c,
    ha: { state: 'started', maxRestart: 1, maxRelocate: 1, status: 'started on pve-02' },
    replication: [
      { id: '118-0', target: 'pve-01', schedule: '*/15', rate: '50', lastSync: at(now - 6 * 60_000) },
    ],
  }));
  patchConfig('pve-02', 'pve:140', (c) => ({ ...c, values: { ...c.values, protection: '1' } }));
  patchConfig('pve-02', 'pve:125', (c) => ({ ...c, values: { ...c.values, template: '1' } }));
  coverage('pve-02');
  coverage('pve-01');

  /* Tasks ------------------------------------------------------------------------------------------- */

  const guestTasks = (serverId: string, guestId: string) => world.tasks.get(cfgKey(serverId, guestId)) ?? [];

  function view(t: FakeTask, logStart: number): HostTask {
    const done = t.reads >= t.steps;
    const shown = done ? t.lines.length : Math.ceil((t.reads / t.steps) * t.lines.length);
    const lines = t.lines.slice(0, shown);
    return {
      id: t.id,
      type: t.type,
      platform: 'pve',
      ...(t.guestId ? { guestId: t.guestId } : {}),
      node: t.serverId,
      user: 'john@pam',
      started: at(t.started),
      ended: t.ended ? at(t.ended) : null,
      status: done ? t.result : 'running',
      ...(done ? { message: t.message } : {}),
      ...(logStart >= 0 ? { log: lines.slice(logStart) } : {}),
      logNext: lines.length,
    };
  }

  /** Moves a task on by one read; at its end it changes the world once. */
  function step(t: FakeTask) {
    if (t.reads >= t.steps) return;
    t.reads += 1;
    if (t.reads >= t.steps) {
      t.ended = clock();
      t.onDone?.();
    }
    if (t.guestId) {
      const v = view(t, -1);
      world.tasks.set(
        cfgKey(t.serverId, t.guestId),
        guestTasks(t.serverId, t.guestId).map((x) => (x.id === t.id ? v : x)),
      );
    }
  }

  function start(
    serverId: string,
    o: Omit<FakeTask, 'id' | 'serverId' | 'started' | 'reads'> & { op: string; vmid?: number | string },
  ): string {
    seq += 1;
    const id = `UPID:${serverId}:000${(0x4a1b2 + seq).toString(16).toUpperCase()}:${o.type}:${o.vmid ?? ''}:john@pam:`;
    const t: FakeTask = { ...o, id, serverId, started: clock(), reads: 0 };
    tasks.set(id, t);
    if (o.guestId)
      world.tasks.set(cfgKey(serverId, o.guestId), [view(t, -1), ...guestTasks(serverId, o.guestId)]);
    return id;
  }

  const backupLines = (g: HostGuest, storage: string, mode: string) => [
    `INFO: starting new backup job: vzdump ${g.vmid} --storage ${storage} --mode ${mode} --node ${g.node ?? ''}`,
    `INFO: Starting Backup of VM ${g.vmid} (${g.kind === 'vm' ? 'qemu' : 'lxc'})`,
    `INFO: Backup started at ${at(clock()).replace('T', ' ').slice(0, 19)}`,
    `INFO: status = ${g.state}`,
    `INFO: VM Name: ${g.name}`,
    'INFO: include disk scsi0 size 64G',
    `INFO: creating ${storage === 'pbs' ? 'Proxmox Backup Server' : 'vzdump'} archive`,
    'INFO:   8% (5.1 GiB of 64.0 GiB) in 3s, read: 1.7 GiB/s, write: 412.0 MiB/s',
    'INFO:  31% (19.8 GiB of 64.0 GiB) in 9s, read: 2.4 GiB/s, write: 388.0 MiB/s',
    'INFO:  64% (41.0 GiB of 64.0 GiB) in 18s, read: 2.3 GiB/s, write: 402.0 MiB/s',
    'INFO: 100% (64.0 GiB of 64.0 GiB) in 27s, read: 2.4 GiB/s, write: 396.0 MiB/s',
    ...(storage === 'local'
      ? [
          'WARN: local is 91% full; the next backup may not fit',
          'INFO: backup is sparse: 41.2 GiB (64%) total zero data',
        ]
      : [
          'INFO: backup is sparse: 41.2 GiB (64%) total zero data',
          'INFO: transferred 64.0 GiB in 27 seconds',
        ]),
    `INFO: Finished Backup of VM ${g.vmid} (00:00:29)`,
    'INFO: Backup job finished successfully',
  ];

  function readTask(req: HostsFixtureRequest, serverId: string, taskId: string): HostsFixtureAnswer {
    let t = tasks.get(taskId);
    if (!t) {
      // Another stream's task (the default handler's `UPID:<server>:<n>:<op>`): a short one that ends well.
      const op = taskId.split(':')[3] ?? 'task';
      tasks.set(taskId, {
        id: taskId,
        serverId,
        type: op.includes('.') ? (op === 'guest.create' ? 'qmcreate' : op.replace(/\..*/, '')) : op,
        started: clock(),
        reads: 0,
        steps: 4,
        lines: ['Starting…', 'Working…', 'Writing the configuration…', 'TASK OK'],
        result: 'ok',
        message: 'OK',
      });
      t = tasks.get(taskId);
    }
    if (!t) return problem(404, 'not_found', 'That task isn’t there.');
    step(t);
    const logStart = Number(req.query.logStart ?? req.query.log_start ?? 0);
    return { status: 200, body: view(t, Number.isFinite(logStart) ? logStart : 0) };
  }

  /* Changes ----------------------------------------------------------------------------------------- */

  const nextId = (_serverId: string, want?: unknown) => {
    if (typeof want === 'number' && want >= 100) return want;
    const all = [...world.guests.values()].flat().map((g) => g.vmid ?? 0);
    return Math.max(145, ...all) + 1;
  };

  function addGuest(
    serverId: string,
    from: HostGuest,
    vmid: number,
    name: string,
    extra: Partial<HostGuest> = {},
  ) {
    const id = `pve:${vmid}`;
    const g: HostGuest = {
      ...from,
      id,
      vmid,
      name,
      state: 'stopped',
      cpuPct: null,
      memoryUsedMb: null,
      uptimeS: null,
      addresses: [],
      snapshots: 0,
      oldestSnapshot: null,
      pendingChanges: 0,
      lastBackup: null,
      guestAgent: from.kind === 'vm' ? null : from.guestAgent,
      haState: null,
      lock: undefined,
      console: { ...from.console, available: false },
      ...extra,
    };
    world.guests.set(serverId, [...guestsOf(serverId), g]);
    const src = world.configs.get(cfgKey(serverId, from.id));
    if (src)
      world.configs.set(cfgKey(serverId, id), {
        ...src,
        digest: `d${vmid}`,
        running: false,
        values: {
          ...src.values,
          ...(src.kind === 'vm' ? { name } : { hostname: name }),
          template: '0',
          protection: '0',
        },
        pending: {},
        ha: null,
        replication: [],
      });
    const fw = world.firewall.get(cfgKey(serverId, from.id));
    if (fw)
      world.firewall.set(cfgKey(serverId, id), {
        ...fw,
        optionsDigest: `fo${vmid}`,
        rulesDigest: `fr${vmid}`,
      });
    world.snapshots.set(cfgKey(serverId, id), [
      { name: 'current', current: true, description: 'You are here' },
    ]);
    world.tasks.set(cfgKey(serverId, id), []);
    coverage(serverId);
    return id;
  }

  function manage(serverId: string, body: Record<string, unknown>): HostsFixtureAnswer | null {
    const op = String(body.op ?? '');
    const guestId = typeof body.guestId === 'string' ? body.guestId : '';
    const p = (body.params ?? {}) as Record<string, unknown>;
    const g = guestId ? findGuest(serverId, guestId) : undefined;
    const key = cfgKey(serverId, guestId);
    switch (op) {
      case 'backup.create': {
        if (!g) return null; // another stream's (a template in WC's list) or the default 404
        const storage = String(p.storage ?? 'pbs');
        patchGuest(serverId, g.id, { lock: 'backup' });
        refreshServer(serverId);
        const id = start(serverId, {
          op,
          type: 'vzdump',
          vmid: g.vmid,
          guestId: g.id,
          steps: 8,
          lines: backupLines(g, storage, String(p.mode ?? 'snapshot')),
          result: storage === 'local' ? 'warning' : 'ok',
          message: storage === 'local' ? 'WARNINGS: 1' : 'OK',
          onDone: () => {
            const made = clock();
            world.backups.push({
              volume: `${storage}:backup/${g.kind === 'vm' ? 'vm' : 'ct'}/${g.vmid}/${at(made).slice(0, 19)}Z`,
              storage,
              guest: String(g.vmid),
              kind: g.kind,
              sizeBytes: Math.round((g.memoryLimitMb ?? 1024) * 1024 * 1024 * 5.2),
              created: at(made),
              format: storage === 'pbs' ? (g.kind === 'vm' ? 'pbs-vm' : 'pbs-ct') : 'vma.zst',
              notes: String(p.notes ?? '')
                .replace('{{guestname}}', g.name)
                .replace('{{vmid}}', String(g.vmid)),
              protected: p.protected === true,
              encrypted: storage === 'pbs',
              verified: '',
            });
            patchGuest(serverId, g.id, { lock: undefined, lastBackup: { result: 'ok', at: at(made) } });
            refreshServer(serverId);
          },
        });
        return ok({ task: { id } });
      }
      case 'backup.restore': {
        const volume = String(p.volume ?? '');
        const b = world.backups.find((x) => x.volume === volume);
        if (!b) return problem(404, 'not_found', 'That backup isn’t there.');
        const over = typeof p.guest === 'string' ? findGuest(serverId, p.guest) : undefined;
        if (over && over.state !== 'stopped')
          return problem(409, 'guest_running', `${over.name} is running: shut it down first.`);
        const src = guestsOf(serverId).find((x) => String(x.vmid) === b.guest) ?? guestsOf(serverId)[0];
        const vmid = over?.vmid ?? nextId(serverId, p.newId);
        // Proxmox refuses a new guest under an ID that's taken, once the task runs.
        const fails = !over && guestsOf(serverId).some((x) => x.vmid === vmid);
        const newId = over ? undefined : `pve:${vmid}`;
        const id = start(serverId, {
          op,
          type: b.kind === 'vm' ? 'qmrestore' : 'vzrestore',
          vmid,
          ...(over ? { guestId: over.id } : {}),
          steps: 7,
          lines: [
            `restore vma archive: ${volume}`,
            'CFG: size: 812 name: qemu-server.conf',
            'DEV: dev_id=1 size: 68719476736 devname: drive-scsi0',
            ...(fails
              ? [`TASK ERROR: unable to restore VM ${vmid} - VM ${vmid} already exists on node '${serverId}'`]
              : [
                  `new volume ID is 'local-zfs:vm-${vmid}-disk-0'`,
                  'progress 25% (read 17179869184 bytes, duration 6 sec)',
                  'progress 100% (read 68719476736 bytes, duration 24 sec)',
                  'rescan volumes...',
                  'TASK OK',
                ]),
          ],
          result: fails ? 'error' : 'ok',
          message: fails
            ? `unable to restore VM ${vmid} - VM ${vmid} already exists on node '${serverId}'`
            : 'OK',
          onDone: () => {
            if (fails || over || !src) return;
            addGuest(serverId, src, vmid, `${src.name}-restored`, p.start ? { state: 'running' } : {});
          },
        });
        return ok({ task: { id }, ...(newId ? { newId } : {}) });
      }
      case 'backup.update': {
        const at_ = world.backups.findIndex((x) => x.volume === p.volume);
        const b = world.backups[at_];
        if (!b) return problem(404, 'not_found', 'That backup isn’t there.');
        const next_: HostBackupVolume = { ...b };
        if (typeof p.notes === 'string') next_.notes = p.notes;
        if (typeof p.protected === 'boolean') next_.protected = p.protected;
        world.backups[at_] = next_;
        return ok();
      }
      case 'backup.delete': {
        const b = world.backups.find((x) => x.volume === p.volume);
        if (!b) return problem(404, 'not_found', 'That backup isn’t there.');
        if (b.protected)
          return problem(409, 'protected', 'That backup is protected: remove the protection first.');
        world.backups.splice(world.backups.indexOf(b), 1);
        return ok();
      }
      case 'guest.clone': {
        if (!g) return null; // another stream's (a template in WC's list) or the default 404
        const vmid = nextId(serverId, p.newId);
        const name = String(p.name ?? `${g.name}-copy`);
        if (guestsOf(serverId).some((x) => x.vmid === vmid))
          return {
            status: 400,
            body: {
              error: {
                code: 'validation_failed',
                message: 'Check the fields.',
                fields: { new_id: [`ID ${vmid} is taken.`] },
                details: { code: 'invalid_value' },
              },
            },
          };
        const full = p.full !== false;
        const id = start(serverId, {
          op,
          type: g.kind === 'vm' ? 'qmclone' : 'vzclone',
          vmid: g.vmid,
          guestId: g.id,
          steps: full ? 6 : 3,
          lines: full
            ? [
                `create full clone of drive scsi0 (local-zfs:vm-${g.vmid}-disk-0)`,
                'transferred 0.0 B of 64.0 GiB (0.00%)',
                'transferred 21.1 GiB of 64.0 GiB (33.00%)',
                'transferred 45.4 GiB of 64.0 GiB (71.00%)',
                'transferred 64.0 GiB of 64.0 GiB (100.00%)',
                'TASK OK',
              ]
            : [`create linked clone of drive scsi0 (local-zfs:base-${g.vmid}-disk-0)`, 'TASK OK'],
          result: 'ok',
          message: 'OK',
          onDone: () => void addGuest(serverId, g, vmid, name),
        });
        return ok({ task: { id }, newId: `pve:${vmid}` });
      }
      case 'guest.template': {
        if (!g) return null; // another stream's (a template in WC's list) or the default 404
        if (g.state !== 'stopped')
          return problem(409, 'guest_running', `${g.name} is running: shut it down first.`);
        const id = start(serverId, {
          op,
          type: g.kind === 'vm' ? 'qmtemplate' : 'vztemplate',
          vmid: g.vmid,
          guestId: g.id,
          steps: 3,
          lines: [
            `converting VM ${g.vmid} to a template`,
            `renamed volume to 'base-${g.vmid}-disk-0'`,
            'TASK OK',
          ],
          result: 'ok',
          message: 'OK',
          onDone: () =>
            patchConfig(serverId, g.id, (c) => ({ ...c, values: { ...c.values, template: '1' } })),
        });
        return ok({ task: { id } });
      }
      case 'guest.delete': {
        if (!g) return null; // another stream's (a template in WC's list) or the default 404
        if (body.confirmName !== g.name)
          return problem(400, 'confirm_required', 'Type its name to delete it.');
        if (world.configs.get(key)?.values.protection === '1')
          return problem(409, 'protected', `Protection is on for ${g.name}: turn it off in Options first.`);
        if (g.state !== 'stopped')
          return problem(409, 'guest_running', `${g.name} is running: shut it down first.`);
        const id = start(serverId, {
          op,
          type: g.kind === 'vm' ? 'qmdestroy' : 'vzdestroy',
          vmid: g.vmid,
          steps: 4,
          lines: [
            `Removing ${g.kind === 'vm' ? 'VM' : 'CT'} ${g.vmid}`,
            `Removing image: 100% complete…done.`,
            ...(p.purge ? [`purging ${g.vmid} from backup jobs, replication and HA`] : []),
            'TASK OK',
          ],
          result: 'ok',
          message: 'OK',
          onDone: () => {
            world.guests.set(
              serverId,
              guestsOf(serverId).filter((x) => x.id !== g.id),
            );
            if (p.purge)
              jobs.set(
                serverId,
                (jobs.get(serverId) ?? []).map((j) => ({
                  ...j,
                  guests: j.guests?.filter((x) => x !== g.id),
                  exclude: j.exclude?.filter((x) => x !== g.id),
                })),
              );
            coverage(serverId);
          },
        });
        return ok({ task: { id } });
      }
      case 'firewall.options':
      case 'firewall.rule_add':
      case 'firewall.rule_update':
      case 'firewall.rule_delete': {
        const fw = world.firewall.get(key);
        if (!fw) return null;
        const rulesOp = op !== 'firewall.options';
        const digest = rulesOp ? fw.rulesDigest : fw.optionsDigest;
        if (body.digest && digest && body.digest !== digest)
          return problem(409, 'digest_mismatch', 'Changed meanwhile — review again.');
        let rules = [...fw.rules].sort((a, b) => a.pos - b.pos);
        let options = fw.options;
        const renumber = (list: HostFirewall['rules']) => list.map((r, i) => ({ ...r, pos: i }));
        if (op === 'firewall.options') {
          options = { ...fw.options, ...((p.set as Record<string, string>) ?? {}) };
          for (const k of (p.delete as string[]) ?? []) delete options[k];
        } else if (op === 'firewall.rule_add') {
          const rule = (p.rule ?? {}) as HostFirewall['rules'][number];
          const pos = Math.min(Math.max(0, rule.pos ?? 0), rules.length);
          rules.splice(pos, 0, { ...rule, pos });
          rules = renumber(rules);
        } else if (op === 'firewall.rule_delete') {
          rules = renumber(rules.filter((r) => r.pos !== Number(p.pos)));
        } else {
          const from = rules.findIndex((r) => r.pos === Number(p.pos));
          if (from < 0) return problem(404, 'not_found', 'That rule isn’t there.');
          if (p.rule) rules[from] = { ...(p.rule as HostFirewall['rules'][number]), pos: Number(p.pos) };
          if (typeof p.moveTo === 'number') {
            const [r] = rules.splice(from, 1);
            if (r) rules.splice(Math.min(Math.max(0, p.moveTo), rules.length), 0, r);
          }
          rules = renumber(rules);
        }
        world.firewall.set(key, {
          ...fw,
          options,
          rules,
          ...(rulesOp
            ? { rulesDigest: `${fw.rulesDigest ?? 'fr'}+` }
            : { optionsDigest: `${fw.optionsDigest ?? 'fo'}+` }),
        });
        return ok();
      }
      case 'replication.add': {
        const cfg = world.configs.get(key);
        if (!cfg || !g) return null;
        const list = cfg.replication ?? [];
        if (list.some((j) => j.target === p.target))
          return problem(409, 'exists', `${g.name} already has a job to ${String(p.target)}.`);
        patchConfig(serverId, g.id, (c) => ({
          ...c,
          replication: [
            ...list,
            {
              id: `${g.vmid}-${list.length}`,
              target: String(p.target ?? ''),
              schedule: String(p.schedule ?? '*/15'),
              ...(p.rate ? { rate: String(p.rate) } : {}),
              ...(p.comment ? { comment: String(p.comment) } : {}),
              lastSync: null,
            },
          ],
        }));
        return ok();
      }
      case 'replication.delete': {
        if (!g) return null; // another stream's (a template in WC's list) or the default 404
        patchConfig(serverId, g.id, (c) => ({
          ...c,
          replication: (c.replication ?? []).filter((j) => j.id !== p.job),
        }));
        return ok();
      }
      case 'backupjob.create': {
        seq += 1;
        const id = `backup-${(0x51e0a + seq * 7919).toString(16)}-${(0xb3c + seq).toString(16)}`;
        const job: HostBackupJob = {
          id,
          enabled: p.enabled !== false,
          schedule: String(p.schedule ?? '02:00'),
          storage: String(p.storage ?? 'pbs'),
          node: (p.node as string) ?? null,
          selection: (p.selection as HostBackupJob['selection']) ?? 'all',
          ...(p.guests ? { guests: p.guests as string[] } : {}),
          ...(p.exclude ? { exclude: p.exclude as string[] } : {}),
          pool: (p.pool as string) ?? null,
          mode: (p.mode as HostBackupJob['mode']) ?? 'snapshot',
          compress: (p.compress as string) ?? null,
          keep: (p.keep as HostBackupJob['keep']) ?? null,
          notesTemplate: (p.notesTemplate as string) ?? null,
          comment: (p.comment as string) ?? null,
          nextRun: at(now + 14 * 3_600_000),
          digest: `job-${seq}`,
        };
        jobs.set(serverId, [...(jobs.get(serverId) ?? []), job]);
        coverage(serverId);
        return ok({ newId: id });
      }
      case 'backupjob.update': {
        const list = jobs.get(serverId) ?? [];
        const j = list.find((x) => x.id === p.jobId);
        if (!j) return problem(404, 'not_found', 'That backup job isn’t there.');
        if (body.digest && j.digest && body.digest !== j.digest)
          return problem(409, 'digest_mismatch', 'Changed meanwhile — review again.');
        const { jobId: _id, ...change } = p;
        const updated = { ...j, ...change, digest: `${j.digest}+` } as HostBackupJob;
        if (updated.enabled && !j.enabled) updated.nextRun = at(now + 14 * 3_600_000);
        if (!updated.enabled) updated.nextRun = null;
        jobs.set(
          serverId,
          list.map((x) => (x.id === j.id ? updated : x)),
        );
        coverage(serverId);
        return ok({ changes: [] });
      }
      case 'backupjob.delete': {
        if (body.confirm !== true) return problem(400, 'confirm_required', 'Confirm deleting the job.');
        jobs.set(
          serverId,
          (jobs.get(serverId) ?? []).filter((x) => x.id !== p.jobId),
        );
        coverage(serverId);
        return ok();
      }
      case 'backupjob.run': {
        const j = (jobs.get(serverId) ?? []).find((x) => x.id === p.jobId);
        if (!j) return problem(404, 'not_found', 'That backup job isn’t there.');
        const covered = guestsOf(serverId).filter(
          (x) => x.platform === 'pve' && backupJobIncludes(j, x.id, x.node),
        );
        const id = start(serverId, {
          op,
          type: 'vzdump',
          steps: Math.min(10, 3 + covered.length),
          lines: [
            `INFO: starting new backup job: vzdump --storage ${j.storage} --mode ${j.mode} --all ${j.selection === 'all' ? 1 : 0}`,
            ...covered.flatMap((x) => [
              `INFO: Starting Backup of VM ${x.vmid} (${x.kind === 'vm' ? 'qemu' : 'lxc'})`,
              `INFO: Finished Backup of VM ${x.vmid} (00:00:${String(12 + ((x.vmid ?? 0) % 40)).padStart(2, '0')})`,
            ]),
            'INFO: Backup job finished successfully',
          ],
          result: 'ok',
          message: 'OK',
        });
        return ok({ task: { id } });
      }
      case 'task.stop': {
        const t = tasks.get(String(p.task ?? ''));
        if (!t) return problem(404, 'not_found', 'That task isn’t there.');
        if (t.reads < t.steps) {
          t.lines = [
            ...t.lines.slice(0, Math.ceil((t.reads / t.steps) * t.lines.length)),
            'received interrupt',
            'TASK ERROR: interrupted by signal',
          ];
          t.steps = t.reads + 1;
          t.result = 'error';
          t.message = 'interrupted by signal';
          t.onDone = () => {
            if (t.guestId) patchGuest(serverId, t.guestId, { lock: undefined });
            refreshServer(serverId);
          };
        }
        return ok();
      }
      default:
        return null;
    }
  }

  /** The guest history with the series the hub keeps that the base world doesn't draw (disk I/O). */
  function metrics(req: HostsFixtureRequest): HostsFixtureAnswer | null {
    const base = next(req);
    if (base?.status !== 200) return base;
    const s = base.body as HostSeries;
    const want = (req.query.series ?? '').split(',').filter(Boolean);
    const n = s.timestamps.length;
    const seed = hash(req.path);
    const series = { ...s.series };
    for (const k of want)
      if (!series[k])
        series[k] = k.startsWith('disk_write') ? wave(seed + 2, n, 1, 9) : wave(seed + 1, n, 0.5, 6);
    return { status: 200, body: { ...s, series } };
  }

  return (req) => {
    const seg = req.path.split('/').filter(Boolean).map(decodeURIComponent);
    const route = `${req.method} ${seg.map((s, i) => (i % 2 === 1 ? ':' : s)).join('/')}`;
    const serverId = seg[1] ?? '';
    if (route === 'GET servers/:/manage' && req.query.op === 'backupjob.list')
      return { status: 200, body: { op: 'backupjob.list', items: jobs.get(serverId) ?? [] } };
    if (route === 'GET servers/:/guests/:/metrics') return metrics(req);
    if (route === 'GET servers/:/tasks/:') return readTask(req, serverId, seg[3] ?? '');
    if (route === 'POST servers/:/manage') return manage(serverId, req.body) ?? next(req);
    return next(req);
  };
}
