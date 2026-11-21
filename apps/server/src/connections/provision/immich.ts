/**
 * Sign in once for Immich (docs/decisions/connections-setup.md CS-25): a session from the account's email and
 * password, an API key named after this Whombat with every permission to manage or the read permissions this version
 * knows to look, and the session logged out again. Immich limits the key itself (CS-07).
 */
import type { ConnectionAccessLevel } from '@whombat/core';
import {
  candidateNames,
  jsonRequest,
  ok,
  quietly,
  record,
  text,
  unexpected,
  wrongPasswordOrSingleSignOn,
} from './home-common';
import { type Provisioner, type ProvisionInput, refuseSignIn } from './types';

const SERVICE = 'Immich';
const INSTEAD = 'make a key by hand';

const WRONG_LOGIN = 'Wrong email or password.';
const NO_PASSWORDS =
  'This Immich doesn’t sign in with passwords (it uses another sign-in service). Make a key by hand instead.';
const NO_KEYS = 'Immich didn’t let this account make an API key. Make one by hand instead.';

/** Look only: what every Immich with key permissions knows (1.113 on). */
const READ_BASE = [
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
/** The versions that added them (connection-signin.md SG-16): 1.137 and 2.5. */
const READ_FROM_1_137 = ['user.read', 'server.about', 'duplicate.read'];
const READ_FROM_2_5 = ['map.read', 'map.search', 'folder.read'];

interface Version {
  major: number;
  minor: number;
}

/** The permissions of a key at each level (CS-25): `all` to manage; to look, the read permissions of this version. */
export function immichPermissions(access: ConnectionAccessLevel, version: Version | null): string[] {
  if (access === 'manage') return ['all'];
  const at = (major: number, minor: number) =>
    !!version && (version.major > major || (version.major === major && version.minor >= minor));
  return [...READ_BASE, ...(at(1, 137) ? READ_FROM_1_137 : []), ...(at(2, 5) ? READ_FROM_2_5 : [])];
}

async function serverVersion(input: ProvisionInput): Promise<Version | null> {
  const res = await input.fetch('/api/server/version', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const json = ok(res) ? record(res.json()) : null;
  return typeof json?.major === 'number' && typeof json.minor === 'number'
    ? { major: json.major, minor: json.minor }
    : null;
}

/** The key's name (CS-06): Immich allows two of a name, but the person couldn't tell them apart. */
async function freeName(input: ProvisionInput, bearer: Record<string, string>): Promise<string> {
  const res = await input.fetch('/api/api-keys', {
    method: 'GET',
    headers: { ...bearer, Accept: 'application/json' },
  });
  const listed = ok(res) ? res.json() : null;
  const taken = new Set(Array.isArray(listed) ? listed.map((k) => text(record(k)?.name)) : []);
  for (const name of candidateNames(input.name, ' ')) if (!taken.has(name)) return name;
  return input.name;
}

export const provisionImmich: Provisioner = async (input) => {
  const features = await input.fetch('/api/server/features', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const offered = ok(features) ? record(features.json()) : null;
  if (offered?.passwordLogin === false) throw refuseSignIn('unsupported', NO_PASSWORDS, 'token');
  // With OAuth on, an account that signs in through it has no password: Immich answers as for a wrong one (SG-13).
  const wrongLogin = () =>
    offered?.oauth === true
      ? wrongPasswordOrSingleSignOn(WRONG_LOGIN, SERVICE, 'token', 'make a key by hand instead')
      : refuseSignIn('password', WRONG_LOGIN);

  const login = await input.fetch(
    '/api/auth/login',
    jsonRequest('POST', { email: input.account.trim(), password: input.password }),
  );
  if (login.status === 401 || login.status === 400) throw wrongLogin();
  if (!ok(login)) throw unexpected(SERVICE, login.status, INSTEAD);
  const session = record(login.json());
  const accessToken = text(session?.accessToken);
  if (!accessToken) throw unexpected(SERVICE, undefined, INSTEAD);
  const bearer = { Authorization: `Bearer ${accessToken}` };

  try {
    const name = await freeName(input, bearer);
    const version = await serverVersion(input);
    const create = (permissions: string[]) =>
      input.fetch('/api/api-keys', jsonRequest('POST', { name, permissions }, bearer));
    const permissions = immichPermissions(input.access, version);
    let res = await create(permissions);
    // A version that doesn't know one of the newer read permissions: once more with the ones every version knows.
    if (res.status === 400 && permissions.length > READ_BASE.length && /permission/i.test(res.text())) {
      res = await create(immichPermissions(input.access, null));
    }
    if (res.status === 403) throw refuseSignIn('rights', NO_KEYS);
    if (!ok(res)) throw unexpected(SERVICE, res.status, INSTEAD);
    const secret = text(record(res.json())?.secret);
    if (!secret) throw unexpected(SERVICE, undefined, INSTEAD);
    return { fields: {}, secret, limited: true, externalName: text(session?.userEmail), note: null };
  } finally {
    await quietly(() => input.fetch('/api/auth/logout', { method: 'POST', headers: bearer }));
  }
};
