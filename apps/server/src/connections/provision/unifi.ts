/**
 * Sign in once for a UniFi OS console: UniFi Network and UniFi Protect (docs/decisions/connections-setup.md CS-30).
 * One API key serves both; it has the account's rights (UniFi can't limit keys), so Whombat keeps it to the level
 * chosen (`limited: false`, CS-10). The console signs in at its root, whatever the entry's API path is.
 *
 * A UI.com account's second factor belongs to the challenge the console made (connection-signin.md SG-06, SG-07): the
 * first round signs in without a code, and the 499 answer's `UBIC_2FA` challenge is handed back with the ask, worded
 * from `data.authenticators[].type` (an authenticator app, an emailed code, both). The second round answers that
 * challenge: the cookie and the code in one POST; another 499 is a wrong code, refused with the new challenge. An
 * account that only confirms in the UI Verify app or with a passkey is refused before anyone waits for a code.
 */
import { CookieJar, parseSetCookie } from './cookies';
import {
  bodyText,
  cleanCode,
  headerOf,
  isObject,
  type JsonObject,
  jsonObject,
  MAX_NAME_TRIES,
  nthName,
  originOf,
  quietly,
  stringAt,
  unexpectedAnswer,
} from './network-support';
import {
  needSecondFactor,
  type Provisioner,
  type ProvisionInput,
  type ProvisionResponse,
  refuseSignIn,
} from './types';

/** The challenge cookie a second factor is answered with (CS-30). */
const MFA_COOKIE = 'UBIC_2FA';

const SECOND_FACTOR = 'Enter the code from your authenticator app, or the one UniFi just emailed you.';
const APP_CODE = 'Enter the code from your authenticator app.';
const WRONG_PASSWORD = 'Wrong username or password.';
const WRONG_CODE = 'That code didn’t work. Enter the newest code.';
const NO_TYPED_CODE =
  'This UI.com account confirms sign-ins in the UI Verify app or with a passkey, which Whombat can’t answer. Use a local admin, or make an API key by hand.';
const LOCKED = 'UniFi paused sign-ins after too many tries. Wait a few minutes, then try again.';
const RIGHTS = 'Sign in as the console’s Owner or a Super Admin.';
const OLD_SERVER = 'This is the older Network Server: API keys need a UniFi OS console.';

/** The session: its cookies (`TOKEN` or `UOS_TOKEN`) and the CSRF token, which the console may replace on any answer. */
interface Session {
  jar: CookieJar;
  csrf: string | null;
  /** The signed-in user as the login answered it (`unique_id`, `username`, `email`). */
  user: JsonObject | null;
}

