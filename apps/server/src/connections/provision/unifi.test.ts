/**
 * Sign in once for UniFi OS (docs/decisions/connections-setup.md CS-30) against a stub console over https: the
 * login with its CSRF token and second factor (499 and the `UBIC_2FA` challenge cookie), the key, the logout. The stub
 * plays a console that makes a new challenge for every password POST that doesn't answer a live one, and an emailed code
 * that only answers its own challenge (connection-signin.md SG-06, SG-07).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cookiesOf,
  networkInput,
  PASSWORD,
  refusalOf,
  type SeenRequest,
  type StubReply,
  type StubServer,
  startStub,
} from './testing-network';
import { maskedEmail, provisionUnifi } from './unifi';

const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${part({ alg: 'HS256' })}.${part({ userId: 'u-1', csrfToken: 'csrf-1' })}.c2ln`;

const knobs = {
  legacy: false,
  mfa: false,
  /** The account's second factor: an authenticator app (any challenge takes 123456) or an emailed code per challenge. */
  factor: 'app' as 'app' | 'email',
  /** `data.authenticators` of the 499. */
  authenticators: [] as object[],
  /** The challenges the console made, with the code each takes. */
  challenges: new Map<string, string>(),
  /** Where the 499 puts the challenge cookie. */
  mfaCookieIn: 'body' as 'body' | 'header',
  locked: false,
  owner: true,
  selfMissing: false,
  /** The console sends no CSRF header: the token is a claim of the session's JWT. */
  csrfInJwt: false,
  taken: new Set<string>(),
};

function unifiConsole(req: SeenRequest): StubReply {
  const path = req.path.split('?')[0];
  const cookies = cookiesOf(req.headers.cookie);
  if (req.method === 'GET' && path === '/api/system') {
    return knobs.legacy
      ? { status: 404, body: 'Not found' }
      : { status: 200, body: { hardware: { shortname: 'UDMPRO' }, name: 'Dream Machine' } };
  }
  if (req.method === 'POST' && path === '/api/auth/login') {
    if (knobs.locked) return { status: 429, body: { code: 'TOO_MANY_REQUESTS' } };
    const body = JSON.parse(req.body) as Record<string, unknown>;
    if (body.username !== 'admin' || body.password !== PASSWORD) {
      return {
        status: 401,
        body: {
          code: 'AUTHENTICATION_FAILED_INVALID_CREDENTIALS',
          message: `bad password ${String(body.password)}`,
        },
      };
    }
    if (knobs.mfa) {
      const live = cookies.UBIC_2FA ? knobs.challenges.get(cookies.UBIC_2FA) : undefined;
      if (live === undefined || body.token !== live) {
        // A new challenge (and, for an emailed code, a new email) for every POST that doesn't answer a live one.
        const n = knobs.challenges.size + 1;
        const value = `challenge-${n}`;
        knobs.challenges.set(value, knobs.factor === 'email' ? `${100000 + n}` : '123456');
        const cookie = `UBIC_2FA=${value}; path=/; samesite=none; secure; httponly`;
        return {
          status: 499,
          headers: knobs.mfaCookieIn === 'header' ? { 'set-cookie': [cookie] } : {},
          body: {
            message: 'MFA token required to authenticate to SSO',
            code: 'MFA_AUTH_REQUIRED',
            data: {
              required: '2fa',
              ...(knobs.mfaCookieIn === 'body' ? { mfaCookie: cookie } : {}),
              authenticators: knobs.authenticators,
            },
          },
        };
      }
    }
    return {
      status: 200,
      headers: {
        'set-cookie': [`TOKEN=${knobs.csrfInJwt ? JWT : 'jwt-1'}; path=/; samesite=none; secure; httponly`],
        ...(knobs.csrfInJwt ? {} : { 'x-csrf-token': 'csrf-1' }),
      },
      body: { unique_id: 'u-1', username: 'admin', email: 'admin@home.test', isOwner: knobs.owner },
    };
  }
  const signedIn = cookies.TOKEN === 'jwt-1' || cookies.TOKEN === JWT;
  if (req.method === 'POST' && /^\/proxy\/users\/api\/v2\/user\/[^/]+\/keys$/.test(path ?? '')) {
    if (!signedIn) return { status: 401, body: { error: 'unauthorized' } };
    if (req.headers['x-csrf-token'] !== 'csrf-1') return { status: 403, body: { error: 'csrf' } };
    if (path?.includes('/self/') && knobs.selfMissing) return { status: 404, body: { error: 'not found' } };
    if (!knobs.owner) return { status: 403, body: { error: 'forbidden' } };
    const { name } = JSON.parse(req.body) as { name: string };
    if (knobs.taken.has(name)) return { status: 400, body: { error: 'api key name already exists' } };
    return {
      status: 200,
      headers: { 'x-updated-csrf-token': 'csrf-2' },
      body: { data: { id: 'k-1', name, full_api_key: 'unifi-key-1' } },
    };
  }
  if (req.method === 'POST' && path === '/api/auth/logout') return { status: 200, body: {} };
  return { status: 404, body: 'Not found' };
}

