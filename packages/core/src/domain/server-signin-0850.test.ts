import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { api } from '../contracts/index.js';
import { REALTIME_EVENT_TOPICS, RealtimeEvent } from '../contracts/realtime.js';
import {
  type CatalogEntry,
  catalogEntry,
  SERVERS_TOOLS,
  sensitiveReason,
  toolAlwaysAsks,
} from './connections-catalog.js';
import { GUIDE_TOPIC_LABELS, GUIDE_TOPICS, guideCardLabel, STARTABLE_GUIDE_TOPICS } from './guides.js';
import {
  HOST_CONTROL_LEVEL_DEFAULT,
  HOST_CONTROL_LEVEL_SWITCHES,
  HOST_CONTROL_LEVEL_WORDS,
  HOST_CONTROL_LEVELS,
  HOST_INSTALL_DETAIL_MAX,
  HostControlLevel,
  HostCreateEnrollmentBody,
  HostEnrollment,
  HostInstall,
  HostInstallBody,
  HostInstallErrorCode,
  HostInstallState,
  HostPendingEnrollment,
  HostRemoteToggles,
  hostInstallErrorText,
  parseHostInstallAddress,
} from './hosts.js';

const T = '2026-10-18T09:00:00.000Z';

/** The job of the approved mockup: pve-03 signed in, installed, waiting for its first report (SI-02). */
const JOB = {
  id: 'inst_q3Vx9LpA0dZk',
  address: '10.100.0.14',
  username: 'root',
  control: 'full',
  state: 'waiting',
  hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:q3VxkY0n1bQ8mH2cZr5uWj7tLs9dEfGhT8w' },
  hostKeyNew: true,
  serverId: 'pve-03',
  serverName: 'pve-03',
  system: 'Proxmox VE 9.0 · Debian GNU/Linux 13 (trixie) · amd64',
  already: false,
  keptKey: false,
  error: null,
  detail: null,
  startedAt: T,
  updatedAt: T,
  finishedAt: null,
};

const servers = (): CatalogEntry => {
  const e = catalogEntry('whombat_servers');
  if (!e) throw new Error('no Servers entry');
  return e;
};
const tool = (name: string) => SERVERS_TOOLS.find((t) => t.name === name);

