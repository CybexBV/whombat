/** A server's updates on the web and the phone (Whombat server-updates.md SWU-07, SWU-10…SWU-14; AP-2860…). */
import { describe, expect, it } from 'vitest';
import { serverDashboard } from './dashboard';
import { dashboardFixtures } from './dashboard-fixtures';
import {
  isRebootHint,
  isUpdatesHint,
  packageOpOf,
  packageResultText,
  packageRows,
  packageTaskOutcomeText,
  type ServerUpdatesInput,
  serverUpdatesView,
  UPDATES_WORDS,
  type UpdatesSystem,
} from './updates';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;

const sys = (over: Partial<UpdatesSystem> = {}): UpdatesSystem => ({
  packageManager: 'apt',
  updates: 23,
  securityUpdates: 5,
  updatesCheckedAt: new Date(NOW - 3 * 3600_000).toISOString(),
  updatesError: null,
  rebootRequired: false,
  rebootReason: null,
  packageTask: null,
  packageLast: null,
  ...over,
});

const input = (over: Partial<ServerUpdatesInput> = {}): ServerUpdatesInput => ({
  server: 'pve-02',
  system: sys(),
  remoteControl: { manage: true, hostPower: true },
  unraid: false,
  connected: true,
  now: NOW,
  ...over,
});

describe('the Updates line and its buttons', () => {
  it('offers Install updates and Check now with Full control while updates wait', () => {
    const v = serverUpdatesView(input());
    expect(v.available).toBe(true);
    expect(v.line.text).toMatch(/^23 updates waiting, 5 for security/);
    expect(v.line.tone).toBe('warn');
    expect(v.line.checked).toMatch(/^checked 3/);
    expect([v.may, v.install, v.check, v.note, v.count]).toEqual([true, true, true, null, 23]);
  });

  it('offers only Check now when the server is up to date', () => {
    const v = serverUpdatesView(input({ system: sys({ updates: 0, securityUpdates: 0 }) }));
    expect(v.line.text).toBe(UPDATES_WORDS.upToDate);
    expect([v.install, v.check]).toEqual([false, true]);
  });

  it('keeps Check now when the last read failed, so it can be tried again', () => {
    const v = serverUpdatesView(input({ system: sys({ updates: null, updatesError: 'apt is locked' }) }));
    expect(v.line.text).toContain('apt is locked');
    expect([v.install, v.check]).toEqual([false, true]);
  });

  it('says SWU-07’s sentence instead when Full control is off', () => {
    const v = serverUpdatesView(input({ remoteControl: { manage: false, hostPower: true } }));
    expect([v.may, v.install, v.check]).toEqual([false, false, false]);
    expect(v.note).toContain('Full control on pve-02');
  });

  it('adds nothing on Unraid, or where the agent reads no updates', () => {
    for (const v of [
      serverUpdatesView(input({ unraid: true })),
      serverUpdatesView(input({ system: sys({ updates: null, packageManager: null }) })),
    ]) {
      expect(v.available).toBe(false);
      expect([v.install, v.check, v.note, v.running, v.result, v.restart.button]).toEqual([
        false,
        false,
        null,
        null,
        null,
        false,
      ]);
    }
    expect(serverUpdatesView(input({ unraid: true })).line.text).toMatch(/^23 updates waiting/);
  });

  it('offers nothing while the agent is away', () => {
    const v = serverUpdatesView(input({ connected: false, system: sys({ rebootRequired: true }) }));
    expect([v.install, v.check, v.restart.button]).toEqual([false, false, false]);
  });
});

describe('a running package task (also one started elsewhere)', () => {
  it('says what runs, with its task for the log, and hides the buttons', () => {
    const v = serverUpdatesView(
      input({
        system: sys({
          packageTask: {
            id: 'pkg:00000000000000a1',
            op: 'install',
            startedAt: new Date(NOW - MIN).toISOString(),
          },
          packageLast: {
            op: 'install',
            status: 'ok',
            finishedAt: new Date(NOW - DAY).toISOString(),
            installed: 3,
            message: null,
            code: null,
          },
        }),
      }),
    );
    expect(v.line.text).toBe(UPDATES_WORDS.running.install);
    expect(v.running).toEqual({ taskId: 'pkg:00000000000000a1', op: 'install', text: v.line.text });
    expect([v.install, v.check, v.result]).toEqual([false, false, null]);
  });

  it('says Checking for a check', () => {
    const v = serverUpdatesView(
      input({
        system: sys({ packageTask: { id: 'pkg:1', op: 'check', startedAt: new Date(NOW).toISOString() } }),
      }),
    );
    expect(v.line.text).toBe(UPDATES_WORDS.running.check);
  });
});

