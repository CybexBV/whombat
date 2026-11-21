/**
 * A guest's screen in the one-Whombat demo world (proxmox-mobile.md AP-1501): what `fixtures/assistant.ts` doesn't
 * answer for a Proxmox guest — its detail, metrics, configuration with a digest, choices, snapshots, backups, tasks
 * and backup jobs — and its changes: `config.set` applies (a stale digest is refused as “Changed meanwhile”), the
 * rest start a task that ends 2.5 seconds later with a `hosts.task` frame, and snapshot actions change the list. The
 * guests are the world's own (`guestsFor`), so the server's rows and the guest's screen agree.
 */
import type {
  HostBackupJob,
  HostBackupVolume,
  HostGuest,
  HostGuestConfig,
  HostGuestDetail,
  HostSeries,
  HostServer,
  HostSnapshot,
  HostTask,
  RealtimeEvent,
} from '@whombat/core';

const H = 3600_000;
const D = 24 * H;

export interface GuestManageDeps {
  now: () => Date;
  emit: (topic: string, event: RealtimeEvent) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  hostsTopic: string;
  servers: readonly HostServer[];
  guests: Map<string, HostGuest[]>;
  json: (body: unknown, status?: number) => Response;
  notFound: (text: string) => Response;
  bodyOf: <T>(init: RequestInit | undefined) => Promise<T>;
}

/** A guest's extra facts in the demo: last night's backup, a job for all but win11-test, a running agent. */
function detailed(g: HostGuest, now: number, s: HostServer | undefined): HostGuestDetail {
  const inJob = g.vmid !== 130;
  return {
    ...g,
    tags: g.tags ?? (g.kind === 'vm' ? ['prod'] : ['home']),
    lastBackup: inJob ? { result: 'ok', at: new Date(now - 12 * H).toISOString() } : null,
    backupJob: inJob,
    guestAgent: g.kind === 'vm' ? (g.state === 'running' ? 'running' : null) : null,
    snapshots: g.kind === 'vm' ? 2 : 1,
    addresses: g.state === 'running' ? [`10.100.2.${g.vmid ?? 1}`] : [],
    remoteControl: s?.remoteControl ?? { console: true, power: true, manage: true },
    manageable: g.platform === 'pve',
  };
}

function configOf(g: HostGuest): HostGuestConfig {
  const mem = String(g.memoryLimitMb ?? 2048);
  const id = g.vmid ?? 100;
  const pending: Record<string, string> = g.pendingChanges ? { memory: String(Number(mem) * 2) } : {};
  if (g.kind === 'vm')
    return {
      platform: 'pve',
      kind: 'vm',
      digest: `d${id}`,
      running: g.state === 'running',
      values: {
        name: g.name,
        memory: mem,
        balloon: '0',
        cores: String(g.vcpu ?? 4),
        sockets: '1',
        cpu: 'x86-64-v2-AES',
        bios: 'ovmf',
        machine: 'q35',
        scsi0: `local-zfs:vm-${id}-disk-0,iothread=1,size=64G`,
        ide2: `local-zfs:vm-${id}-cloudinit,media=cdrom`,
        net0: `virtio=BC:24:11:3A:${String(id).slice(-2)}:01,bridge=vmbr0,firewall=1`,
        boot: 'order=scsi0;net0',
        onboot: '1',
        agent: '1',
        ostype: 'l26',
        tags: (g.tags ?? ['prod']).join(';'),
        description: g.name === 'arnica-prod-nest-01' ? 'Arnica production nest, first of two.' : '',
      },
      pending,
      pendingDelete: [],
    };
  return {
    platform: 'pve',
    kind: 'container',
    digest: `d${id}`,
    running: g.state === 'running',
    values: {
      hostname: g.name,
      memory: mem,
      swap: '512',
      cores: String(g.vcpu ?? 2),
      rootfs: `local-zfs:subvol-${id}-disk-0,size=16G`,
      net0: `name=eth0,bridge=vmbr0,hwaddr=BC:24:11:5C:${String(id).slice(-2)}:02,ip=dhcp,type=veth`,
      onboot: '1',
      unprivileged: '1',
      ostype: 'debian',
      tags: (g.tags ?? ['home']).join(';'),
      description: '',
    },
    pending,
    pendingDelete: [],
  };
}