describe('control levels (CT-373, 0.85.0)', () => {
  it('has three levels, full by default, each with exact switches', () => {
    expect(HostControlLevel.options).toEqual(['watch', 'operate', 'full']);
    expect(HOST_CONTROL_LEVELS).toEqual(['watch', 'operate', 'full']);
    expect(HOST_CONTROL_LEVEL_DEFAULT).toBe('full');
    for (const level of HOST_CONTROL_LEVELS) {
      const switches = HOST_CONTROL_LEVEL_SWITCHES[level];
      expect(HostRemoteToggles.parse(switches), level).toEqual(switches);
      expect(Object.keys(switches).sort(), level).toEqual(Object.keys(HostRemoteToggles.shape).sort());
      // Every level runs read-only checks.
      expect(switches.diagnose, level).toBe(true);
    }
    const on = (level: HostControlLevel) =>
      Object.entries(HOST_CONTROL_LEVEL_SWITCHES[level])
        .filter(([, v]) => v)
        .map(([k]) => k)
        .sort();
    expect(on('watch')).toEqual(['diagnose']);
    expect(on('operate')).toEqual(['console', 'diagnose', 'power']);
    expect(on('full')).toEqual(['console', 'diagnose', 'hostPower', 'hostShell', 'manage', 'power']);
  });

  it('names each level in the mockup’s words', () => {
    expect(HOST_CONTROL_LEVELS.map((l) => HOST_CONTROL_LEVEL_WORDS[l].title)).toEqual([
      'Watch only',
      'Restart and consoles',
      'Full control',
    ]);
    expect(HOST_CONTROL_LEVEL_WORDS.watch.line).toBe(
      'Whombat sees how it’s doing and runs read-only checks.',
    );
    for (const level of HOST_CONTROL_LEVELS) expect(HOST_CONTROL_LEVEL_WORDS[level].line).not.toMatch(/'/);
  });
});

describe('pre-approved enrollments (CT-374, 0.85.0)', () => {
  it('keeps an empty POST valid and takes the level and a name', () => {
    const body = api.hosts.createEnrollment.body;
    expect(body.safeParse(undefined).success).toBe(true);
    expect(body.parse({})).toEqual({});
    expect(body.parse({ control: 'operate', name: 'pve-03' })).toEqual({
      control: 'operate',
      name: 'pve-03',
    });
    expect(HostCreateEnrollmentBody.safeParse({ control: 'root' }).success).toBe(false);
    expect(HostCreateEnrollmentBody.safeParse({ name: '' }).success).toBe(false);
    expect(HostCreateEnrollmentBody.safeParse({ name: 'x'.repeat(64) }).success).toBe(false);
    // Whombat always pre-approves: there is no `approve` to send.
    expect(HostCreateEnrollmentBody.safeParse({ approve: true }).success).toBe(false);
  });

  it('reads the new enrollment fields, and an older Whombat without them', () => {
    const old = {
      id: 'enr_1',
      expiresAt: T,
      installCommand: 'curl -fsSL https://10.100.1.160:8443/install.sh | sh',
    };
    expect(HostEnrollment.parse(old)).toEqual(old);
    const now = HostEnrollment.parse({
      ...old,
      installCommand: `${old.installCommand} -s -- --token wbe_x --control full`,
      control: 'full',
      preApproved: true,
    });
    expect([now.control, now.preApproved]).toEqual(['full', true]);

    const pending = {
      id: 'enr_2',
      state: 'pending',
      hostname: 'pve-03',
      os: 'Debian GNU/Linux 13',
      address: '10.100.0.14',
      agentVersion: '0.12.0',
      requestedAt: T,
    };
    expect(HostPendingEnrollment.parse(pending).control).toBeUndefined();
    expect(HostPendingEnrollment.parse({ ...pending, control: null, name: null }).name).toBeNull();
    expect(HostPendingEnrollment.parse({ ...pending, control: 'watch', name: 'nas' })).toMatchObject({
      control: 'watch',
      name: 'nas',
    });
  });
});

describe('Sign in once (CT-375, CT-376, 0.85.0)', () => {
  it('reads a job through its steps and how it ended', () => {
    expect(HostInstallState.options).toEqual(['connecting', 'installing', 'waiting', 'ready', 'failed']);
    expect(HostInstall.parse(JOB)).toEqual(JOB);
    expect(
      HostInstall.parse({
        ...JOB,
        state: 'connecting',
        hostKey: null,
        serverId: null,
        serverName: null,
        system: null,
      }).hostKey,
    ).toBeNull();
    const failed = HostInstall.parse({
      ...JOB,
      state: 'failed',
      serverId: null,
      error: { code: 'cant_reach_whombat', message: 'x' },
      detail: 'install.sh: cannot reach https://10.100.1.160:8443/agent/whombat-agent-amd64',
      finishedAt: T,
    });
    expect(failed.error?.code).toBe('cant_reach_whombat');
    expect(HostInstall.safeParse({ ...JOB, detail: 'x'.repeat(HOST_INSTALL_DETAIL_MAX + 1) }).success).toBe(
      false,
    );
    expect(HostInstall.safeParse({ ...JOB, state: 'done' }).success).toBe(false);
  });

  it('has every error code of SI-11, in words a person can act on', () => {
    expect(HostInstallErrorCode.options).toEqual([
      'not_allowed',
      'unreachable',
      'host_key_changed',
      'sign_in_failed',
      'sudo_password_needed',
      'sudo_refused',
      'no_downloader',
      'cant_reach_whombat',
      'unsupported',
      'other_whombat',
      'timed_out',
      'failed',
    ]);
    const ctx = { address: '10.100.0.14', name: 'pve-03', whombat: '10.100.1.160:8443' };
    for (const code of HostInstallErrorCode.options) {
      const text = hostInstallErrorText(code, ctx);
      expect(text.length, code).toBeGreaterThan(10);
      expect(text, code).not.toMatch(/'/);
      expect(text, code).toMatch(/[.?]$/);
    }
    expect(hostInstallErrorText('sign_in_failed', ctx)).toBe(
      'Couldn’t sign in to 10.100.0.14: the user name or password isn’t right.',
    );
    expect(hostInstallErrorText('sign_in_failed', { ...ctx, withKey: true })).toContain('user name or key');
    expect(hostInstallErrorText('cant_reach_whombat', ctx)).toBe(
      'pve-03 can’t reach this Whombat at 10.100.1.160:8443. Is it on another network?',
    );
    expect(hostInstallErrorText('cant_reach_whombat', { address: '10.100.0.14' })).toBe(
      '10.100.0.14 can’t reach this Whombat. Is it on another network?',
    );
    expect(hostInstallErrorText('other_whombat', ctx)).toBe(
      'This server reports to another Whombat. Remove Whombat’s helper there first.',
    );
    expect(hostInstallErrorText('host_key_changed', ctx)).toMatch(
      /^pve-03 showed a different key than the one your Vault trusts/,
    );
    expect(hostInstallErrorText('timed_out', { ...ctx, installed: true })).toBe(
      'It’s installed, but its first report hasn’t come in yet. It shows up once it does.',
    );
  });

  it('takes a password or a Vault key, strictly, and never anything else', () => {
    const body = {
      address: '10.100.0.14',
      username: 'root',
      auth: { kind: 'password', password: 'correct horse' },
      control: 'full',
    };
    expect(HostInstallBody.parse(body)).toEqual(body);
    expect(api.hosts.startInstall.body.parse(body)).toEqual(body);
    const withKey = {
      ...body,
      username: 'deploy',
      auth: { kind: 'vault', entryId: 'vlt_servers' },
      name: 'pve-03',
      keepKey: { entryId: 'vlt_servers' },
    };
    expect(HostInstallBody.parse(withKey)).toEqual(withKey);
    expect(
      HostInstallBody.parse({ ...withKey, auth: { ...withKey.auth, password: 'sudo pw' } }).auth,
    ).toEqual({
      kind: 'vault',
      entryId: 'vlt_servers',
      password: 'sudo pw',
    });
    expect(HostInstallBody.parse({ ...body, keepKey: { create: true } }).keepKey).toEqual({ create: true });

    const refused: unknown[] = [
      { ...body, control: undefined },
      { ...body, auth: { kind: 'password', password: '' } },
      { ...body, auth: { kind: 'password' } },
      { ...body, auth: { kind: 'password', password: 'x', entryId: 'vlt_1' } },
      { ...body, auth: { kind: 'token', token: 'x' } },
      { ...body, keepKey: { create: false } },
      { ...body, keepKey: { entryId: 'vlt_1', create: true } },
      { ...body, keepKey: {} },
      { ...body, address: '' },
      { ...body, address: 'x'.repeat(256) },
      { ...body, username: 'x'.repeat(65) },
      { ...body, approve: true },
    ];
    for (const b of refused) expect(HostInstallBody.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it('reads an address as typed, port 22 unless given', () => {
    expect(parseHostInstallAddress('10.100.0.14')).toEqual({
      host: '10.100.0.14',
      hostKind: 'ipv4',
      port: 22,
    });
    expect(parseHostInstallAddress(' PVE-03.lan:2222 ')).toEqual({
      host: 'pve-03.lan',
      hostKind: 'name',
      port: 2222,
    });
    expect(parseHostInstallAddress('2001:db8::7')).toEqual({
      host: '2001:db8::7',
      hostKind: 'ipv6',
      port: 22,
    });
    expect(parseHostInstallAddress('[2001:db8::7]:2200')).toEqual({
      host: '2001:db8::7',
      hostKind: 'ipv6',
      port: 2200,
    });
    expect(parseHostInstallAddress('[2001:db8::7]')?.port).toBe(22);
    for (const bad of [
      '',
      'pve-03:',
      'pve-03:0',
      'pve-03:65536',
      'pve-03:22a',
      '[2001:db8::7',
      '[::1]x',
      'a b',
      '10.0.0.1:22:1',
    ])
      expect(parseHostInstallAddress(bad), bad).toBeNull();
  });

  it('starts a job, reads it, and says when it moves on', () => {
    const start = api.hosts.startInstall;
    expect([start.id, start.method, start.path, start.status]).toEqual([
      'hosts.startInstall',
      'POST',
      '/burrows/:burrow/hosts/installs',
      202,
    ]);
    expect(start.response).toBe(HostInstall);
    const get = api.hosts.getInstall;
    expect([get.id, get.method, get.path]).toEqual([
      'hosts.getInstall',
      'GET',
      '/burrows/:burrow/hosts/installs/:installId',
    ]);
    expect(get.params.parse({ burrow: 'lumio-bv', installId: JOB.id })).toEqual({
      burrow: 'lumio-bv',
      installId: JOB.id,
    });
    // At the end of the enrollment group, before the consoles.
    const ops = Object.keys(api.hosts);
    expect(ops.slice(ops.indexOf('createEnrollment'), ops.indexOf('createConsole'))).toEqual([
      'createEnrollment',
      'listEnrollments',
      'approveEnrollment',
      'rejectEnrollment',
      'startInstall',
      'getInstall',
    ]);

    expect(RealtimeEvent.parse({ type: 'hosts.install', installId: JOB.id, state: 'ready' })).toEqual({
      type: 'hosts.install',
      installId: JOB.id,
      state: 'ready',
    });
    expect(REALTIME_EVENT_TOPICS['hosts.install']).toEqual(['hosts']);
  });
});

describe('server_add (CT-378, 0.85.0)', () => {
  it('only asks the owner, with a card', () => {
    expect(SERVERS_TOOLS.at(-1)?.name).toBe('server_add');
    const t = tool('server_add');
    expect(t?.access).toBe('read');
    expect(t?.sensitive).toBeUndefined();
    expect(t?.description).toContain('You never get the password.');
    expect(`${t?.title} ${t?.description} ${JSON.stringify(t?.inputSchema)}`).not.toMatch(/'/);
    expect(toolAlwaysAsks(servers(), 'server_add')).toBe(false);
    expect(sensitiveReason(servers(), 'server_add', { address: '10.100.0.40' })).toBeNull();
    expect(servers().guide).toContain('server_add');
    expect(servers().guide.length).toBeLessThanOrEqual(1500);
  });

  it('takes an address, and the user, level and name when given', () => {
    const schema = z.fromJSONSchema(tool('server_add')?.inputSchema as never);
    expect(schema.safeParse({ address: '10.100.0.40' }).success).toBe(true);
    expect(
      schema.safeParse({ address: '10.100.0.40', username: 'root', control: 'operate', name: 'pve-04' })
        .success,
    ).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ address: '10.100.0.40', control: 'root' }).success).toBe(false);
    expect(schema.safeParse({ address: '10.100.0.40', password: 'x' }).success).toBe(false);
  });

  it('labels the card it posts', () => {
    expect(GUIDE_TOPICS).toContain('add_server');
    expect(GUIDE_TOPIC_LABELS.add_server).toBe('Servers');
    expect(guideCardLabel({ guide: 'add_server', step: null })).toBe('SERVERS');
    expect(STARTABLE_GUIDE_TOPICS as readonly string[]).not.toContain('add_server');
  });
});
