import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { api } from '../contracts/index.js';
import {
  type CatalogEntry,
  catalogEntry,
  SERVERS_SENSITIVE,
  SERVERS_TOOLS,
  SensitiveRule,
  sensitiveReason,
  toolAlwaysAsks,
} from './connections-catalog.js';
import {
  HOST_MANAGE_DESTRUCTIVE_OPS,
  HOST_MANAGE_OPS,
  HOST_MANAGE_READ_OPS,
  HostBackupJob,
  HostBackupJobParams,
  HostManageReadResult,
  HostManageRequest,
} from './hosts.js';

/** §2.1's example of the hub's `BackupJob`, in Whombat's camelCase. */
const JOB = {
  id: 'backup-dc316015-ac2c',
  enabled: true,
  schedule: '04:00',
  storage: 'PBS-BlackBox',
  node: 'pve-01',
  selection: 'guests',
  guests: ['pve:101', 'pve:118'],
  exclude: ['pve:100'],
  pool: null,
  mode: 'snapshot',
  compress: 'zstd',
  keep: { last: 7, hourly: 0, daily: 14, weekly: 8, monthly: 6, yearly: 0 },
  notesTemplate: '{{guestname}}',
  comment: 'Nightly',
  nextRun: '2026-10-18T02:00:00Z',
  digest: 'c0ffee'.repeat(10),
};

const servers = (): CatalogEntry => {
  const e = catalogEntry('whombat_servers');
  if (!e) throw new Error('no Servers entry');
  return e;
};

const S = { server: 'pve-02' };
const G = { server: 'pve-02', guest: 'pve:101' };

describe('backup jobs (CT-353, 0.81.0)', () => {
  it('parses a job as the hub sends it, and a lean one', () => {
    expect(HostBackupJob.parse(JOB)).toEqual(JOB);
    const lean = {
      id: 'backup-1',
      enabled: false,
      schedule: 'sat 02:00',
      storage: 'local',
      selection: 'all',
      mode: 'stop',
    };
    expect(HostBackupJob.parse(lean)).toEqual(lean);
    expect(
      HostBackupJob.parse({ ...lean, node: null, keep: null, compress: '1', nextRun: null }).compress,
    ).toBe('1');
    expect(HostBackupJob.safeParse({ ...JOB, keep: { daily: -1 } }).success).toBe(false);
    expect(HostBackupJob.safeParse({ ...JOB, selection: 'tags' }).success).toBe(false);
  });

  it('lists jobs through manageRead and changes them through manage', () => {
    expect(HOST_MANAGE_READ_OPS).toContain('backupjob.list');
    expect(api.hosts.manageRead.query?.parse({ op: 'backupjob.list' })).toEqual({ op: 'backupjob.list' });
    const read = HostManageReadResult.parse({ op: 'backupjob.list', items: [JOB] });
    expect(read.op === 'backupjob.list' && read.items[0]?.guests).toEqual(['pve:101', 'pve:118']);
    // Older answers keep parsing.
    expect(HostManageReadResult.parse({ op: 'backup.list', items: [] })).toEqual({
      op: 'backup.list',
      items: [],
    });

    for (const op of ['backupjob.create', 'backupjob.update', 'backupjob.delete', 'backupjob.run'] as const)
      expect(HOST_MANAGE_OPS).toContain(op);
    expect(HOST_MANAGE_DESTRUCTIVE_OPS).toContain('backupjob.delete');
    expect(HOST_MANAGE_DESTRUCTIVE_OPS).not.toContain('backupjob.run');
    expect(HOST_MANAGE_DESTRUCTIVE_OPS).not.toContain('backupjob.update');

    const update = HostManageRequest.parse({
      op: 'backupjob.update',
      params: { jobId: JOB.id, schedule: 'sat 02:00', keep: { daily: 7 }, comment: null },
      digest: JOB.digest,
    });
    expect(HostBackupJobParams.parse(update.params)).toEqual({
      jobId: JOB.id,
      schedule: 'sat 02:00',
      keep: { daily: 7 },
      comment: null,
    });
    const create = {
      enabled: true,
      schedule: '04:00',
      storage: 'PBS-BlackBox',
      node: 'pve-01',
      selection: 'all',
      exclude: ['pve:100'],
      mode: 'snapshot',
      compress: 'zstd',
      keep: { last: 3 },
      notesTemplate: '{{guestname}}',
    };
    expect(HostBackupJobParams.parse(create)).toEqual(create);
  });

  it('refuses a job field it doesn’t know, naming it (PX-08)', () => {
    const r = HostBackupJobParams.safeParse({ jobId: 'backup-1', retention: 3 });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('retention');
    expect(HostBackupJobParams.safeParse({ compress: 'brotli' }).success).toBe(false);
  });
});

