/**
 * A password traded for a session (docs/decisions/connections-more.md CM-10, CM-11; desk-found.md NS-03, NS-04) against
 * fake http servers playing Pi-hole v6 (`POST /api/auth` → `session.sid` in `X-FTL-SID`, `DELETE /api/auth`), Nginx
 * Proxy Manager (`POST /api/tokens` → a bearer `token` with its `expires`), a Synology-shaped service (a `GET` sign-in
 * with the account in the query → `data.sid`, refusals and an ended session as `error.code` in a 200) and a QNAP-shaped
 * one (a form with a base64 password → the XML `authSid`, refusals as `authPassed` 0 with an `errorValue`).
 */
import { type CatalogEntry, catalogEntry, sessionCredential } from '@whombat/core';
import { afterEach, describe, expect, it } from 'vitest';
import { outboundRequest } from '../lib/outbound';
import { renewedOn } from './http';
import { type Stub, type StubReply, type StubRequest, startStub } from './provision/testing-home';
import {
  accountRefused,
  reauthMessage,
  type SessionAuth,
  SessionError,
  type SessionSend,
  sessionRefusalText,
  signInSession,
  signOutSession,
} from './session';

const PIHOLE: SessionAuth = {
  type: 'session',
  login: { method: 'POST', path: '/api/auth', body: { password: '{secret}' } },
  tokenJsonPath: 'session.sid',
  expiresJsonPath: 'session.validity',
  ttlSeconds: 1800,
  apply: { type: 'header', name: 'X-FTL-SID', template: '{token}' },
  logout: { method: 'DELETE', path: '/api/auth' },
};

const NPM: SessionAuth = {
  type: 'session',
  login: { method: 'POST', path: '/api/tokens', body: { identity: '{username}', secret: '{secret}' } },
  tokenJsonPath: 'token',
  expiresJsonPath: 'expires',
  ttlSeconds: 86_400,
  apply: { type: 'bearer' },
};

const PIHOLE_ENTRY = catalogEntry('pihole') as CatalogEntry;
const NPM_ENTRY = catalogEntry('nginx_proxy_manager') as CatalogEntry;

const APP_PASSWORD = 'Qx7nV2pL9sK4mR8w';
const NOW = new Date('2026-10-19T12:00:00Z');

function fakePihole(sids: string[] = ['sid-one', 'sid-two']) {
  let n = 0;
  return (req: StubRequest): StubReply => {
    if (req.path === '/api/auth' && req.method === 'POST') {
      if (req.json()?.password !== APP_PASSWORD)
        return {
          status: 401,
          json: {
            session: { valid: false, totp: false, sid: null, validity: -1, message: 'password incorrect' },
          },
        };
      const sid = sids[n++ % sids.length];
      return {
        json: { session: { valid: true, totp: false, sid, csrf: 'csrf-x', validity: 1800 }, took: 0.01 },
      };
    }
    if (req.path === '/api/auth' && req.method === 'DELETE') return { status: 204 };
    return { status: 404, json: { error: { key: 'not_found' } } };
  };
}

function fakeNpm(world: { twoStep?: boolean } = {}) {
  return (req: StubRequest): StubReply => {
    if (req.path !== '/api/tokens' || req.method !== 'POST') return { status: 404 };
    const body = req.json();
    if (body?.identity !== 'whombat@example.com' || body?.secret !== APP_PASSWORD)
      return { status: 401, json: { error: { code: 401, message: 'Invalid email or password' } } };
    if (world.twoStep) return { json: { requires_2fa: true, challenge_token: 'chal-1' } };
    return { json: { token: 'eyJhbGciOiJSUzI1NiJ9.npm', expires: '2026-10-20T11:00:00.000Z' } };
  };
}

let stub: Stub | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});

/** Straight to the stub on 127.0.0.1 (the destination policy is the server's: `sessionSend`). */
const send: SessionSend = (url, init) => outboundRequest(url, init, { allowPrivate: true });

