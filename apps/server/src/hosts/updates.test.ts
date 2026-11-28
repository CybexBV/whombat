/**
 * A server's operating-system updates on Whombat's side, the pure parts (server-updates.md SWU-01…SWU-14;
 * server-updates-server.md): the manage requests the two ops become and their titles, the report and the task mapped to
 * the contract, the packages an agent may name, the calls in words, the self-server question, the follow-up message,
 * the hub's refusals in SWU's words and the hint's way out. Words are checked by the facts they must carry.
 */
import { catalogEntry, HostServerDetail, HostTask } from '@whombat/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type CallServerInfo, callTier } from '../connections/call';
import { ConnectionArgumentError } from '../connections/request';
import { HostsError } from './client';
import { hostsErrorText, refusedBeforeActing } from './errors';
import { TaskFollow } from './follow';
import { toHostServerDetail, toHostTask } from './map';
import { manageCall, manageText, packagesDetail } from './routes';
import { noteSelfServers } from './self';
import { hintLink } from './sources';
import { memoryTaskStore } from './testing/task-store';
import { updatesSummary, waitingList } from './tools-updates';
import {
  checkedText,
  installedText,
  listWords,
  noteWaitingUpdates,
  packagesArg,
  reportAfterTask,
  restartWords,
  waitingUpdates,
} from './updates';
import {
  serversAskWords,
  serversDoneWords,
  serversNoteWords,
  serversTaskWords,
  taskOutcomeText,
} from './words';

const NOW = new Date('2026-10-19T10:00:00Z');

afterEach(() => noteSelfServers({ servers: [] }));

describe('the two ops as the hub’s routes', () => {
  it('Check posts an empty body; Install the names and always its confirmation', () => {
    expect(manageCall('pve-02', { op: 'packages.check', params: {} })).toEqual({
      method: 'POST',
      path: '/api/v1/servers/pve-02/packages/check',
      body: {},
    });
    expect(manageCall('pve-02', { op: 'packages.install', platform: 'host', params: {} })).toEqual({
      method: 'POST',
      path: '/api/v1/servers/pve-02/packages/install',
      body: { confirm: true },
    });
    expect(
      manageCall('web-01', {
        op: 'packages.install',
        params: { packages: ['nginx', 'openssl'] },
        confirm: false,
      }).body,
    ).toEqual({ packages: ['nginx', 'openssl'], confirm: true });
  });

  it('refuses a param the op doesn’t take, naming it', () => {
    expect(() => manageCall('pve-02', { op: 'packages.check', params: { packages: ['nginx'] } })).toThrow(
      /packages/,
    );
  });

  it('titles them for Done recently, with the packages an Install named', () => {
    expect(manageText('packages.install', 'pve-02', null)).toBe('Installed updates on pve-02');
    expect(manageText('packages.check', 'pve-02', null)).toBe('Checked pve-02 for updates');
    expect(packagesDetail(['nginx', 'openssl'])).toContain('nginx and openssl');
    expect(packagesDetail(undefined)).toBeNull();
  });
});