/** One call each tool takes, as a model would make it. */
const EXAMPLES: Record<string, Record<string, unknown>> = {
  servers_overview: {},
  server_detail: S,
  server_metrics: { ...S, range: '7d', series: ['net_rx_mbps', 'net_tx_mbps'] },
  guests_list: { state: 'running' },
  guest_detail: G,
  guest_config: G,
  guest_snapshots: G,
  guest_backups: S,
  guest_firewall: G,
  server_choices: S,
  backup_jobs: S,
  storage_contents: { ...S, content: 'iso' },
  server_tasks: { ...S, task: 'UPID:pve-02:0001' },
  guest_power: { ...G, action: 'pause' },
  guest_config_set: { ...G, digest: 'd', revert: ['memory'], delete: ['unused0'], confirm: true },
  guest_snapshot: { ...G, action: 'create', name: 'before-upgrade' },
  guest_migrate: { ...G, target: 'pve-01', storage: 'local-zfs' },
  guest_create: {
    ...S,
    kind: 'container',
    name: 'web-01',
    id: 120,
    cores: 2,
    memory_mb: 2048,
    disk_gb: 16,
    storage: 'local-lvm',
    bridge: 'vmbr0',
    template: 'local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst',
    ssh_keys: 'ssh-ed25519 AAAA… john',
    start: true,
    settings: { onboot: '1' },
  },
  guest_clone: { ...S, guest: 'pve:9000', name: 'web-02', full: false },
  guest_template: G,
  guest_delete: { ...G, purge: true },
  guest_disk: { ...G, action: 'resize', disk: 'scsi0', size: '+10G' },
  guest_backup: {
    ...G,
    action: 'create',
    storage: 'PBS-BlackBox',
    mode: 'snapshot',
    notes: 'Before the upgrade',
  },
  backup_job_set: {
    ...S,
    action: 'create',
    guest: 'pve:101',
    schedule: '04:00',
    keep: { last: 3, daily: 7 },
  },
  storage_content: {
    ...S,
    action: 'download',
    storage: 'local',
    content: 'iso',
    url: 'https://example.org/debian-13.iso',
    filename: 'debian-13.iso',
    checksum_algorithm: 'sha256',
  },
  task_stop: { ...S, task: 'UPID:pve-02:0001' },
  guest_firewall_set: {
    ...G,
    action: 'add_rule',
    rule: { type: 'in', action: 'ACCEPT', proto: 'tcp', dport: '443' },
  },
  guest_ha: { ...G, action: 'set', state: 'started', max_restart: 1 },
  guest_replication: { ...G, action: 'add', target: 'pve-01', schedule: '*/15' },
  alerts_list: {},
  alert_snooze: { alert: 'al_1', minutes: 60 },
  server_diagnose: { ...S, check: 'logs', args: { grep: 'sdc', since: '2h' } },
  server_command: { ...S, command: 'uptime', reason: 'See how long it has run' },
  server_power: { ...S, action: 'reboot' },
};

type Prop = { description?: unknown; enum?: unknown[]; default?: unknown };

