/**
 * Sign in once for Proxmox VE (docs/decisions/connections-setup.md CS-20) and Proxmox Backup Server (CS-21): a ticket
 * from the account's password (and a second factor's code), then an API token named `whombat` (`whombat-2`, … when
 * the account has one) with the roles of the level asked on `/`, checked with the token itself. The ticket is
 * stateless and simply dropped (nothing to log out); a token Whombat just made and couldn't finish is deleted again.
 */
import type { ConnectionAccessLevel } from '@whombat/core';
import {
  AUTHENTICATOR_CODE,
  candidateNames,
  formRequest,
  ok,
  quietly,
  record,
  text,
  unexpected,
  WRONG_CODE,
} from './home-common';
import {
  needSecondFactor,
  type Provisioned,
  type Provisioner,
  type ProvisionInput,
  type ProvisionRequest,
  type ProvisionResponse,
  refuseSignIn,
} from './types';

const API = '/api2/json';

/** What tells Proxmox VE and Proxmox Backup Server apart here. */
interface Product {
  service: string;
  /** The ticket's prefix (`PVE:…`, `PBS:…`). */
  prefix: 'PVE' | 'PBS';
  cookie(ticket: string): string;
  /** The `Authorization` header of an API token (the catalog's token sign-in template). */
  tokenHeader(tokenId: string, secret: string): string;
}

const PVE: Product = {
  service: 'Proxmox VE',
  prefix: 'PVE',
  cookie: (ticket) => `PVEAuthCookie=${ticket}`,
  tokenHeader: (tokenId, secret) => `PVEAPIToken=${tokenId}=${secret}`,
};

const PBS: Product = {
  service: 'Proxmox Backup Server',
  prefix: 'PBS',
  cookie: (ticket) => `PBSAuthCookie=${encodeURIComponent(ticket)}`,
  tokenHeader: (tokenId, secret) => `PBSAPIToken=${tokenId}:${secret}`,
};

/** Proxmox VE's roles per level (CS-20), filtered by what the server has. Never `PVEAdmin`: it can manage users. */
export const PVE_ROLES: Readonly<Record<ConnectionAccessLevel, readonly string[]>> = {
  read: ['PVEAuditor'],
  manage: ['PVEVMAdmin', 'PVEDatastoreAdmin', 'PVEPoolAdmin', 'PVESDNAdmin', 'PVEMappingUser', 'PVEAuditor'],
};

/** Proxmox Backup Server's roles per level (CS-21); Manage adds `RemoteDatastoreAdmin` where the server has it. */
export const PBS_ROLES: Readonly<Record<ConnectionAccessLevel, readonly string[]>> = {
  read: ['Audit', 'RemoteAudit', 'TapeAudit'],
  manage: ['DatastoreAdmin', 'RemoteAdmin', 'TapeAdmin', 'Audit'],
};
const PBS_MANAGE_EXTRA = 'RemoteDatastoreAdmin';

/** The token id Whombat makes (CS-06), as the token sign-in's steps name it. */
const TOKEN_NAME = 'whombat';

const WRONG_LOGIN = 'Wrong username, password or realm.';
const OPENID =
  'This account signs in through OpenID, which has no password here. Make a token by hand instead.';
const SECURITY_KEY_ONLY =
  'This account signs in with a security key, which sign in once can’t use. Make a token by hand instead.';
const YUBIKEY_CODE = 'Enter a one-time password from your YubiKey.';
const OLD_SECOND_FACTOR =
  'This Proxmox is too old for sign in once with a second factor. Make a token by hand instead.';
const CODES_LOCKED =
  'Proxmox locked this account’s codes after too many wrong ones. An administrator can unlock them under Permissions → Two Factor.';
const NO_TOKENS = 'This account may not make API tokens. Sign in with one that may, or make a token by hand.';
const TOO_MANY_TOKENS =
  'This account already has tokens named whombat to whombat-20. Remove the ones you don’t use, then try again.';

/** Proxmox VE without `Permissions.Modify` on `/` (CS-20, CS-08). */
export const PVE_OWN_RIGHTS_NOTE =
  'Proxmox didn’t let this account hand out permissions, so the token has the account’s own rights; Whombat keeps agents to the level you chose.';