describe('the report and the task as the contract has them', () => {
  const raw = (system: Record<string, unknown>) => ({
    server: { id: 'pve-02', detail_view: 'proxmox' },
    system: {
      package_manager: 'apt',
      updates: 23,
      security_updates: 4,
      updates_checked_at: '2026-10-19T09:00:00Z',
      updates_error: null,
      reboot_required: false,
      reboot_reason: null,
      init_system: 'systemd',
      failed_count: 0,
      failed_units: [],
      time_synced: true,
      time_offset_ms: 1,
      time_source: 'chrony',
      oom_kills: 0,
      processes: 300,
      steal_pct: null,
      pressure: null,
      ...system,
    },
  });

  it('maps the running package task and the last result', () => {
    const d = toHostServerDetail(
      raw({
        package_task: { id: 'pkg:0123456789abcdef', op: 'install', started_at: '2026-10-19T09:58:00Z' },
        package_last: {
          op: 'check',
          status: 'failed',
          finished_at: '2026-10-19T09:00:00Z',
          installed: null,
          message: '',
          code: 'busy',
        },
      }),
      [],
      null,
      NOW,
    );
    expect(HostServerDetail.safeParse(d).error).toBeUndefined();
    expect(d.health?.system?.packageTask).toMatchObject({ id: 'pkg:0123456789abcdef', op: 'install' });
    // An empty message is none; a missing code is null.
    expect(d.health?.system?.packageLast).toMatchObject({ status: 'failed', message: null, code: 'busy' });
  });

  it('keeps an older hub’s report as it was, and an odd package part as none', () => {
    const old = toHostServerDetail(raw({}), [], null, NOW);
    expect(HostServerDetail.safeParse(old).error).toBeUndefined();
    expect(old.health?.system && 'packageTask' in old.health.system).toBe(false);
    const odd = toHostServerDetail(
      raw({ package_task: { id: 3 }, package_last: { op: 'x' } }),
      [],
      null,
      NOW,
    );
    expect(HostServerDetail.safeParse(odd).error).toBeUndefined();
    expect(odd.health?.system?.packageTask).toBeNull();
    expect(odd.health?.system?.packageLast).toBeNull();
  });

  it('maps a package task’s result and its code', () => {
    const t = toHostTask({
      id: 'pkg:0123456789abcdef',
      type: 'packages-install',
      started: '2026-10-19T09:58:00Z',
      ended: '2026-10-19T10:00:00Z',
      status: 'ok',
      cancellable: false,
      packages: { installed: 21, kept_back: ['zfsutils-linux'], warning: '' },
    });
    expect(HostTask.safeParse(t).error).toBeUndefined();
    expect(t.packages).toEqual({ installed: 21, keptBack: ['zfsutils-linux'], warning: null });
    const busy = toHostTask({ id: 'pkg:1', started: '2026-10-19T09:58:00Z', status: 'error', code: 'busy' });
    expect(busy.code).toBe('busy');
    expect(busy.packages).toBeUndefined();
  });
});

describe('the packages an agent names', () => {
  it('takes names, without repeats; none is everything', () => {
    expect(packagesArg(['nginx', ' openssl', 'nginx', 'libc6:amd64'])).toEqual([
      'nginx',
      'openssl',
      'libc6:amd64',
    ]);
    expect(packagesArg(undefined)).toBeNull();
    expect(packagesArg([])).toBeNull();
  });

  it('refuses what isn’t a package name, and more than 200', () => {
    expect(() => packagesArg(['nginx; rm -rf /'])).toThrow(ConnectionArgumentError);
    expect(() => packagesArg('nginx')).toThrow(ConnectionArgumentError);
    expect(() => packagesArg(Array.from({ length: 201 }, (_, i) => `p${i}`))).toThrow(/200/);
  });
});

describe('the calls in words', () => {
  it('asks with the count Whombat last read, or the packages named', () => {
    noteWaitingUpdates('PVE-02', 23, NOW.getTime());
    const ask = serversAskWords('server_update', { server: 'PVE-02', action: 'install' }, NOW);
    expect(ask).toMatch(/^install /);
    expect(ask).toContain('23 updates');
    expect(ask).toContain('PVE-02');
    const named = serversAskWords('server_update', {
      server: 'web-01',
      action: 'install',
      packages: ['nginx', 'openssl'],
    });
    expect(named).toContain('nginx and openssl');
    expect(named).toContain('web-01');
    const many = serversAskWords('server_update', {
      server: 'web-01',
      action: 'install',
      packages: ['a', 'b', 'c', 'd'],
    });
    expect(many).toContain('4 packages');
  });

  it('says “the waiting updates” when it doesn’t know how many, or the count is old', () => {
    noteWaitingUpdates('pve-03', 5, NOW.getTime() - 2 * 60 * 60 * 1000);
    expect(waitingUpdates('pve-03', NOW.getTime())).toBeNull();
    expect(serversAskWords('server_update', { server: 'pve-03', action: 'install' })).toContain(
      'the waiting updates',
    );
    expect(serversAskWords('server_update', { server: 'pve-03', action: 'check' })).toContain('check pve-03');
  });

  it('says it is installing after a yes, and what went wrong when it didn’t start', () => {
    noteWaitingUpdates('PVE-02', 23);
    const args = { server: 'PVE-02', action: 'install', reason: 'Security updates' };
    const done = serversDoneWords('server_update', args, { ok: true, isError: false, content: '{}' });
    expect(done).toMatch(/^Installing 23 updates on PVE-02/);
    const refused = serversDoneWords('server_update', args, {
      ok: true,
      isError: true,
      content: JSON.stringify({ error: 'Installing updates needs Full control on PVE-02.' }),
    });
    expect(refused).toContain('Full control');
  });

  it('adds a note before installing on the server this Whombat runs on, not before a check', () => {
    noteSelfServers({
      servers: [{ id: 'the-titan', hostname: 'the-titan', hosts_this_whombat: true }, { id: 'lab' }],
    });
    expect(serversNoteWords('server_update', { server: 'the-titan', action: 'install' })).toContain(
      'This Whombat',
    );
    expect(serversNoteWords('server_update', { server: 'the-titan', action: 'check' })).toBeNull();
    expect(serversNoteWords('server_update', { server: 'lab', action: 'install' })).toBeNull();
  });
});

