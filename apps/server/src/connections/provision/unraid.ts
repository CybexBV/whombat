/**
 * Sign in once for Unraid 7.2 or later (docs/decisions/connections-setup.md CS-32): the web interface's login as root,
 * the per-boot `csrf_token` from the Dashboard, then an API key over GraphQL with the role of the level asked (Viewer
 * or Admin: `limited: true`). Unraid answers an existing key when the name is taken, so the names in use are read
 * first and the next free one is made (CS-06).
 */
import { CookieJar } from './cookies';
import {
  bodyText,
  headerOf,
  isObject,
  jsonObject,
  MAX_NAME_TRIES,
  nthName,
  quietly,
  stringAt,
  unexpectedAnswer,
} from './network-support';
import { type Provisioner, type ProvisionInput, type ProvisionResponse, refuseSignIn } from './types';

const WRONG_PASSWORD = 'Wrong password. Unraid pauses sign-ins for 15 minutes after three wrong tries.';
const WRONG_NOW_LOCKED = 'Wrong password. Unraid now pauses sign-ins for 15 minutes.';
const LOCKED = 'Unraid paused sign-ins after too many tries. Wait 15 minutes, then try again.';
const RIGHTS = 'Unraid didn’t let this account make API keys. Sign in as root.';
const NO_API = 'Unraid’s API isn’t answering: it needs Unraid 7.2 or later, or the Unraid Connect plugin.';
const MOVED =
  'Unraid sends this address on to its https address. Use the address from Settings → Management Access instead.';

const ROLE = { read: 'VIEWER', manage: 'ADMIN' } as const;
const DESCRIPTION = { read: 'Made by Whombat (Look only)', manage: 'Made by Whombat (Manage)' } as const;

const CREATE =
  'mutation CreateWhombatKey($input: CreateApiKeyInput!) { apiKey { create(input: $input) { id key name roles } } }';

/** Unraid's key names: letters, digits and spaces only (`Whombat (Home)` → `Whombat Home`). */
export function unraidKeyName(name: string): string {
  return (
    name
      .replace(/[^\p{L}\p{N} ]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'Whombat'
  );
}

export const provisionUnraid: Provisioner = async (input) => {
  const account = input.account.trim() || 'root';
  const jar = new CookieJar(input.clock);
  await signIn(input, account, jar);
  try {
    const dashboard = await input.fetch('/Dashboard', {
      method: 'GET',
      headers: jar.with({ Accept: 'text/html' }),
    });
    jar.take(dashboard);
    const csrf = /\bcsrf_token\s*=\s*["']([^"']+)["']/.exec(
      dashboard.status === 200 ? dashboard.text() : '',
    )?.[1];
    if (!csrf) throw unexpectedAnswer('Unraid', dashboard.status);

    const graphql = async (query: string, variables?: Record<string, unknown>) => {
      const res = await input.fetch('/graphql', {
        method: 'POST',
        headers: jar.with({
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-csrf-token': csrf,
        }),
        body: JSON.stringify(variables ? { query, variables } : { query }),
      });
      if (res.status === 404 || res.status === 502 || res.status === 503)
        throw refuseSignIn('unsupported', NO_API);
      if (res.status === 401 || res.status === 403) throw refuseSignIn('rights', RIGHTS);
      return res;
    };

    const taken = keyNames(await graphql('query WhombatKeyNames { apiKeys { name } }'));
    const base = unraidKeyName(input.name);
    let name: string | null = null;
    for (let n = 1; n <= MAX_NAME_TRIES && !name; n++) {
      if (!taken.has(nthName(base, n))) name = nthName(base, n);
    }
    if (!name) {
      throw refuseSignIn(
        'unsupported',
        `Unraid already has keys named ${base} to ${nthName(base, MAX_NAME_TRIES)}. Make a key by hand instead.`,
      );
    }

    const role = ROLE[input.access];
    const res = await graphql(CREATE, {
      input: { name, description: DESCRIPTION[input.access], roles: [role] },
    });
    const created = createdKey(res);
    if (created === 'forbidden') throw refuseSignIn('rights', RIGHTS);
    // An existing key (made since the names were read) would answer with its own roles: never take that.
    if (!created || (created.roles && created.roles.join() !== role))
      throw unexpectedAnswer('Unraid', res.status);
    return { fields: {}, secret: created.key, limited: true, externalName: account, note: null };
  } finally {
    await quietly(() => input.fetch('/logout', { method: 'GET', headers: jar.with() }));
  }
};

/** `POST /login`: a 302 with the `unraid_<…>` session cookie is signed in; the login page again is refused. */
async function signIn(input: ProvisionInput, account: string, jar: CookieJar): Promise<void> {
  const res = await input.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
    body: new URLSearchParams({ username: account, password: input.password }).toString(),
  });
  jar.take(res);
  if (res.status === 200) {
    const text = bodyText(res);
    if (/too many previous login attempts/.test(text)) throw refuseSignIn('locked', LOCKED);
    if (/invalid username or password/.test(text)) {
      throw refuseSignIn('password', /logins prevented/.test(text) ? WRONG_NOW_LOCKED : WRONG_PASSWORD);
    }
    throw unexpectedAnswer('Unraid', res.status);
  }
  const signedIn =
    (res.status === 302 || res.status === 303) && /(^|; )unraid_[^=]*=/.test(jar.header() ?? '');
  if (signedIn) return;
  if (/^https:/i.test(headerOf(res, 'location') ?? '') && /^http:/i.test(input.baseUrl)) {
    throw refuseSignIn('unsupported', MOVED);
  }
  throw unexpectedAnswer('Unraid', res.status);
}

/** The names of the keys there are (none when the list can't be read: the create's roles still guard). */
function keyNames(res: ProvisionResponse): Set<string> {
  const data = jsonObject(res)?.data;
  const keys = isObject(data) && Array.isArray(data.apiKeys) ? data.apiKeys : [];
  return new Set(keys.map((k) => (isObject(k) ? stringAt(k, 'name') : null)).filter((n): n is string => !!n));
}

/** `data.apiKey.create`: the key and its roles; `forbidden` when GraphQL refused (status 200 with `errors`). */
function createdKey(res: ProvisionResponse): { key: string; roles: string[] | null } | 'forbidden' | null {
  const body = jsonObject(res);
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    return /forbidden|unauthori[sz]ed/.test(bodyText(res)) ? 'forbidden' : null;
  }
  const data = body?.data;
  const apiKey = isObject(data) && isObject(data.apiKey) ? data.apiKey : null;
  const create = apiKey && isObject(apiKey.create) ? apiKey.create : null;
  const key = stringAt(create, 'key');
  if (!key) return null;
  const roles = Array.isArray(create?.roles)
    ? create.roles.filter((r): r is string => typeof r === 'string')
    : null;
  return { key, roles };
}
