import { afterEach, describe, expect, it } from 'vitest';
import { immichPermissions, provisionImmich } from './immich';
import {
  expectStop,
  type Stub,
  type StubReply,
  type StubRequest,
  startStub,
  stubInput,
  TEST_PASSWORD,
} from './testing-home';

/** An Immich as CS-25 reads it: features, version, login, API keys and logout. */
interface ImmichWorld {
  version?: [number, number];
  passwordLogin?: boolean;
  oauth?: boolean;
  /** Permissions this server doesn't know (a 400 names them). */
  unknown?: string[];
  keys?: { id: string; name: string }[];
  keysForbidden?: boolean;
}

const EMAIL = 'mara@example.com';

function fakeImmich(world: ImmichWorld) {
  const keys = [...(world.keys ?? [])];
  const made: { name: string; permissions: string[] }[] = [];
  const loggedOut: string[] = [];
  const [major, minor] = world.version ?? [2, 1];
  const signedIn = (req: StubRequest) => req.headers.authorization === 'Bearer session-token';
  const route = (req: StubRequest): StubReply => {
    const at = `${req.method} ${req.path}`;
    if (at === 'GET /api/server/features')
      return { json: { passwordLogin: world.passwordLogin ?? true, oauth: world.oauth ?? false } };
    if (at === 'GET /api/server/version') return { json: { major, minor, patch: 0 } };
    if (at === 'POST /api/auth/login') {
      const body = req.json();
      if (body.email !== EMAIL || body.password !== TEST_PASSWORD) {
        return {
          status: 401,
          json: { message: 'Incorrect email or password', error: 'Unauthorized', statusCode: 401 },
        };
      }
      return {
        status: 201,
        json: { accessToken: 'session-token', userId: 'u1', userEmail: EMAIL, name: 'Mara', isAdmin: false },
      };
    }
    if (!signedIn(req)) return { status: 401, json: { message: 'Authentication required' } };
    if (at === 'GET /api/api-keys') return { json: keys.map((k) => ({ ...k, permissions: ['all'] })) };
    if (at === 'POST /api/api-keys') {
      if (world.keysForbidden)
        return { status: 403, json: { message: 'Missing required permission: apiKey.create' } };
      const body = req.json();
      const bad = (body.permissions as string[]).filter((p) => world.unknown?.includes(p));
      if (bad.length) {
        return {
          status: 400,
          json: { message: [`permissions.${bad[0]}: Invalid option`], error: 'Bad Request', statusCode: 400 },
        };
      }
      made.push({ name: body.name, permissions: body.permissions });
      const id = `k${made.length}`;
      keys.push({ id, name: body.name });
      return {
        status: 201,
        json: {
          secret: `immich-secret-${made.length}`,
          apiKey: { id, name: body.name, permissions: body.permissions },
        },
      };
    }
    if (at === 'POST /api/auth/logout') {
      loggedOut.push(String(req.headers.authorization));
      return { json: { successful: true, redirectUri: '/auth/login' } };
    }
    return { status: 404, json: { message: 'Not found' } };
  };
  return { route, made, loggedOut };
}

let stub: Stub | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});

async function immich(world: ImmichWorld = {}) {
  const fake = fakeImmich(world);
  stub = await startStub(fake.route);
  return { ...fake, stub };
}

const BASE_READ = [
  'activity.read',
  'album.read',
  'album.download',
  'archive.read',
  'asset.read',
  'asset.view',
  'asset.download',
  'face.read',
  'library.read',
  'memory.read',
  'partner.read',
  'person.read',
  'sharedLink.read',
  'stack.read',
  'tag.read',
  'timeline.read',
  'timeline.download',
];

describe('Immich (CS-25)', () => {
  it('makes a key with all permissions to manage, and logs out', async () => {
    const { stub, made, loggedOut } = await immich();
    const result = await provisionImmich(stubInput(stub, 'immich', { account: EMAIL, access: 'manage' }));
    expect(result).toEqual({
      fields: {},
      secret: 'immich-secret-1',
      limited: true,
      externalName: EMAIL,
      note: null,
    });
    expect(made).toEqual([{ name: 'Whombat', permissions: ['all'] }]);
    expect(loggedOut).toEqual(['Bearer session-token']);
  });

  it('looks with the read permissions of the server’s version', async () => {
    // The versions that added them (SG-16): 1.137 and 2.5.
    const newer = ['user.read', 'server.about', 'duplicate.read'];
    const newest = ['map.read', 'map.search', 'folder.read'];
    const cases: [[number, number], string[]][] = [
      [[1, 125], BASE_READ],
      [[1, 136], BASE_READ],
      [
        [1, 137],
        [...BASE_READ, ...newer],
      ],
      [
        [2, 4],
        [...BASE_READ, ...newer],
      ],
      [
        [2, 5],
        [...BASE_READ, ...newer, ...newest],
      ],
      [
        [3, 3],
        [...BASE_READ, ...newer, ...newest],
      ],
    ];
    for (const [version, permissions] of cases) {
      const { stub, made } = await immich({ version });
      await provisionImmich(stubInput(stub, 'immich', { account: EMAIL, access: 'read' }));
      expect(made).toEqual([{ name: 'Whombat', permissions }]);
      await stub.close();
    }
    expect(immichPermissions('read', null)).toEqual(BASE_READ);
  });

  it('asks once more without the newer permissions when the server doesn’t know one', async () => {
    const { stub, made } = await immich({ version: [3, 3], unknown: ['folder.read'] });
    const result = await provisionImmich(stubInput(stub, 'immich', { account: EMAIL }));
    expect(result.secret).toBe('immich-secret-1');
    expect(stub.calls('POST /api/api-keys')).toHaveLength(2);
    expect(made).toEqual([{ name: 'Whombat', permissions: BASE_READ }]);
  });

  it('takes the next name beside a key named Whombat', async () => {
    const { stub, made } = await immich({ keys: [{ id: 'theirs', name: 'Whombat' }] });
    await provisionImmich(stubInput(stub, 'immich', { account: EMAIL }));
    expect(made[0]?.name).toBe('Whombat 2');
  });

  it('can’t sign in where passwords are off', async () => {
    const { stub } = await immich({ passwordLogin: false });
    const stop = await expectStop(
      provisionImmich(stubInput(stub, 'immich', { account: EMAIL })),
      'unsupported',
    );
    expect(stop.method).toBe('token');
    expect(stub.calls('POST /api/auth/login')).toHaveLength(0);
  });

  it('refuses a wrong password', async () => {
    const { stub } = await immich();
    const stop = await expectStop(
      provisionImmich(stubInput(stub, 'immich', { account: EMAIL, password: 'wrong' })),
      'password',
      'wrong',
    );
    expect(stop.message).toBe('Wrong email or password.');
    expect(stop.method).toBeNull();
  });

  it('offers a key instead when Immich also signs in through another service (SG-13)', async () => {
    const { stub } = await immich({ oauth: true });
    const stop = await expectStop(
      provisionImmich(stubInput(stub, 'immich', { account: EMAIL, password: 'wrong' })),
      'password',
      'wrong',
    );
    expect(stop.message).toMatch(/^Wrong email or password\./);
    expect(stop.message).toContain('through another service');
    expect(stop.method).toBe('token');
  });

  it('refuses an account that may not make keys, and still logs out', async () => {
    const { stub, loggedOut } = await immich({ keysForbidden: true });
    await expectStop(provisionImmich(stubInput(stub, 'immich', { account: EMAIL })), 'rights');
    expect(loggedOut).toEqual(['Bearer session-token']);
  });
});