/** A signed-in session, dropped when the call ends. */
interface Session {
  userid: string;
  ticket: string;
  csrf: string | null;
}

/** A token Whombat made in this call. */
interface Made {
  name: string;
  tokenId: string;
  secret: string;
}

const dataOf = (res: ProvisionResponse): unknown => record(res.json())?.data;

/** A request as the signed-in account: the ticket's cookie, and the CSRF token on writes. */
function asAccount(session: Session, product: Product, init: ProvisionRequest): ProvisionRequest {
  const headers: Record<string, string> = { ...init.headers, Cookie: product.cookie(session.ticket) };
  if (init.method !== 'GET' && session.csrf) headers.CSRFPreventionToken = session.csrf;
  return { ...init, headers };
}

/**
 * The accounts to sign in as (CS-20, CS-D31): as typed with a realm; else `root` as `root@pam` (then the default realm
 * when it's another), anyone else in the realm Proxmox marks default, or `pve` then `pam`. At most two: each refusal
 * costs Proxmox 3 seconds and a syslog line. Proxmox VE's realm list (public) also says each realm's type: an `openid`
 * realm has no password, so it is refused before the password is sent (connection-signin.md SG-13, SG-S32). Proxmox
 * Backup Server has no default to ask: `@pam` (CS-21).
 */
async function accountsToTry(input: ProvisionInput, product: Product): Promise<string[]> {
  const account = input.account.trim();
  if (product === PBS) return [account.includes('@') ? account : `${account}@pam`];
  const domains = await input.fetch(`${API}/access/domains`, { method: 'GET' });
  const list = ok(domains) ? dataOf(domains) : null;
  const realms = (Array.isArray(list) ? list.map(record) : []).filter(
    (d): d is Record<string, unknown> => !!d,
  );
  const singleSignOn = (realm: string | null) =>
    !!realm && realms.some((d) => d.realm === realm && d.type === 'openid');
  const noPassword = () => refuseSignIn('single_sign_on', OPENID, 'token');
  if (account.includes('@')) {
    if (singleSignOn(account.slice(account.lastIndexOf('@') + 1))) throw noPassword();
    return [account];
  }
  const defaultRealm = text(realms.find((d) => d.default === 1 || d.default === true)?.realm);
  const wanted = account === 'root' ? ['pam', defaultRealm] : defaultRealm ? [defaultRealm] : ['pve', 'pam'];
  const tried = [...new Set(wanted.filter((r): r is string => !!r && !singleSignOn(r)))];
  if (tried.length === 0) throw noPassword();
  return tried.slice(0, 2).map((realm) => `${account}@${realm}`);
}

/** What a second factor's challenge offers (the JSON inside a `!tfa!` ticket), or null when it can't be read. */
function challengeOf(ticket: string): { totp: boolean; yubico: boolean; recovery: boolean } | null {
  try {
    const part = ticket.split(':')[1] ?? '';
    const challenge = record(JSON.parse(decodeURIComponent(part.slice('!tfa!'.length))));
    if (!challenge) return null;
    return {
      totp: !!challenge.totp,
      yubico: !!challenge.yubico,
      recovery: Array.isArray(challenge.recovery) && challenge.recovery.length > 0,
    };
  } catch {
    return null;
  }
}

/** The code as Proxmox wants it (CS-20): `totp:<code>`, a YubiKey's `yubico:<otp>`, or `recovery:<key>`. */
function tfaResponse(code: string, offers: { totp: boolean; yubico: boolean; recovery: boolean }): string {
  const c = code.replace(/\s+/g, '');
  if (offers.totp && /^\d{6,8}$/.test(c)) return `totp:${c}`;
  if (offers.yubico && /^[cbdefghijklnrtuv]{32,64}$/.test(c)) return `yubico:${c}`;
  if (offers.recovery && !/^\d+$/.test(c)) return `recovery:${c}`;
  return offers.totp ? `totp:${c}` : `yubico:${c}`;
}

