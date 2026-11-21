/**
 * Contracts 0.98.0, a server's operating-system updates (Whombat server-updates.md SWU-01…SWU-15, CT-500…CT-506): the
 * host's package ops and their task, the server's report, the Servers tools and the asking.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { api } from '../contracts/index.js';
import {
  type CatalogEntry,
  catalogEntry,
  SERVERS_SENSITIVE,
  SERVERS_TOOLS,
  sensitiveReason,
  toolAlwaysAsks,
} from './connections-catalog.js';
import {
  HOST_ASKS_FIRST_WORDS,
  HOST_MANAGE_DESTRUCTIVE_OPS,
  HOST_MANAGE_OPS,
  HOST_PACKAGE_MANAGE_OPS,
  HOST_PACKAGE_NAME_PATTERN,
  HOST_PACKAGE_TASK_CODES,
  HOST_PACKAGES_MAX,
  HostManagePlatform,
  HostManageRequest,
  HostSystem,
  HostTask,
  isHostPackageManageOp,
  serverAsksApply,
} from './hosts.js';

const servers = (): CatalogEntry => {
  const e = catalogEntry('whombat_servers');
  if (!e) throw new Error('no Servers entry');
  return e;
};
const tool = (name: string) => SERVERS_TOOLS.find((t) => t.name === name);
const schema = (name: string) => z.fromJSONSchema(tool(name)?.inputSchema as never);

const SYSTEM = {
  packageManager: 'apt',
  updates: 23,
  securityUpdates: 4,
  updatesCheckedAt: '2026-10-19T08:00:00Z',
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
  processes: 312,
  stealPct: null,
  pressure: null,
};

describe('the host’s package ops (CT-500)', () => {
  it('appends Check and Install to the manage ops, on platform host', () => {
    expect(HOST_MANAGE_OPS.slice(-2)).toEqual(['packages.check', 'packages.install']);
    expect(HOST_PACKAGE_MANAGE_OPS).toEqual(['packages.check', 'packages.install']);
    expect(HostManagePlatform.options.at(-1)).toBe('host');
    expect(isHostPackageManageOp('packages.install')).toBe(true);
    expect(isHostPackageManageOp('plugin.update')).toBe(false);
    // Installing asks like updating a plugin or a container; checking changes nothing.
    expect(HOST_MANAGE_DESTRUCTIVE_OPS).toContain('packages.install');
    expect(HOST_MANAGE_DESTRUCTIVE_OPS).not.toContain('packages.check');
  });

  it('takes Check and Install on the host, with or without the platform', () => {
    expect(HostManageRequest.parse({ op: 'packages.check', platform: 'host' }).params).toEqual({});
    expect(HostManageRequest.safeParse({ op: 'packages.check' }).success).toBe(true);
    const named = HostManageRequest.parse({
      op: 'packages.install',
      platform: 'host',
      params: { packages: ['nginx', 'openssl:amd64', 'libstdc++6', 'linux-image-6.1.0-26-amd64', 'g++'] },
    });
    expect(named.params.packages).toHaveLength(5);
    expect(HostManageRequest.safeParse({ op: 'packages.install', platform: 'host' }).success).toBe(true);
  });

  it('keeps the host platform to the package ops and their tasks', () => {
    const refused = (req: unknown, path: string) => {
      const r = HostManageRequest.safeParse(req);
      expect(r.success, JSON.stringify(req)).toBe(false);
      expect(r.error?.issues.map((i) => i.path.join('.'))).toContain(path);
    };
    refused({ op: 'config.set', platform: 'host', guestId: 'pve:101' }, 'platform');
    refused({ op: 'packages.install', platform: 'pve' }, 'platform');
    refused({ op: 'packages.install', guestId: 'pve:101' }, 'guestId');
    refused({ op: 'packages.check', params: { packages: ['nginx'] } }, 'params.packages');
    // Stopping a Check goes through `task.stop` on the host.
    expect(
      HostManageRequest.safeParse({
        op: 'task.stop',
        platform: 'host',
        params: { task: 'pkg:0123456789abcdef' },
      }).success,
    ).toBe(true);
    expect(api.hosts.getTask.query?.parse({ platform: 'host', logStart: '40' })).toEqual({
      platform: 'host',
      logStart: 40,
    });
  });

  it('takes only package names, 1 to 200 of them', () => {
    const install = (packages: unknown) =>
      HostManageRequest.safeParse({ op: 'packages.install', platform: 'host', params: { packages } }).success;
    for (const bad of ['-y', '', 'a b', 'nginx;reboot', '$(id)', 'x'.repeat(129)]) {
      expect(HOST_PACKAGE_NAME_PATTERN.test(bad), bad).toBe(false);
      expect(install([bad]), bad).toBe(false);
    }
    expect(install([])).toBe(false);
    expect(install('nginx')).toBe(false);
    expect(install(Array.from({ length: HOST_PACKAGES_MAX }, (_, i) => `pkg${i}`))).toBe(true);
    expect(install(Array.from({ length: HOST_PACKAGES_MAX + 1 }, (_, i) => `pkg${i}`))).toBe(false);
  });
});

describe('the package task and the server’s report (CT-501, CT-502)', () => {
  it('parses an older hub’s system without the package fields', () => {
    const system = HostSystem.parse(SYSTEM);
    expect(system.packageTask).toBeUndefined();
    expect(system.packageLast).toBeUndefined();
    expect(HostSystem.parse({ ...SYSTEM, packageTask: null, packageLast: null }).packageTask).toBeNull();
  });

  it('carries the running task and how the last one ended', () => {
    const system = HostSystem.parse({
      ...SYSTEM,
      packageTask: { id: 'pkg:0123456789abcdef', op: 'install', startedAt: '2026-10-19T22:00:00Z' },
      packageLast: {
        op: 'check',
        status: 'failed',
        finishedAt: '2026-10-19T21:00:00Z',
        installed: null,
        message: 'Another program is installing packages right now.',
        code: 'busy',
      },
    });
    expect(system.packageTask?.op).toBe('install');
    expect(system.packageLast?.code).toBe('busy');
    expect(HOST_PACKAGE_TASK_CODES).toEqual(['busy', 'timeout']);
    // `code` is there, null when the task ran.
    expect(
      HostSystem.safeParse({
        ...SYSTEM,
        packageLast: {
          op: 'install',
          status: 'ok',
          finishedAt: '2026-10-19T21:00:00Z',
          installed: 23,
          message: null,
        },
      }).success,
    ).toBe(false);
    expect(
      HostSystem.safeParse({
        ...SYSTEM,
        packageTask: { id: 'pkg:1', op: 'upgrade', startedAt: '2026-10-19T22:00:00Z' },
      }).success,
    ).toBe(false);
  });

  it('gives an ended package task its counts, kept-back packages, warning and code', () => {
    const task = HostTask.parse({
      id: 'pkg:0123456789abcdef',
      type: 'packages.install',
      platform: 'host',
      started: '2026-10-19T22:00:00Z',
      ended: '2026-10-19T22:04:00Z',
      status: 'ok',
      log: ['Setting up nginx (1.22.1-9+deb12u3) ...'],
      logNext: 1,
      cancellable: false,
      packages: { installed: 23, keptBack: ['proxmox-ve'], warning: null },
    });
    expect(task.packages?.keptBack).toEqual(['proxmox-ve']);
    expect(task.code).toBeUndefined();
    const busy = HostTask.parse({
      id: 'pkg:fedcba9876543210',
      type: 'packages.check',
      started: '2026-10-19T22:00:00Z',
      status: 'error',
      code: 'busy',
    });
    expect(busy.code).toBe('busy');
    expect(
      HostTask.safeParse({ ...busy, packages: { installed: -1, keptBack: [], warning: null } }).success,
    ).toBe(false);
  });
});

describe('the Servers tools for updates (CT-505)', () => {
  it('reads with server_updates and changes with server_update, before server_add', () => {
    const names = SERVERS_TOOLS.map((t) => t.name);
    expect(names.slice(-3)).toEqual(['server_updates', 'server_update', 'server_add']);
    expect(servers().tools.map((t) => t.name)).toEqual(names);
    expect(tool('server_updates')?.access).toBe('read');
    expect(tool('server_update')?.access).toBe('write');
    expect(tool('server_update')?.sensitive).toBeUndefined();
    for (const t of [tool('server_updates'), tool('server_update')])
      expect(`${t?.title} ${t?.description} ${JSON.stringify(t?.inputSchema)}`).not.toMatch(/'/);
    expect(tool('server_update')?.description).toContain('unless the server is set not to ask');
  });

  it('takes a call as a model would make it', () => {
    expect(schema('server_updates').safeParse({ server: 'pve-02' }).success).toBe(true);
    expect(schema('server_updates').safeParse({ server: 'pve-02', all: true }).success).toBe(false);
    const update = schema('server_update');
    const S = { server: 'pve-02', reason: 'Security updates are waiting' };
    expect(update.safeParse({ ...S, action: 'check' }).success).toBe(true);
    expect(update.safeParse({ ...S, action: 'install' }).success).toBe(true);
    expect(update.safeParse({ ...S, action: 'install', packages: ['nginx', 'openssl'] }).success).toBe(true);
    expect(update.safeParse({ ...S, action: 'upgrade' }).success).toBe(false);
    expect(update.safeParse({ ...S, action: 'install', packages: ['nginx; reboot'] }).success).toBe(false);
    expect(update.safeParse({ ...S, action: 'install', packages: [] }).success).toBe(false);
    expect(update.safeParse({ server: 'pve-02', action: 'install' }).success).toBe(false);
  });

  it('asks before installing, never before checking', () => {
    const S = { server: 'pve-02', reason: 'x' };
    expect(sensitiveReason(servers(), 'server_update', { ...S, action: 'install' })).toBe(
      'Installing updates always asks',
    );
    expect(
      sensitiveReason(servers(), 'server_update', { ...S, action: 'install', packages: ['nginx'] }),
    ).not.toBeNull();
    expect(sensitiveReason(servers(), 'server_update', { ...S, action: 'check' })).toBeNull();
    expect(sensitiveReason(servers(), 'server_updates', { server: 'pve-02' })).toBeNull();
    expect(toolAlwaysAsks(servers(), 'server_update')).toBe(false);
    expect(SERVERS_SENSITIVE.filter((r) => r.tools?.includes('server_update'))).toHaveLength(1);
  });

  it('tells the assistant how, within the guide’s 1 500 characters', () => {
    const guide = servers().guide;
    expect(guide.length).toBeLessThanOrEqual(1500);
    for (const fact of [
      'server_updates',
      'server_update',
      'server_power',
      'one node at a time',
      'major release',
    ])
      expect(guide).toContain(fact);
  });
});

describe('asking about updates (CT-504, SWU-08, SWU-09)', () => {
  it('always asks before installing on the server this Whombat runs on', () => {
    expect(serverAsksApply('server_update', { asksFirst: 'never', hostsThisWhombat: true })).toBe(true);
    expect(serverAsksApply('server_update', { asksFirst: 'never' })).toBe(false);
    expect(serverAsksApply('server_update', { asksFirst: 'risky' })).toBe(true);
    expect(serverAsksApply('server_update', { hostsThisWhombat: true })).toBe(true);
    expect(serverAsksApply('server_command', { asksFirst: 'never', hostsThisWhombat: true })).toBe(false);
  });

  it('names updates in the words', () => {
    expect(HOST_ASKS_FIRST_WORDS.hint.risky).toContain('updates');
    expect(HOST_ASKS_FIRST_WORDS.selfNote('PVE-02')).toContain('updating PVE-02');
    expect(HOST_ASKS_FIRST_WORDS.confirmBody('PVE-02')).toContain('install updates');
  });
});