describe('the last result', () => {
  const last = (over: Partial<NonNullable<UpdatesSystem['packageLast']>> = {}) =>
    serverUpdatesView(
      input({
        system: sys({
          packageLast: {
            op: 'install',
            status: 'ok',
            finishedAt: new Date(NOW - 12 * MIN).toISOString(),
            installed: 23,
            message: null,
            code: null,
            ...over,
          },
        }),
      }),
    ).result;

  it('says how many were installed, with when', () => {
    expect(last()).toMatchObject({ text: 'Installed 23 updates.', tone: 'ok' });
    expect(last()?.when).toMatch(/^12/);
    expect(last({ installed: 1 })?.text).toBe('Installed 1 update.');
    expect(last({ installed: 0 })?.text).toBe('Nothing to install.');
  });

  it('keeps a note of a good install (the enterprise repository, SWU-06)', () => {
    const r = last({ message: 'The Proxmox enterprise repository refused (it needs a subscription); …' });
    expect(r?.text).toMatch(/^Installed 23 updates\. The Proxmox enterprise repository/);
    expect(r?.tone).toBe('warn');
  });

  it('says why it stopped', () => {
    expect(last({ status: 'failed', message: 'E: Unable to fetch some archives.\nmore' })).toMatchObject({
      text: 'Installing updates stopped: E: Unable to fetch some archives.',
      tone: 'bad',
    });
    expect(last({ status: 'failed', code: 'busy', message: null })?.text).toContain(
      'installing packages on pve-02 right now',
    );
    expect(last({ status: 'failed', code: 'timeout', message: null })?.text).toContain('2 hours');
    expect(last({ op: 'check', status: 'failed', code: 'timeout', message: null })?.text).toMatch(
      /^Checking for updates stopped: .*10 minutes/,
    );
  });

  it('leaves a good check to the line’s “checked”, and a result older than a week out', () => {
    expect(last({ op: 'check', installed: null })).toBeNull();
    expect(last({ finishedAt: new Date(NOW - 8 * DAY).toISOString() })).toBeNull();
  });

  it('words an ended task’s packages in its dialog', () => {
    expect(packageTaskOutcomeText('install', { installed: 4, keptBack: [], warning: null }, 'pve-02')).toBe(
      'Installed 4 updates.',
    );
    const kept = packageTaskOutcomeText(
      'install',
      { installed: 2, keptBack: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], warning: null },
      'pve-02',
    );
    expect(kept).toContain('Kept back: a, b, c, d, e and 2 more');
    expect(
      packageTaskOutcomeText('check', { installed: 0, keptBack: [], warning: null }, 'pve-02'),
    ).toBeNull();
    expect(packageTaskOutcomeText('install', null, 'pve-02')).toBeNull();
    expect(
      packageResultText({ op: 'install', status: 'ok', installed: null, message: 'OK', code: null }, 'x'),
    ).toBe('Installed the updates.');
  });

  it('knows a package op by its name', () => {
    expect([packageOpOf('packages.install'), packageOpOf('check'), packageOpOf('backup.create')]).toEqual([
      'install',
      'check',
      null,
    ]);
  });
});

describe('the Restart line', () => {
  it('offers Restart now when a restart is needed and the server’s power is on', () => {
    const v = serverUpdatesView(
      input({ system: sys({ rebootRequired: true, rebootReason: 'a new kernel' }) }),
    );
    expect(v.restart).toEqual({ text: 'Needed: a new kernel', tone: 'warn', button: true });
    const off = serverUpdatesView(
      input({ system: sys({ rebootRequired: true }), remoteControl: { manage: true, hostPower: false } }),
    );
    expect(off.restart.button).toBe(false);
    expect(serverUpdatesView(input()).restart).toEqual({ text: 'Not needed', tone: 'ok', button: false });
  });
});

describe('the waiting packages', () => {
  it('lists security first, then by name, with now → new', () => {
    const rows = packageRows([
      { name: 'zfsutils-linux', current: '2.3.4-pve1', new: '2.3.4-pve2' },
      { name: 'openssl', current: '3.5.1-1', new: '3.5.1-1+deb13u1', security: true },
      { name: 'curl', new: '8.14.1-2' },
    ]);
    expect(rows.map((r) => [r.name, r.security, r.versions])).toEqual([
      ['openssl', true, '3.5.1-1 → 3.5.1-1+deb13u1'],
      ['curl', false, '8.14.1-2'],
      ['zfsutils-linux', false, '2.3.4-pve1 → 2.3.4-pve2'],
    ]);
    expect(rows[0]?.label).toContain('security');
  });
});

describe('the updates hint’s way out (SWU-13)', () => {
  const fx = dashboardFixtures(NOW)['pve-02'];
  const look = (updates?: 'web' | 'phone') =>
    serverDashboard({ detail: fx.detail, range: '24h', now: NOW, ...(updates ? { updates } : {}) })
      .flatMap((p) => (p.kind === 'notices' && p.id === 'look' ? p.items : []))
      .find((i) => i.id.includes('system.updates'));

  it('opens the System tab on the web and the Updates screen on the phone', () => {
    expect(isUpdatesHint({ kind: 'system.updates' })).toBe(true);
    expect(look()?.link).toMatchObject({ kind: 'tab', tab: 'system', label: 'See details' });
    expect(look('web')?.link).toEqual({ kind: 'tab', tab: 'system', label: UPDATES_WORDS.wayOut.web });
    expect(look('phone')?.link).toEqual({
      kind: 'href',
      label: UPDATES_WORDS.wayOut.phone,
      href: '/things/server%3Apve-02?tab=updates',
    });
    expect(UPDATES_WORDS.wayOut.phone.length).toBeLessThanOrEqual(12);
  });

  it('opens Updates from the restart hint on the phone only (AP-2887)', () => {
    const reboot = {
      serverId: 'pve-02',
      kind: 'system.reboot',
      severity: 'info' as const,
      entity: 'host',
      title: 'Reboot required',
      detail: 'a new kernel',
      section: 'system',
    };
    const detail = { ...fx.detail, hints: [...fx.detail.hints, reboot] };
    const link = (updates?: 'web' | 'phone') =>
      serverDashboard({ detail, range: '24h', now: NOW, ...(updates ? { updates } : {}) })
        .flatMap((p) => (p.kind === 'notices' && p.id === 'look' ? p.items : []))
        .find((i) => i.id.includes('system.reboot'))?.link;
    expect(isRebootHint(reboot)).toBe(true);
    expect(link('phone')).toMatchObject({ kind: 'href', href: '/things/server%3Apve-02?tab=updates' });
    expect(link('web')).toMatchObject({ kind: 'tab', tab: 'system', label: 'See details' });
  });
});
