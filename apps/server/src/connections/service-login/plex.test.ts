/**
 * Plex's PIN sign-in (docs/decisions/connection-signin.md SG-04, SG-05) against a fake plex.tv: which requests, which
 * answers mean waiting, gone or the token, and what the person reads.
 */
import { type CatalogEntry, catalogEntry } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { OutboundError, type OutboundInit, type OutboundResponse } from '../../lib/outbound';
import type { CheckOutcome } from '../checks';
import { PLEX_APP, PLEX_TV, pinOf, plexLoginUrl, plexServiceLogin } from './plex';
import { type ServiceLoginContext, ServiceLoginError } from './types';

interface Sent {
  url: string;
  init: OutboundInit;
}

type Reply = { status: number; json?: unknown } | Error;

/** A fake plex.tv: the answers by `METHOD path` (without the query), every request kept. */
function fakePlexTv(replies: Record<string, Reply | Reply[]>) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: OutboundInit): Promise<OutboundResponse> => {
    sent.push({ url, init });
    const u = new URL(url);
    const key = `${init.method} ${u.origin === PLEX_TV ? u.pathname : url}`;
    const queued = replies[key];
    const reply = Array.isArray(queued) ? (queued.shift() ?? { status: 500 }) : queued;
    if (!reply) return { status: 404, headers: {}, body: Buffer.from('') };
    if (reply instanceof Error) throw reply;
    return {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(reply.json === undefined ? '' : JSON.stringify(reply.json)),
    };
  };
  return { sent, fetch };
}

const PLEX = catalogEntry('plex') as CatalogEntry;

function ctxWith(fetch: ServiceLoginContext['fetch']): ServiceLoginContext {
  return {
    entry: PLEX,
    baseUrl: 'http://192.168.1.20:32400',
    fields: { url: 'http://192.168.1.20:32400' },
    name: 'Whombat',
    clientId: 'whombat-abc123',
    fetch,
  };
}

const PIN = { id: 4242, code: 'k3yc0de9', expiresIn: 1800, authToken: null };

describe('Plex’s PIN sign-in (SG-04)', () => {
  it('makes a strong PIN as Whombat, and opens Plex’s page with its code', async () => {
    const plex = fakePlexTv({ 'POST /api/v2/pins': { status: 201, json: PIN } });
    const started = await plexServiceLogin().start(ctxWith(plex.fetch));
    const [create] = plex.sent;
    expect(create?.url).toBe(`${PLEX_TV}/api/v2/pins?strong=true`);
    expect(create?.init.headers).toMatchObject({
      Accept: 'application/json',
      'X-Plex-Product': 'Whombat',
      'X-Plex-Device-Name': 'Whombat',
      'X-Plex-Client-Identifier': 'whombat-abc123',
    });
    expect(started.loginUrl).toBe(
      `${PLEX_APP}/auth#?clientID=whombat-abc123&code=k3yc0de9&context%5Bdevice%5D%5Bproduct%5D=Whombat`,
    );
    expect(started.loginUrl).not.toContain('forwardUrl');
    expect(started).toMatchObject({ userCode: null, pollEveryMs: 2000, ttlMs: 1_800_000 });
    expect(started.state).toEqual({ id: '4242', code: 'k3yc0de9' });
  });

  it('says so when plex.tv is busy or answers oddly, in Whombat’s words', async () => {
    const busy = fakePlexTv({ 'POST /api/v2/pins': { status: 429, json: { error: 'slow down' } } });
    const err = await plexServiceLogin()
      .start(ctxWith(busy.fetch))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceLoginError);
    expect((err as Error).message).toContain('busy');
    const odd = fakePlexTv({ 'POST /api/v2/pins': { status: 201, json: { id: 'x', code: '<script>' } } });
    const oddErr = await plexServiceLogin()
      .start(ctxWith(odd.fetch))
      .catch((e: unknown) => e);
    expect(oddErr).toBeInstanceOf(ServiceLoginError);
    expect((oddErr as Error).message).not.toContain('script');
  });

  it('waits while the PIN has no token, is gone at 404, and keeps waiting through a busy moment', async () => {
    const state = { id: '4242', code: 'k3yc0de9' };
    const plex = fakePlexTv({
      'GET /api/v2/pins/4242': [
        { status: 200, json: PIN },
        { status: 503 },
        { status: 404, json: { errors: [{ code: 1020 }] } },
      ],
    });
    const adapter = plexServiceLogin();
    expect(await adapter.poll(ctxWith(plex.fetch), state)).toEqual({ state: 'pending' });
    expect(plex.sent[0]?.url).toBe(`${PLEX_TV}/api/v2/pins/4242?code=k3yc0de9`);
    expect(plex.sent[0]?.init.headers?.['X-Plex-Client-Identifier']).toBe('whombat-abc123');
    expect(await adapter.poll(ctxWith(plex.fetch), state)).toEqual({ state: 'pending' });
    expect(await adapter.poll(ctxWith(plex.fetch), state)).toEqual({ state: 'expired' });
  });

  it('takes the token once allowed, and asks who the account is with it', async () => {
    const plex = fakePlexTv({
      'GET /api/v2/pins/4242': { status: 200, json: { ...PIN, authToken: 'plex-account-token' } },
      'GET /api/v2/user': { status: 200, json: { username: 'mara', email: 'mara@example.com' } },
    });
    const polled = await plexServiceLogin().poll(ctxWith(plex.fetch), { id: '4242', code: 'k3yc0de9' });
    expect(polled).toEqual({
      state: 'token',
      secret: 'plex-account-token',
      externalName: 'mara@example.com',
    });
    expect(plex.sent[1]?.init.headers?.['X-Plex-Token']).toBe('plex-account-token');
  });

  it('takes the token without a name when plex.tv doesn’t say who it is', async () => {
    const plex = fakePlexTv({
      'GET /api/v2/pins/4242': { status: 200, json: { ...PIN, authToken: 'plex-account-token' } },
      'GET /api/v2/user': new OutboundError('timeout', 'slow'),
    });
    const polled = await plexServiceLogin().poll(ctxWith(plex.fetch), { id: '4242', code: 'k3yc0de9' });
    expect(polled).toMatchObject({ state: 'token', secret: 'plex-account-token', externalName: null });
  });

  it('says a refused check is about the server’s owner, and leaves other failures their own words', () => {
    const refused = { ok: false, refused: true, status: 401, message: 'x' } as CheckOutcome;
    const down = { ok: false, refused: false, status: null, message: 'x' } as CheckOutcome;
    const adapter = plexServiceLogin();
    expect(adapter.checkFailedText?.(PLEX, refused)).toContain('server’s owner');
    expect(adapter.checkFailedText?.(PLEX, down)).toBeNull();
  });

  it('reads a PIN only with an id of digits and a code of letters and digits', () => {
    expect(pinOf({ id: '17', code: 'abc', expiresIn: 'x' })).toEqual({
      id: '17',
      code: 'abc',
      expiresIn: null,
    });
    expect(pinOf({ id: 17.5, code: 'abc' })).toBeNull();
    expect(pinOf({ id: 17, code: 'a b' })).toBeNull();
    expect(plexLoginUrl('https://app.plex.tv', { clientId: 'a&b', code: 'c', name: 'Whombat (Home)' })).toBe(
      'https://app.plex.tv/auth#?clientID=a%26b&code=c&context%5Bdevice%5D%5Bproduct%5D=Whombat%20(Home)',
    );
  });
});
