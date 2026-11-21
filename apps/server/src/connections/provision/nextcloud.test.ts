import { afterEach, describe, expect, it } from 'vitest';
import { provisionNextcloud } from './nextcloud';
import {
  expectStop,
  type Stub,
  type StubReply,
  type StubRequest,
  startStub,
  stubInput,
  TEST_PASSWORD,
} from './testing-home';

/** A Nextcloud as CS-23 reads it: `getapppassword` over OCS with Basic auth, and WebDAV's answer to a PROPFIND. */
interface NextcloudWorld {
  twoStep?: boolean;
  appPasswordsOff?: boolean;
  throttled?: boolean;
  /** Nextcloud 32.0.12 / 33.0.6 and later: an app password doesn't confirm the password (SG-15b). */
  notConfirmed?: boolean;
}

const APP_PASSWORD = 'yKz3QbA9wVt7LmN2pR5sX8cD4fG6hJ1kQ0eW3rT5yU7iO9pA2sD4fG6hJ8kL0zX2cV4bN6mQ8wE1rT3yU5';
const EXISTING_APP_PASSWORD = 'Ab1cD-eF2gH-iJ3kL-mN4oP-qR5sT';

function fakeNextcloud(world: NextcloudWorld) {
  const made: { userAgent: string }[] = [];
  const ocs = (status: number, statuscode: number, message: string, data: unknown = []): StubReply => ({
    status,
    json: { ocs: { meta: { status: status === 200 ? 'ok' : 'failure', statuscode, message }, data } },
  });
  const credentials = (req: StubRequest) => {
    const raw = String(req.headers.authorization ?? '').replace(/^Basic /, '');
    const [user, ...rest] = Buffer.from(raw, 'base64').toString('utf8').split(':');
    return { user, password: rest.join(':') };
  };
  const route = (req: StubRequest): StubReply => {
    if (world.throttled) return { status: 429, body: 'Reached maximum delay' };
    const { user, password } = credentials(req);
    const appPassword = password === EXISTING_APP_PASSWORD;
    const passwordOk = user === 'mara' && (password === TEST_PASSWORD || appPassword);
    if (req.method === 'GET' && req.path === '/ocs/v2.php/core/getapppassword') {
      if (req.headers['ocs-apirequest'] !== 'true') return ocs(412, 412, 'CSRF check failed');
      if (!passwordOk || (world.twoStep && !appPassword))
        return ocs(401, 997, 'Current user is not logged in');
      if (appPassword && world.notConfirmed)
        return {
          status: 403,
          headers: { 'X-NC-Auth-NotConfirmed': 'true' },
          json: { message: 'Password confirmation is required' },
        };
      if (appPassword) return ocs(403, 403, 'You cannot request an new apppassword with an apppassword');
      if (world.appPasswordsOff) return ocs(403, 403, '');
      made.push({ userAgent: String(req.headers['user-agent']) });
      return ocs(200, 200, 'OK', { apppassword: APP_PASSWORD });
    }
    if (req.method === 'PROPFIND' && req.path === '/remote.php/dav/') {
      if (passwordOk && (!world.twoStep || appPassword))
        return {
          status: 207,
          headers: { 'Content-Type': 'application/xml; charset=utf-8' },
          body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/remote.php/dav/principals/users/mara/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
        };
      const hint =
        world.twoStep && passwordOk
          ? '<s:exception>OCA\\DAV\\Connector\\Sabre\\Exception\\PasswordLoginForbidden</s:exception><s:message/><o:hint xmlns:o="o:">password login forbidden</o:hint>'
          : '<s:exception>Sabre\\DAV\\Exception\\NotAuthenticated</s:exception><s:message>No public access to this resource., Username or password was incorrect</s:message>';
      return {
        status: 401,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        body: `<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">${hint}</d:error>`,
      };
    }
    return { status: 404, body: '' };
  };
  return { route, made };
}

let stub: Stub | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});

async function nextcloud(world: NextcloudWorld = {}) {
  const fake = fakeNextcloud(world);
  stub = await startStub(fake.route);
  return { ...fake, stub };
}

describe('Nextcloud (CS-23)', () => {
  it('turns the password into an app password named after this Whombat, at either level', async () => {
    for (const access of ['read', 'manage'] as const) {
      const { stub, made } = await nextcloud();
      const result = await provisionNextcloud(
        stubInput(stub, 'nextcloud', { access, account: ' mara ', name: 'Whombat (Lumio)' }),
      );
      expect(result).toEqual({
        fields: { username: 'mara' },
        secret: APP_PASSWORD,
        limited: false,
        externalName: null,
        note: null,
      });
      expect(made).toEqual([{ userAgent: 'Whombat (Lumio)' }]);
      const [request] = stub.calls('GET /ocs/v2.php/core/getapppassword');
      expect(request?.headers.accept).toBe('application/json');
      expect(request?.headers.cookie).toBeUndefined();
      // WebDAV first, once (SG-15c).
      expect(stub.requests.map((r) => r.method)).toEqual(['PROPFIND', 'GET']);
      expect(stub.calls('PROPFIND /remote.php/dav/')[0]?.body).toContain('current-user-principal');
      await stub.close();
    }
  });

  it('keeps an app password typed as the password, as old and new Nextclouds answer it (SG-15b)', async () => {
    for (const world of [{}, { notConfirmed: true }, { notConfirmed: true, twoStep: true }]) {
      const { stub, made } = await nextcloud(world);
      const result = await provisionNextcloud(
        stubInput(stub, 'nextcloud', { password: EXISTING_APP_PASSWORD }),
      );
      expect(result).toMatchObject({
        fields: { username: 'mara' },
        secret: EXISTING_APP_PASSWORD,
        limited: false,
      });
      expect(made).toHaveLength(0);
      await stub.close();
    }
  });

  it('refuses a wrong password at WebDAV, one attempt, and offers its own login (SG-15c, SG-15e)', async () => {
    const { stub } = await nextcloud();
    const stop = await expectStop(
      provisionNextcloud(stubInput(stub, 'nextcloud', { password: 'wrong' })),
      'password',
      'wrong',
    );
    expect(stop.message).toMatch(/^Wrong username or password\./);
    expect(stop.message).toContain('sign in with Nextcloud instead');
    expect(stop.method).toBe('nextcloud_login');
    expect(stub.requests).toHaveLength(1);
    expect(stub.calls('PROPFIND /remote.php/dav/')[0]?.headers.depth).toBe('0');
  });

  it('sends an account with two-step sign-in to Nextcloud’s own login', async () => {
    const { stub } = await nextcloud({ twoStep: true });
    const stop = await expectStop(provisionNextcloud(stubInput(stub, 'nextcloud')), 'second_factor');
    expect(stop.method).toBe('nextcloud_login');
    expect(stop.message).toBe('This account uses two-step sign-in. Sign in with Nextcloud instead.');
    expect(stub.calls('GET /ocs/v2.php/core/getapppassword')).toHaveLength(0);
  });

  it('refuses where app passwords are off, and when Nextcloud pauses sign-ins', async () => {
    const off = await nextcloud({ appPasswordsOff: true });
    const stop = await expectStop(provisionNextcloud(stubInput(off.stub, 'nextcloud')), 'rights');
    expect(stop.method).toBe('nextcloud_login');
    await off.stub.close();

    const paused = await nextcloud({ throttled: true });
    await expectStop(provisionNextcloud(stubInput(paused.stub, 'nextcloud')), 'locked');
  });
});
