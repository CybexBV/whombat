import { HostInstall, HostInstallBody } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  addServerHref,
  addServerPrefill,
  addServerPrefillFromHref,
  commandOutcome,
  defaultKeepKey,
  installBody,
  installHostKeyNote,
  installOutcome,
  installSteps,
  installTitle,
  NEW_KEY,
  signInFormDefaults,
  signInFormErrors,
  signInFormForRetry,
  sshKeyChoices,
  withKeyDefaults,
} from './install';

const AT = '2026-10-18T10:00:00.000Z';
const job = (patch: Partial<HostInstall> = {}): HostInstall =>
  HostInstall.parse({
    id: 'inst_1',
    address: '10.100.0.14',
    username: 'root',
    control: 'full',
    state: 'connecting',
    hostKey: null,
    hostKeyNew: false,
    serverId: null,
    serverName: null,
    system: null,
    already: false,
    keptKey: false,
    error: null,
    detail: null,
    startedAt: AT,
    updatedAt: AT,
    finishedAt: null,
    ...patch,
  });
const key = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:q3VxR8mKp2dLw7NfYc4ZtH1sJb9GeA6uQo5XiV0nT8w' };
const states = (j: HostInstall) => installSteps(j).map((s) => `${s.key}:${s.state}`);

describe('the address Add a server opens with (SI-10)', () => {
  it('fills the form from the assistant’s card and keeps the defaults for the rest', () => {
    expect(addServerPrefill({ add: '1', address: '10.100.0.40', control: 'operate' })).toEqual({
      address: '10.100.0.40',
      username: 'root',
      control: 'operate',
      name: '',
    });
    expect(addServerPrefill({ add: '1', control: 'everything', user: 'john', name: 42 })).toMatchObject({
      control: 'full',
      username: 'john',
      name: '42',
    });
  });

  it('builds and reads the card’s link (the phone maps it to its screen)', () => {
    const href = addServerHref({ address: '10.100.0.40', username: 'root', control: 'full' });
    // Over the Servers list; the servers' cards' and older messages' addresses still read.
    expect(href).toBe('/servers?add=1&address=10.100.0.40&user=root&control=full');
    expect(addServerPrefillFromHref(href)).toEqual(
      addServerPrefill({ address: '10.100.0.40', control: 'full' }),
    );
    expect(
      addServerPrefillFromHref('https://box.local/things/servers/?add=server&name=pve%2003'),
    ).toMatchObject({
      name: 'pve 03',
    });
    expect(addServerPrefillFromHref('/things/servers?add=1&address=10.100.0.9')).toMatchObject({
      address: '10.100.0.9',
    });
    expect(addServerPrefillFromHref('/connections?add=1&address=10.100.0.8')).toMatchObject({
      address: '10.100.0.8',
    });
    expect(addServerPrefillFromHref('/things/servers')).toBeNull();
    expect(addServerPrefillFromHref('/connections')).toBeNull();
    expect(addServerPrefillFromHref('/things/server:pve-02?add=1')).toBeNull();
  });
});

