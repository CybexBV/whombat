/**
 * Sign in once for a self-hosted Grafana (docs/decisions/connections-setup.md CS-34): a service account named Whombat
 * with the level's role (Viewer or Editor: `limited: true`) and a token for it. Basic auth on each call; where Grafana
 * has basic auth off, the login form's `grafana_session` cookie instead (no `Origin` header, so Grafana's CSRF check
 * passes), logged out at the end. Grafana Cloud signs in through grafana.com: refused before anything is sent.
 */
import { CookieJar } from './cookies';
import { wrongPasswordOrSingleSignOn } from './home-common';
import {
  bodyText,
  isObject,
  type JsonObject,
  jsonObject,
  MAX_NAME_TRIES,
  nthName,
  numberAt,
  quietly,
  stamp,
  stringAt,
  unexpectedAnswer,
} from './network-support';
import { type Provisioner, type ProvisionInput, type ProvisionResponse, refuseSignIn } from './types';

const CLOUD = 'Grafana Cloud signs in through grafana.com: make a token instead.';
const WRONG_PASSWORD = 'Wrong username or password.';
const LOCKED =
  'Grafana paused sign-ins for this account after too many tries. Wait a few minutes, then try again.';
const RIGHTS =
  'This account isn’t an organisation admin in this Grafana. Sign in as one, or make a token by hand.';
const TOO_OLD = 'This Grafana is too old for service accounts. Make a token by hand instead.';
const SINGLE_SIGN_ON =
  'This Grafana doesn’t take a password from Whombat (single sign-on, or password sign-in turned off). Make a token instead.';

const ROLE = { read: 'Viewer', manage: 'Editor' } as const;

/** How Whombat is signed in: basic auth on each call, or the login form's session cookie. */
interface Session {
  headers(): Record<string, string>;
  jar: CookieJar | null;
  user: JsonObject | null;
}

export const provisionGrafana: Provisioner = async (input) => {
  const host = new URL(input.baseUrl).hostname.toLowerCase();
  if (host === 'grafana.net' || host.endsWith('.grafana.net'))
    throw refuseSignIn('unsupported', CLOUD, 'token');

  const session = await signIn(input);
  try {
    const role = ROLE[input.access];
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await input.fetch(path, {
        method,
        headers: {
          ...session.headers(),
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      session.jar?.take(res);
      return res;
    };
    const accountId = await serviceAccount(input, call, role);
    const secret = await token(input, call, accountId);
    return {
      fields: {},
      secret,
      limited: true,
      externalName: stringAt(session.user, 'login') ?? stringAt(session.user, 'email') ?? input.account,
      note: null,
    };
  } finally {
    const jar = session.jar;
    if (jar) await quietly(() => input.fetch('/logout', { method: 'GET', headers: jar.with() }));
  }
};

type Call = (method: string, path: string, body?: unknown) => Promise<ProvisionResponse>;

/** A refusal of the password in Grafana's words: blocked, or wrong; null when it says neither (basic auth off). */
function passwordRefusal(res: ProvisionResponse) {
  const text = bodyText(res);
  if (res.status === 429 || /blocked|too many/.test(text)) return refuseSignIn('locked', LOCKED);
  // Accounts that sign in through another service get the same answer (SG-13).
  if (/invalid (username or password|password or username)|password-auth\.(failed|invalid)/.test(text)) {
    return wrongPasswordOrSingleSignOn(WRONG_PASSWORD, 'Grafana');
  }
  return null;
}

/**
 * `GET /api/user` with basic auth. A 401 that names the password refuses it (never tried again, CS-04); one that
 * doesn't means basic auth is off: the login form, once.
 */
async function signIn(input: ProvisionInput): Promise<Session> {
  const basic = `Basic ${Buffer.from(`${input.account}:${input.password}`, 'utf8').toString('base64')}`;
  const res = await input.fetch('/api/user', {
    method: 'GET',
    headers: { Authorization: basic, Accept: 'application/json' },
  });
  if (res.status === 200)
    return { headers: () => ({ Authorization: basic }), jar: null, user: jsonObject(res) };
  const refused = passwordRefusal(res);
  if (refused) throw refused;
  if (res.status !== 401) throw unexpectedAnswer('Grafana', res.status, 'a token');

  const jar = new CookieJar(input.clock);
  const login = await input.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ user: input.account, password: input.password }),
  });
  jar.take(login);
  if (login.status !== 200 || jar.size === 0)
    throw passwordRefusal(login) ?? refuseSignIn('single_sign_on', SINGLE_SIGN_ON, 'token');
  const session: Session = { headers: () => jar.with(), jar, user: null };
  const me = await input.fetch('/api/user', {
    method: 'GET',
    headers: jar.with({ Accept: 'application/json' }),
  });
  jar.take(me);
  if (me.status !== 200) {
    await quietly(() => input.fetch('/logout', { method: 'GET', headers: jar.with() }));
    throw refuseSignIn('single_sign_on', SINGLE_SIGN_ON, 'token');
  }
  session.user = jsonObject(me);
  return session;
}

