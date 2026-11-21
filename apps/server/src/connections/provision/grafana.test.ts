/**
 * Sign in once for Grafana (docs/decisions/connections-setup.md CS-34) against a stub: basic auth, the service account
 * and its role (an existing one of exactly that name, its role set), the token's timestamped name, the login cookie
 * where basic auth is off (no Origin), Grafana Cloud refused, the refusals.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { provisionGrafana } from './grafana';
import {
  basicOf,
  cookiesOf,
  networkInput,
  PASSWORD,
  refusalOf,
  type SeenRequest,
  type StubReply,
  type StubServer,
  startStub,
} from './testing-network';

interface Account {
  id: number;
  name: string;
  role: string;
  isDisabled: boolean;
  tokens: string[];
}

const knobs = {
  basicOff: false,
  loginFormOff: false,
  blocked: false,
  orgRole: 'Admin',
  old: false,
};
let accounts: Account[] = [];
let tokenNames = new Set<string>();
let sessions = new Set<string>();

const json = (status: number, body: object): StubReply => ({ status, body });

function grafana(req: SeenRequest): StubReply {
  const [path = '', query = ''] = req.path.split('?');
  if (req.method === 'POST' && path === '/login') {
    if (knobs.loginFormOff) return { status: 404, body: 'Not found' };
    const { user, password } = JSON.parse(req.body) as { user: string; password: string };
    if (knobs.blocked) return json(401, { message: 'Login temporarily blocked' });
    if (user !== 'admin' || password !== PASSWORD)
      return json(401, { message: `Invalid username or password ${password}` });
    sessions.add('sess1');
    return {
      status: 200,
      headers: {
        'set-cookie': [
          'grafana_session=sess1; Path=/; HttpOnly; SameSite=Lax',
          'grafana_session_expiry=1791000000; Path=/',
        ],
      },
      body: { message: 'Logged in', redirectUrl: '/' },
    };
  }
  if (req.method === 'GET' && path === '/logout') {
    sessions.delete(cookiesOf(req.headers.cookie).grafana_session ?? '');
    return { status: 302, headers: { location: '/login', 'set-cookie': ['grafana_session=; Max-Age=0'] } };
  }

  // Who is asking: basic auth (when on), or the session cookie (no foreign Origin on writes).
  const basic = knobs.basicOff ? null : basicOf(req.headers.authorization);
  const cookie = cookiesOf(req.headers.cookie).grafana_session;
  if (basic) {
    if (knobs.blocked)
      return json(401, {
        message:
          'Too many consecutive incorrect login attempts for user - login for user temporarily blocked',
      });
    if (basic.user !== 'admin' || basic.password !== PASSWORD)
      return json(401, { message: 'Invalid username or password' });
  } else if (cookie && sessions.has(cookie)) {
    if (req.method !== 'GET' && req.headers.origin) return json(403, { message: 'origin not allowed' });
  } else {
    return json(401, { message: 'Unauthorized', messageId: 'auth.unauthorized' });
  }

  if (req.method === 'GET' && path === '/api/user')
    return json(200, { id: 1, login: 'admin', email: 'admin@home.test' });
  if (knobs.old && path.startsWith('/api/serviceaccounts')) return json(404, { message: 'Not found' });
  if (path.startsWith('/api/serviceaccounts') && knobs.orgRole !== 'Admin') {
    return json(403, { message: 'You’ll need additional permissions to perform this action.' });
  }
  if (req.method === 'POST' && path === '/api/serviceaccounts') {
    const { name, role, isDisabled } = JSON.parse(req.body) as {
      name: string;
      role: string;
      isDisabled: boolean;
    };
    if (accounts.some((a) => a.name.toLowerCase() === name.toLowerCase() || slug(a.name) === slug(name))) {
      return json(400, { message: 'service account already exists' });
    }
    const account = { id: accounts.length + 1, name, role, isDisabled, tokens: [] };
    accounts.push(account);
    return json(201, { ...account, login: `sa-${slug(name)}`, orgId: 1 });
  }
  if (req.method === 'GET' && path === '/api/serviceaccounts/search') {
    const q = (new URLSearchParams(query).get('query') ?? '').toLowerCase();
    const found = accounts.filter((a) => a.name.toLowerCase().includes(q) || slug(a.name).includes(slug(q)));
    return json(200, { totalCount: found.length, serviceAccounts: found, page: 1, perPage: 100 });
  }
  const one = /^\/api\/serviceaccounts\/(\d+)(\/tokens)?$/.exec(path);
  const account = one ? accounts.find((a) => a.id === Number(one[1])) : undefined;
  if (req.method === 'PATCH' && one && !one[2] && account) {
    Object.assign(account, JSON.parse(req.body));
    return json(200, {
      id: account.id,
      name: account.name,
      message: 'Service account updated',
      serviceaccount: account,
    });
  }
  if (req.method === 'POST' && one?.[2] && account) {
    const { name } = JSON.parse(req.body) as { name: string };
    if (tokenNames.has(name))
      return json(400, {
        message: 'service account token with given name already exists in the organization',
      });
    tokenNames.add(name);
    account.tokens.push(name);
    return json(200, { id: tokenNames.size, name, key: `glsa_token${tokenNames.size}_abc` });
  }
  return json(404, { message: 'Not found' });
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

let stub: StubServer;

beforeAll(async () => {
  stub = await startStub(grafana);
});

afterAll(async () => {
  await stub.close();
});

beforeEach(() => {
  stub.requests.length = 0;
  accounts = [];
  tokenNames = new Set();
  sessions = new Set();
  Object.assign(knobs, {
    basicOff: false,
    loginFormOff: false,
    blocked: false,
    orgRole: 'Admin',
    old: false,
  });
});

const input = (overrides = {}) => networkInput('grafana', stub, overrides);
const bodies = (method: string, path: string) =>
  stub.to(method, path).map((r) => JSON.parse(r.body) as unknown);

describe('Grafana sign in once (CS-34)', () => {
  it('makes a Viewer service account named Whombat and a token with a timestamped name, with basic auth', async () => {
    const result = await provisionGrafana(input());
    expect(result).toEqual({
      fields: {},
      secret: 'glsa_token1_abc',
      limited: true,
      externalName: 'admin',
      note: null,
    });
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/user',
      'POST /api/serviceaccounts',
      'POST /api/serviceaccounts/1/tokens',
    ]);
    for (const r of stub.requests)
      expect(basicOf(r.headers.authorization)).toEqual({ user: 'admin', password: PASSWORD });
    expect(bodies('POST', '/api/serviceaccounts')).toEqual([
      { name: 'Whombat', role: 'Viewer', isDisabled: false },
    ]);
    expect(bodies('POST', '/api/serviceaccounts/1/tokens')).toEqual([{ name: 'Whombat 20261008-1405' }]);
  });

  it('makes an Editor to manage', async () => {
    await provisionGrafana(input({ access: 'manage' }));
    expect(bodies('POST', '/api/serviceaccounts')).toEqual([
      { name: 'Whombat', role: 'Editor', isDisabled: false },
    ]);
  });

  it('uses the existing service account of exactly that name and sets its role when it differs', async () => {
    accounts = [
      { id: 1, name: 'Whombat Old', role: 'Admin', isDisabled: false, tokens: [] },
      { id: 2, name: 'Whombat', role: 'Viewer', isDisabled: false, tokens: [] },
    ];
    const result = await provisionGrafana(input({ access: 'manage' }));
    expect(result.secret).toBe('glsa_token1_abc');
    expect(bodies('PATCH', '/api/serviceaccounts/2')).toEqual([{ role: 'Editor' }]);
    expect(accounts[1]?.tokens).toEqual(['Whombat 20261008-1405']);
    expect(accounts[0]?.role).toBe('Admin');
  });

  it('leaves an existing one alone when its role is right, and turns a disabled one back on', async () => {
    accounts = [{ id: 1, name: 'Whombat', role: 'Viewer', isDisabled: false, tokens: [] }];
    await provisionGrafana(input());
    expect(stub.to('PATCH', '/api/serviceaccounts/1')).toHaveLength(0);

    stub.requests.length = 0;
    tokenNames = new Set();
    accounts = [{ id: 1, name: 'Whombat', role: 'Viewer', isDisabled: true, tokens: [] }];
    await provisionGrafana(input());
    expect(bodies('PATCH', '/api/serviceaccounts/1')).toEqual([{ role: 'Viewer', isDisabled: false }]);
  });

  it('takes the next name when the name is taken by one it can’t tell is its own', async () => {
    // Same login (sa-whombat), another name: Grafana says it exists, the search has no exact match.
    accounts = [{ id: 1, name: 'WHOMBAT!', role: 'Admin', isDisabled: false, tokens: [] }];
    await provisionGrafana(input());
    expect(bodies('POST', '/api/serviceaccounts').map((b) => (b as { name: string }).name)).toEqual([
      'Whombat',
      'Whombat 2',
    ]);
    expect(stub.to('PATCH', '/api/serviceaccounts/1')).toHaveLength(0);
  });

  it('gives the token the next name when one made this minute has it', async () => {
    tokenNames = new Set(['Whombat 20261008-1405']);
    const result = await provisionGrafana(input());
    expect(result.secret).toBe('glsa_token2_abc');
    expect(bodies('POST', '/api/serviceaccounts/1/tokens')).toEqual([
      { name: 'Whombat 20261008-1405' },
      { name: 'Whombat 20261008-1405 2' },
    ]);
  });

  it('signs in with the login form where basic auth is off, without an Origin, and logs out', async () => {
    knobs.basicOff = true;
    const result = await provisionGrafana(input());
    expect(result.secret).toBe('glsa_token1_abc');
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/user',
      'POST /login',
      'GET /api/user',
      'POST /api/serviceaccounts',
      'POST /api/serviceaccounts/1/tokens',
      'GET /logout',
    ]);
    expect(bodies('POST', '/login')).toEqual([{ user: 'admin', password: PASSWORD }]);
    for (const r of stub.requests.slice(2)) {
      expect(cookiesOf(r.headers.cookie).grafana_session).toBe('sess1');
      expect(r.headers.authorization).toBeUndefined();
      expect(r.headers.origin).toBeUndefined();
    }
    expect(sessions.size).toBe(0);
  });

  it('refuses a wrong password once, with basic auth or the login form', async () => {
    const basic = await refusalOf(provisionGrafana(input({ password: 'not-it' })), 'not-it');
    expect(basic.reason).toBe('password');
    expect(basic.message).toMatch(/^Wrong username or password\./);
    // Single sign-on accounts get the same answer: the form offers a token instead (SG-13).
    expect(basic.message).toContain('through another service');
    expect(basic.method).toBe('token');
    expect(stub.to('POST', '/login')).toHaveLength(0);
    expect(stub.requests).toHaveLength(1);

    knobs.basicOff = true;
    stub.requests.length = 0;
    const form = await refusalOf(provisionGrafana(input({ password: 'not-it' })), 'not-it');
    expect(form.reason).toBe('password');
    expect(stub.to('POST', '/login')).toHaveLength(1);
  });

  it('says when Grafana blocked the account’s sign-ins', async () => {
    knobs.blocked = true;
    const err = await refusalOf(provisionGrafana(input()));
    expect(err.reason).toBe('locked');
  });

  it('refuses an account that isn’t an organisation admin', async () => {
    knobs.orgRole = 'Editor';
    const err = await refusalOf(provisionGrafana(input()));
    expect([err.reason, err.message]).toEqual([
      'rights',
      'This account isn’t an organisation admin in this Grafana. Sign in as one, or make a token by hand.',
    ]);
  });

  it('refuses single sign-on only (basic auth and the login form off)', async () => {
    knobs.basicOff = true;
    knobs.loginFormOff = true;
    const err = await refusalOf(provisionGrafana(input()));
    expect([err.reason, err.method]).toEqual(['single_sign_on', 'token']);
  });

  it('refuses a Grafana without service accounts', async () => {
    knobs.old = true;
    const err = await refusalOf(provisionGrafana(input()));
    expect(err.reason).toBe('unsupported');
  });

  it('refuses Grafana Cloud before sending anything', async () => {
    let sent = 0;
    const err = await refusalOf(
      provisionGrafana(
        input({
          baseUrl: 'https://mystack.grafana.net',
          fetch: () => {
            sent++;
            return Promise.reject(new Error('not here'));
          },
        }),
      ),
    );
    expect([err.reason, err.message]).toEqual([
      'unsupported',
      'Grafana Cloud signs in through grafana.com: make a token instead.',
    ]);
    expect(sent).toBe(0);
  });
});
