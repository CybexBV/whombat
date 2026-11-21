import type { ClientStatus, ProviderSignIn } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_PROVIDERS,
  type ClientsList,
  clientOf,
  clientReady,
  clientUsable,
  needsClient,
  type SignInsList,
} from './model';

const client = (provider: 'claude' | 'codex', version: string | null): ClientStatus => ({
  provider,
  installed: version ? { version, installedAt: '2026-10-20T09:00:00Z' } : null,
  latest: null,
  state: version ? 'installed' : 'not_installed',
  progress: null,
  error: null,
});
const list = (...clients: ClientStatus[]): ClientsList => ({ clients, checkedAt: null });
const signedIn = (provider: 'claude' | 'codex'): SignInsList => ({
  signIns: [
    {
      provider,
      authMode: provider === 'claude' ? 'subscription_cli' : 'chatgpt',
      createdAt: '2026-10-20T09:00:00Z',
      expiresAt: null,
      verified: 'valid',
      login: null,
      state: 'ready',
      explanation: null,
    } as ProviderSignIn,
  ],
  logins: [],
  modes: [],
  consoles: [],
});

describe('only Claude Code is an installed client (chatgpt-no-client.md AP-5610)', () => {
  it('lists Claude Code alone as a client', () => {
    expect(CLIENT_PROVIDERS).toEqual(['claude']);
    expect(needsClient('claude')).toBe(true);
    expect(needsClient('codex')).toBe(false);
  });

  it('ignores a Codex client an older Whombat still lists', () => {
    const older = list(client('claude', '2.1.302'), client('codex', '0.162.1'));
    expect(clientOf(older, 'claude')?.installed?.version).toBe('2.1.302');
    expect(clientOf(older, 'codex')).toBeNull();
  });

  it('has nothing to install before ChatGPT, whatever the list says', () => {
    expect(clientReady('codex', undefined)).toBe(true);
    expect(clientReady('codex', list(client('claude', null)))).toBe(true);
    expect(clientReady('codex', list(client('codex', null)))).toBe(true);
    expect(clientReady('claude', list(client('claude', null)))).toBe(false);
    expect(clientReady('claude', list(client('claude', '2.1.302')))).toBe(true);
  });

  it('makes ChatGPT usable once signed in, and Claude Code once installed and signed in', () => {
    const none = list();
    expect(clientUsable('codex', none, signedIn('codex'))).toBe(true);
    expect(clientUsable('codex', none, signedIn('claude'))).toBe(false);
    expect(clientUsable('claude', none, signedIn('claude'))).toBe(false);
    expect(clientUsable('claude', list(client('claude', '2.1.302')), signedIn('claude'))).toBe(true);
  });
});