/**
 * `POST /api/serviceaccounts {name, role}` → `id`. A name that exists: the service account of exactly that name is
 * Whombat's (its role set when it differs, turned on when it was off); none of exactly that name takes the next
 * suffix (CS-06).
 */
async function serviceAccount(input: ProvisionInput, call: Call, role: string): Promise<number> {
  for (let n = 1; n <= MAX_NAME_TRIES; n++) {
    const name = nthName(input.name, n);
    const res = await call('POST', '/api/serviceaccounts', { name, role, isDisabled: false });
    if (res.status === 401 || res.status === 403) throw refuseSignIn('rights', RIGHTS);
    if (res.status === 404) throw refuseSignIn('unsupported', TOO_OLD);
    if (res.status === 200 || res.status === 201) {
      const id = numberAt(jsonObject(res), 'id');
      if (id === null) throw unexpectedAnswer('Grafana', res.status, 'a token');
      return id;
    }
    if ((res.status === 400 || res.status === 409) && /already exists/.test(bodyText(res))) {
      const existing = await findAccount(call, name);
      if (!existing) continue;
      const id = numberAt(existing, 'id');
      if (id === null) continue;
      const disabled = existing.isDisabled === true;
      if (stringAt(existing, 'role') !== role || disabled) {
        const changed = await call('PATCH', `/api/serviceaccounts/${id}`, {
          role,
          ...(disabled ? { isDisabled: false } : {}),
        });
        if (changed.status === 401 || changed.status === 403) throw refuseSignIn('rights', RIGHTS);
        if (changed.status !== 200) throw unexpectedAnswer('Grafana', changed.status, 'a token');
      }
      return id;
    }
    throw unexpectedAnswer('Grafana', res.status, 'a token');
  }
  throw refuseSignIn(
    'unsupported',
    `Grafana already has service accounts named ${input.name} to ${nthName(input.name, MAX_NAME_TRIES)}. Make a token by hand instead.`,
  );
}

/** The service account named exactly `name` (the search matches parts of names and logins). */
async function findAccount(call: Call, name: string): Promise<JsonObject | null> {
  const res = await call(
    'GET',
    `/api/serviceaccounts/search?query=${encodeURIComponent(name)}&perpage=100&page=1`,
  );
  if (res.status !== 200) throw unexpectedAnswer('Grafana', res.status, 'a token');
  const list = jsonObject(res)?.serviceAccounts;
  if (!Array.isArray(list)) return null;
  return list.find((a): a is JsonObject => isObject(a) && a.name === name) ?? null;
}

/** `POST /api/serviceaccounts/{id}/tokens {name: <name> <yyyymmdd-hhmm>}` → `key`; a name taken gets ` 2`, ` 3`. */
async function token(input: ProvisionInput, call: Call, accountId: number): Promise<string> {
  const base = `${input.name} ${stamp(input.clock())}`;
  for (let n = 1; n <= MAX_NAME_TRIES; n++) {
    const res = await call('POST', `/api/serviceaccounts/${accountId}/tokens`, { name: nthName(base, n) });
    if (res.status === 401 || res.status === 403) throw refuseSignIn('rights', RIGHTS);
    if ((res.status === 400 || res.status === 409) && /already exists/.test(bodyText(res))) continue;
    const key = res.status === 200 || res.status === 201 ? stringAt(jsonObject(res), 'key') : null;
    if (!key) throw unexpectedAnswer('Grafana', res.status, 'a token');
    return key;
  }
  throw unexpectedAnswer('Grafana', 400, 'a token');
}