describe('signing in for a session (CM-10)', () => {
  it('signs in to Pi-hole with the app password and keeps the session id with its lifetime', async () => {
    stub = await startStub(fakePihole());
    const made = await signInSession(send, {
      entry: PIHOLE_ENTRY,
      auth: PIHOLE,
      baseUrl: stub.url,
      secret: APP_PASSWORD,
      fields: {},
      now: NOW,
    });
    expect(made).toEqual({ token: 'sid-one', expiresAt: new Date(NOW.getTime() + 1800_000) });
    const login = stub.calls('POST /api/auth')[0];
    expect(login?.json()).toEqual({ password: APP_PASSWORD });
    expect(login?.headers['content-type']).toBe('application/json');
    expect(sessionCredential(PIHOLE.apply, made.token)).toEqual({
      headers: { 'X-FTL-SID': 'sid-one' },
      query: {},
    });
  });

  it('signs in to Nginx Proxy Manager with the email field, until the answer’s expiry', async () => {
    stub = await startStub(fakeNpm());
    const made = await signInSession(send, {
      entry: NPM_ENTRY,
      auth: NPM,
      baseUrl: `${stub.url}/`,
      secret: APP_PASSWORD,
      fields: { username: 'whombat@example.com' },
      now: NOW,
    });
    expect(made.token).toBe('eyJhbGciOiJSUzI1NiJ9.npm');
    expect(made.expiresAt.toISOString()).toBe('2026-10-20T11:00:00.000Z');
    expect(sessionCredential(NPM.apply, made.token).headers.Authorization).toBe(
      'Bearer eyJhbGciOiJSUzI1NiJ9.npm',
    );
  });

  it('tells a refused password from a user with two-step sign-in on', async () => {
    stub = await startStub(fakePihole());
    const wrong = await signInSession(send, {
      entry: PIHOLE_ENTRY,
      auth: PIHOLE,
      baseUrl: stub.url,
      secret: 'nope',
      fields: {},
      now: NOW,
    }).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(SessionError);
    expect((wrong as SessionError).reason).toBe('refused');
    await stub.close();

    stub = await startStub(fakeNpm({ twoStep: true }));
    const twoStep = await signInSession(send, {
      entry: NPM_ENTRY,
      auth: NPM,
      baseUrl: stub.url,
      secret: APP_PASSWORD,
      fields: { username: 'whombat@example.com' },
      now: NOW,
    }).catch((e: unknown) => e);
    expect((twoStep as SessionError).reason).toBe('two_step');
    expect(sessionRefusalText({ name: 'Nginx Proxy Manager' }, twoStep as SessionError)).toContain(
      'Turn off two-step sign-in for the user Whombat signs in as.',
    );
  });

  it('reads Pi-hole’s two-step answer to its main password as two-step, in the entry’s words (SG-10)', async () => {
    // FTL v6: the main password with two-step on and no `totp` answers 400 with an `error` object.
    stub = await startStub(() => ({
      status: 400,
      json: { error: { key: 'bad_request', message: 'No 2FA token found in JSON payload', hint: null } },
    }));
    const words = 'Pi-hole asks for a two-step code with that password. Make an app password in Pi-hole.';
    const twoStep = (await signInSession(send, {
      entry: PIHOLE_ENTRY,
      auth: {
        ...PIHOLE,
        failures: [
          {
            json: 'error.message',
            values: ['No 2FA token found in JSON payload', 'Invalid 2FA token', 'Reused 2FA token'],
            reason: 'two_step',
            text: words,
          },
        ],
      },
      baseUrl: stub.url,
      secret: 'main-password',
      fields: {},
      now: NOW,
    }).catch((e: unknown) => e)) as SessionError;
    expect([twoStep.reason, twoStep.text]).toEqual(['two_step', words]);
    expect(accountRefused(twoStep)).toBe(true);
    // The stored connection says the entry's words too, not “turn off two-step sign-in”.
    expect(reauthMessage(PIHOLE_ENTRY, twoStep)).toBe(words);
    expect(reauthMessage(NPM_ENTRY, new SessionError('two_step', 200, 'x'))).toContain('Turn off two-step');
  });

  it('reads Nginx Proxy Manager’s two-step answer with the catalog’s own words', async () => {
    stub = await startStub(fakeNpm({ twoStep: true }));
    const catalogAuth = NPM_ENTRY.signIn.find((m) => m.kind === 'token');
    if (catalogAuth?.kind !== 'token' || catalogAuth.auth.type !== 'session') throw new Error('no session');
    const twoStep = (await signInSession(send, {
      entry: NPM_ENTRY,
      auth: catalogAuth.auth,
      baseUrl: stub.url,
      secret: APP_PASSWORD,
      fields: { username: 'whombat@example.com' },
      now: NOW,
    }).catch((e: unknown) => e)) as SessionError;
    expect(twoStep.reason).toBe('two_step');
    expect(twoStep.text).toContain('Users → Add User');
    expect(sessionRefusalText(NPM_ENTRY, twoStep)).toBe(twoStep.text);
    expect(reauthMessage(NPM_ENTRY, twoStep)).toBe(twoStep.text);
  });

  it('says an older service has no sign-in there, in the entry’s words', async () => {
    stub = await startStub(() => ({ status: 404, body: 'Not Found' }));
    const old = await signInSession(send, {
      entry: PIHOLE_ENTRY,
      auth: { ...PIHOLE, missing: 'This Pi-hole is older than version 6: update it, then connect it.' },
      baseUrl: stub.url,
      secret: APP_PASSWORD,
      fields: {},
      now: NOW,
    }).catch((e: unknown) => e);
    expect((old as SessionError).reason).toBe('missing');
    expect(
      sessionRefusalText({ name: 'Pi-hole' }, old as SessionError, { missing: 'Too old: update it.' }),
    ).toBe('Too old: update it.');
  });

  it('signs a session out with the session applied', async () => {
    stub = await startStub(fakePihole());
    await signOutSession(send, { auth: PIHOLE, baseUrl: stub.url, token: 'sid-one' });
    expect(stub.calls('DELETE /api/auth')[0]?.headers['x-ftl-sid']).toBe('sid-one');
    // No logout in the spec: nothing is sent; a dead service: nothing thrown.
    await signOutSession(send, { auth: NPM, baseUrl: stub.url, token: 't' });
    await signOutSession(send, { auth: PIHOLE, baseUrl: 'http://127.0.0.1:1', token: 't' });
    expect(stub.requests).toHaveLength(1);
  });
});

