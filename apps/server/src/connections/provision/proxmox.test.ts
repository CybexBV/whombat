import { afterEach, describe, expect, it } from 'vitest';
import { AUTHENTICATOR_CODE } from './home-common';
import { PVE_OWN_RIGHTS_NOTE, provisionProxmoxBackup, provisionProxmoxVe } from './proxmox';
import {
  expectStop,
  type Stub,
  type StubReply,
  type StubRequest,
  startStub,
  stubInput,
  TEST_PASSWORD,
} from './testing-home';

/**
 * A Proxmox VE or Backup Server as CS-20/CS-21 read it: tickets (with `!tfa!` challenges), cookies and CSRF tokens,
 * realms, roles, tokens and ACLs.
 */
interface ProxmoxWorld {
  product: 'pve' | 'pbs';
  /** userid → password. */
  users: Record<string, string>;
  defaultRealm?: string;
  /** A realm of type `openid` (single sign-on: no password). */
  openid?: string;
  /** A second factor: what the challenge offers and the code that passes. */
  tfa?: { offers: Record<string, unknown>; answer: string };
  /** The account holds `Permissions.Modify` on `/` (Proxmox VE). */
  modify?: boolean;
  roles?: string[];
  /** Token names the account already has. */
  existing?: string[];
  /** ACL updates are refused (400) even so. */
  aclRefused?: boolean;
  tokenCreate?: StubReply;
  codesLocked?: boolean;
}

interface Token {
  userid: string;
  name: string;
  secret: string;
  form: Record<string, string>;
}

const PVE_ROLE_LIST = [
  'Administrator',
  'NoAccess',
  'PVEAdmin',
  'PVEAuditor',
  'PVEDatastoreAdmin',
  'PVEDatastoreUser',
  'PVEMappingAdmin',
  'PVEMappingUser',
  'PVEPoolAdmin',
  'PVEPoolUser',
  'PVESDNAdmin',
  'PVESDNUser',
  'PVESysAdmin',
  'PVETemplateUser',
  'PVEUserAdmin',
  'PVEVMAdmin',
  'PVEVMUser',
];
const PBS_ROLE_LIST = [
  'Admin',
  'Audit',
  'DatastoreAdmin',
  'DatastoreAudit',
  'DatastoreBackup',
  'NoAccess',
  'RemoteAdmin',
  'RemoteAudit',
  'RemoteDatastoreAdmin',
  'RemoteSyncOperator',
  'TapeAdmin',
  'TapeAudit',
  'TapeOperator',
];

