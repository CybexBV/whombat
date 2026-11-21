/**
 * Sign in once for Forgejo / Gitea (docs/decisions/connections-setup.md CS-35) against a stub: one token request with
 * basic auth, both OTP headers, the level's scopes and a timestamped name; codes used up, security keys, the refusals.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FORGEJO_SCOPES, provisionForgejo } from './forgejo';
import {
  basicOf,
  networkInput,
  PASSWORD,
  refusalOf,
  type SeenRequest,
  type StubReply,
  type StubServer,
  startStub,
} from './testing-network';

const knobs = {
  totp: null as string | null,
  /** Older servers name the OTP in their 401; newer ones say only “invalid username, password or token”. */
  verbose: false,
  webauthn: false,
  /** Basic auth turned off, as each server says it (SG-17). */
  basicOff: null as null | 'forgejo14' | 'forgejo15' | 'gitea' | 'anonymous',
  oldScopes: false,
};
let usedCodes = new Set<string>();
let tokenNames = new Set<string>();

const json = (status: number, body: object): StubReply => ({ status, body });

function forgejo(req: SeenRequest): StubReply {
  const match = /^\/api\/v1\/users\/([^/]+)\/tokens$/.exec(req.path);
  if (req.method !== 'POST' || !match) return json(404, { message: 'Not Found' });
  const auth = basicOf(req.headers.authorization);
  if (knobs.basicOff === 'forgejo14') return json(401, { message: 'auth method not allowed' });
  if (knobs.basicOff === 'forgejo15')
    return json(401, { message: 'basic authentication by username & password is disabled' });
  // Gitea asks who before how: an anonymous request isn't the user it makes a token for.
  if (knobs.basicOff === 'gitea')
    return json(403, { message: 'doer should be the site admin or be same as the contextUser' });
  if (knobs.basicOff === 'anonymous') return json(401, { message: 'auth required' });
  if (!auth) return json(401, { message: 'auth method not allowed' });
  const known = auth.user === 'mara' || auth.user === 'mara@home.test';
  if (!known || auth.password !== PASSWORD) {
    return json(401, {
      message: knobs.verbose
        ? `user's password is invalid [name: mara] ${auth.password}`
        : 'invalid username, password or token',
    });
  }
  if (knobs.webauthn)
    return json(401, { message: 'basic authorization is not allowed while WebAuthn enrolled' });
  if (knobs.totp) {
    const otp = req.headers['x-gitea-otp'] ?? req.headers['x-forgejo-otp'];
    if (otp !== knobs.totp || usedCodes.has(otp)) {
      return json(401, {
        message: knobs.verbose ? 'invalid provided OTP' : 'invalid username, password or token',
      });
    }
    usedCodes.add(otp);
  }
  const user = decodeURIComponent(match[1] ?? '');
  if (user !== 'mara') return json(404, { message: `user does not exist [uid: 0, name: ${user}]` });
  const { name, scopes } = JSON.parse(req.body) as { name: string; scopes: string[] };
  if (tokenNames.has(name)) return json(400, { message: 'access token name has been used already' });
  if (knobs.oldScopes && scopes.some((s) => s.endsWith(':misc'))) {
    return json(400, {
      message: 'invalid access token scope provided: invalid access token scope: read:misc',
    });
  }
  tokenNames.add(name);
  return json(201, {
    id: tokenNames.size,
    name,
    sha1: `${'0f'.repeat(19)}a${tokenNames.size}`,
    token_last_eight: 'x',
    scopes,
  });
}

let stub: StubServer;

beforeAll(async () => {
  stub = await startStub(forgejo);
});

afterAll(async () => {
  await stub.close();
});

beforeEach(() => {
  stub.requests.length = 0;
  usedCodes = new Set();
  tokenNames = new Set();
  Object.assign(knobs, { totp: null, verbose: false, webauthn: false, basicOff: null, oldScopes: false });
});

const input = (overrides = {}) => networkInput('forgejo', stub, { account: 'mara', ...overrides });
const sent = () => stub.requests.map((r) => JSON.parse(r.body) as { name: string; scopes: string[] });