let stub: StubServer;

beforeAll(async () => {
  stub = await startStub(unifiConsole, { tls: true });
});

afterAll(async () => {
  await stub.close();
});

beforeEach(() => {
  stub.requests.length = 0;
  Object.assign(knobs, {
    legacy: false,
    mfa: false,
    factor: 'app',
    authenticators: [],
    challenges: new Map<string, string>(),
    mfaCookieIn: 'body',
    locked: false,
    owner: true,
    selfMissing: false,
    csrfInJwt: false,
    taken: new Set<string>(),
  });
});

const network = (overrides = {}) =>
  networkInput('unifi_network', stub, { baseUrl: `${stub.url}/proxy/network/integration`, ...overrides });

describe('UniFi sign in once (CS-30)', () => {
  it('signs in at the console’s root, makes a key named Whombat with the CSRF token and logs out', async () => {
    const made = await provisionUnifi(network());
    expect(made).toEqual({
      fields: {},
      secret: 'unifi-key-1',
      limited: false,
      externalName: 'admin',
      note: null,
    });

    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/system',
      'POST /api/auth/login',
      'POST /proxy/users/api/v2/user/self/keys',
      'POST /api/auth/logout',
    ]);
    const [, login, key, logout] = stub.requests as [SeenRequest, SeenRequest, SeenRequest, SeenRequest];
    // The first round sends no code (SG-07).
    expect(JSON.parse(login.body)).toEqual({ username: 'admin', password: PASSWORD, rememberMe: false });
    expect(login.headers['content-type']).toBe('application/json');
    expect(JSON.parse(key.body)).toEqual({ name: 'Whombat', description: 'Made by Whombat for its agents' });
    expect(key.headers['x-csrf-token']).toBe('csrf-1');
    expect(cookiesOf(key.headers.cookie)).toEqual({ TOKEN: 'jwt-1' });
    // The CSRF token the key's answer updated is the one the logout sends.
    expect(logout.headers['x-csrf-token']).toBe('csrf-2');
    expect(cookiesOf(logout.headers.cookie)).toEqual({ TOKEN: 'jwt-1' });
  });

  it('makes the same key for Manage and for UniFi Protect: UniFi can’t limit it', async () => {
    const managed = await provisionUnifi(network({ access: 'manage' }));
    expect(managed.limited).toBe(false);
    const protect = await provisionUnifi(
      networkInput('unifi_protect', stub, {
        baseUrl: `${stub.url}/proxy/protect/integration`,
        access: 'manage',
      }),
    );
    expect(protect.secret).toBe('unifi-key-1');
    const keys = stub.to('POST', '/proxy/users/api/v2/user/self/keys');
    expect(keys.map((r) => JSON.parse(r.body))).toEqual([
      { name: 'Whombat', description: 'Made by Whombat for its agents' },
      { name: 'Whombat', description: 'Made by Whombat for its agents' },
    ]);
  });

  it('asks for the code when the console answers 499, handing back its challenge', async () => {
    knobs.mfa = true;
    const err = await refusalOf(provisionUnifi(network()));
    expect([err.code, err.challenge]).toEqual(['second_factor_needed', 'challenge-1']);
    expect(err.message).toBe(
      'Enter the code from your authenticator app, or the one UniFi just emailed you.',
    );
    expect(JSON.parse(stub.to('POST', '/api/auth/login')[0]?.body ?? '{}')).not.toHaveProperty('token');
    expect(stub.to('POST', '/proxy/users/api/v2/user/self/keys')).toHaveLength(0);
  });

  it('words the ask from the account’s authenticators, the address masked', async () => {
    knobs.mfa = true;
    knobs.authenticators = [{ type: 'totp' }];
    expect((await refusalOf(provisionUnifi(network()))).message).toMatch(/authenticator app\.$/);
    knobs.authenticators = [{ type: 'email', email: 'mara@example.com' }];
    const emailed = await refusalOf(provisionUnifi(network()));
    expect(emailed.message).toContain('emailed to m•••@example.com');
    expect(emailed.message).not.toContain('authenticator');
    knobs.authenticators = [{ type: 'totp' }, { type: 'email', email: 'mara@example.com' }];
    const both = (await refusalOf(provisionUnifi(network()))).message;
    expect([both.includes('authenticator app'), both.includes('m•••@example.com')]).toEqual([true, true]);
  });

  it('refuses an account that only confirms in UI Verify or with a passkey, pointing at a key', async () => {
    knobs.mfa = true;
    knobs.authenticators = [{ type: 'push' }, { type: 'webauthn' }];
    const err = await refusalOf(provisionUnifi(network()));
    expect([err.code, err.reason, err.method]).toEqual(['sign_in_refused', 'second_factor', 'token']);
    expect(err.message).toContain('UI Verify');
    expect(err.challenge).toBeNull();
  });

  it('answers the challenge with the emailed code in one POST', async () => {
    knobs.mfa = true;
    knobs.factor = 'email';
    const ask = await refusalOf(provisionUnifi(network()));
    expect(ask.challenge).toBe('challenge-1');
    stub.requests.length = 0;
    const made = await provisionUnifi(network({ code: '100 001', challenge: ask.challenge }));
    expect(made.secret).toBe('unifi-key-1');
    const logins = stub.to('POST', '/api/auth/login');
    expect(logins).toHaveLength(1);
    expect(cookiesOf(logins[0]?.headers.cookie)).toEqual({ UBIC_2FA: 'challenge-1' });
    expect(JSON.parse(logins[0]?.body ?? '')).toMatchObject({ token: '100001', password: PASSWORD });
  });

  it('refuses a wrong code as the code, handing back the console’s new challenge', async () => {
    knobs.mfa = true;
    knobs.factor = 'email';
    await refusalOf(provisionUnifi(network()));
    const err = await refusalOf(provisionUnifi(network({ code: '999999', challenge: 'challenge-1' })));
    expect([err.code, err.reason, err.challenge]).toEqual(['sign_in_refused', 'code', 'challenge-2']);
    expect(err.message).toBe('That code didn’t work. Enter the newest code.');
    // The newest code answers the newest challenge.
    const made = await provisionUnifi(network({ code: '100002', challenge: err.challenge }));
    expect(made.secret).toBe('unifi-key-1');
    expect(stub.to('POST', '/proxy/users/api/v2/user/self/keys')).toHaveLength(1);
  });

  it('starts fresh with a code but no challenge: a POST without it, then the code with the new challenge', async () => {
    knobs.mfa = true;
    const made = await provisionUnifi(network({ code: '123 456' }));
    expect(made.secret).toBe('unifi-key-1');
    const logins = stub.to('POST', '/api/auth/login');
    expect(logins).toHaveLength(2);
    expect(JSON.parse(logins[0]?.body ?? '')).not.toHaveProperty('token');
    expect(cookiesOf(logins[0]?.headers.cookie)).toEqual({});
    expect(JSON.parse(logins[1]?.body ?? '')).toMatchObject({ token: '123456', password: PASSWORD });
    expect(cookiesOf(logins[1]?.headers.cookie)).toEqual({ UBIC_2FA: 'challenge-1' });
  });

  it('takes the challenge cookie from Set-Cookie when the body has none', async () => {
    knobs.mfa = true;
    knobs.mfaCookieIn = 'header';
    expect((await refusalOf(provisionUnifi(network()))).challenge).toBe('challenge-1');
    const made = await provisionUnifi(network({ code: '123456' }));
    expect(made.secret).toBe('unifi-key-1');
    expect(cookiesOf(stub.to('POST', '/api/auth/login').at(-1)?.headers.cookie)).toEqual({
      UBIC_2FA: 'challenge-2',
    });
  });

  it('masks an address to its first letter and its domain', () => {
    expect(maskedEmail('mara@example.com')).toBe('m•••@example.com');
    expect(maskedEmail('@example.com')).toBeNull();
    expect(maskedEmail('mara@')).toBeNull();
  });

  it('refuses a wrong password once, never tries again, and never echoes the console’s text', async () => {
    const err = await refusalOf(provisionUnifi(network({ password: 'not-it' })), 'not-it');
    expect([err.code, err.reason, err.message]).toEqual([
      'sign_in_refused',
      'password',
      'Wrong username or password.',
    ]);
    expect(stub.to('POST', '/api/auth/login')).toHaveLength(1);
  });

  it('says when sign-ins are paused', async () => {
    knobs.locked = true;
    const err = await refusalOf(provisionUnifi(network()));
    expect(err.reason).toBe('locked');
  });

  it('refuses an account that may not make keys, and still logs out', async () => {
    knobs.owner = false;
    const err = await refusalOf(provisionUnifi(network()));
    expect([err.reason, err.message]).toEqual(['rights', 'Sign in as the console’s Owner or a Super Admin.']);
    expect(stub.to('POST', '/api/auth/logout')).toHaveLength(1);
  });

  it('reads the CSRF token from the session’s JWT when the console sends no header', async () => {
    knobs.csrfInJwt = true;
    const made = await provisionUnifi(network());
    expect(made.secret).toBe('unifi-key-1');
    expect(stub.to('POST', '/proxy/users/api/v2/user/self/keys')[0]?.headers['x-csrf-token']).toBe('csrf-1');
  });

  it('makes the key under the user’s id when the console doesn’t know `self`', async () => {
    knobs.selfMissing = true;
    const made = await provisionUnifi(network());
    expect(made.secret).toBe('unifi-key-1');
    expect(stub.to('POST', '/proxy/users/api/v2/user/u-1/keys')).toHaveLength(1);
  });

  it('takes the next name when Whombat is taken', async () => {
    knobs.taken = new Set(['Whombat', 'Whombat 2']);
    await provisionUnifi(network());
    const names = stub.to('POST', '/proxy/users/api/v2/user/self/keys').map((r) => JSON.parse(r.body).name);
    expect(names).toEqual(['Whombat', 'Whombat 2', 'Whombat 3']);
  });

  it('refuses the older Network Server before sending the password', async () => {
    knobs.legacy = true;
    const err = await refusalOf(provisionUnifi(network()));
    expect([err.reason, err.message]).toEqual([
      'unsupported',
      'This is the older Network Server: API keys need a UniFi OS console.',
    ]);
    expect(stub.to('POST', '/api/auth/login')).toHaveLength(0);
  });
});
