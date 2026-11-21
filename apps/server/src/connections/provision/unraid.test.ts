/**
 * Sign in once for Unraid (docs/decisions/connections-setup.md CS-32) against a stub server: the login form and its
 * lockout, the Dashboard's per-boot CSRF token, the GraphQL key with the level's role, names taken, the logout.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { provisionUnraid, unraidKeyName } from './unraid';

const COOKIE = 'unraid_5f4dcc3b5aa765d61d8327deb882cf99';
const CSRF = 'C5RF0BOOT1A2B3C4';

const knobs = {
  fails: 0,
  apiMissing: false,
  forbidden: false,
  listBroken: false,
  keys: [] as { name: string; roles: string[]; key: string }[],
};
let signedIn = new Set<string>();
let made = 0;

function server(req: SeenRequest): StubReply {
  const sid = cookiesOf(req.headers.cookie)[COOKIE];
  const session = sid !== undefined && signedIn.has(sid);
  if (req.method === 'POST' && req.path === '/login') {
    const form = formOf(req.body);
    if (knobs.fails >= 3)
      return {
        status: 200,
        body: '<p class="error">Too many previous login attempts.<br>Logins prevented for <span id="countdown"></span></p>',
      };
    if (form.username === 'root' && form.password === PASSWORD) {
      const id = `sid${signedIn.size + 1}`;
      signedIn.add(id);
      return {
        status: 302,
        headers: {
          location: '/Dashboard',
          'set-cookie': [`${COOKIE}=${id}; path=/; HttpOnly; SameSite=Lax`],
        },
      };
    }
    knobs.fails++;
    const prevented = knobs.fails === 3 ? '<br>Logins prevented for <span id="countdown"></span>' : '';
    return {
      status: 200,
      body: `<p class="error">Invalid username or password${prevented}</p><!-- ${form.password} -->`,
    };
  }
  if (req.method === 'GET' && req.path === '/Dashboard') {
    if (!session) return { status: 302, headers: { location: '/login' } };
    return { status: 200, body: `<script>var csrf_token = "${CSRF}";</script><h1>Tower</h1>` };
  }
  if (req.method === 'POST' && req.path === '/graphql') {
    if (knobs.apiMissing) return { status: 502, body: '<html>502 Bad Gateway</html>' };
    if (!session || req.headers['x-csrf-token'] !== CSRF)
      return { status: 401, body: { message: 'Invalid CSRF token' } };
    const { query, variables } = JSON.parse(req.body) as {
      query: string;
      variables?: { input: { name: string; description: string; roles: string[] } };
    };
    if (/^query/.test(query) && query.includes('apiKeys')) {
      if (knobs.listBroken)
        return { status: 200, body: { errors: [{ message: 'Cannot query field "apiKeys"' }] } };
      return { status: 200, body: { data: { apiKeys: knobs.keys.map(({ name }) => ({ name })) } } };
    }
    if (/^mutation/.test(query) && query.includes('create(input: $input)') && variables) {
      if (knobs.forbidden)
        return {
          status: 200,
          body: { errors: [{ message: 'Forbidden resource', extensions: { code: 'FORBIDDEN' } }] },
        };
      const { name, roles } = variables.input;
      if (!/^[\p{L}\p{N} ]+$/u.test(name))
        return { status: 200, body: { errors: [{ message: 'API key name must contain only letters' }] } };
      const existing = knobs.keys.find((k) => k.name === name);
      const key = existing ?? { name, roles, key: `unraid-key-${++made}` };
      if (!existing) knobs.keys.push(key);
      return { status: 200, body: { data: { apiKey: { create: { id: `srv:${name}`, ...key } } } } };
    }
    return { status: 200, body: { errors: [{ message: 'Unknown query' }] } };
  }
  if (req.method === 'GET' && req.path === '/logout') {
    if (sid) signedIn.delete(sid);
    return { status: 302, headers: { location: '/login', 'set-cookie': [`${COOKIE}=deleted; Max-Age=0`] } };
  }
  return { status: 404, body: 'Not found' };
}

let stub: StubServer;

beforeAll(async () => {
  stub = await startStub(server);
});

afterAll(async () => {
  await stub.close();
});

beforeEach(() => {
  stub.requests.length = 0;
  signedIn = new Set();
  made = 0;
  Object.assign(knobs, { fails: 0, apiMissing: false, forbidden: false, listBroken: false, keys: [] });
});

const input = (overrides = {}) => networkInput('unraid', stub, { account: 'root', ...overrides });
const creates = () =>
  stub
    .to('POST', '/graphql')
    .map((r) => JSON.parse(r.body) as { query: string; variables?: unknown })
    .filter((b) => b.query.startsWith('mutation'));

describe('Unraid sign in once (CS-32)', () => {
  it('signs in as root, reads the CSRF token, makes a Viewer key over GraphQL and logs out', async () => {
    const result = await provisionUnraid(input());
    expect(result).toEqual({
      fields: {},
      secret: 'unraid-key-1',
      limited: true,
      externalName: 'root',
      note: null,
    });

    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /login',
      'GET /Dashboard',
      'POST /graphql',
      'POST /graphql',
      'GET /logout',
    ]);
    const [login, dashboard, , create, logout] = stub.requests as SeenRequest[];
    expect(formOf(login?.body ?? '')).toEqual({ username: 'root', password: PASSWORD });
    expect(login?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(cookiesOf(dashboard?.headers.cookie)).toEqual({ [COOKIE]: 'sid1' });
    expect(create?.headers['x-csrf-token']).toBe(CSRF);
    expect(create?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(create?.body ?? '').variables).toEqual({
      input: { name: 'Whombat', description: 'Made by Whombat (Look only)', roles: ['VIEWER'] },
    });
    expect(cookiesOf(logout?.headers.cookie)).toEqual({ [COOKIE]: 'sid1' });
    expect(signedIn.size).toBe(0);
  });

  it('makes an Admin key to manage', async () => {
    await provisionUnraid(input({ access: 'manage' }));
    expect(creates()[0]?.variables).toEqual({
      input: { name: 'Whombat', description: 'Made by Whombat (Manage)', roles: ['ADMIN'] },
    });
  });

  it('keeps the name to letters, digits and spaces', async () => {
    await provisionUnraid(input({ name: 'Whombat (Home-Lab)' }));
    expect(creates()[0]?.variables).toMatchObject({ input: { name: 'Whombat Home Lab' } });
    expect(unraidKeyName('Whömbat · 2')).toBe('Whömbat 2');
  });

  it('takes the next free name rather than Unraid’s existing key', async () => {
    knobs.keys = [{ name: 'Whombat', roles: ['ADMIN'], key: 'someone-elses' }];
    const result = await provisionUnraid(input());
    expect(result.secret).toBe('unraid-key-1');
    expect(creates()[0]?.variables).toMatchObject({ input: { name: 'Whombat 2' } });
  });

  it('never takes an existing key answered in place of a new one', async () => {
    knobs.listBroken = true;
    knobs.keys = [{ name: 'Whombat', roles: ['ADMIN'], key: 'someone-elses' }];
    const err = await refusalOf(provisionUnraid(input()));
    expect(err.reason).toBe('unsupported');
    expect(err.message).not.toContain('someone-elses');
  });

  it('refuses a wrong password once, and says when Unraid starts pausing', async () => {
    const first = await refusalOf(provisionUnraid(input({ password: 'not-it' })), 'not-it');
    expect([first.reason, first.message]).toEqual([
      'password',
      'Wrong password. Unraid pauses sign-ins for 15 minutes after three wrong tries.',
    ]);
    expect(stub.to('POST', '/login')).toHaveLength(1);
    knobs.fails = 2;
    const third = await refusalOf(provisionUnraid(input({ password: 'not-it' })), 'not-it');
    expect(third.message).toBe('Wrong password. Unraid now pauses sign-ins for 15 minutes.');
    const locked = await refusalOf(provisionUnraid(input()));
    expect(locked.reason).toBe('locked');
  });

  it('refuses when GraphQL forbids it, and still logs out', async () => {
    knobs.forbidden = true;
    const err = await refusalOf(provisionUnraid(input()));
    expect(err.reason).toBe('rights');
    expect(stub.to('GET', '/logout')).toHaveLength(1);
  });

  it('refuses an Unraid without its API', async () => {
    knobs.apiMissing = true;
    const err = await refusalOf(provisionUnraid(input()));
    expect([err.reason, err.message]).toEqual([
      'unsupported',
      'Unraid’s API isn’t answering: it needs Unraid 7.2 or later, or the Unraid Connect plugin.',
    ]);
    expect(stub.to('GET', '/logout')).toHaveLength(1);
  });
});