describe('asking before installing (SWU-08)', () => {
  const servers = catalogEntry('whombat_servers');
  if (!servers) throw new Error('whombat_servers');
  const tool = { name: 'server_update', tier: 'can' as const, access: 'write' as const, origin: 'adapter' };
  const lab: CallServerInfo = { id: 'lab', name: 'lab', asksFirst: 'risky', hostsThisWhombat: false };
  const beast: CallServerInfo = {
    id: 'the-titan',
    name: 'The-Titan',
    asksFirst: 'never',
    hostsThisWhombat: true,
  };
  const install = { server: 'lab', action: 'install', reason: 'monthly' };
  const check = { server: 'lab', action: 'check', reason: 'monthly' };

  it('Install asks; a server set to Never doesn’t, but for the one this Whombat runs on', () => {
    expect(callTier(servers, tool, install, 'can', 'manage', lab)).toMatchObject({
      tier: 'ask',
      sensitive: true,
    });
    expect(callTier(servers, tool, install, 'can', 'manage', { ...lab, asksFirst: 'never' })).toMatchObject({
      tier: 'can',
      sensitive: false,
    });
    const self = callTier(servers, tool, { ...install, server: 'the-titan' }, 'can', 'manage', beast);
    expect(self).toMatchObject({ tier: 'ask', sensitive: true, askServer: null });
  });

  it('Check never asks', () => {
    expect(callTier(servers, tool, check, 'can', 'manage', lab).tier).toBe('can');
    expect(callTier(servers, tool, { ...check, server: 'the-titan' }, 'can', 'manage', beast).tier).toBe(
      'can',
    );
  });
});