describe('the pieces (CM-10)', () => {
  it('puts the session in the query when the spec says so', () => {
    expect(sessionCredential({ type: 'query', name: 'sid' }, 'x')).toEqual({
      headers: {},
      query: { sid: 'x' },
    });
  });
});

/* Synology and QNAP's shapes (NS-03, NS-04) ------------------------------------------------------------------------ */

/** Synology DSM's `SYNO.API.Auth`: a GET with the account in the query, `data.sid` as `_sid`, codes in a 200. */
const SYNO: SessionAuth = {
  type: 'session',
  login: {
    method: 'GET',
    path: '/webapi/entry.cgi',
    body: {},
    query: {
      api: 'SYNO.API.Auth',
      version: '6',
      method: 'login',
      account: '{username}',
      passwd: '{secret}',
      session: 'Whombat',
      format: 'sid',
    },
  },
  tokenJsonPath: 'data.sid',
  ttlSeconds: 1800,
  apply: { type: 'query', name: '_sid' },
  logout: {
    method: 'GET',
    path: '/webapi/entry.cgi',
    query: { api: 'SYNO.API.Auth', version: '6', method: 'logout', session: 'Whombat' },
  },
  stale: [{ json: 'error.code', values: ['106', '107', '119'] }],
  failures: [
    { json: 'error.code', values: ['400'], reason: 'refused' },
    { json: 'error.code', values: ['401'], reason: 'disabled' },
    { json: 'error.code', values: ['402'], reason: 'denied' },
    { json: 'error.code', values: ['403', '404', '406'], reason: 'two_step' },
    { json: 'error.code', values: ['407'], reason: 'locked' },
    { json: 'error.code', values: ['410'], reason: 'expired' },
  ],
};

/** QNAP's `authLogin.cgi`: a form with the password in base64, the XML `authSid` as `sid`, `authPassed` 0 refusing. */
const QNAP: SessionAuth = {
  type: 'session',
  login: {
    method: 'POST',
    path: '/cgi-bin/authLogin.cgi',
    encoding: 'form',
    body: { user: '{username}', pwd: '{secret:base64}', serviceKey: '1' },
  },
  tokenXmlTag: 'authSid',
  ttlSeconds: 1800,
  apply: { type: 'query', name: 'sid' },
  stale: [{ xml: 'authPassed', values: ['0'] }],
  failures: [
    { xml: 'errorValue', values: ['-2'], reason: 'locked' },
    { xml: 'authPassed', values: ['0'], reason: 'refused' },
  ],
};

