/**
 * Sign in once for Portainer (docs/decisions/connections-setup.md CS-33) against a stub: the JWT, the user's id, the
 * access token (with the password again), the 422 refusals, the logout.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { provisionPortainer } from './portainer';
import {
  networkInput,
  PASSWORD,
  refusalOf,
  type SeenRequest,
  type StubReply,
  type StubServer,
  startStub,
} from './testing-network';

const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ id: 3, username: 'admin', role: 1 })}.c2lnbmF0dXJl`;

/** `banned`: Portainer's rate limit, at the sign-in or at making the token (a 403 “Access denied”, SG-17). */
const knobs = {
  locked: false,
  sso: false,
  noMe: false,
  rights: true,
  banned: null as null | 'auth' | 'tokens',
};
const BAN = { status: 403, body: { message: 'Access denied', details: 'Access denied to resource' } };
let live = new Set<string>();
let made = 0;

function portainer(req: SeenRequest): StubReply {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const authed = bearer !== undefined && live.has(bearer);
  if (req.method === 'POST' && req.path === '/api/auth') {
    if (knobs.locked) return { status: 429, body: { message: 'Too many login attempts' } };
    if (knobs.banned === 'auth') return BAN;
    const { Username, Password } = JSON.parse(req.body) as { Username: string; Password: string };
    if (knobs.sso) {
      return {
        status: 422,
        body: { message: 'Only initial admin is allowed to login without oauth', details: 'Unauthorized' },
      };
    }
    if (Username !== 'admin' || Password !== PASSWORD) {
      return { status: 422, body: { message: 'Invalid credentials', details: `Unauthorized ${Password}` } };
    }
    live.add(JWT);
    return {
      status: 200,
      headers: { 'set-cookie': [`portainer_api_key=${JWT}; Path=/; HttpOnly`] },
      body: { jwt: JWT },
    };
  }
  if (!authed) return { status: 401, body: { message: 'Unauthorized' } };
  if (req.method === 'GET' && req.path === '/api/users/me') {
    return knobs.noMe
      ? { status: 404, body: { message: 'Not found' } }
      : { status: 200, body: { Id: 3, Username: 'admin', Role: 1 } };
  }
  if (req.method === 'POST' && req.path === '/api/users/3/tokens') {
    if (knobs.banned === 'tokens') return BAN;
    if (!knobs.rights)
      return { status: 403, body: { message: 'Permission denied to create user access token' } };
    const { description, password } = JSON.parse(req.body) as { description: string; password: string };
    if (password !== PASSWORD) return { status: 403, body: { message: 'Current password doesn’t match' } };
    if (!description) return { status: 400, body: { message: 'Invalid request payload' } };
    made++;
    return {
      status: 200,
      body: { rawAPIKey: `ptr_token${made}`, apiKey: { id: made, userId: 3, description } },
    };
  }
  if (req.method === 'POST' && req.path === '/api/auth/logout') {
    live.delete(bearer as string);
    return { status: 204 };
  }
  return { status: 404, body: { message: 'Not found' } };
}

let stub: StubServer;

beforeAll(async () => {
  stub = await startStub(portainer);
});

afterAll(async () => {
  await stub.close();
});

beforeEach(() => {
  stub.requests.length = 0;
  live = new Set();
  made = 0;
  Object.assign(knobs, { locked: false, sso: false, noMe: false, rights: true, banned: null });
});

const input = (overrides = {}) => networkInput('portainer', stub, overrides);

describe('Portainer sign in once (CS-33)', () => {
  it('signs in, makes an access token named Whombat with the password, and logs out', async () => {
    const result = await provisionPortainer(input());
    expect(result).toEqual({
      fields: {},
      secret: 'ptr_token1',
      limited: false,
      externalName: 'admin',
      note: null,
    });
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/auth',
      'GET /api/users/me',
      'POST /api/users/3/tokens',
      'POST /api/auth/logout',
    ]);
    const [login, , token, logout] = stub.requests as SeenRequest[];
    expect(JSON.parse(login?.body ?? '')).toEqual({ Username: 'admin', Password: PASSWORD });
    expect(JSON.parse(token?.body ?? '')).toEqual({ description: 'Whombat', password: PASSWORD });
    expect(token?.headers.authorization).toBe(`Bearer ${JWT}`);
    // The bearer token, never the cookie (Portainer checks CSRF on cookies).
    expect(token?.headers.cookie).toBeUndefined();
    expect(logout?.headers.authorization).toBe(`Bearer ${JWT}`);
    expect(live.size).toBe(0);
  });

  it('makes the same token for Manage, and a second one beside the first (descriptions may repeat)', async () => {
    await provisionPortainer(input());
    const second = await provisionPortainer(input({ access: 'manage' }));
    expect(second).toMatchObject({ secret: 'ptr_token2', limited: false });
  });

  it('reads the user’s id from the JWT when Portainer has no /api/users/me', async () => {
    knobs.noMe = true;
    const result = await provisionPortainer(input());
    expect(result.secret).toBe('ptr_token1');
    expect(result.externalName).toBe('admin');
  });

  it('refuses a wrong password once and never echoes Portainer’s text', async () => {
    const err = await refusalOf(provisionPortainer(input({ password: 'not-it' })), 'not-it');
    expect([err.code, err.reason, err.message]).toEqual([
      'sign_in_refused',
      'password',
      'Wrong username or password.',
    ]);
    expect(stub.to('POST', '/api/auth')).toHaveLength(1);
  });

  it('refuses an account that signs in through OAuth as single sign-on', async () => {
    knobs.sso = true;
    const err = await refusalOf(provisionPortainer(input()));
    expect([err.reason, err.method]).toEqual(['single_sign_on', 'token']);
  });

  it('reads Portainer’s hour-long ban as locked, at the sign-in and at the token (SG-17)', async () => {
    for (const at of ['auth', 'tokens'] as const) {
      knobs.banned = at;
      const err = await refusalOf(provisionPortainer(input()));
      expect([at, err.reason]).toEqual([at, 'locked']);
      expect(err.message).toContain('an hour');
    }
  });

  it('says when sign-ins are paused', async () => {
    knobs.locked = true;
    const err = await refusalOf(provisionPortainer(input()));
    expect(err.reason).toBe('locked');
  });

  it('refuses when Portainer won’t make the token, and still logs out', async () => {
    knobs.rights = false;
    const err = await refusalOf(provisionPortainer(input()));
    expect(err.reason).toBe('rights');
    expect(stub.to('POST', '/api/auth/logout')).toHaveLength(1);
    expect(live.size).toBe(0);
  });
});
