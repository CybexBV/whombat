import { describe, expect, it, vi } from 'vitest';
import type { ApplianceSession } from '../session/types';
import {
  finishGoogleConnection,
  GOOGLE_CONNECT_KEY,
  googleFinishStep,
  heldGoogleConnect,
  holdGoogleConnect,
  isManagedConnectionReturn,
  readGoogleReturn,
  withConnectError,
} from './google';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

describe('managed Google connect (AG-14)', () => {
  it('holds which Whombat started the connect, for 30 minutes', () => {
    const s = memoryStorage();
    holdGoogleConnect(s, { device: 'dev_1', returnTo: '/hq/dm/hazel?guide=email' }, 1000);
    expect(heldGoogleConnect(s, 1000 + 29 * 60_000)).toEqual({
      device: 'dev_1',
      returnTo: '/hq/dm/hazel?guide=email',
      at: 1000,
    });
    expect(heldGoogleConnect(s, 1000 + 31 * 60_000)).toBeNull();
    holdGoogleConnect(s, null);
    expect(s.raw.has(GOOGLE_CONNECT_KEY)).toBe(false);
  });

  it('never trusts a held return path to another origin', () => {
    const s = memoryStorage();
    s.setItem(GOOGLE_CONNECT_KEY, JSON.stringify({ device: 'dev_1', returnTo: '//evil.example', at: 1 }));
    expect(heldGoogleConnect(s, 2)).toBeNull();
    s.setItem(GOOGLE_CONNECT_KEY, 'not json');
    expect(heldGoogleConnect(s, 2)).toBeNull();
  });

  it('forgets a held connect from the future or past its 30 minutes, and never crashes on storage (AP-590)', () => {
    const s = memoryStorage();
    s.setItem(
      GOOGLE_CONNECT_KEY,
      JSON.stringify({ device: 'dev_1', returnTo: '/hq/settings', at: 1000 + 86_400_000 }),
    );
    expect(heldGoogleConnect(s, 1000)).toBeNull();
    expect(s.raw.has(GOOGLE_CONNECT_KEY)).toBe(false);
    holdGoogleConnect(s, { device: 'dev_1', returnTo: '/hq/settings' }, 1000);
    expect(heldGoogleConnect(s, 1000 + 30 * 60_000)).toBeNull();
    expect(s.raw.has(GOOGLE_CONNECT_KEY)).toBe(false);

    const unreachable = () => {
      throw new Error('SecurityError: The operation is insecure.');
    };
    expect(holdGoogleConnect(unreachable, { device: 'dev_1', returnTo: '/hq/settings' })).toBe(false);
    expect(heldGoogleConnect(unreachable)).toBeNull();
    expect(() => holdGoogleConnect(unreachable, null)).not.toThrow();
    const full = { ...memoryStorage(), setItem: unreachable };
    expect(holdGoogleConnect(full, { device: 'dev_1', returnTo: '/hq/settings' })).toBe(false);
  });

  it('reads what Google put on the redirect, only on /connect/google', () => {
    expect(
      readGoogleReturn({ pathname: '/connect/google', search: '?code=4%2F0Ab&state=oas_1&scope=x' }),
    ).toEqual({
      code: '4/0Ab',
      state: 'oas_1',
      error: null,
    });
    expect(
      readGoogleReturn({ pathname: '/connect/google', search: '?error=access_denied&state=oas_1' }),
    ).toEqual({
      code: null,
      state: 'oas_1',
      error: 'access_denied',
    });
    expect(readGoogleReturn({ pathname: '/hq/settings', search: '?code=1&state=2' })).toBeNull();
  });

  it('adds connect_error to a return path', () => {
    expect(withConnectError('/hq/dm/hazel?guide=email', 'invalid_state')).toBe(
      '/hq/dm/hazel?guide=email&connect_error=invalid_state',
    );
    expect(withConnectError('/hq/settings', 'invalid_state')).toBe(
      '/hq/settings?connect_error=invalid_state',
    );
  });

  it('finishes over the session and answers the return path', async () => {
    const call = vi.fn(async () => ({
      status: 200,
      body: { returnPath: '/hq/dm/hazel?guide=email&connected=google' },
      requestId: 'r',
    }));
    const session = { call } as unknown as ApplianceSession;
    await expect(
      finishGoogleConnection(session, { code: 'c0de', state: 'oas_1', error: null }),
    ).resolves.toBe('/hq/dm/hazel?guide=email&connected=google');
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ id: 'connections.finishGoogle' }), {
      params: {},
      query: {},
      body: { state: 'oas_1', code: 'c0de' },
    });
    call.mockResolvedValueOnce({ status: 404, body: {} as never, requestId: 'r' });
    await expect(finishGoogleConnection(session, { code: 'c', state: 's', error: null })).rejects.toThrow();
    await expect(finishGoogleConnection(session, { code: 'c', state: null, error: null })).rejects.toThrow();
  });

  it('holds, reads and finishes a catalog connection’s sign-in (AP-766)', async () => {
    const s = memoryStorage();
    holdGoogleConnect(
      s,
      { device: 'dev_1', returnTo: '/hq/settings?tab=connections', flow: 'connection' },
      1000,
    );
    expect(heldGoogleConnect(s, 2000)).toEqual({
      device: 'dev_1',
      returnTo: '/hq/settings?tab=connections',
      flow: 'connection',
      at: 1000,
    });
    expect(
      readGoogleReturn({
        pathname: '/connect/connection',
        search: '?code=abc&state=oas_2&iss=https%3A%2F%2Fa.example',
      }),
    ).toEqual({ code: 'abc', state: 'oas_2', error: null, provider: 'connection', iss: 'https://a.example' });
    expect(isManagedConnectionReturn('/connect/dropbox')).toBe(true);
    expect(isManagedConnectionReturn('/connect/google')).toBe(false);
    expect(isManagedConnectionReturn('/connect/../x')).toBe(false);
    const call = vi.fn(async () => ({
      status: 200,
      body: {
        returnPath: '/hq/settings?tab=connections&connected=homeassistant&connection=con_1',
        connectionId: 'con_1',
      },
      requestId: 'r',
    }));
    const session = { call } as unknown as ApplianceSession;
    await expect(
      finishGoogleConnection(session, {
        provider: 'connection',
        code: 'abc',
        state: 'oas_2',
        error: null,
        iss: 'https://a.example',
      }),
    ).resolves.toBe('/hq/settings?tab=connections&connected=homeassistant&connection=con_1');
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ id: 'connections.finishOAuth' }), {
      params: {},
      query: {},
      body: { state: 'oas_2', code: 'abc', iss: 'https://a.example' },
    });
  });

  it('sends once the session is open, and gives up when it can’t get through', () => {
    const open = { status: 'open', info: {} } as never;
    expect(googleFinishStep({ status: 'connecting', attempt: 0 }, false)).toBe('wait');
    expect(googleFinishStep(open, false)).toBe('send');
    expect(googleFinishStep(open, true)).toBe('wait');
    expect(googleFinishStep({ status: 'closed', reason: 'revoked' }, false)).toBe('give_up');
    expect(googleFinishStep({ status: 'closed', reason: 'revoked' }, true)).toBe('wait');
    // Its own close (the screen went away) is not a failure.
    expect(googleFinishStep({ status: 'closed', reason: 'closed' }, false)).toBe('wait');
    const retry = (attempt: number) =>
      ({ status: 'reconnecting', attempt, reason: 'offline', retryAt: 0 }) as never;
    expect(googleFinishStep(retry(1), false)).toBe('wait');
    expect(googleFinishStep(retry(2), false)).toBe('give_up');
  });
});