describe('the message when it ends (SWU-08)', () => {
  it('says what was installed, what stays held back, a restart and a warning', () => {
    const kernel = {
      rebootRequired: true,
      rebootReason: 'Kernel 6.8.12-5-pve is installed, 6.8.12-4-pve runs',
    };
    const done = installedText('PVE-02', { installed: 23, keptBack: [], warning: null }, kernel);
    expect(done).toContain('PVE-02 is up to date');
    expect(done).toContain('23 updates installed');
    expect(done).toContain('restart for the new kernel');
    expect(done).not.toMatch(/pkg:|6\.8\.12/);
    const held = installedText('PVE-02', { installed: 21, keptBack: ['a', 'b'], warning: null }, null);
    expect(held).toContain('21 updates installed');
    expect(held).toMatch(/held back/);
    expect(held).toContain('a and b');
    expect(held).not.toContain('restart');
    const warned = installedText(
      'PVE-02',
      {
        installed: 1,
        keptBack: [],
        warning: 'The Proxmox enterprise repository refused (it needs a subscription)',
      },
      { rebootRequired: false, rebootReason: null },
    );
    expect(warned).toContain('1 update installed');
    expect(warned).toContain('enterprise repository');
    expect(installedText('web-01', { installed: 0, keptBack: [], warning: null }, null)).toContain(
      'already up to date',
    );
    expect(
      installedText('web-01', { installed: 2, keptBack: [], warning: null }, null, ['nginx', 'openssl']),
    ).toContain('nginx and openssl on web-01');
    expect(installedText('web-01', null, null)).toContain('web-01');
  });

  it('says what a check found', () => {
    expect(checkedText('PVE-02', { updates: 23, securityUpdates: 4 })).toMatch(
      /23 updates waiting, 4 for security/,
    );
    expect(checkedText('PVE-02', { updates: 0, securityUpdates: 0 })).toContain('up to date');
    expect(checkedText('PVE-02', null)).toBeNull();
  });

  it('names what a restart is for', () => {
    expect(restartWords('Kernel 6.8.12-5-pve is installed, 6.8.12-4-pve runs')).toContain('new kernel');
    expect(restartWords('Updated packages need a reboot: libc6, dbus')).toContain('libc6 and dbus');
    expect(restartWords('Updated packages need a reboot: a, b, c and 2 more')).toContain('2 more');
    expect(restartWords(null)).toContain('restart');
    expect(listWords(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
  });

  it('knows a report made after the task from one before it', () => {
    const since = Date.parse('2026-10-19T09:50:00Z');
    const ended = Date.parse('2026-10-19T10:00:00Z');
    const last = { op: 'install' as const, status: 'ok' as const, installed: 3, message: null, code: null };
    expect(
      reportAfterTask(
        {
          updatesCheckedAt: '2026-10-19T10:00:01Z',
          packageLast: { ...last, finishedAt: '2026-10-19T10:00:00Z' },
        },
        since,
        ended,
      ),
    ).toBe(true);
    // The periodic report from before the end, or one still running a task.
    expect(
      reportAfterTask(
        {
          updatesCheckedAt: '2026-10-19T09:55:00Z',
          packageLast: { ...last, finishedAt: '2026-10-19T10:00:00Z' },
        },
        since,
        ended,
      ),
    ).toBe(false);
    expect(
      reportAfterTask(
        {
          updatesCheckedAt: '2026-10-19T10:00:01Z',
          packageTask: { id: 'pkg:1', op: 'install', startedAt: '2026-10-19T10:00:00Z' },
        },
        since,
        ended,
      ),
    ).toBe(false);
    // An older hub without the last result: after the end was heard.
    expect(reportAfterTask({ updatesCheckedAt: '2026-10-19T10:00:02Z' }, since, ended)).toBe(true);
  });

  it('tells the whole message for an Install, the code’s words for an early end, the reason for a failure', async () => {
    const store = memoryTaskStore();
    const follow = new TaskFollow({
      store,
      enrich: async () => ({
        text: 'PVE-02 is up to date: 23 updates installed. It needs a restart for the new kernel.',
        rebootRequired: true,
        installed: 23,
      }),
    });
    const words = serversTaskWords(
      'server_update',
      { action: 'install' },
      { server: 'pve-02', label: 'PVE-02' },
    );
    expect(words?.after).toBe('updates.install');
    const task = (taskId: string) => ({
      taskId,
      serverId: 'pve-02',
      serverName: 'PVE-02',
      burrowId: 'b',
      conversationId: 'c',
      threadRootId: null,
      agentId: 'a',
      personId: null,
      words: words as NonNullable<typeof words>,
    });
    await follow.remember(task('pkg:1'));
    await follow.finished('pve-02', 'pkg:1', 'ok', 'OK');
    await follow.remember(task('pkg:2'));
    await follow.finished('pve-02', 'pkg:2', 'error', 'E: Could not get lock', 'busy');
    await follow.remember(task('pkg:3'));
    await follow.finished('pve-02', 'pkg:3', 'error', 'E: Unable to fetch some archives');
    // Ended before the call remembered it (the answer and the event race): still told, with its code.
    await follow.finished('pve-02', 'pkg:4', 'error', '', 'timeout');
    await follow.remember(task('pkg:4'));
    const posted = store.told.map((t) => t.end.words);
    expect(posted[0]).toContain('23 updates installed');
    // The restart the report asks for, and what it installed, go with the end (the wake and Done recently, TF-12, TF-13).
    expect(store.told[0]?.end).toMatchObject({ state: 'ok', rebootRequired: true, installed: 23 });
    expect(posted[1]).toContain('Another program is installing packages on PVE-02');
    // The card's words say how many when Whombat read them (TF-10).
    expect(posted[2]).toMatch(/^Installing (23 )?updates on PVE-02 didn’t work/);
    expect(posted[2]).toContain('Unable to fetch some archives');
    expect(store.told[2]?.end).toMatchObject({ state: 'error', rebootRequired: false });
    expect(posted[3]).toContain('two hours');
    expect(posted.join('\n')).not.toContain('pkg:');
  });

  it('falls back to plain words when the report can’t be read', () => {
    const w = serversTaskWords('server_update', { action: 'check' }, { server: 'pve-02' });
    expect(taskOutcomeText(w as NonNullable<typeof w>, 'ok', 'OK')).toContain('pve-02');
    expect(taskOutcomeText(w as NonNullable<typeof w>, 'error', '', 'timeout')).toContain('ten minutes');
  });
});

describe('the hub’s refusals in SWU’s words', () => {
  const err = (status: number, code: string, detail?: string) => new HostsError(status, code, detail ?? null);
  const install = { server: 'PVE-02', op: 'packages.install' };

  it('Full control, a task already running, the lock, an old agent', () => {
    expect(hostsErrorText(err(403, 'manage_disabled', 'Managing guests is turned off'), install)).toMatch(
      /Installing updates needs Full control on PVE-02/,
    );
    expect(hostsErrorText(err(403, 'manage_disabled'), { server: 'PVE-02', op: 'packages.check' })).toMatch(
      /^Checking/,
    );
    expect(hostsErrorText(err(409, 'busy', 'A package task is already running'), install)).toContain(
      'already',
    );
    expect(hostsErrorText(err(409, 'busy', 'the package lock is still held'), install)).toContain(
      'Another program is installing packages on PVE-02',
    );
    expect(hostsErrorText(err(501, 'unsupported', 'unknown operation'), install)).toBe(
      'Update Whombat’s helper on PVE-02 first.',
    );
    expect(hostsErrorText(err(501, 'unsupported'), install)).toContain('Update Whombat’s helper');
  });

  it('an old agent’s 501 is a refusal before acting, not an unknown outcome', () => {
    expect(refusedBeforeActing(err(501, 'unsupported', 'unknown operation'))).toBe(true);
    expect(refusedBeforeActing(err(409, 'busy'))).toBe(true);
    expect(refusedBeforeActing(err(502, 'agent_error'))).toBe(false);
    expect(refusedBeforeActing(err(504, 'timeout'))).toBe(false);
    expect(refusedBeforeActing(new Error('x'))).toBe(false);
  });

  it('keeps the agent’s own sentence (TrueNAS, NixOS, Unraid), and the general words for other ops', () => {
    expect(
      hostsErrorText(
        err(403, 'not_allowed', 'TrueNAS installs its updates itself, on its Update page.'),
        install,
      ),
    ).toBe('TrueNAS installs its updates itself, on its Update page.');
    expect(
      hostsErrorText(err(501, 'unsupported', 'NixOS is updated by its configuration'), install),
    ).toContain('NixOS');
    expect(hostsErrorText(err(403, 'manage_disabled'), { server: 'PVE-02' })).not.toContain('updates');
  });
});

describe('the waiting packages for an agent', () => {
  it('lists security first, then by name, at most 500', () => {
    const items = [
      { name: 'zlib', new: '2' },
      { name: 'curl', new: '8', current: '7', source: 'debian' },
      { name: 'openssl', new: '3.1', security: true },
    ];
    const { packages, more } = waitingList(items);
    expect(packages.map((p) => p.name)).toEqual(['openssl', 'curl', 'zlib']);
    expect(packages[1]).toMatchObject({ now: '7', new: '8', source: 'debian' });
    expect(more).toBe(0);
    const big = waitingList(Array.from({ length: 520 }, (_, i) => ({ name: `p${i}`, new: '1' })));
    expect(big.packages).toHaveLength(500);
    expect(big.more).toBe(20);
  });
});

describe('what the switches say about an install (task-feedback.md TF-03)', () => {
  it('leaves the last word to the install when Full control looks off', () => {
    const off = updatesSummary('PVE-02', { updates: 3 }, false);
    expect(off.canInstall).toBe(false);
    // The install is checked live by the hub: the agent tries it rather than tell the person it can't.
    expect(String(off.next)).toContain('server_update install');
    expect(String(off.next)).not.toMatch(/needs Full control/);
    expect(String(updatesSummary('PVE-02', { updates: 3 }, true).next)).toContain('server_update install');
  });

  it('points nowhere near an install on a Windows PC, where the person installs them', () => {
    const pc = updatesSummary('OFFICE-PC', { updates: 3 }, false, true);
    expect(pc.canInstall).toBe(false);
    expect(pc.next).toBeUndefined();
    expect(JSON.stringify(pc)).not.toContain('server_update');
  });
});

describe('the waiting updates hint’s way out (SWU-13)', () => {
  it('opens the System tab and says to install them there', () => {
    const link = hintLink(
      { serverId: 'pve-02', kind: 'system.updates', detail: '4 security updates · apt', section: 'system' },
      [],
    );
    expect(link.href).toContain('tab=system');
    expect(link.wayOut).toContain('System tab');
  });
});