function fakeProxmox(world: ProxmoxWorld) {
  const prefix = world.product === 'pve' ? 'PVE' : 'PBS';
  const tokens = new Map<string, Token>();
  for (const [userid] of Object.entries(world.users)) {
    for (const name of world.existing ?? []) {
      tokens.set(`${userid}!${name}`, { userid, name, secret: 'theirs', form: {} });
    }
  }
  const acl: Record<string, string>[] = [];
  const tickets = new Map<string, string>(); // full ticket → userid
  const partial = new Map<string, string>(); // tfa ticket → userid
  let n = 0;
  const denied = (message: string): StubReply => ({ status: 401, json: { data: null, message } });
  const loginRefused = () =>
    denied(world.product === 'pve' ? 'authentication failure\n' : 'permission check failed.');

  function signedIn(req: StubRequest): string | null {
    const cookie = String(req.headers.cookie ?? '');
    const raw = cookie.replace(/^(PVEAuthCookie|PBSAuthCookie)=/, '');
    const ticket = world.product === 'pbs' ? decodeURIComponent(raw) : raw;
    const userid = tickets.get(ticket);
    if (!userid) return null;
    if (req.method !== 'GET' && req.headers.csrfpreventiontoken !== `csrf-${userid}`) return null;
    return userid;
  }

  function fullTicket(userid: string): StubReply {
    const ticket = `${prefix}:${userid}:6700${++n}::sig/${n}+=`;
    tickets.set(ticket, userid);
    return { json: { data: { username: userid, ticket, CSRFPreventionToken: `csrf-${userid}` } } };
  }

  const route = (req: StubRequest): StubReply => {
    const p = req.path.replace(/^\/api2\/json/, '');
    if (req.method === 'GET' && p === '/access/domains') {
      const realms = world.product === 'pve' ? ['pam', 'pve', 'ldap'] : ['pam', 'pbs'];
      if (world.openid) realms.push(world.openid);
      return {
        json: {
          data: realms.map((realm) => ({
            realm,
            type: realm === world.openid ? 'openid' : realm,
            ...(realm === world.defaultRealm ? { default: 1 } : {}),
          })),
        },
      };
    }
    if (req.method === 'POST' && p === '/access/ticket') {
      const form = req.form();
      if (form['tfa-challenge']) {
        const userid = partial.get(form['tfa-challenge']);
        if (!userid || userid !== form.username) return loginRefused();
        if (world.codesLocked) return loginRefused();
        if (form.password !== world.tfa?.answer) return loginRefused();
        return fullTicket(userid);
      }
      const userid = form.username;
      if (!userid?.includes('@') || world.users[userid] !== form.password) return loginRefused();
      if (world.tfa) {
        const challenge = encodeURIComponent(JSON.stringify(world.tfa.offers));
        const ticket = `${prefix}:!tfa!${challenge}:6700${++n}::sig${n}`;
        partial.set(ticket, userid);
        return {
          json: {
            data: {
              username: userid,
              ticket,
              CSRFPreventionToken: world.product === 'pbs' ? 'invalid' : `csrf-${userid}`,
              ...(world.product === 'pve' ? { NeedTFA: 1 } : {}),
            },
          },
        };
      }
      return fullTicket(userid);
    }
    if (req.method === 'GET' && p === '/access/permissions') {
      const auth = String(req.headers.authorization ?? '');
      const tokenAuth =
        world.product === 'pve'
          ? /^PVEAPIToken=([^=]+)=(.+)$/.exec(auth)
          : /^PBSAPIToken=([^:]+):(.+)$/.exec(auth);
      if (tokenAuth) {
        const token = tokens.get(tokenAuth[1] ?? '');
        if (!token || token.secret !== tokenAuth[2]) return denied('authentication failure');
        return { json: { data: { '/': { 'Sys.Audit': 1 } } } };
      }
      if (!signedIn(req)) return denied('authentication failure');
      const privs: Record<string, number> = { 'Sys.Audit': 1, 'VM.Audit': 1 };
      if (world.modify) privs['Permissions.Modify'] = 1;
      return { json: { data: { [req.query.get('path') ?? '/']: privs } } };
    }
    if (!signedIn(req)) return denied('authentication failure');
    const userid = signedIn(req) as string;
    if (req.method === 'GET' && p === '/access/roles') {
      const list = world.roles ?? (world.product === 'pve' ? PVE_ROLE_LIST : PBS_ROLE_LIST);
      return { json: { data: list.map((roleid) => ({ roleid, privs: '' })) } };
    }
    const tokenMatch = /^\/access\/users\/([^/]+)\/token\/([^/]+)$/.exec(p);
    if (tokenMatch) {
      const owner = decodeURIComponent(tokenMatch[1] ?? '');
      const name = decodeURIComponent(tokenMatch[2] ?? '');
      const id = `${owner}!${name}`;
      if (owner !== userid) return { status: 403, json: { data: null } };
      if (req.method === 'DELETE') {
        tokens.delete(id);
        return { json: { data: null } };
      }
      if (req.method === 'POST') {
        if (world.tokenCreate) return world.tokenCreate;
        if (tokens.has(id)) {
          return world.product === 'pve'
            ? { status: 400, json: { data: null, errors: { tokenid: 'Token already exists.' } } }
            : {
                status: 400,
                json: { data: null, message: `token '${name}' for user '${owner}' already exists.\n` },
              };
        }
        const secret = `5e3b0c2a-0000-4000-8000-00000000000${++n}`;
        tokens.set(id, { userid, name, secret, form: req.form() });
        return {
          json: {
            data:
              world.product === 'pve'
                ? { 'full-tokenid': id, info: { privsep: Number(req.form().privsep) }, value: secret }
                : { tokenid: id, value: secret },
          },
        };
      }
    }
    if (req.method === 'PUT' && p === '/access/acl') {
      if (world.aclRefused || (world.product === 'pve' && !world.modify)) {
        return {
          status: 400,
          json: { data: null, errors: { role: "Cannot add role - requires 'Permissions.Modify'" } },
        };
      }
      acl.push(req.form());
      return { json: { data: null } };
    }
    return { status: 501, json: { data: null } };
  };
  return { route, tokens, acl };
}

