/**
 * Sign in once for OPNsense (docs/decisions/connections-setup.md CS-31) against a stub firewall over https: the login
 * form's random CSRF field, the session renewed at sign-in, the code in the password field (both orders), the key and
 * secret, the logout.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { csrfField, provisionOpnsense } from './opnsense';
import {
  cookiesOf,
  formOf,
  networkInput,
  PASSWORD,
  refusalOf,
  type SeenRequest,
  type StubReply,
  type StubServer,
  startStub,
} from './testing-network';

const KEY = 'w86XNZob8Oq8aC5rA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1vW2xY3z4A5b6C7d8E9f0G1h2I3j4K5l6';
const SECRET = 'oPnSeCrEt0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345678';

const USERS = new Set(['root', 'mara@corp']);

const knobs = {
  /** The account's 2FA code, or null without 2FA. */
  totp: null as string | null,
  /** OPNsense's “Reverse token order”: the password before the code. */
  reversed: false,
  rights: true,
  old: false,
  rebind: false,
  localUser: true,
};

interface PhpSession {
  csrfKey: string;
  csrfToken: string;
  user: string | null;
}
const sessions = new Map<string, PhpSession>();
let nextSession = 1;

function newSession(data?: PhpSession): string {
  const id = `sess${nextSession++}`;
  sessions.set(id, data ?? { csrfKey: `k${id}Rn4`, csrfToken: `tok-${id}`, user: null });
  return id;
}

function loginPage(session: PhpSession, error: string | null): string {
  return `<html><head><script>xhr.setRequestHeader("X-CSRFToken", "${session.csrfToken}" );</script></head><body>
<div id="inputerrors" class="text-danger">${error ?? '&nbsp;'}</div>
<form class="clearfix" id="iform" name="iform" method="post" autocomplete="off"><input type="hidden" name="${session.csrfKey}" value="${session.csrfToken}" autocomplete="new-password" />
<input id="usernamefld" type="text" name="usernamefld" class="form-control user" />
<input id="passwordfld" type="password" name="passwordfld" class="form-control pwd" />
<button type="submit" name="login" value="1">Login</button></form></body></html>`;
}

function firewall(req: SeenRequest): StubReply {
  const path = req.path;
  let id = cookiesOf(req.headers.cookie).PHPSESSID;
  let session = id ? sessions.get(id) : undefined;
  const setCookie: string[] = [];
  if (!session) {
    id = newSession();
    session = sessions.get(id) as PhpSession;
    setCookie.push(`PHPSESSID=${id}; path=/; secure; HttpOnly; SameSite=Lax`);
  }
  if (req.method === 'GET' && path === '/') {
    if (knobs.rebind)
      return {
        status: 200,
        body: '<html><body>A potential DNS Rebind attack has been detected.</body></html>',
      };
    return { status: 200, headers: { 'set-cookie': setCookie }, body: loginPage(session, null) };
  }
  if (req.method === 'POST' && path === '/') {
    const form = formOf(req.body);
    if (form[session.csrfKey] !== session.csrfToken)
      return { status: 403, body: '<html>CSRF check failed</html>' };
    const expected = knobs.totp ? (knobs.reversed ? PASSWORD + knobs.totp : knobs.totp + PASSWORD) : PASSWORD;
    if (USERS.has(form.usernamefld ?? '') && form.passwordfld === expected && form.login === '1') {
      // session_regenerate_id(): a new id, the same data.
      const renewed = newSession({ ...session, user: form.usernamefld ?? null });
      sessions.delete(id as string);
      return {
        status: 302,
        headers: {
          location: '/ui/core/dashboard',
          'set-cookie': [`PHPSESSID=${renewed}; path=/; secure; HttpOnly`],
        },
      };
    }
    return { status: 200, body: loginPage(session, `Wrong username or password. (${form.passwordfld})`) };
  }
  if (req.method === 'POST' && path.startsWith('/api/auth/user/add_api_key/')) {
    if (knobs.old) return { status: 404, body: { errorMessage: 'Endpoint not found' } };
    if (!session.user || req.headers['x-csrftoken'] !== session.csrfToken) {
      return { status: 403, body: { status: 403, message: 'Forbidden' } };
    }
    if (!knobs.rights) return { status: 403, body: { status: 403, message: 'Forbidden' } };
    const user = decodeURIComponent(path.slice('/api/auth/user/add_api_key/'.length));
    if (!knobs.localUser || user !== session.user) return { status: 200, body: { result: 'failed' } };
    return { status: 200, body: { result: 'ok', hostname: 'fw.home.test', key: KEY, secret: SECRET } };
  }
  if (req.method === 'GET' && path === '/?logout') {
    sessions.delete(id as string);
    return {
      status: 302,
      headers: { location: '/', 'set-cookie': ['PHPSESSID=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT'] },
    };
  }
  return { status: 404, body: 'Not found' };
}

let stub: StubServer;

beforeAll(async () => {
  stub = await startStub(firewall, { tls: true });
});

afterAll(async () => {
  await stub.close();
});

beforeEach(() => {
  stub.requests.length = 0;
  sessions.clear();
  nextSession = 1;
  Object.assign(knobs, {
    totp: null,
    reversed: false,
    rights: true,
    old: false,
    rebind: false,
    localUser: true,
  });
});