const NAS_ENTRY = { ...NPM_ENTRY, name: 'The NAS' } as CatalogEntry;
const ACCOUNT = { username: 'whombat' };

function fakeSynology(world: { code?: number } = {}) {
  return (req: StubRequest): StubReply => {
    if (req.path !== '/webapi/entry.cgi') return { status: 404 };
    const q = req.query;
    if (q.get('api') === 'SYNO.API.Auth' && q.get('method') === 'login') {
      if (world.code) return { json: { error: { code: world.code }, success: false } };
      if (q.get('account') !== 'whombat' || q.get('passwd') !== APP_PASSWORD)
        return { json: { error: { code: 400 }, success: false } };
      return { json: { data: { sid: 'syno-sid-1', did: 'd' }, success: true } };
    }
    if (q.get('method') === 'logout') return { json: { success: true } };
    return { json: { error: { code: 119 }, success: false } };
  };
}

function fakeQnap(world: { blocked?: boolean } = {}) {
  return (req: StubRequest): StubReply => {
    if (req.path !== '/cgi-bin/authLogin.cgi' || req.method !== 'POST') return { status: 404 };
    const form = req.form();
    const ok =
      form.user === 'whombat' && Buffer.from(form.pwd ?? '', 'base64').toString('utf8') === APP_PASSWORD;
    const xml = (inner: string) => ({
      headers: { 'content-type': 'text/xml' },
      body: `<?xml version="1.0" encoding="UTF-8" ?>\n<QDocRoot version="1.0">${inner}</QDocRoot>`,
    });
    if (world.blocked)
      return xml('<authPassed><![CDATA[0]]></authPassed><errorValue><![CDATA[-2]]></errorValue>');
    if (!ok) return xml('<authPassed><![CDATA[0]]></authPassed><errorValue><![CDATA[-1]]></errorValue>');
    return xml('<authPassed><![CDATA[1]]></authPassed><authSid><![CDATA[qnap-sid-9]]></authSid>');
  };
}