/** Signs in (CS-20, CS-21): the realm, the ticket, and a second factor's challenge answered with the code. */
async function signIn(input: ProvisionInput, product: Product): Promise<Session> {
  const accounts = await accountsToTry(input, product);
  let first: Record<string, unknown> | null = null;
  for (const [i, username] of accounts.entries()) {
    const res = await input.fetch(
      `${API}/access/ticket`,
      formRequest('POST', { username, password: input.password }),
    );
    if (res.status === 401) {
      if (i < accounts.length - 1) continue;
      throw refuseSignIn('password', WRONG_LOGIN);
    }
    if (!ok(res)) throw unexpected(product.service, res.status);
    first = record(dataOf(res));
    break;
  }
  const ticket = text(first?.ticket);
  const userid = text(first?.username);
  if (!first || !ticket || !userid) throw unexpected(product.service);
  const firstCsrf = text(first.CSRFPreventionToken);
  const csrf = firstCsrf && firstCsrf !== 'invalid' ? firstCsrf : null;

  if (!ticket.startsWith(`${product.prefix}:!tfa!`)) {
    if (first.NeedTFA) throw refuseSignIn('unsupported', OLD_SECOND_FACTOR);
    return { userid, ticket, csrf };
  }

  // A second factor: unreadable challenges are treated as an authenticator app's.
  const offers = challengeOf(ticket) ?? { totp: true, yubico: false, recovery: false };
  if (!offers.totp && !offers.yubico) throw refuseSignIn('unsupported', SECURITY_KEY_ONLY);
  if (!input.code) throw needSecondFactor(offers.totp ? AUTHENTICATOR_CODE : YUBIKEY_CODE);
  const res = await input.fetch(
    `${API}/access/ticket`,
    formRequest('POST', {
      username: userid,
      'tfa-challenge': ticket,
      password: tfaResponse(input.code, offers),
    }),
  );
  if (res.status === 401) {
    if (/limit reached|locked/i.test(res.text())) throw refuseSignIn('locked', CODES_LOCKED);
    throw refuseSignIn('code', WRONG_CODE);
  }
  if (!ok(res)) throw unexpected(product.service, res.status);
  const full = record(dataOf(res));
  const fullTicket = text(full?.ticket);
  if (!fullTicket || fullTicket.includes('!tfa!')) throw unexpected(product.service);
  const fullCsrf = text(full?.CSRFPreventionToken);
  return { userid, ticket: fullTicket, csrf: fullCsrf && fullCsrf !== 'invalid' ? fullCsrf : csrf };
}

/** The roles the server has (`GET /access/roles`), or null when it won't say. */
async function serverRoles(
  input: ProvisionInput,
  session: Session,
  product: Product,
): Promise<Set<string> | null> {
  const res = await input.fetch(`${API}/access/roles`, asAccount(session, product, { method: 'GET' }));
  const list = ok(res) ? dataOf(res) : null;
  if (!Array.isArray(list)) return null;
  return new Set(list.map((r) => text(record(r)?.roleid)).filter((r): r is string => !!r));
}

const tokenPath = (session: Session, name: string) =>
  `${API}/access/users/${encodeURIComponent(session.userid)}/token/${encodeURIComponent(name)}`;

/** Makes the token (CS-06): `whombat`, or the next free `whombat-<n>` when Proxmox says it exists. */
async function makeToken(
  input: ProvisionInput,
  session: Session,
  product: Product,
  values: Record<string, string>,
): Promise<Made> {
  for (const name of candidateNames(TOKEN_NAME, '-')) {
    const res = await input.fetch(
      tokenPath(session, name),
      asAccount(session, product, formRequest('POST', values)),
    );
    if (ok(res)) {
      const made = record(dataOf(res));
      const tokenId = text(made?.['full-tokenid']) ?? text(made?.tokenid) ?? `${session.userid}!${name}`;
      const secret = text(made?.value);
      if (!secret) {
        await deleteToken(input, session, product, name);
        throw unexpected(product.service);
      }
      return { name, tokenId, secret };
    }
    if ((res.status === 400 || res.status === 500) && /already exists/i.test(res.text())) continue;
    if (res.status === 403) throw refuseSignIn('rights', NO_TOKENS);
    throw unexpected(product.service, res.status);
  }
  throw refuseSignIn('unsupported', TOO_MANY_TOKENS);
}