export const provisionUnifi: Provisioner = async (input) => {
  const origin = originOf(input.baseUrl);
  const at = (path: string) => `${origin}${path}`;

  // Only a UniFi OS console makes API keys; the older Network Server has no public /api/system.
  const system = await input.fetch(at('/api/system'), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (system.status === 404 || system.status === 401) throw refuseSignIn('unsupported', OLD_SERVER);
  if (system.status !== 200) throw unexpectedAnswer('UniFi', system.status);

  const session = await signIn(input, at);
  try {
    const key = await makeKey(input, at, session);
    return {
      fields: {},
      secret: key,
      limited: false,
      externalName: stringAt(session.user, 'username') ?? stringAt(session.user, 'email') ?? input.account,
      note: null,
    };
  } finally {
    await quietly(() =>
      input.fetch(at('/api/auth/logout'), { method: 'POST', headers: session.jar.with(csrfHeader(session)) }),
    );
  }
};

/**
 * `POST /api/auth/login` with the account and the password (SG-07). With a code and the challenge it belongs to: one
 * POST with the `UBIC_2FA` cookie and `token`. Without a challenge: a first POST without `token`; a 499 asks for a second
 * factor — without a code the person is asked (the challenge handed back), with one (a challenge that expired or didn't
 * open) the code goes with the new challenge, as before SG-06. A 499 to a code is a wrong code, refused with the new
 * challenge so the newest code can answer it.
 */
async function signIn(input: ProvisionInput, at: (path: string) => string): Promise<Session> {
  const code = cleanCode(input.code);
  const jar = new CookieJar(input.clock);
  const post = (token: string | null) =>
    input.fetch(at('/api/auth/login'), {
      method: 'POST',
      headers: jar.with({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({
        username: input.account,
        password: input.password,
        ...(token !== null ? { token } : {}),
        rememberMe: false,
      }),
    });
  /** The code against the challenge in the jar: a 499 again means the code was wrong (a new challenge to answer). */
  const answer = async (token: string) => {
    const res = await post(token);
    jar.take(res);
    if (asksSecondFactor(res))
      throw refuseSignIn('code', WRONG_CODE, null, challengeCookie(res, jar)?.value ?? null);
    return res;
  };

  let res: ProvisionResponse;
  let challenged = false;
  if (code && input.challenge) {
    jar.set(MFA_COOKIE, input.challenge);
    challenged = true;
    res = await answer(code);
  } else {
    res = await post(null);
    jar.take(res);
    if (asksSecondFactor(res)) {
      const challenge = challengeCookie(res, jar);
      if (!code) throw secondFactorAsk(res, challenge?.value ?? null);
      if (!challenge) throw unexpectedAnswer('UniFi', res.status);
      jar.set(challenge.name, challenge.value);
      challenged = true;
      res = await answer(code);
    }
  }
  if (res.status === 429) throw refuseSignIn('locked', LOCKED);
  if ((res.status === 401 || res.status === 403) && /limit_reached|too_many|locked/.test(bodyText(res))) {
    throw refuseSignIn('locked', LOCKED);
  }
  if (res.status === 401 || res.status === 403) {
    // After the challenge the password was right: the code wasn't.
    if (challenged || (code && /mfa|2fa|two.?factor|otp/.test(bodyText(res))))
      throw refuseSignIn('code', WRONG_CODE);
    throw refuseSignIn('password', WRONG_PASSWORD);
  }
  if (res.status !== 200 || !(jar.get('TOKEN') || jar.get('UOS_TOKEN')))
    throw unexpectedAnswer('UniFi', res.status);

  const answered = jsonObject(res);
  const user = isObject(answered?.data) ? answered.data : answered;
  const csrf =
    headerOf(res, 'x-csrf-token') ??
    headerOf(res, 'x-updated-csrf-token') ??
    csrfInToken(jar.get('TOKEN') ?? jar.get('UOS_TOKEN'));
  return { jar, csrf, user };
}

/** How an authenticator answers (SG-07; UniFi's type names aren't documented, so they are matched loosely). */
type Authenticator =
  | { kind: 'app' }
  | { kind: 'email'; email: string | null }
  | { kind: 'other' | 'unknown' };

/** `data.authenticators[]` of a 499: what each one is. */
export function authenticatorsOf(res: Pick<ProvisionResponse, 'json'>): Authenticator[] {
  const data = jsonObject(res)?.data;
  const list = isObject(data) && Array.isArray(data.authenticators) ? data.authenticators : [];
  return list.slice(0, 20).map((item): Authenticator => {
    const one = isObject(item) ? item : null;
    const type = (stringAt(one, 'type') ?? '').toLowerCase();
    if (/e-?mail/.test(type)) return { kind: 'email', email: stringAt(one, 'email') };
    if (/totp|otp|authenticator|google/.test(type)) return { kind: 'app' };
    // Push to the UI Verify app, a passkey or a security key: nothing to type.
    if (/push|verify|passkey|webauthn|fido|u2f|security.?key/.test(type)) return { kind: 'other' };
    return { kind: 'unknown' };
  });
}

/** `m•••@example.com`: enough of the address to recognise it. */
export function maskedEmail(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  return `${email[0]}•••${email.slice(at)}`;
}

/**
 * The ask for a second factor, worded from the account's authenticators (SG-07), with the challenge handed back; or,
 * when none of them takes a typed code (UI Verify, a passkey), the refusal that switches to a hand-made key. Types it
 * doesn't know, or none listed, keep the sentence that names both.
 */
export function secondFactorAsk(
  res: Pick<ProvisionResponse, 'json'>,
  challenge: string | null,
): ReturnType<typeof needSecondFactor> {
  const kinds = authenticatorsOf(res);
  if (kinds.length && kinds.every((k) => k.kind === 'other'))
    return refuseSignIn('second_factor', NO_TYPED_CODE, 'token');
  if (kinds.some((k) => k.kind === 'unknown')) return needSecondFactor(SECOND_FACTOR, challenge);
  const app = kinds.some((k) => k.kind === 'app');
  const email = kinds.find((k): k is { kind: 'email'; email: string | null } => k.kind === 'email');
  if (!email) return needSecondFactor(app ? APP_CODE : SECOND_FACTOR, challenge);
  const masked = email.email ? maskedEmail(email.email) : null;
  const emailed = masked ? `the one UniFi just emailed to ${masked}` : 'the one UniFi just emailed you';
  return needSecondFactor(
    app
      ? `Enter the code from your authenticator app, or ${emailed}.`
      : masked
        ? `Enter the code UniFi just emailed to ${masked}.`
        : 'Enter the code UniFi just emailed you.',
    challenge,
  );
}

/** The `csrfToken` claim of the session's JWT, for a console that sends no CSRF header (unverified). */
function csrfInToken(jwt: string | undefined): string | null {
  const payload = jwt?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return isObject(claims) ? stringAt(claims, 'csrfToken') : null;
  } catch {
    return null;
  }
}

/** A 499, `MFA_AUTH_REQUIRED`, or the older `api.err.Ubic2faTokenRequired`. */
function asksSecondFactor(res: ProvisionResponse): boolean {
  if (res.status === 499) return true;
  const body = jsonObject(res);
  if (stringAt(body, 'code') === 'MFA_AUTH_REQUIRED') return true;
  const meta = isObject(body?.meta) ? body.meta : null;
  return stringAt(meta, 'msg') === 'api.err.Ubic2faTokenRequired';
}

/** The challenge cookie: the 499 body's `data.mfaCookie` (`UBIC_2FA=…; path=/`), else what it set. */
function challengeCookie(res: ProvisionResponse, jar: CookieJar): { name: string; value: string } | null {
  const body = jsonObject(res);
  const raw = stringAt(isObject(body?.data) ? body.data : null, 'mfaCookie');
  if (raw) {
    const parsed = raw.includes('=') ? parseSetCookie(raw) : { name: MFA_COOKIE, value: raw };
    if (parsed?.value) return { name: parsed.name, value: parsed.value };
  }
  const set = jar.get(MFA_COOKIE);
  return set ? { name: MFA_COOKIE, value: set } : null;
}

function csrfHeader(session: Session): Record<string, string> {
  return session.csrf ? { 'X-CSRF-Token': session.csrf } : {};
}

/**
 * `POST /proxy/users/api/v2/user/self/keys` (`user/<unique_id>/keys` where `self` isn't known) → `data.full_api_key`.
 * A name taken (unverified: UniFi may allow the same name twice) takes the next suffix (CS-06).
 */
async function makeKey(
  input: ProvisionInput,
  at: (path: string) => string,
  session: Session,
): Promise<string> {
  const userId = stringAt(session.user, 'unique_id') ?? stringAt(session.user, 'id');
  let path = '/proxy/users/api/v2/user/self/keys';
  const post = async (name: string) => {
    const res = await input.fetch(at(path), {
      method: 'POST',
      headers: session.jar.with({
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...csrfHeader(session),
      }),
      body: JSON.stringify({ name, description: 'Made by Whombat for its agents' }),
    });
    session.jar.take(res);
    session.csrf = headerOf(res, 'x-updated-csrf-token') ?? session.csrf;
    return res;
  };

  for (let n = 1; n <= MAX_NAME_TRIES; n++) {
    const name = nthName(input.name, n);
    let res = await post(name);
    if (res.status === 404 && path.includes('/self/') && userId) {
      path = `/proxy/users/api/v2/user/${encodeURIComponent(userId)}/keys`;
      res = await post(name);
    }
    if (res.status === 401 || res.status === 403) throw refuseSignIn('rights', RIGHTS);
    if ([400, 409, 422].includes(res.status) && /exist|duplicate|already|taken|unique/.test(bodyText(res)))
      continue;
    if (res.status < 200 || res.status >= 300) throw unexpectedAnswer('UniFi', res.status);
    const key = fullKey(res);
    if (!key) throw unexpectedAnswer('UniFi', res.status);
    return key;
  }
  throw refuseSignIn(
    'unsupported',
    `UniFi already has keys named ${input.name} to ${nthName(input.name, MAX_NAME_TRIES)}. Make a key by hand instead.`,
  );
}

/** `data.full_api_key`, read defensively (the answer's shape isn't documented). */
function fullKey(res: ProvisionResponse): string | null {
  const body = jsonObject(res);
  const data = body?.data;
  const first = Array.isArray(data) ? data[0] : data;
  return (
    stringAt(isObject(first) ? first : null, 'full_api_key') ??
    stringAt(body, 'full_api_key') ??
    stringAt(isObject(first) ? first : null, 'fullApiKey')
  );
}