describe('the session sign-in grown for Synology and QNAP (NS-03, NS-04)', () => {
  it('signs in with a GET and the account in the query, reads data.sid and signs out with the session added', async () => {
    stub = await startStub(fakeSynology());
    const made = await signInSession(send, {
      entry: NAS_ENTRY,
      auth: SYNO,
      baseUrl: stub.url,
      secret: APP_PASSWORD,
      fields: ACCOUNT,
      now: NOW,
    });
    expect(made).toEqual({ token: 'syno-sid-1', expiresAt: new Date(NOW.getTime() + 1800_000) });
    const login = stub.requests[0];
    expect(login?.method).toBe('GET');
    expect(login?.body).toBe('');
    expect(login?.query.get('passwd')).toBe(APP_PASSWORD);
    expect(sessionCredential(SYNO.apply, made.token)).toEqual({ headers: {}, query: { _sid: 'syno-sid-1' } });
    await signOutSession(send, { auth: SYNO, baseUrl: stub.url, token: made.token });
    const out = stub.requests[1];
    expect(out?.query.get('method')).toBe('logout');
    expect(out?.query.get('_sid')).toBe('syno-sid-1');
  });

  it('signs in with a form and a base64 password, and reads the session from the XML answer', async () => {
    stub = await startStub(fakeQnap());
    const made = await signInSession(send, {
      entry: NAS_ENTRY,
      auth: QNAP,
      baseUrl: stub.url,
      secret: APP_PASSWORD,
      fields: ACCOUNT,
      now: NOW,
    });
    expect(made.token).toBe('qnap-sid-9');
    const login = stub.requests[0];
    expect(login?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(login?.form().pwd).toBe(Buffer.from(APP_PASSWORD).toString('base64'));
  });

  it('reads why a 200 refused the sign-in, in the person’s words, and which refusals are the account’s', async () => {
    const reasons: Record<number, string> = {
      400: 'refused',
      401: 'disabled',
      402: 'denied',
      403: 'two_step',
      407: 'locked',
      410: 'expired',
    };
    for (const [code, reason] of Object.entries(reasons)) {
      stub = await startStub(fakeSynology({ code: Number(code) }));
      const err = (await signInSession(send, {
        entry: NAS_ENTRY,
        auth: SYNO,
        baseUrl: stub.url,
        secret: APP_PASSWORD,
        fields: ACCOUNT,
        now: NOW,
      }).catch((e: unknown) => e)) as SessionError;
      expect(err, code).toBeInstanceOf(SessionError);
      expect(err.reason, code).toBe(reason);
      expect(sessionRefusalText(NAS_ENTRY, err), code).toContain('The NAS');
      expect(accountRefused(err), code).toBe(reason !== 'locked');
      await stub.close();
      stub = null;
    }
    expect(
      sessionRefusalText(NAS_ENTRY, new SessionError('two_step', 200, 'x', null)).toLowerCase(),
    ).toContain('two-step');

    stub = await startStub(fakeQnap({ blocked: true }));
    const blocked = (await signInSession(send, {
      entry: NAS_ENTRY,
      auth: QNAP,
      baseUrl: stub.url,
      secret: APP_PASSWORD,
      fields: ACCOUNT,
      now: NOW,
    }).catch((e: unknown) => e)) as SessionError;
    expect(blocked.reason).toBe('locked');
    await stub.close();
    stub = await startStub(fakeQnap());
    const wrong = (await signInSession(send, {
      entry: NAS_ENTRY,
      auth: QNAP,
      baseUrl: stub.url,
      secret: 'nope',
      fields: ACCOUNT,
      now: NOW,
    }).catch((e: unknown) => e)) as SessionError;
    expect(wrong.reason).toBe('refused');
  });

  it('says a field the sign-in needs is missing before sending anything', async () => {
    stub = await startStub(fakeSynology());
    const err = (await signInSession(send, {
      entry: NAS_ENTRY,
      auth: SYNO,
      baseUrl: stub.url,
      secret: APP_PASSWORD,
      fields: {},
      now: NOW,
    }).catch((e: unknown) => e)) as SessionError;
    expect(err.reason).toBe('other');
    expect(stub.requests).toHaveLength(0);
  });

  it('signs in again on an answer that says the session ended, only for a session that has such rules', () => {
    const row = (auth: SessionAuth) => ({ signIn: 'token' as const, auth });
    const ended = {
      body: Buffer.from('{"error":{"code":119},"success":false}'),
      url: 'https://nas:5001/webapi/entry.cgi?api=x',
    };
    const fine = { body: Buffer.from('{"data":{},"success":true}'), url: ended.url };
    expect(renewedOn(row(SYNO), 200, ended)).toBe(true);
    expect(renewedOn(row(SYNO), 200, fine)).toBe(false);
    expect(renewedOn(row(SYNO), 500, ended)).toBe(false);
    expect(renewedOn(row(PIHOLE), 200, ended)).toBe(false);
    expect(renewedOn(row(PIHOLE), 401)).toBe(true);
    const qnapEnded = {
      body: Buffer.from('<QDocRoot><authPassed><![CDATA[0]]></authPassed></QDocRoot>'),
      url: 'https://nas/cgi-bin/x.cgi',
    };
    expect(renewedOn(row(QNAP), 200, qnapEnded)).toBe(true);
  });
});

/* Two-step sign-in asked once (connection-signin.md SG-09) ------------------------------------------------------------- */

/** Synology DSM's form sign-in with contracts 0.111.0's `twoStep` (CT-732, CT-740). */
const DSM_TWO_STEP = {
  type: 'session',
  login: {
    method: 'POST',
    path: '/webapi/entry.cgi',
    query: { api: 'SYNO.API.Auth', version: '6', method: 'login' },
    encoding: 'form',
    body: { account: '{username}', passwd: '{secret}', session: 'webui', format: 'sid' },
  },
  tokenJsonPath: 'data.sid',
  ttlSeconds: 1800,
  apply: { type: 'query', name: '_sid' },
  failures: [
    { json: 'error.code', values: ['400'], reason: 'refused' },
    {
      json: 'error.code',
      values: ['406'],
      reason: 'two_step',
      text: 'DSM requires two-step sign-in for this user.',
    },
  ],
  twoStep: {
    asked: { json: 'error.code', values: ['403'] },
    wrongCode: { json: 'error.code', values: ['404'] },
    code: { name: 'otp_code' },
    remember: {
      body: { enable_device_token: 'yes', device_name: 'Whombat' },
      tokenJsonPaths: ['data.device_id', 'data.did'],
      name: 'device_id',
      with: { device_name: 'Whombat' },
    },
    again: 'Synology asks for a two-step code again. Replace the password and enter a code.',
  },
} as SessionAuth;

/** A DSM user with two-step sign-in: code 246810, and the devices it trusts. */
function fakeDsmTwoStep(world: { trusted: Set<string>; enforced?: boolean }) {
  return (req: StubRequest): StubReply => {
    const form = req.form();
    if (form.account !== 'whombat' || form.passwd !== APP_PASSWORD)
      return { json: { error: { code: 400 }, success: false } };
    if (world.enforced) return { json: { error: { code: 406 }, success: false } };
    if (form.device_id && world.trusted.has(form.device_id))
      return { json: { data: { sid: 'sid-trusted' }, success: true } };
    if (!form.otp_code)
      return { json: { error: { code: 403, errors: { types: [{ type: 'otp' }] } }, success: false } };
    if (form.otp_code !== '246810') return { json: { error: { code: 404 }, success: false } };
    const did = form.enable_device_token === 'yes' ? `did-${world.trusted.size + 1}` : undefined;
    if (did) world.trusted.add(did);
    return { json: { data: { sid: 'sid-coded', ...(did ? { did } : {}) }, success: true } };
  };
}

describe('two-step sign-in asked once (SG-09)', () => {
  const signIn = (extras: { code?: string; remembered?: string } = {}) =>
    signInSession(send, {
      entry: NAS_ENTRY,
      auth: DSM_TWO_STEP,
      baseUrl: stub?.url ?? '',
      secret: APP_PASSWORD,
      fields: ACCOUNT,
      now: NOW,
      ...extras,
    }).catch((e: unknown) => e as SessionError);

  it('asks for a code, refuses a wrong one, and keeps the device token a right one gets', async () => {
    const world = { trusted: new Set<string>() };
    stub = await startStub(fakeDsmTwoStep(world));
    const asked = (await signIn()) as SessionError;
    expect([asked.reason, accountRefused(asked)]).toEqual(['code_needed', true]);
    const wrong = (await signIn({ code: '111111' })) as SessionError;
    expect(wrong.reason).toBe('wrong_code');
    const made = await signIn({ code: '246 810' });
    expect(made).toMatchObject({ token: 'sid-coded', remembered: 'did-1' });
    const coded = stub.requests.at(-1)?.form();
    expect(coded).toMatchObject({ otp_code: '246810', enable_device_token: 'yes', device_name: 'Whombat' });
    expect(coded).not.toHaveProperty('device_id');
  });

  it('sends the device token instead of a code, and needs a new sign-in when DSM forgot it', async () => {
    const world = { trusted: new Set(['did-7']) };
    stub = await startStub(fakeDsmTwoStep(world));
    expect(await signIn({ remembered: 'did-7' })).toMatchObject({ token: 'sid-trusted' });
    const sent = stub.requests.at(-1)?.form();
    expect(sent).toMatchObject({ device_id: 'did-7', device_name: 'Whombat' });
    expect(sent).not.toHaveProperty('otp_code');
    world.trusted.clear();
    const again = (await signIn({ remembered: 'did-7' })) as SessionError;
    expect(again.reason).toBe('code_needed');
    expect(reauthMessage(NAS_ENTRY, again, DSM_TWO_STEP)).toBe(
      'Synology asks for a two-step code again. Replace the password and enter a code.',
    );
    expect(sessionRefusalText(NAS_ENTRY, again)).toContain('authenticator app');
  });

  it('says two-step sign-in is enforced but not set up in the entry’s own words', async () => {
    stub = await startStub(fakeDsmTwoStep({ trusted: new Set(), enforced: true }));
    const enforced = (await signIn()) as SessionError;
    expect([enforced.reason, enforced.text]).toEqual([
      'two_step',
      'DSM requires two-step sign-in for this user.',
    ]);
  });
});