/** Deletes a token Whombat made in this call and couldn't finish (CS-06: it is Whombat's own). */
async function deleteToken(
  input: ProvisionInput,
  session: Session,
  product: Product,
  name: string,
): Promise<void> {
  await quietly(() =>
    input.fetch(tokenPath(session, name), asAccount(session, product, { method: 'DELETE' })),
  );
}

/** The token works (CS-20): `GET /access/permissions?path=/` with the token itself; else it is deleted again. */
async function verifyToken(
  input: ProvisionInput,
  session: Session,
  product: Product,
  made: Made,
): Promise<void> {
  const res = await input.fetch(`${API}/access/permissions?path=${encodeURIComponent('/')}`, {
    method: 'GET',
    headers: { Authorization: product.tokenHeader(made.tokenId, made.secret) },
  });
  if (ok(res)) return;
  await deleteToken(input, session, product, made.name);
  throw unexpected(product.service, res.status);
}

/** Does the account hold `Permissions.Modify` on `/` (CS-20)? */
async function mayHandOutPermissions(input: ProvisionInput, session: Session): Promise<boolean> {
  const res = await input.fetch(
    `${API}/access/permissions?path=${encodeURIComponent('/')}`,
    asAccount(session, PVE, { method: 'GET' }),
  );
  const root = ok(res) ? record(record(dataOf(res))?.['/']) : null;
  return !!root && 'Permissions.Modify' in root;
}

const provisioned = (session: Session, made: Made, limited: boolean, note: string | null): Provisioned => ({
  fields: { tokenId: made.tokenId },
  secret: made.secret,
  limited,
  externalName: session.userid,
  note,
});

/**
 * Proxmox VE (CS-20). With `Permissions.Modify` on `/`: a privilege-separated token with the level's roles on `/`
 * (`limited`). Without it, or when Proxmox refuses the roles: a token with the account's own rights (`privsep=0`), and
 * a note (CS-08, CS-D32).
 */
export const provisionProxmoxVe: Provisioner = async (input) => {
  const session = await signIn(input, PVE);
  const comment = input.name;

  if (await mayHandOutPermissions(input, session)) {
    const available = await serverRoles(input, session, PVE);
    const roles = PVE_ROLES[input.access].filter((r) => !available || available.has(r));
    if (roles.length === 0) throw unexpected(PVE.service);
    const made = await makeToken(input, session, PVE, { privsep: '1', comment });
    const acl = await input.fetch(
      `${API}/access/acl`,
      asAccount(
        session,
        PVE,
        formRequest('PUT', { path: '/', tokens: made.tokenId, roles: roles.join(','), propagate: '1' }),
      ),
    );
    if (ok(acl)) {
      await verifyToken(input, session, PVE, made);
      return provisioned(session, made, true, null);
    }
    await deleteToken(input, session, PVE, made.name);
  }

  const made = await makeToken(input, session, PVE, { privsep: '0', comment });
  await verifyToken(input, session, PVE, made);
  return provisioned(session, made, false, PVE_OWN_RIGHTS_NOTE);
};

/**
 * Proxmox Backup Server (CS-21): every token needs its own ACLs, which an account may set on its own tokens: one
 * `PUT /access/acl` per role on `/`.
 */
export const provisionProxmoxBackup: Provisioner = async (input) => {
  const session = await signIn(input, PBS);
  const available = await serverRoles(input, session, PBS);
  const wanted =
    input.access === 'manage' && available?.has(PBS_MANAGE_EXTRA)
      ? [...PBS_ROLES.manage, PBS_MANAGE_EXTRA]
      : [...PBS_ROLES[input.access]];
  const roles = wanted.filter((r) => !available || available.has(r));
  if (roles.length === 0) throw unexpected(PBS.service);

  const made = await makeToken(input, session, PBS, { comment: input.name });
  for (const role of roles) {
    const res = await input.fetch(
      `${API}/access/acl`,
      asAccount(
        session,
        PBS,
        formRequest('PUT', { path: '/', role, 'auth-id': made.tokenId, propagate: '1' }),
      ),
    );
    if (ok(res)) continue;
    await deleteToken(input, session, PBS, made.name);
    if (res.status === 403) throw refuseSignIn('rights', NO_TOKENS);
    throw unexpected(PBS.service, res.status);
  }
  await verifyToken(input, session, PBS, made);
  return provisioned(session, made, true, null);
};