describe('the Servers tools (CT-355, 0.81.0)', () => {
  it('has every tool of the brief, each with a valid JSON schema', () => {
    // 0.83 (CT-366) adds the Incus and unRAID tools (incus-unraid-0830.test.ts); these 34 stay.
    expect(Object.keys(EXAMPLES)).toHaveLength(34);
    expect(SERVERS_TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(Object.keys(EXAMPLES)));
    expect(servers().tools.map((t) => t.name)).toEqual(SERVERS_TOOLS.map((t) => t.name));
    for (const t of SERVERS_TOOLS.filter((x) => x.name in EXAMPLES)) {
      const schema = t.inputSchema as {
        type: string;
        properties: Record<string, Prop>;
        required: string[];
        additionalProperties: boolean;
      };
      expect(schema.type, t.name).toBe('object');
      expect(schema.additionalProperties, t.name).toBe(false);
      for (const r of schema.required) expect(Object.keys(schema.properties), `${t.name}.${r}`).toContain(r);
      for (const [key, p] of Object.entries(schema.properties)) {
        expect(typeof p.description === 'string' && p.description.length > 0, `${t.name}.${key}`).toBe(true);
        expect(p.description as string, `${t.name}.${key}`).not.toMatch(/'/);
        if (p.enum) expect(new Set(p.enum).size, `${t.name}.${key}`).toBe(p.enum.length);
        if (p.default !== undefined)
          expect(z.fromJSONSchema(p as never).safeParse(p.default).success, `${t.name}.${key} default`).toBe(
            true,
          );
      }
      expect(`${t.title} ${t.description}`, t.name).not.toMatch(/'/);
      const validator = z.fromJSONSchema(t.inputSchema as never);
      expect(validator.safeParse(EXAMPLES[t.name]).success, t.name).toBe(true);
      expect(validator.safeParse({ ...EXAMPLES[t.name], online: true }).success, `${t.name} extra`).toBe(
        false,
      );
    }
  });

  it('takes the fixed inputs (PX-08)', () => {
    const props = (name: string): Record<string, Prop> => {
      const schema = SERVERS_TOOLS.find((t) => t.name === name)?.inputSchema;
      return (schema?.properties ?? {}) as Record<string, Prop>;
    };
    expect(props('guest_power').action?.enum).toEqual([
      'start',
      'stop',
      'shutdown',
      'reboot',
      'pause',
      'resume',
    ]);
    expect(Object.keys(props('guest_config_set'))).toEqual(
      expect.arrayContaining(['set', 'delete', 'revert', 'confirm']),
    );
    expect(props('guest_migrate').online).toBeUndefined();
    expect(props('guest_migrate').storage).toBeDefined();
    expect(props('server_diagnose').args).toBeDefined();
    expect(props('server_metrics').series?.description).toContain('net_rx_mbps, net_tx_mbps');
  });

  it('always asks before what destroys or moves something', () => {
    const asks: [string, Record<string, unknown>][] = [
      ['guest_delete', G],
      ['guest_template', G],
      ['server_power', { ...S, action: 'reboot' }],
      ['server_power', { ...S, action: 'shutdown' }],
      ['guest_power', { ...G, action: 'stop' }],
      ['guest_power', { ...G, action: 'shutdown' }],
      ['guest_power', { ...G, action: 'reboot' }],
      ['guest_power', { ...G, action: 'pause' }],
      ['guest_snapshot', { ...G, action: 'restore', name: 'before-upgrade' }],
      ['guest_snapshot', { ...G, action: 'delete', name: 'before-upgrade' }],
      ['guest_disk', { ...G, action: 'move', disk: 'scsi0', storage: 'tank' }],
      ['guest_backup', { ...G, action: 'restore', backup: 'PBS:backup/vm/101/2026-10-17T02:00:00Z' }],
      ['guest_backup', { ...S, action: 'delete', backup: 'PBS:backup/vm/101/2026-10-17T02:00:00Z' }],
      ['storage_content', { ...S, action: 'delete', storage: 'local', volume: 'local:iso/old.iso' }],
      ['backup_job_set', { ...S, action: 'delete', job: 'backup-1' }],
      ['guest_migrate', { ...G, target: 'pve-01' }],
      ['server_command', { ...S, command: 'uptime', reason: 'Check' }],
    ];
    for (const [tool, args] of asks) expect(sensitiveReason(servers(), tool, args), tool).not.toBeNull();
    for (const tool of ['guest_delete', 'guest_template', 'server_power', 'guest_migrate', 'server_command'])
      expect(toolAlwaysAsks(servers(), tool), tool).toBe(true);
  });

  it('doesn’t ask for everyday work, even when a name or note says “delete”', () => {
    const plain: [string, Record<string, unknown>][] = [
      ['guest_power', { ...G, action: 'start' }],
      ['guest_power', { ...G, action: 'resume' }],
      ['guest_backup', { ...G, action: 'create' }],
      ['guest_backup', { ...G, action: 'create', notes: 'delete' }],
      ['guest_backup', { ...S, action: 'notes', backup: 'PBS:backup/vm/101/x', notes: 'restore' }],
      ['storage_content', EXAMPLES.storage_content as Record<string, unknown>],
      ['storage_content', { ...S, action: 'download', storage: 'local', content: 'iso', filename: 'delete' }],
      ['guest_snapshot', { ...G, action: 'create', name: 'restore' }],
      ['guest_disk', { ...G, action: 'resize', disk: 'scsi0', size: '+10G' }],
      ['backup_job_set', { ...S, action: 'run', job: 'backup-1' }],
      ['backup_job_set', { ...S, action: 'update', job: 'backup-1', comment: 'delete' }],
      ['task_stop', { ...S, task: 'UPID:pve-02:0001' }],
    ];
    for (const [tool, args] of plain) expect(sensitiveReason(servers(), tool, args), tool).toBeNull();
    for (const tool of ['guest_power', 'guest_backup', 'storage_content', 'backup_job_set'])
      expect(toolAlwaysAsks(servers(), tool), tool).toBe(false);
  });

  it('tests only the `action` argument in its rules (CT-354)', () => {
    const names = new Set(SERVERS_TOOLS.map((t) => t.name));
    for (const r of SERVERS_SENSITIVE) {
      expect(r.arg).toBe('action');
      for (const t of r.tools ?? []) expect(names.has(t), t).toBe(true);
    }
    // A rule without `arg` still looks at every string, nested ones too.
    const anywhere = {
      ...servers(),
      sensitive: [{ tools: ['guest_backup'], argValue: '^delete$', reason: 'x' }],
    };
    expect(sensitiveReason(anywhere, 'guest_backup', { ...G, action: 'create', notes: 'delete' })).toBe('x');
    expect(SensitiveRule.safeParse({ arg: 'not an arg', argValue: 'x', reason: 'x' }).success).toBe(false);
  });
});
