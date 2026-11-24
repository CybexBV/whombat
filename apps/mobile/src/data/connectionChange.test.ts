/** Changing a connection on the phone (phone-connect.md PC-09, AP-2911). */
import { reconnectServiceLoginBody, setSecretBody } from '@whombat/client/connections';
import { type CatalogEntry, catalogEntry, catalogSignIn } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  raisedNote,
  reconnectWay,
  removeAsk,
  replacedText,
  replaceProblem,
  signInView,
  stacksActions,
} from './connectionChange';

const entry = (id: string): CatalogEntry => {
  const e = catalogEntry(id);
  if (!e) throw new Error(id);
  return e;
};

describe('a connection’s sign-in on the phone', () => {
  it('replaces a token (a session sign-in’s password by its name), signs in again elsewhere, or has none', () => {
    const token = signInView(entry('todoist'), { signIn: 'token' });
    expect(token.action).toMatchObject({ kind: 'replace', label: 'Replace token' });
    expect(replaceProblem(token, '')).toContain('needed');
    expect(replaceProblem(token, 'x')).toBeNull();
    expect(signInView(entry('pihole'), { signIn: 'token' }).action).toMatchObject({
      label: 'Replace app password',
    });
    expect(signInView(entry('dropbox'), { signIn: 'app_oauth' }).action).toMatchObject({ kind: 'reconnect' });
    // An agent's ask for more on the service (step-up): Allow on {Name}, what it is in words.
    const asked = signInView(
      entry('cloudflare'),
      { signIn: 'mcp_oauth', permissionAsked: ['dns.write'] },
      true,
      'Dusty',
    );
    expect(asked.action).toMatchObject({ kind: 'reconnect', label: 'Allow on Cloudflare…', primary: true });
    expect(asked.line).toContain('change DNS');
    expect(signInView(entry('custom_mcp'), { signIn: 'none' }).action).toBeNull();
    // An OAuth client's new secret replaces the old one on the same connection (CS-12).
    const client = ['tailscale', 'cloudflare']
      .map(entry)
      .find((e) => e.signIn.some((m) => m.kind === 'client_credentials'));
    if (client)
      expect(signInView(client, { signIn: 'client_credentials' }).action).toMatchObject({ kind: 'replace' });
    // No Reconnect that would make a second connection (AP-2920).
    expect(signInView(entry('proxmox'), { signIn: 'password' }).action).toBeNull();
  });

  it('signs in again on the same connection in the browser or with Nextcloud’s login, nothing else', () => {
    expect(reconnectWay('ha_oauth')).toBe('oauth');
    expect(reconnectWay('nextcloud_login')).toBe('nextcloud');
    expect(reconnectWay('password')).toBeNull();
    expect(reconnectWay('client_credentials')).toBeNull();
  });

  it('asks before Remove, saying what stops', () => {
    expect(removeAsk(entry('homeassistant'), { label: 'Home' }, 'Dusty')).toContain('Dusty');
    expect(removeAsk(entry('tracker'), { label: 'Acme Desk' }, 'Dusty')).toContain('Automations');
    // 1Password stops keeping the Vault in step, and isn't changed itself: never the agent's or automations' words.
    const onepassword = removeAsk(entry('onepassword'), { label: '1Password' }, 'Dusty');
    expect(onepassword).toMatch(/^Remove 1Password\?/);
    expect(onepassword).not.toMatch(/Dusty|Automations/);
  });

  it('says a key made at Look only stays that way once raised, where the service limits it (CS-11)', () => {
    const limited = ['proxmox', 'unifi_network', 'homeassistant', 'portainer']
      .map(entry)
      .find((e) => e.signIn.some((m) => m.kind === 'password' && m.serviceLimits));
    if (limited) expect(raisedNote(limited, true, 'manage')).toContain(limited.name);
    expect(raisedNote(entry('todoist'), true, 'manage')).toBeNull();
    expect(raisedNote(entry('proxmox'), false, 'manage')).toBeNull();
  });
});

describe('signing in properly on a connection’s screen (connection-signin-android.md AP-3957, AP-3958)', () => {
  it('offers Sign in again beside Replace token for Plex where the runtime has its sign-in page', () => {
    const plex = entry('plex');
    const view = signInView(plex, { signIn: 'token' }, true);
    expect(view.again?.label).toBe('Sign in again');
    expect(view.action).toMatchObject({ kind: 'replace', label: 'Replace token' });
    expect(signInView(plex, { signIn: 'token' }, false).again).toBeNull();
    // Only entries with a sign-in page of their own.
    expect(signInView(entry('todoist'), { signIn: 'token' }, true).again).toBeNull();
    // The same connection, its level as it is.
    expect(
      reconnectServiceLoginBody({
        id: 'con_demo_1',
        catalogId: 'plex',
        fields: { url: 'http://plex.lan:32400' },
        access: 'read',
      }),
    ).toMatchObject({ connectionId: 'con_demo_1', access: 'read', fields: { url: 'http://plex.lan:32400' } });
  });

  it('replaces Synology’s password with the code DSM asked for, and nothing more elsewhere', () => {
    const synology = entry('synology');
    expect(signInView(synology, { signIn: 'token' }).action).toMatchObject({ label: 'Replace password' });
    const method = catalogSignIn(synology, 'token');
    expect(setSecretBody(method, 'pw', ' 123456 ')).toEqual({ secret: 'pw', code: '123456' });
    expect(setSecretBody(method, 'pw')).toEqual({ secret: 'pw' });
    expect(setSecretBody(catalogSignIn(entry('plex'), 'token'), 'tok', '123456')).toEqual({ secret: 'tok' });
    // “Replace password” doesn't fit beside Remove: the buttons stack. “Replace token” does.
    expect(stacksActions(signInView(synology, { signIn: 'token' }))).toBe(true);
    expect(stacksActions(signInView(entry('plex'), { signIn: 'token' }))).toBe(false);
    // Its toast names the password, never a token.
    const token = { signIn: 'token' } as const;
    expect(replacedText(synology, token, signInView(synology, token))).toBe('Password replaced.');
    expect(replacedText(entry('plex'), token, signInView(entry('plex'), token))).toBe('Token replaced.');
  });

  it('signs a T3 Code connection in again with a new pairing code, never Replace token', () => {
    const t3 = entry('t3code');
    const view = signInView(t3, { signIn: 'token', status: 'active' }, true);
    expect(view.title).toBe('Pairing code');
    expect(view.again).toBeNull();
    expect(view.action).toMatchObject({
      kind: 'code',
      label: 'Sign in again',
      secretLabel: 'Pairing code',
      needs: false,
    });
    if (view.action?.kind !== 'code') throw new Error('t3code sign in again');
    expect(view.action.steps.length).toBeGreaterThan(0);
    expect(view.action.placeholder).not.toBe('');
    // Needing a new code leads with it and makes Sign in again the main button.
    const needs = signInView(t3, { signIn: 'token', status: 'needs_reauth' });
    expect(needs.line.startsWith('T3 Code')).toBe(true);
    expect(needs.action).toMatchObject({ kind: 'code', needs: true });
    expect(stacksActions(view)).toBe(false);
    expect(replaceProblem(view, '  ')).toBe('Pairing code is needed.');
    expect(replaceProblem(view, 'ABCD2345EFGH')).toBeNull();
    expect(replacedText(t3, { signIn: 'token' }, view)).toBe('Signed in to T3 Code again.');
    // The code goes as the secret, without a two-step code.
    expect(setSecretBody(catalogSignIn(t3, 'token'), 'ABCD2345EFGH')).toEqual({ secret: 'ABCD2345EFGH' });
  });
});