let stub: Stub | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});

async function pve(world: Omit<ProxmoxWorld, 'product'>) {
  const fake = fakeProxmox({ product: 'pve', ...world });
  stub = await startStub(fake.route, { tls: true });
  return { ...fake, stub };
}

async function pbs(world: Omit<ProxmoxWorld, 'product'>) {
  const fake = fakeProxmox({ product: 'pbs', ...world });
  stub = await startStub(fake.route, { tls: true });
  return { ...fake, stub };
}

const ticketPosts = (s: Stub) => s.calls('POST /api2/json/access/ticket').map((r) => r.form());

describe('Proxmox VE (CS-20)', () => {
  it('makes a privilege-separated token with PVEAuditor to look', async () => {
    const { stub, tokens, acl } = await pve({ users: { 'root@pam': TEST_PASSWORD }, modify: true });
    const made = await provisionProxmoxVe(
      stubInput(stub, 'proxmox', { account: 'root@pam', access: 'read' }),
    );

    expect(made).toEqual({
      fields: { tokenId: 'root@pam!whombat' },
      secret: tokens.get('root@pam!whombat')?.secret,
      limited: true,
      externalName: 'root@pam',
      note: null,
    });
    expect(tokens.get('root@pam!whombat')?.form).toEqual({ privsep: '1', comment: 'Whombat' });
    expect(acl).toEqual([{ path: '/', tokens: 'root@pam!whombat', roles: 'PVEAuditor', propagate: '1' }]);
    // Writes carry the cookie and the CSRF token; the token is checked with itself.
    const put = stub.calls('PUT /api2/json/access/acl')[0];
    expect(put?.headers.cookie).toMatch(/^PVEAuthCookie=PVE:root@pam:/);
    expect(put?.headers.csrfpreventiontoken).toBe('csrf-root@pam');
    const check = stub.calls('GET /api2/json/access/permissions').at(-1);
    expect(check?.headers.authorization).toBe(`PVEAPIToken=root@pam!whombat=${made.secret}`);
    expect(check?.query.get('path')).toBe('/');
  });

  it('manages with the VM, storage, pool, SDN and mapping roles the server has, never PVEAdmin', async () => {
    const { stub, acl } = await pve({ users: { 'root@pam': TEST_PASSWORD }, modify: true });
    await provisionProxmoxVe(stubInput(stub, 'proxmox', { account: 'root@pam', access: 'manage' }));
    expect(acl[0]?.roles).toBe(
      'PVEVMAdmin,PVEDatastoreAdmin,PVEPoolAdmin,PVESDNAdmin,PVEMappingUser,PVEAuditor',
    );

    await stub.close();
    // An older Proxmox VE without the mapping and SDN roles.
    const older = await pve({
      users: { 'root@pam': TEST_PASSWORD },
      modify: true,
      roles: PVE_ROLE_LIST.filter((r) => !/Mapping|SDN/.test(r)),
    });
    await provisionProxmoxVe(stubInput(older.stub, 'proxmox', { account: 'root@pam', access: 'manage' }));
    expect(older.acl[0]?.roles).toBe('PVEVMAdmin,PVEDatastoreAdmin,PVEPoolAdmin,PVEAuditor');
    expect(older.acl[0]?.roles).not.toContain('PVEAdmin,');
  });

  it('takes whombat-2 when whombat exists', async () => {
    const { stub, tokens, acl } = await pve({
      users: { 'root@pam': TEST_PASSWORD },
      modify: true,
      existing: ['whombat'],
    });
    const made = await provisionProxmoxVe(stubInput(stub, 'proxmox', { account: 'root@pam' }));
    expect(made.fields.tokenId).toBe('root@pam!whombat-2');
    expect(tokens.get('root@pam!whombat')?.secret).toBe('theirs');
    expect(acl[0]?.tokens).toBe('root@pam!whombat-2');
  });

  it('without Permissions.Modify makes a token with the account’s own rights, and says so', async () => {
    const { stub, tokens, acl } = await pve({ users: { 'mara@pve': TEST_PASSWORD }, modify: false });
    const made = await provisionProxmoxVe(
      stubInput(stub, 'proxmox', { account: 'mara@pve', access: 'manage' }),
    );
    expect(made.limited).toBe(false);
    expect(made.note).toBe(PVE_OWN_RIGHTS_NOTE);
    expect(made.fields.tokenId).toBe('mara@pve!whombat');
    expect(tokens.get('mara@pve!whombat')?.form).toEqual({ privsep: '0', comment: 'Whombat' });
    expect(acl).toEqual([]);
    expect(stub.calls('PUT /api2/json/access/acl')).toHaveLength(0);
  });

  it('falls back to the account’s rights when Proxmox refuses the roles: the separated token is deleted', async () => {
    const { stub, tokens } = await pve({
      users: { 'root@pam': TEST_PASSWORD },
      modify: true,
      aclRefused: true,
    });
    const made = await provisionProxmoxVe(stubInput(stub, 'proxmox', { account: 'root@pam' }));
    expect(stub.calls('DELETE /api2/json/access/users/root%40pam/token/whombat')).toHaveLength(1);
    expect(made).toMatchObject({
      fields: { tokenId: 'root@pam!whombat' },
      limited: false,
      note: PVE_OWN_RIGHTS_NOTE,
    });
    expect(tokens.get('root@pam!whombat')?.form.privsep).toBe('0');
    expect([...tokens.keys()]).toEqual(['root@pam!whombat']);
  });

  it('uses the realm Proxmox marks default for an account without one', async () => {
    const { stub } = await pve({ users: { 'mara@ldap': TEST_PASSWORD }, modify: true, defaultRealm: 'ldap' });
    const made = await provisionProxmoxVe(stubInput(stub, 'proxmox', { account: 'mara' }));
    expect(made.externalName).toBe('mara@ldap');
    expect(ticketPosts(stub).map((f) => f.username)).toEqual(['mara@ldap']);
  });

  it('tries pve, then pam, without a default realm: at most two tries', async () => {
    const found = await pve({ users: { 'mara@pam': TEST_PASSWORD }, modify: true });
    await provisionProxmoxVe(stubInput(found.stub, 'proxmox', { account: 'mara' }));
    expect(ticketPosts(found.stub).map((f) => f.username)).toEqual(['mara@pve', 'mara@pam']);
    await found.stub.close();

    const wrong = await pve({ users: { 'mara@pam': 'something else' }, modify: true });
    const stop = await expectStop(
      provisionProxmoxVe(stubInput(wrong.stub, 'proxmox', { account: 'mara' })),
      'password',
    );
    expect(stop.message).toBe('Wrong username, password or realm.');
    expect(ticketPosts(wrong.stub)).toHaveLength(2);
  });

  it('signs root in as root@pam first, then the default realm', async () => {
    const plain = await pve({ users: { 'root@pam': TEST_PASSWORD }, modify: true });
    await provisionProxmoxVe(stubInput(plain.stub, 'proxmox', { account: 'root' }));
    expect(ticketPosts(plain.stub).map((f) => f.username)).toEqual(['root@pam']);
    await plain.stub.close();

    const marked = await pve({ users: { 'root@pve': TEST_PASSWORD }, modify: true, defaultRealm: 'pve' });
    await provisionProxmoxVe(stubInput(marked.stub, 'proxmox', { account: 'root' }));
    expect(ticketPosts(marked.stub).map((f) => f.username)).toEqual(['root@pam', 'root@pve']);
  });

  it('a wrong password with a realm is one try', async () => {
    const { stub } = await pve({ users: { 'root@pam': 'other' } });
    await expectStop(provisionProxmoxVe(stubInput(stub, 'proxmox', { account: 'root@pam' })), 'password');
    expect(ticketPosts(stub)).toHaveLength(1);
    // Only for the realm's type (SG-13).
    expect(stub.calls('GET /api2/json/access/domains')).toHaveLength(1);
  });

  it('refuses an OpenID realm before sending the password, typed or default (SG-13)', async () => {
    for (const account of ['mara@sso', 'mara']) {
      const { stub } = await pve({
        users: { 'mara@sso': TEST_PASSWORD },
        openid: 'sso',
        defaultRealm: 'sso',
      });
      const stop = await expectStop(
        provisionProxmoxVe(stubInput(stub, 'proxmox', { account })),
        'single_sign_on',
      );
      expect([account, stop.method]).toEqual([account, 'token']);
      expect(stop.message).toContain('OpenID');
      expect(ticketPosts(stub)).toHaveLength(0);
      await stub.close();
    }
    // root still signs in at pam.
    const root = await pve({
      users: { 'root@pam': TEST_PASSWORD },
      modify: true,
      openid: 'sso',
      defaultRealm: 'sso',
    });
    await provisionProxmoxVe(stubInput(root.stub, 'proxmox', { account: 'root' }));
    expect(ticketPosts(root.stub).map((f) => f.username)).toEqual(['root@pam']);
  });

  it('asks for the authenticator code, then answers the challenge with it', async () => {
    const world = {
      users: { 'root@pam': TEST_PASSWORD },
      modify: true,
      tfa: { offers: { totp: true, recovery: [0, 1, 2] }, answer: 'totp:123456' },
    };
    const first = await pve(world);
    const stop = await expectStop(
      provisionProxmoxVe(stubInput(first.stub, 'proxmox', { account: 'root@pam' })),
      'second_factor_needed',
    );
    expect(stop.message).toBe(AUTHENTICATOR_CODE);
    expect(first.tokens.size).toBe(0);
    await first.stub.close();

    // The form sends everything again with the code: a fresh challenge, answered.
    const second = await pve(world);
    const made = await provisionProxmoxVe(
      stubInput(second.stub, 'proxmox', { account: 'root@pam', code: '123 456' }),
    );
    expect(made.fields.tokenId).toBe('root@pam!whombat');
    const [signIn, answer] = ticketPosts(second.stub);
    expect(signIn).toEqual({ username: 'root@pam', password: TEST_PASSWORD });
    expect(answer?.username).toBe('root@pam');
    expect(answer?.['tfa-challenge']).toMatch(/^PVE:!tfa!/);
    expect(answer?.password).toBe('totp:123456');
  });

  it('refuses a wrong code, and says when Proxmox locked the codes', async () => {
    const world = {
      users: { 'root@pam': TEST_PASSWORD },
      tfa: { offers: { totp: true }, answer: 'totp:123456' },
    };
    const wrong = await pve(world);
    const stop = await expectStop(
      provisionProxmoxVe(stubInput(wrong.stub, 'proxmox', { account: 'root@pam', code: '654321' })),
      'code',
    );
    expect(stop.message).toContain('code didn’t work');
    await wrong.stub.close();

    const locked = fakeProxmox({ product: 'pve', ...world, codesLocked: true });
    stub = await startStub(
      (req) =>
        req.form()['tfa-challenge']
          ? { status: 401, json: { data: null, message: 'failed 2nd factor: TOTP limit reached, locked' } }
          : locked.route(req),
      { tls: true },
    );
    await expectStop(
      provisionProxmoxVe(stubInput(stub, 'proxmox', { account: 'root@pam', code: '123456' })),
      'locked',
    );
  });

  it('answers a recovery key as one', async () => {
    const { stub } = await pve({
      users: { 'root@pam': TEST_PASSWORD },
      modify: true,
      tfa: { offers: { totp: true, recovery: [3, 4] }, answer: 'recovery:4c1f-9a2b-77de-0e15' },
    });
    await provisionProxmoxVe(
      stubInput(stub, 'proxmox', { account: 'root@pam', code: '4c1f-9a2b-77de-0e15' }),
    );
    expect(ticketPosts(stub)[1]?.password).toBe('recovery:4c1f-9a2b-77de-0e15');
  });

  it('can’t use a security key: make a token by hand', async () => {
    const { stub, tokens } = await pve({
      users: { 'root@pam': TEST_PASSWORD },
      tfa: { offers: { webauthn: { challenge: 'x' } }, answer: 'never' },
    });
    const stop = await expectStop(
      provisionProxmoxVe(stubInput(stub, 'proxmox', { account: 'root@pam', code: '123456' })),
      'unsupported',
    );
    expect(stop.message).toContain('security key');
    expect(ticketPosts(stub)).toHaveLength(1);
    expect(tokens.size).toBe(0);
  });

  it('refuses when the account may not make tokens', async () => {
    const { stub } = await pve({
      users: { 'mara@pve': TEST_PASSWORD },
      tokenCreate: { status: 403, json: { data: null, message: 'Permission check failed' } },
    });
    await expectStop(provisionProxmoxVe(stubInput(stub, 'proxmox', { account: 'mara@pve' })), 'rights');
  });

  it('stops on an answer it doesn’t expect, in its own words', async () => {
    stub = await startStub(() => ({ status: 500, body: `internal error near ${TEST_PASSWORD}` }), {
      tls: true,
    });
    const stop = await expectStop(
      provisionProxmoxVe(stubInput(stub, 'proxmox', { account: 'root@pam' })),
      'unsupported',
    );
    expect(stop.message).toBe(
      'Proxmox VE gave an answer Whombat didn’t expect (500), so Whombat stopped. Try again, or make a token by hand.',
    );
  });
});

