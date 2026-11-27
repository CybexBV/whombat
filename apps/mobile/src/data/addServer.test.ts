/** Add a server on the phone (server-signin-mobile.md AP-1697…): the phone's parts beside the shared `install.ts`. */
import { installSteps } from '@whombat/client/hosts';
import type { HostInstall, HostPendingEnrollment, VaultEntry } from '@whombat/core';
import { FIXTURE_SSH_FINGERPRINT, vaultSshDeployKey } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import {
  ADD_SERVER_COPY,
  carriesOnText,
  keyRows,
  pendingRows,
  serverNameProblem,
  shortFingerprint,
  stepSpoken,
} from './addServer';
import { guideAppUrl } from './guides';

const job = (patch: Partial<HostInstall>): HostInstall => ({
  id: 'ins_1',
  address: '10.100.0.14',
  username: 'root',
  control: 'full',
  state: 'connecting',
  hostKey: null,
  hostKeyNew: true,
  serverId: null,
  serverName: null,
  system: null,
  already: false,
  keptKey: false,
  error: null,
  detail: null,
  startedAt: '2026-10-18T14:05:00.000Z',
  updatedAt: '2026-10-18T14:05:00.000Z',
  finishedAt: null,
  ...patch,
});

describe('Add a server on the phone', () => {
  it('says what TalkBack reads for each step, with what the server runs', () => {
    const steps = installSteps(
      job({
        state: 'waiting',
        system: 'Proxmox VE 9.0 · Debian 13 · amd64',
        serverId: 'pve-03',
        serverName: 'pve-03',
      }),
    );
    expect(steps.map((s) => stepSpoken(s))).toEqual([
      'Done: Signed in to 10.100.0.14',
      'Done: Installed Whombat’s helper. Proxmox VE 9.0 · Debian 13 · amd64',
      'Under way: Waiting for its first report',
      'Still to come: Ready',
    ]);
    const failed = installSteps(job({ state: 'failed', error: { code: 'sign_in_failed', message: 'No.' } }));
    expect(stepSpoken(failed[0] as never)).toBe('Stopped here: Signing in to 10.100.0.14');
  });

  it('shortens a fingerprint for a narrow row, and keeps a short one', () => {
    expect(shortFingerprint('SHA256:q3VxR8mKp2dLw7NfYc4ZtH1sJb9GeA6uQo5XiV0nT8w')).toBe('SHA256:q3Vx…T8w');
    expect(shortFingerprint('SHA256:abc')).toBe('SHA256:abc');
  });

  it('lists the person’s SSH keys as the shared picker does, each with its fingerprint', () => {
    const other = { ...vaultSshDeployKey, id: 'vlt_b', name: 'Another key' } as unknown as VaultEntry;
    const notSsh = { ...vaultSshDeployKey, id: 'vlt_c', kind: 'http', auth: null } as unknown as VaultEntry;
    const rows = keyRows([vaultSshDeployKey as unknown as VaultEntry, other, notSsh]);
    expect(rows.map((r) => r.id)).toEqual(['vlt_b', 'vlt_deploykey']);
    expect(rows[1]).toMatchObject({
      name: 'Deploy key',
      fingerprint: FIXTURE_SSH_FINGERPRINT,
      short: shortFingerprint(FIXTURE_SSH_FINGERPRINT),
    });
  });

  it('says Whombat carries on when the person leaves a job that runs', () => {
    expect(carriesOnText('pve-03')).toBe(
      'Whombat carries on. pve-03 shows up under Servers when it’s ready.',
    );
    expect(carriesOnText(null)).toBe(
      'Whombat carries on adding it. It shows up under Servers when it’s ready.',
    );
  });

  it('shows a waiting server with what it said, and its level when it has one', () => {
    const e: HostPendingEnrollment = {
      id: 'enr_1',
      state: 'pending',
      hostname: 'nas-02',
      os: 'Debian GNU/Linux 12',
      address: '10.100.0.27',
      agentVersion: '0.9.2',
      requestedAt: '2026-10-18T13:59:00.000Z',
      serverId: null,
      control: 'operate',
    };
    const [row] = pendingRows(
      [e, { ...e, id: 'enr_2', hostname: null, os: null, control: null }],
      Date.parse('2026-10-18T14:05:00Z'),
    );
    expect(row).toEqual({
      id: 'enr_1',
      hostname: 'nas-02',
      title: 'nas-02',
      meta: 'Debian GNU/Linux 12 · 10.100.0.27 · Restart and consoles',
      asked: 'Asked 6 min ago',
    });
    expect(
      pendingRows([{ ...e, hostname: null, os: null, control: null, requestedAt: null }], 0)[0],
    ).toMatchObject({
      title: 'A server',
      meta: '10.100.0.27',
      asked: '',
    });
  });

  it('takes a server name as the web does', () => {
    expect(serverNameProblem('pve-03')).toBeNull();
    expect(serverNameProblem('-bad')).toBe(ADD_SERVER_COPY.nameRule);
    expect(serverNameProblem('a b')).toBe(ADD_SERVER_COPY.nameRule);
  });
});

describe('the assistant’s card opens the phone’s screen (AP-1704)', () => {
  it('maps Add a server’s address to the app, filled in', () => {
    expect(guideAppUrl('/things/servers?add=1&address=10.100.0.40&user=root&control=full')).toBe(
      'whombat://servers/add?address=10.100.0.40&user=root&control=full',
    );
    expect(guideAppUrl('/things/servers?add=1&address=10.100.0.40&user=admin&control=watch&name=nas')).toBe(
      'whombat://servers/add?address=10.100.0.40&user=admin&control=watch&name=nas',
    );
    // A level that isn't one is Full control; no user is root.
    expect(guideAppUrl('/things/servers?add=1&control=all')).toBe(
      'whombat://servers/add?user=root&control=full',
    );
  });

  it('leaves every other link to the web', () => {
    expect(guideAppUrl('/things/servers')).toBeNull();
    // The connect card (connect-in-chat.md): Connect {Name} on the phone, the address and the level along.
    expect(
      guideAppUrl(
        '/settings?tab=connections&connection=homeassistant&url=http%3A%2F%2F192.168.1.20%3A8123&access=manage',
      ),
    ).toBe(
      'whombat://settings/connections/connect/homeassistant?url=http%3A%2F%2F192.168.1.20%3A8123&access=manage',
    );
    expect(guideAppUrl('/settings?tab=connections&connection=synology&access=admin')).toBe(
      'whombat://settings/connections/connect/synology',
    );
    // The card asking to allow more on a service (step-up): that connection's own screen.
    expect(guideAppUrl('/settings?tab=connections&connection=cloudflare&id=con_cf1')).toMatch(
      /^whombat:\/\/things\//,
    );
    expect(guideAppUrl('/settings?tab=ai')).toBeNull();
    expect(guideAppUrl('https://example.com/things/servers?add=1')).toBeNull();
  });

  it('opens the welcome’s other email and See all here (Whombat first-day.md)', () => {
    expect(guideAppUrl('/settings?tab=connections&connection=imap')).toBe(
      'whombat://settings/connections/account/imap',
    );
    expect(guideAppUrl('/settings?tab=connections&found=1')).toBe('whombat://settings/connections/add');
    // Other account pages keep opening the web.
    expect(guideAppUrl('/settings?tab=connections&connection=google')).toBeNull();
  });
});
