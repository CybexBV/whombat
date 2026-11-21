import type { HostInstall } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { installFailureCard, installHostKeyNote } from './install';

const key = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc' };
const base: Pick<HostInstall, 'address' | 'serverName' | 'hostKey' | 'pins'> = {
  address: '10.20.0.5',
  serverName: null,
  hostKey: null,
};

describe('a failed install as one card (connect-in-chat.md)', () => {
  it('offers the command when the server can’t reach the Whombat', () => {
    const card = installFailureCard(base, { code: 'cant_reach_whombat', text: 'x' });
    expect(card).toMatchObject({ step: 'command', label: 'Run this one line on it instead' });
  });

  it('asks to trust a changed key when Vault servers trusted the old one', () => {
    const pins = [{ entryId: 'vlt_1', serverId: 'vss_1' }];
    const card = installFailureCard({ ...base, hostKey: key, pins }, { code: 'host_key_changed', text: 'x' });
    expect(card).toMatchObject({
      title: 'Its key changed since last time. Trust the new one?',
      step: 'trust',
      label: 'Trust the new one',
    });
    // Without the key or a pin there is nothing to trust here: back to the form.
    expect(installFailureCard(base, { code: 'host_key_changed', text: 'x' }).step).toBe('retry');
  });

  it('says the rest in plain words, the installer’s own when nothing better is known', () => {
    expect(installFailureCard(base, { code: 'sign_in_failed', text: 'x' }).title).toContain('isn’t right');
    expect(installFailureCard(base, { code: 'no_downloader', text: 'x' }).text).toContain('curl or wget');
    expect(installFailureCard(base, { code: 'failed', text: 'The installer said no.' })).toMatchObject({
      title: 'The installer said no.',
      step: 'retry',
    });
  });

  it('shows the new key, not “the one your Vault trusts”, when it changed', () => {
    const note = installHostKeyNote({
      hostKey: key,
      hostKeyNew: false,
      keptKey: false,
      error: { code: 'host_key_changed', message: '' },
    });
    expect(note?.before).toBe('It shows a new key now: ');
  });
});