/** A gentle day of CPU and memory, 30 minutes apart. */
function seriesOf(serverId: string, g: HostGuest, now: number): HostSeries {
  const n = 48;
  const ts = Array.from({ length: n }, (_, i) => new Date(now - (n - 1 - i) * 1800_000).toISOString());
  const base = g.cpuPct ?? 2;
  const mem = g.memoryUsedMb ?? 512;
  return {
    serverId,
    guestId: g.id,
    range: '24h',
    stepSeconds: 1800,
    asOf: new Date(now).toISOString(),
    timestamps: ts,
    series: {
      cpu_pct: ts.map((_, i) =>
        Math.max(0.2, +(base + Math.sin(i / 5) * base * 0.4 + (i > 4 && i < 9 ? base : 0)).toFixed(1)),
      ),
      mem_mb: ts.map((_, i) => Math.round(mem * (0.9 + 0.1 * Math.sin(i / 7)))),
    },
  } as HostSeries;
}

export function createGuestManageFixtures(deps: GuestManageDeps) {
  const { now, emit, setTimer, hostsTopic, json, notFound, bodyOf } = deps;
  const t0 = () => now().getTime();
  const configs = new Map<string, HostGuestConfig>();
  const snapshots = new Map<string, HostSnapshot[]>();
  const tasks = new Map<string, HostTask>();
  let seq = 0;
  let jobs: HostBackupJob[] = [
    {
      id: 'backup-dc316015-ac2c',
      enabled: true,
      schedule: '04:00',
      storage: 'PBS-BlackBox',
      node: null,
      selection: 'all',
      exclude: ['pve:130'],
      mode: 'snapshot',
      nextRun: new Date(t0() + 14 * H).toISOString(),
      digest: 'j1',
    },
    {
      id: 'backup-7a1e02bb-1f90',
      enabled: false,
      schedule: 'sat 02:00',
      storage: 'local',
      node: 'pve-02',
      selection: 'guests',
      guests: ['pve:118', 'pve:119'],
      mode: 'stop',
      nextRun: null,
      digest: 'j2',
    },
  ];

  const find = (serverId: string, guestId: string) =>
    deps.guests.get(serverId)?.find((g) => g.id === guestId);
  const key = (serverId: string, guestId: string) => `${serverId}/${guestId}`;
  const configFor = (serverId: string, g: HostGuest) => {
    const k = key(serverId, g.id);
    const c = configs.get(k) ?? configOf(g);
    configs.set(k, c);
    return c;
  };
  const snapsFor = (serverId: string, g: HostGuest) => {
    const k = key(serverId, g.id);
    const list = snapshots.get(k) ?? [
      {
        name: 'before-upgrade',
        created: new Date(t0() - 9 * D).toISOString(),
        description: 'Before the 9.2 upgrade',
      },
      ...(g.kind === 'vm'
        ? [{ name: 'weekly', created: new Date(t0() - 2 * D).toISOString(), memory: true, description: '' }]
        : []),
      { name: 'current', current: true, description: 'You are here' },
    ];
    snapshots.set(k, list);
    return list;
  };
  const backupsOf = (serverId: string, g?: HostGuest): HostBackupVolume[] =>
    (g ? [g] : (deps.guests.get(serverId) ?? []))
      .filter((x) => x.vmid !== 130)
      .flatMap((x) =>
        [0, 1, 2].map((d) => {
          const at = new Date(t0() - d * D - 12 * H);
          return {
            volume: `PBS-BlackBox:backup/${x.kind === 'vm' ? 'vm' : 'ct'}/${x.vmid}/${at.toISOString().slice(0, 19)}Z`,
            storage: 'PBS-BlackBox',
            guest: String(x.vmid),
            kind: x.kind,
            sizeBytes: Math.round((x.memoryLimitMb ?? 1024) * 1024 * 1024 * (x.kind === 'vm' ? 5.5 : 1.3)),
            created: at.toISOString(),
            notes: d === 0 ? `${x.name} nightly` : '',
            protected: d === 2 && x.vmid === 118,
            verified: 'ok' as const,
          };
        }),
      );
  const tasksOf = (serverId: string, g: HostGuest): HostTask[] => [
    ...[...tasks.values()].filter((t) => t.guestId === g.id && t.node === serverId),
    {
      id: `UPID:${serverId}:${g.vmid}:vzdump`,
      type: 'vzdump',
      guestId: g.id,
      node: serverId,
      user: 'whombat@pve',
      started: new Date(t0() - 12 * H).toISOString(),
      ended: new Date(t0() - 12 * H + 45_000).toISOString(),
      status: 'ok',
      message: 'Backed up',
    },
    {
      id: `UPID:${serverId}:${g.vmid}:start`,
      type: g.kind === 'vm' ? 'qmstart' : 'vzstart',
      guestId: g.id,
      node: serverId,
      user: 'mara@pam',
      started: new Date(t0() - 6 * D).toISOString(),
      ended: new Date(t0() - 6 * D + 4000).toISOString(),
      status: 'ok',
    },
  ];

  /** A change that runs as a task: running now, done 2.5 s later with its `hosts.task` frame. */
  function startTask(serverId: string, op: string, guestId: string | null, type: string): string {
    const id = `UPID:${serverId}:${++seq}:${op}`;
    const started = new Date(t0()).toISOString();
    tasks.set(id, {
      id,
      type,
      guestId: guestId ?? undefined,
      node: serverId,
      user: 'mara@pve',
      started,
      status: 'running',
      log: [`${op}: starting`],
    });
    setTimer(() => {
      const t = tasks.get(id);
      if (!t) return;
      tasks.set(id, {
        ...t,
        status: 'ok',
        ended: new Date(t0() + 2500).toISOString(),
        log: [...(t.log ?? []), 'TASK OK'],
      });
      emit(hostsTopic, { type: 'hosts.task', serverId, guestId, taskId: id, op, result: 'ok' });
    }, 2500);
    return id;
  }

  const TASK_TYPES: Record<string, string> = {
    'backup.create': 'vzdump',
    'backup.restore': 'qmrestore',
    'guest.clone': 'qmclone',
    'guest.delete': 'qmdestroy',
    'disk.resize': 'resize',
    'backupjob.run': 'vzdump',
  };

  async function handle(
    id: string,
    params: Record<string, string>,
    init: RequestInit | undefined,
    url: URL,
  ): Promise<Response | null> {
    const serverId = params.serverId ?? '';
    const server = deps.servers.find((s) => s.id === serverId);
    switch (id) {
      case 'hosts.getGuest': {
        const g = find(serverId, params.guestId ?? '');
        return g ? json(detailed(g, t0(), server)) : notFound(`No guest ${params.guestId}`);
      }
      case 'hosts.guestMetrics': {
        const g = find(serverId, params.guestId ?? '');
        return g ? json(seriesOf(serverId, g, t0())) : notFound(`No guest ${params.guestId}`);
      }
      case 'hosts.getTask': {
        const t = tasks.get(params.taskId ?? '');
        return t ? json(t) : notFound('No such task');
      }
      case 'hosts.guestAction': {
        // Snapshots here; power is the world's own (`assistant.ts`).
        const g = find(serverId, params.guestId ?? '');
        if (!g) return null;
        const body = await bodyOf<{
          action: string;
          snapshot?: string;
          description?: string;
          memory?: boolean;
        }>(init);
        if (!body.action.startsWith('snapshot_')) return null;
        const list = snapsFor(serverId, g);
        const name = body.snapshot ?? `snap-${++seq}`;
        if (body.action === 'snapshot_create')
          snapshots.set(key(serverId, g.id), [
            ...list.filter((s) => !s.current),
            {
              name,
              created: new Date(t0()).toISOString(),
              description: body.description ?? '',
              memory: !!body.memory,
            },
            ...list.filter((s) => s.current),
          ]);
        else if (body.action === 'snapshot_delete')
          snapshots.set(
            key(serverId, g.id),
            list.filter((s) => s.name !== name),
          );
        const actionId = `act_${g.vmid}_${++seq}`;
        setTimer(
          () =>
            emit(hostsTopic, {
              type: 'hosts.task',
              serverId,
              guestId: g.id,
              actionId,
              op: body.action,
              result: 'ok',
            }),
          1500,
        );
        return json({ actionId }, 202);
      }
      case 'hosts.manageRead': {
        const op = url.searchParams.get('op');
        const guestId = url.searchParams.get('guestId');
        const g = guestId ? find(serverId, guestId) : undefined;
        if (guestId && !g) return notFound(`No guest ${guestId}`);
        switch (op) {
          case 'config.get':
            return g ? json({ op, config: configFor(serverId, g) }) : null;
          case 'choices':
            return json({
              op,
              choices: {
                platform: 'pve',
                node: serverId,
                nextId: 146,
                storages: [
                  { id: 'local', type: 'dir', content: ['iso', 'vztmpl', 'backup'] },
                  { id: 'local-zfs', type: 'zfspool', content: ['images', 'rootdir'] },
                  { id: 'PBS-BlackBox', type: 'pbs', content: ['backup'] },
                ],
                bridges: ['vmbr0'],
              },
            });
          case 'snapshot.list':
            return g ? json({ op, items: snapsFor(serverId, g) }) : null;
          case 'backup.list':
            return json({ op, items: backupsOf(serverId, g) });
          case 'task.list':
            return g ? json({ op, items: tasksOf(serverId, g) }) : json({ op, items: [] });
          case 'backupjob.list':
            return json({ op, items: jobs });
          default:
            return null;
        }
      }
      case 'hosts.manage': {
        const body = await bodyOf<{
          op: string;
          guestId?: string;
          params?: Record<string, unknown>;
          digest?: string;
        }>(init);
        const g = body.guestId ? find(serverId, body.guestId) : undefined;
        const p = body.params ?? {};
        if (body.op === 'config.set' && g) {
          const cfg = configFor(serverId, g);
          if (body.digest && body.digest !== cfg.digest)
            return json(
              {
                error: {
                  code: 'conflict',
                  message: 'Changed meanwhile — review again.',
                  details: { code: 'digest_mismatch' },
                },
              },
              409,
            );
          const set = (p.set ?? {}) as Record<string, string>;
          const values = { ...cfg.values };
          const pending = { ...(cfg.pending ?? {}) };
          const live = new Set(['name', 'hostname', 'description', 'tags', 'onboot', 'protection']);
          const changes = Object.entries(set).map(([k, v]) => {
            const later = cfg.running && !live.has(k);
            if (later) pending[k] = v;
            else values[k] = v;
            return { key: k, old: cfg.values[k], new: v, ...(later ? { pending: true } : {}) };
          });
          for (const k of (p.delete ?? []) as string[]) delete values[k];
          for (const k of (p.revert ?? []) as string[]) delete pending[k];
          configs.set(key(serverId, g.id), { ...cfg, values, pending, digest: `${cfg.digest}+` });
          return json({ ok: true, changes });
        }
        if (body.op === 'backupjob.update') {
          const job = jobs.find((j) => j.id === p.jobId);
          if (!job) return notFound('No such backup job');
          if (body.digest && body.digest !== job.digest)
            return json(
              {
                error: {
                  code: 'conflict',
                  message: 'Changed meanwhile — review again.',
                  details: { code: 'digest_mismatch' },
                },
              },
              409,
            );
          const { jobId: _id, ...rest } = p;
          jobs = jobs.map((j) => (j.id === job.id ? { ...j, ...rest, digest: `${j.digest}+` } : j));
          return json({ ok: true, changes: [] });
        }
        if (body.op === 'backup.update') return json({ ok: true });
        const type = TASK_TYPES[body.op] ?? 'task';
        return json({ ok: true, task: { id: startTask(serverId, body.op, g?.id ?? null, type) } });
      }
      default:
        return null;
    }
  }

  return { handle };
}
