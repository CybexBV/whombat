/** The builtin connections' screens (phone-connect.md PC-02, PC-05; AP-2909, AP-2910). */
import type { Connection, ConnectorsStatus } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  accountErrorText,
  accountHead,
  accountLine,
  BUILTIN_TEXT,
  checkLine,
  isAccountProvider,
  providerConnectable,
  providerConnection,
  reconnectServices,
} from './accountConnect';

const status = (over: Partial<ConnectorsStatus> = {}): ConnectorsStatus =>
  ({
    mode: 'real',
    google: { app: { configured: true } },
    microsoft: { app: { configured: false } },
    connections: [],
    ...over,
  }) as unknown as ConnectorsStatus;

const google = (over: Partial<Connection> = {}): Connection =>
  ({
    id: 'con_g',
    provider: 'google',
    email: 'mara@lumio.example',
    name: 'Mara Okafor',
    services: ['mail', 'calendar'],
    status: 'active',
    reauthReason: null,
    checks: [],
    checkedAt: null,
    ...over,
  }) as unknown as Connection;

describe('Google and Microsoft 365 on the phone', () => {
  it('connects only where accounts are on and the provider’s app is set up', () => {
    expect(providerConnectable(status(), 'google')).toBe(true);
    expect(providerConnectable(status({ mode: 'off' }), 'google')).toBe(false);
    expect(
      providerConnectable(
        status({ mode: 'fake', google: { app: { configured: false } } } as never),
        'google',
      ),
    ).toBe(true);
    expect(providerConnectable(status(), 'microsoft')).toBe(false);
    expect(providerConnectable(status({ microsoft: undefined }), 'microsoft')).toBe(false);
    expect(providerConnectable(undefined, 'google')).toBe(false);
  });

  it('says the account, as whom and its services, or why it needs connecting again', () => {
    const c = google();
    expect(providerConnection(status({ connections: [c] }), 'google')?.id).toBe('con_g');
    expect(accountLine(c, 'google')).toContain('Mara Okafor');
    expect(accountLine(google({ status: 'needs_reauth', reauthReason: 'revoked' }), 'google')).toContain(
      'Sign in again',
    );
    expect(accountHead('microsoft').name).toBe('Microsoft 365');
    expect(isAccountProvider('imap')).toBe(false);
  });

  it('keeps the connected services ticked on Reconnect; all of them the first time', () => {
    expect(reconnectServices(google(), 'google')).toEqual(['mail', 'calendar']);
    expect(reconnectServices(null, 'google').length).toBeGreaterThan(2);
  });

  it('says a refused sign-in in Google’s words, Microsoft’s with its own name', () => {
    expect(accountErrorText('google', 'access_denied')).toContain('Google');
    expect(accountErrorText('microsoft', 'access_denied')).toContain('Microsoft');
    expect(accountErrorText('microsoft', 'access_denied')).not.toContain('Google');
    expect(accountErrorText('google', null)).toBeNull();
  });

  it('says each service’s check in its tone', () => {
    expect(checkLine({ service: 'mail', state: 'ok' } as never, 'google')).toEqual({
      tone: 'ok',
      text: 'Working',
    });
    expect(checkLine({ service: 'mail', state: 'error', message: 'Down' } as never, 'microsoft').tone).toBe(
      'bad',
    );
  });
});

describe('GitHub and Website feedback', () => {
  it('say what is connected in a line', () => {
    expect(BUILTIN_TEXT.github.connected('mara', 1)).toBe('@mara · 1 repository');
    expect(BUILTIN_TEXT.github.connected(null, 3)).toBe('3 repositories');
  });
});