describe('Forgejo / Gitea sign in once (CS-35)', () => {
  it('makes a token with read scopes and a timestamped name in one request', async () => {
    const result = await provisionForgejo(input());
    expect(result).toEqual({
      fields: {},
      secret: `${'0f'.repeat(19)}a1`,
      limited: true,
      externalName: 'mara',
      note: null,
    });
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/v1/users/mara/tokens']);
    const [req] = stub.requests as SeenRequest[];
    expect(basicOf(req?.headers.authorization)).toEqual({ user: 'mara', password: PASSWORD });
    expect(req?.headers['x-forgejo-otp']).toBeUndefined();
    expect(req?.headers['x-gitea-otp']).toBeUndefined();
    expect(sent()).toEqual([
      {
        name: 'whombat-20261008-1405',
        scopes: [
          'read:repository',
          'read:issue',
          'read:organization',
          'read:user',
          'read:package',
          'read:notification',
          'read:misc',
        ],
      },
    ]);
  });

  it('asks for write scopes to manage, never site administration', async () => {
    await provisionForgejo(input({ access: 'manage' }));
    expect(sent()[0]?.scopes).toEqual([...FORGEJO_SCOPES.manage]);
    expect(sent()[0]?.scopes.some((s) => s.includes('admin'))).toBe(false);
  });

  it('derives the token’s name from Whombat’s', async () => {
    await provisionForgejo(input({ name: 'Whombat (Home Lab)' }));
    expect(sent()[0]?.name).toBe('whombat-home-lab-20261008-1405');
  });

  it('sends the code in both servers’ OTP headers', async () => {
    knobs.totp = '123456';
    const result = await provisionForgejo(input({ code: ' 123456 ' }));
    expect(result.secret).toBe(`${'0f'.repeat(19)}a1`);
    expect(stub.requests[0]?.headers['x-forgejo-otp']).toBe('123456');
    expect(stub.requests[0]?.headers['x-gitea-otp']).toBe('123456');
  });

  it('can’t tell a missing code from a wrong password on newer servers', async () => {
    knobs.totp = '123456';
    const err = await refusalOf(provisionForgejo(input()));
    expect(err.reason).toBe('password');
    expect(err.message).toMatch(/^Wrong username or password, or the 2FA code is missing or expired\./);
    // Single sign-on accounts get the same answer: the form offers a token (SG-13).
    expect(err.message).toContain('through another service');
    expect(err.method).toBe('token');
  });

  it('asks for the code, and refuses a wrong one, where an older server says so', async () => {
    knobs.totp = '123456';
    knobs.verbose = true;
    const missing = await refusalOf(provisionForgejo(input()));
    expect([missing.code, missing.message]).toEqual([
      'second_factor_needed',
      'Enter the code from your authenticator app.',
    ]);
    const wrong = await refusalOf(provisionForgejo(input({ code: '000000' })));
    expect([wrong.code, wrong.reason]).toEqual(['sign_in_refused', 'code']);
  });

  it('refuses an account with a security key as unsupported', async () => {
    knobs.webauthn = true;
    const err = await refusalOf(provisionForgejo(input()));
    expect(err.reason).toBe('unsupported');
    expect(err.message).toContain('security key');
  });

  it('refuses a wrong password once and never echoes the server’s text', async () => {
    knobs.verbose = true;
    const err = await refusalOf(provisionForgejo(input({ password: 'not-it' })), 'not-it');
    expect(err.reason).toBe('password');
    expect(stub.requests).toHaveLength(1);
  });

  it('takes the next name when one made this minute has it', async () => {
    tokenNames = new Set(['whombat-20261008-1405']);
    const result = await provisionForgejo(input());
    expect(result.secret).toBe(`${'0f'.repeat(19)}a2`);
    expect(sent().map((b) => b.name)).toEqual(['whombat-20261008-1405', 'whombat-20261008-1405-2']);
  });

  it('says the code was used up when the name was taken and the server won’t take the code again', async () => {
    knobs.totp = '123456';
    tokenNames = new Set(['whombat-20261008-1405']);
    const err = await refusalOf(provisionForgejo(input({ code: '123456' })));
    expect([err.reason, err.message]).toEqual([
      'code',
      'The server used up that code. Wait for the next one from your authenticator app, then try again.',
    ]);
  });

  it('says to use the username when an email address signed in', async () => {
    const err = await refusalOf(provisionForgejo(input({ account: 'mara@home.test' })));
    expect([err.reason, err.message]).toEqual([
      'password',
      'Sign in with your username, not your email address.',
    ]);
    expect(stub.requests[0]?.path).toBe('/api/v1/users/mara%40home.test/tokens');
  });

  it('refuses a server with basic auth off, as each says it, or without scoped tokens (SG-17)', async () => {
    for (const off of ['forgejo14', 'forgejo15', 'gitea', 'anonymous'] as const) {
      knobs.basicOff = off;
      const err = await refusalOf(provisionForgejo(input()));
      expect([off, err.reason, err.method]).toEqual([off, 'unsupported', 'token']);
      expect(err.message).toContain('doesn’t take passwords');
    }
    knobs.basicOff = null;
    knobs.oldScopes = true;
    expect((await refusalOf(provisionForgejo(input()))).reason).toBe('unsupported');
  });
});