describe('the Sign in once form (SI-02, SI-09)', () => {
  const filled = { ...signInFormDefaults({ address: '10.100.0.14' }), password: 'hunter2 ' };

  it('says what is missing, field by field', () => {
    expect(signInFormErrors(signInFormDefaults())).toEqual({
      address: 'Type the server’s address.',
      password: 'Type its password.',
    });
    expect(signInFormErrors({ ...filled, address: 'pve 03' }).address).toMatch(/^That isn’t an address/);
    expect(signInFormErrors({ ...filled, address: '[fd00::14]:2222' })).toEqual({});
    expect(signInFormErrors({ ...filled, address: 'pve-03.lan:99999' }).address).toBeTruthy();
    expect(signInFormErrors({ ...filled, username: '' }).username).toBe('Type a user name.');
    expect(signInFormErrors({ ...filled, method: 'vault' }).entryId).toBe('Pick a key.');
    expect(signInFormErrors({ ...filled, name: '-x' }).name).toBe('Letters, digits, dots and dashes.');
  });

  it('sends the password as typed, a key with sudo’s password only when given, and SI-09 only when ticked', () => {
    const body = installBody(filled, 'full');
    expect(HostInstallBody.parse(body)).toEqual({
      address: '10.100.0.14',
      username: 'root',
      auth: { kind: 'password', password: 'hunter2 ' },
      control: 'full',
    });
    expect(installBody({ ...filled, method: 'vault', entryId: 'vlt_1' }, 'watch').auth).toEqual({
      kind: 'vault',
      entryId: 'vlt_1',
    });
    expect(
      installBody({ ...filled, method: 'vault', entryId: 'vlt_1', sudoPassword: 's', keepKey: true }, 'full'),
    ).toMatchObject({ auth: { password: 's' }, keepKey: { create: true } });
    expect(
      installBody({ ...filled, keepKey: true, keepKeyEntry: 'vlt_2', name: ' pve-03 ' }, 'full'),
    ).toMatchObject({ keepKey: { entryId: 'vlt_2' }, name: 'pve-03' });
  });

  it('Try again clears both passwords and keeps everything else', () => {
    const again = signInFormForRetry({ ...filled, sudoPassword: 'x', keepKey: true });
    expect(again).toMatchObject({ address: '10.100.0.14', password: '', sudoPassword: '', keepKey: true });
  });

  it('lists the person’s own SSH keys with their fingerprints, and picks the key to leave', () => {
    const keys = sshKeyChoices([
      { id: 'v1', name: 'Deploy key', kind: 'ssh', auth: { type: 'ssh_key', fingerprint: 'SHA256:abc' } },
      { id: 'v2', name: 'Stripe', kind: 'http', auth: { type: 'bearer' } },
      { id: 'v3', name: 'Servers', kind: 'ssh', auth: { type: 'ssh_key', fingerprint: 'SHA256:def' } },
    ]);
    expect(keys.map((k) => k.label)).toEqual(['Deploy key · SHA256:abc', 'Servers · SHA256:def']);
    expect(defaultKeepKey(keys)).toBe('v3');
    expect(defaultKeepKey(keys, 'v1')).toBe('v1');
    expect(defaultKeepKey(keys.slice(0, 1))).toBe(NEW_KEY);
    // Until the person picks: the first key to sign in with, SI-09 at it; a pick stays, a removed key falls back.
    const form = { ...filled, method: 'vault' as const };
    expect(withKeyDefaults(form, keys)).toMatchObject({ entryId: 'v1', keepKeyEntry: 'v1' });
    expect(withKeyDefaults({ ...form, keepKeyEntry: NEW_KEY }, keys).keepKeyEntry).toBe(NEW_KEY);
    expect(withKeyDefaults({ ...form, entryId: 'gone' }, keys).entryId).toBe('v1');
    expect(withKeyDefaults(filled, [])).toBe(filled);
  });
});