describe('Proxmox Backup Server (CS-21)', () => {
  const cookieTicket = (r: StubRequest | undefined) =>
    decodeURIComponent(String(r?.headers.cookie).replace(/^PBSAuthCookie=/, ''));

  it('gives its token Audit, RemoteAudit and TapeAudit to look, one ACL each', async () => {
    const { stub, acl, tokens } = await pbs({ users: { 'mara@pbs': TEST_PASSWORD } });
    const made = await provisionProxmoxBackup(stubInput(stub, 'proxmox_backup', { account: 'mara@pbs' }));
    expect(made).toEqual({
      fields: { tokenId: 'mara@pbs!whombat' },
      secret: tokens.get('mara@pbs!whombat')?.secret,
      limited: true,
      externalName: 'mara@pbs',
      note: null,
    });
    expect(tokens.get('mara@pbs!whombat')?.form).toEqual({ comment: 'Whombat' });
    expect(acl).toEqual(
      ['Audit', 'RemoteAudit', 'TapeAudit'].map((role) => ({
        path: '/',
        role,
        'auth-id': 'mara@pbs!whombat',
        propagate: '1',
      })),
    );
    // The ticket goes URL-encoded in the cookie; the token is checked with itself.
    const put = stub.calls('PUT /api2/json/access/acl')[0];
    expect(put?.headers.cookie).toMatch(/^PBSAuthCookie=PBS%3Amara%40pbs%3A/);
    expect(cookieTicket(put)).toMatch(/^PBS:mara@pbs:/);
    const check = stub.calls('GET /api2/json/access/permissions').at(-1);
    expect(check?.headers.authorization).toBe(`PBSAPIToken=mara@pbs!whombat:${made.secret}`);
  });

  it('manages with the datastore, remote and tape admin roles (and RemoteDatastoreAdmin where it exists)', async () => {
    const current = await pbs({ users: { 'root@pam': TEST_PASSWORD } });
    await provisionProxmoxBackup(
      stubInput(current.stub, 'proxmox_backup', { account: 'root', access: 'manage' }),
    );
    expect(current.acl.map((a) => a.role)).toEqual([
      'DatastoreAdmin',
      'RemoteAdmin',
      'TapeAdmin',
      'Audit',
      'RemoteDatastoreAdmin',
    ]);
    await current.stub.close();

    const older = await pbs({
      users: { 'root@pam': TEST_PASSWORD },
      roles: PBS_ROLE_LIST.filter((r) => r !== 'RemoteDatastoreAdmin'),
    });
    await provisionProxmoxBackup(
      stubInput(older.stub, 'proxmox_backup', { account: 'root', access: 'manage' }),
    );
    expect(older.acl.map((a) => a.role)).toEqual(['DatastoreAdmin', 'RemoteAdmin', 'TapeAdmin', 'Audit']);
  });

  it('signs an account without a realm in as @pam, once', async () => {
    const { stub } = await pbs({ users: { 'root@pam': 'other' } });
    const stop = await expectStop(
      provisionProxmoxBackup(stubInput(stub, 'proxmox_backup', { account: 'root' })),
      'password',
    );
    expect(stop.message).toBe('Wrong username, password or realm.');
    expect(ticketPosts(stub).map((f) => f.username)).toEqual(['root@pam']);
    expect(stub.calls('GET /api2/json/access/domains')).toHaveLength(0);
  });

  it('answers a PBS:!tfa! ticket with the code, and writes with the full ticket’s CSRF token', async () => {
    const world = {
      users: { 'root@pam': TEST_PASSWORD },
      tfa: { offers: { totp: true, recovery: [] }, answer: 'totp:246810' },
    };
    const first = await pbs(world);
    await expectStop(
      provisionProxmoxBackup(stubInput(first.stub, 'proxmox_backup', { account: 'root@pam' })),
      'second_factor_needed',
    );
    await first.stub.close();

    const second = await pbs(world);
    const made = await provisionProxmoxBackup(
      stubInput(second.stub, 'proxmox_backup', { account: 'root@pam', code: '246810' }),
    );
    expect(made.fields.tokenId).toBe('root@pam!whombat');
    expect(ticketPosts(second.stub)[1]).toMatchObject({
      'tfa-challenge': expect.stringMatching(/^PBS:!tfa!/),
    });
    expect(second.stub.calls('PUT /api2/json/access/acl')[0]?.headers.csrfpreventiontoken).toBe(
      'csrf-root@pam',
    );
  });

  it('takes whombat-2 when whombat exists', async () => {
    const { stub, acl } = await pbs({ users: { 'root@pam': TEST_PASSWORD }, existing: ['whombat'] });
    const made = await provisionProxmoxBackup(stubInput(stub, 'proxmox_backup', { account: 'root@pam' }));
    expect(made.fields.tokenId).toBe('root@pam!whombat-2');
    expect(new Set(acl.map((a) => a['auth-id']))).toEqual(new Set(['root@pam!whombat-2']));
  });

  it('deletes its token again when an ACL is refused', async () => {
    const { stub, tokens } = await pbs({ users: { 'root@pam': TEST_PASSWORD }, aclRefused: true });
    await expectStop(
      provisionProxmoxBackup(stubInput(stub, 'proxmox_backup', { account: 'root@pam' })),
      'unsupported',
    );
    expect(stub.calls('DELETE /api2/json/access/users/root%40pam/token/whombat')).toHaveLength(1);
    expect(tokens.size).toBe(0);
  });
});
