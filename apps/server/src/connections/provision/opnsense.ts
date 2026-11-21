/**
 * Sign in once for OPNsense 25.1 or later (docs/decisions/connections-setup.md CS-31): the web interface's login form
 * (its CSRF field has a random name and value per session), then `add_api_key` for the signed-in user with the same
 * session and `X-CSRFToken`. The key and secret have the user's privileges (`limited: false`, CS-10); OPNsense keys
 * have no names, so nothing can collide.
 */
import { CookieJar } from './cookies';
import { bodyText, cleanCode, jsonObject, quietly, stringAt, unexpectedAnswer } from './network-support';
import { type Provisioner, type ProvisionInput, refuseSignIn } from './types';

const WRONG_PASSWORD = 'Wrong username or password. If the account asks for a 2FA code, enter it too.';
const WRONG_WITH_CODE = 'Wrong username, password or code.';
const RIGHTS = 'This account may not make API keys. Sign in as an admin of the firewall.';
const TOO_OLD = 'This OPNsense is older than 25.1: make an API key by hand instead.';
const NOT_LOCAL =
  'OPNsense keeps API keys only for its own users. Sign in with a user from System → Access → Users, or make a key by hand.';
const REBIND =
  'OPNsense refused this address as a possible DNS rebinding. Use its IP address, or add the name under System → Settings → Administration → Alternate Hostnames.';

/** The login page's CSRF field: a hidden input with a random name and value (also the `X-CSRFToken` for the API). */
export interface CsrfField {
  name: string;
  value: string;
}

const LOGIN_FIELDS = new Set(['usernamefld', 'passwordfld', 'login']);

/** Reads the CSRF field from a page: the hidden input OPNsense adds to every POST form. */
export function csrfField(html: string): CsrfField | null {
  let fallback: CsrfField | null = null;
  for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
    const attributes: Record<string, string> = {};
    for (const [, key, value] of tag.matchAll(/([a-z-]+)\s*=\s*"([^"]*)"/gi)) {
      if (key) attributes[key.toLowerCase()] = value ?? '';
    }
    const { type, name, value, autocomplete } = attributes;
    if (type?.toLowerCase() !== 'hidden' || !name || !value || LOGIN_FIELDS.has(name)) continue;
    if (autocomplete === 'new-password') return { name, value };
    fallback ??= { name, value };
  }
  return fallback;
}

export const provisionOpnsense: Provisioner = async (input) => {
  const jar = new CookieJar(input.clock);
  const page = await input.fetch('/', { method: 'GET', headers: { Accept: 'text/html' } });
  jar.take(page);
  if (page.status !== 200) throw unexpectedAnswer('OPNsense', page.status);
  const csrf = csrfField(page.text());
  if (!csrf) {
    if (/dns rebind/.test(bodyText(page))) throw refuseSignIn('unsupported', REBIND);
    throw unexpectedAnswer('OPNsense', page.status);
  }

  const session = await signIn(input, jar, csrf);
  try {
    const res = await input.fetch(`/api/auth/user/add_api_key/${encodeURIComponent(input.account)}`, {
      method: 'POST',
      headers: jar.with({
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRFToken': session.value,
      }),
      body: '{}',
    });
    jar.take(res);
    if (res.status === 401 || res.status === 403) throw refuseSignIn('rights', RIGHTS);
    if (res.status === 404) throw refuseSignIn('unsupported', TOO_OLD);
    if (res.status !== 200) throw unexpectedAnswer('OPNsense', res.status);
    const body = jsonObject(res);
    const key = stringAt(body, 'key');
    const secret = stringAt(body, 'secret');
    if (stringAt(body, 'result') === 'ok' && key && secret) {
      return { fields: { apiKey: key }, secret, limited: false, externalName: input.account, note: null };
    }
    if (stringAt(body, 'result') === 'failed') throw refuseSignIn('unsupported', NOT_LOCAL);
    throw unexpectedAnswer('OPNsense', res.status);
  } finally {
    await quietly(() => input.fetch('/?logout', { method: 'GET', headers: jar.with() }));
  }
};

/**
 * Posts the login form. With a code, OPNsense wants it in the password field: `<code><password>` by default,
 * `<password><code>` with “Reverse token order”; both are tried, the one allowed second try (CS-04, CS-31). A 302 is
 * signed in; the login page again (“Wrong username or password”) is refused. Answers the CSRF field to use next.
 */
async function signIn(input: ProvisionInput, jar: CookieJar, csrf: CsrfField): Promise<CsrfField> {
  const code = cleanCode(input.code);
  const tries = code ? [`${code}${input.password}`, `${input.password}${code}`] : [input.password];
  let field = csrf;
  for (const password of tries) {
    const res = await input.fetch('/', {
      method: 'POST',
      headers: jar.with({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' }),
      body: new URLSearchParams({
        [field.name]: field.value,
        usernamefld: input.account,
        passwordfld: password,
        login: '1',
      }).toString(),
    });
    jar.take(res);
    if (res.status === 302 || res.status === 303) return field;
    if (res.status === 200 && /wrong username or password/.test(bodyText(res))) {
      field = csrfField(res.text()) ?? field;
      continue;
    }
    throw unexpectedAnswer('OPNsense', res.status);
  }
  throw refuseSignIn('password', code ? WRONG_WITH_CODE : WRONG_PASSWORD);
}