const input = (overrides = {}) => networkInput('opnsense', stub, { account: 'root', ...overrides });

describe('OPNsense sign in once (CS-31)', () => {
  it('reads the random CSRF field, signs in, makes a key and secret with X-CSRFToken, and logs out', async () => {
    const made = await provisionOpnsense(input());
    expect(made).toEqual({
      fields: { apiKey: KEY },
      secret: SECRET,
      limited: false,
      externalName: 'root',
      note: null,
    });

    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /',
      'POST /',
      'POST /api/auth/user/add_api_key/root',
      'GET /?logout',
    ]);
    const [, login, key, logout] = stub.requests as [SeenRequest, SeenRequest, SeenRequest, SeenRequest];
    expect(formOf(login.body)).toEqual({
      ksess1Rn4: 'tok-sess1',
      usernamefld: 'root',
      passwordfld: PASSWORD,
      login: '1',
    });
    expect(login.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(cookiesOf(login.headers.cookie)).toEqual({ PHPSESSID: 'sess1' });
    // The session renewed at sign-in, the token from the login page.
    expect(cookiesOf(key.headers.cookie)).toEqual({ PHPSESSID: 'sess2' });
    expect(key.headers['x-csrftoken']).toBe('tok-sess1');
    expect(key.body).toBe('{}');
    expect(cookiesOf(logout.headers.cookie)).toEqual({ PHPSESSID: 'sess2' });
    expect(sessions.has('sess2')).toBe(false);
  });

  it('makes the same key for Manage: OPNsense gives a key its user’s rights', async () => {
    const made = await provisionOpnsense(input({ access: 'manage' }));
    expect(made.limited).toBe(false);
    expect(stub.to('POST', '/api/auth/user/add_api_key/root')).toHaveLength(1);
  });

  it('puts the code before the password first', async () => {
    knobs.totp = '123456';
    const made = await provisionOpnsense(input({ code: '123456' }));
    expect(made.secret).toBe(SECRET);
    const logins = stub.to('POST', '/');
    expect(logins.map((r) => formOf(r.body).passwordfld)).toEqual([`123456${PASSWORD}`]);
  });

  it('tries the code after the password once when the firewall reverses the order', async () => {
    knobs.totp = '123456';
    knobs.reversed = true;
    const made = await provisionOpnsense(input({ code: '123 456' }));
    expect(made.secret).toBe(SECRET);
    const logins = stub.to('POST', '/');
    expect(logins.map((r) => formOf(r.body).passwordfld)).toEqual([`123456${PASSWORD}`, `${PASSWORD}123456`]);
  });

  it('refuses a wrong code after the two orders, and no more', async () => {
    knobs.totp = '123456';
    const err = await refusalOf(provisionOpnsense(input({ code: '000000' })));
    expect([err.code, err.reason, err.message]).toEqual([
      'sign_in_refused',
      'password',
      'Wrong username, password or code.',
    ]);
    expect(stub.to('POST', '/')).toHaveLength(2);
    expect(stub.to('POST', '/api/auth/user/add_api_key/root')).toHaveLength(0);
  });

  it('refuses a wrong password once and never echoes the page', async () => {
    const err = await refusalOf(provisionOpnsense(input({ password: 'not-it' })), 'not-it');
    expect([err.reason, err.message]).toEqual([
      'password',
      'Wrong username or password. If the account asks for a 2FA code, enter it too.',
    ]);
    expect(stub.to('POST', '/')).toHaveLength(1);
  });

  it('refuses an account without the privilege, and still logs out', async () => {
    knobs.rights = false;
    const err = await refusalOf(provisionOpnsense(input()));
    expect(err.reason).toBe('rights');
    expect(stub.to('GET', '/')).toHaveLength(2);
    expect(stub.requests.at(-1)?.path).toBe('/?logout');
  });

  it('refuses a firewall older than 25.1', async () => {
    knobs.old = true;
    const err = await refusalOf(provisionOpnsense(input()));
    expect([err.reason, err.message]).toEqual([
      'unsupported',
      'This OPNsense is older than 25.1: make an API key by hand instead.',
    ]);
  });

  it('refuses a user OPNsense doesn’t keep keys for', async () => {
    knobs.localUser = false;
    const err = await refusalOf(provisionOpnsense(input()));
    expect(err.reason).toBe('unsupported');
  });

  it('says what to do about the DNS rebinding check, before sending the password', async () => {
    knobs.rebind = true;
    const err = await refusalOf(provisionOpnsense(input()));
    expect(err.reason).toBe('unsupported');
    expect(err.message).toContain('Alternate Hostnames');
    expect(stub.to('POST', '/')).toHaveLength(0);
  });

  it('encodes the user in the path', async () => {
    const made = await provisionOpnsense(input({ account: 'mara@corp' }));
    expect(made.externalName).toBe('mara@corp');
    expect(stub.to('POST', '/api/auth/user/add_api_key/mara%40corp')).toHaveLength(1);
  });
});

describe('csrfField', () => {
  it('finds the hidden input whatever its attributes’ order', () => {
    expect(
      csrfField(
        '<form method="post"><input value="v1" autocomplete="new-password" name="r4nd" type="hidden"/>',
      ),
    ).toEqual({
      name: 'r4nd',
      value: 'v1',
    });
    expect(csrfField('<input type="text" name="usernamefld" />')).toBeNull();
  });
});