describe('the install job', () => {
  it('walks the four steps (SI-02)', () => {
    expect(states(job())).toEqual(['sign_in:active', 'install:todo', 'report:todo', 'ready:todo']);
    expect(installSteps(job())[0]?.label).toBe('Signing in to 10.100.0.14');
    const installing = job({ state: 'installing', hostKey: key, hostKeyNew: true });
    expect(states(installing)).toEqual(['sign_in:done', 'install:active', 'report:todo', 'ready:todo']);
    const waiting = job({
      state: 'waiting',
      hostKey: key,
      system: 'Proxmox VE 9.0 · Debian 13 · amd64',
      serverId: 'pve-03',
      serverName: 'pve-03',
    });
    expect(installSteps(waiting).map((s) => s.label)).toEqual([
      'Signed in to 10.100.0.14',
      'Installed Whombat’s helper',
      'Waiting for its first report',
      'Ready',
    ]);
    expect(installSteps(waiting)[1]?.sub).toBe('Proxmox VE 9.0 · Debian 13 · amd64');
    expect(installTitle(job())).toBe('Adding 10.100.0.14');
    expect(installTitle(waiting)).toBe('Adding pve-03');
    expect(states(job({ ...waiting, state: 'ready' }))).toEqual([
      'sign_in:done',
      'install:done',
      'report:done',
      'ready:done',
    ]);
  });

  it('stops at the step that failed', () => {
    const wrong = job({ state: 'failed', error: { code: 'sign_in_failed', message: 'No.' } });
    expect(states(wrong)).toEqual(['sign_in:failed', 'install:todo', 'report:todo', 'ready:todo']);
    const changed = job({
      state: 'failed',
      hostKey: key,
      error: { code: 'host_key_changed', message: 'No.' },
    });
    expect(states(changed)[0]).toBe('sign_in:failed');
    const sudo = job({ state: 'failed', hostKey: key, error: { code: 'sudo_refused', message: 'No.' } });
    expect(states(sudo).slice(0, 2)).toEqual(['sign_in:done', 'install:failed']);
    const late = job({
      state: 'failed',
      hostKey: key,
      serverId: 'pve-03',
      serverName: 'pve-03',
      error: { code: 'timed_out', message: '' },
    });
    expect(states(late)).toEqual(['sign_in:done', 'install:done', 'report:late', 'ready:todo']);
    expect(installOutcome(late)).toMatchObject({
      kind: 'late',
      text: 'It’s installed, but its first report hasn’t come in yet. It shows up once it does.',
    });
  });

  it('shows the host key, and says Whombat remembers it only when a key stayed (SI-04, SI-09)', () => {
    expect(installHostKeyNote(job())).toBeNull();
    const shown = installHostKeyNote(job({ hostKey: key, hostKeyNew: true }));
    expect(`${shown?.before}${shown?.fingerprint}${shown?.after}`).toBe(
      `First time on this server: it showed key ${key.fingerprint}.`,
    );
    expect(installHostKeyNote(job({ hostKey: key, hostKeyNew: true, keptKey: true }))?.after).toBe(
      '. Whombat remembers it and warns you if it ever changes.',
    );
    expect(installHostKeyNote(job({ hostKey: key, hostKeyNew: false }))?.before).toBe('It showed key ');
  });

  it('says how it ended: added, already there, under a free name, or why not (SI-07, SI-08, SI-11)', () => {
    const ready = job({ state: 'ready', serverId: 'pve-03', serverName: 'pve-03' });
    expect(installOutcome(job())).toBeNull();
    expect(installOutcome(ready)).toMatchObject({ kind: 'added', text: 'pve-03 is added.' });
    expect(installOutcome({ ...ready, already: true })?.text).toBe(
      'pve-03 was already added. Whombat’s helper on it is updated and set to Full control.',
    );
    const renamed = { ...ready, serverId: 'pve-03-2', serverName: 'pve-03-2' };
    expect(installOutcome(renamed, ['pve-01', 'pve-03'])?.text).toBe(
      'Added as pve-03-2. An older pve-03 isn’t reporting; remove it if it’s the same server.',
    );
    expect(installOutcome(renamed, ['pve-01'])?.kind).toBe('added');
    const refused = job({
      state: 'failed',
      error: { code: 'cant_reach_whombat', message: 'pve-03 can’t reach this Whombat.' },
      detail: 'curl: (28)\n',
    });
    expect(installOutcome(refused)).toEqual({
      kind: 'failed',
      text: 'pve-03 can’t reach this Whombat.',
      code: 'cant_reach_whombat',
      detail: 'curl: (28)\n',
    });
    expect(
      installOutcome({ ...refused, error: { code: 'unreachable', message: '' }, detail: ' ' }),
    ).toMatchObject({
      text: 'Nothing answers at 10.100.0.14. Is the address right, and is the server on?',
      detail: null,
    });
  });

  it('tells when a pre-approved command has run', () => {
    const items = [{ id: 'enr_1', state: 'approved' as const, serverId: 'web-04', hostname: 'web-04' }];
    expect(commandOutcome('enr_1', items)).toEqual({ serverId: 'web-04', text: 'web-04 is added.' });
    expect(commandOutcome('enr_2', items)).toBeNull();
    expect(commandOutcome(null, items)).toBeNull();
  });
});
