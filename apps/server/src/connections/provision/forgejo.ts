/**
 * Sign in once for Forgejo and Gitea (docs/decisions/connections-setup.md CS-35): one `POST /api/v1/users/{account}/tokens`
 * with basic auth (and the code in both servers' OTP headers) makes an access token with the level's scopes (`limited:
 * true`, never site administration). Nothing else is called: the servers may use up a code on its first use, and
 * there is no session to clean up.
 */

import { wrongPasswordOrSingleSignOn } from './home-common';
import {
  bodyText,
  cleanCode,
  idName,
  jsonObject,
  MAX_NAME_TRIES,
  nthName,
  stamp,
  stringAt,
  unexpectedAnswer,
} from './network-support';
import { needSecondFactor, type Provisioner, refuseSignIn } from './types';

/** The scopes per level (CS-35). */
export const FORGEJO_SCOPES = {
  read: [
    'read:repository',
    'read:issue',
    'read:organization',
    'read:user',
    'read:package',
    'read:notification',
    'read:misc',
  ],
  manage: [
    'write:repository',
    'write:issue',
    'write:organization',
    'write:package',
    'write:notification',
    'write:misc',
    'read:user',
  ],
} as const;

const WRONG_PASSWORD = 'Wrong username or password, or the 2FA code is missing or expired.';
const SECOND_FACTOR = 'Enter the code from your authenticator app.';
const WRONG_CODE = 'That code didn’t work. Enter the newest one from your authenticator app.';
const USED_CODE =
  'The server used up that code. Wait for the next one from your authenticator app, then try again.';
const SECURITY_KEY =
  'This account signs in with a security key, which Whombat can’t use. Make a token by hand instead.';
const NO_BASIC = 'This server doesn’t take passwords over its API. Make a token by hand instead.';
/**
 * Basic auth turned off (connection-signin.md SG-17): Forgejo 15+ says so, Forgejo 14 and older “auth method not
 * allowed”; an anonymous request may hear “auth required”.
 */
const BASIC_OFF =
  /password is disabled|auth method not allowed|basic auth\w*.*(disabled|not allowed)|^auth required$/;
/** Gitea checks who asks before how: an anonymous request (basic auth off) hears this 403 (SG-17). */
const ANONYMOUS = /doer should be the site admin/;
const NO_SCOPES = 'This Forgejo or Gitea is too old for tokens with scopes. Make a token by hand instead.';
const RIGHTS = 'The server didn’t let this account make access tokens.';
const EMAIL = 'Sign in with your username, not your email address.';
const NOT_FOUND = 'Whombat couldn’t find a Forgejo or Gitea API at this address.';

/** The answer's `message`, lower-cased and trimmed (never shown), or null. */
function messageOf(res: Parameters<typeof jsonObject>[0]): string | null {
  return stringAt(jsonObject(res), 'message')?.toLowerCase().trim() ?? null;
}

export const provisionForgejo: Provisioner = async (input) => {
  const account = input.account.trim();
  const code = cleanCode(input.code);
  const basic = `Basic ${Buffer.from(`${account}:${input.password}`, 'utf8').toString('base64')}`;
  const base = `${idName(input.name)}-${stamp(input.clock())}`;
  // A name taken means the password (and code) were right: a refusal after that is a used-up code.
  let signedIn = false;

  for (let n = 1; n <= MAX_NAME_TRIES; n++) {
    const res = await input.fetch(`/api/v1/users/${encodeURIComponent(account)}/tokens`, {
      method: 'POST',
      headers: {
        Authorization: basic,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(code ? { 'X-Forgejo-OTP': code, 'X-Gitea-OTP': code } : {}),
      },
      body: JSON.stringify({ name: nthName(base, n, '-'), scopes: FORGEJO_SCOPES[input.access] }),
    });
    const text = bodyText(res);
    if (res.status === 200 || res.status === 201) {
      const token = stringAt(jsonObject(res), 'sha1');
      if (!token) throw unexpectedAnswer('The server', res.status, 'a token');
      return { fields: {}, secret: token, limited: true, externalName: account, note: null };
    }
    if (res.status === 401) {
      if (/webauthn|security key/.test(text)) throw refuseSignIn('unsupported', SECURITY_KEY, 'token');
      if (signedIn && code) throw refuseSignIn('code', USED_CODE);
      if (BASIC_OFF.test(messageOf(res) ?? text)) throw refuseSignIn('unsupported', NO_BASIC, 'token');
      // Older servers say when the code is what's wrong; newer ones can't be told apart (CS-03).
      if (/\botp\b/.test(text))
        throw code ? refuseSignIn('code', WRONG_CODE) : needSecondFactor(SECOND_FACTOR);
      // An account that signs in through another service has no password: the same answer (SG-13).
      throw wrongPasswordOrSingleSignOn(WRONG_PASSWORD, 'Forgejo or Gitea');
    }
    if (res.status === 400 && /used already|already (exists|used)|been used/.test(text)) {
      signedIn = true;
      continue;
    }
    if (res.status === 400 && /scope/.test(text)) throw refuseSignIn('unsupported', NO_SCOPES);
    if (res.status === 403)
      throw ANONYMOUS.test(text)
        ? refuseSignIn('unsupported', NO_BASIC, 'token')
        : refuseSignIn('rights', RIGHTS);
    if (res.status === 404) {
      throw account.includes('@') ? refuseSignIn('password', EMAIL) : refuseSignIn('unsupported', NOT_FOUND);
    }
    if (res.status === 429) {
      throw refuseSignIn('locked', 'The server paused sign-ins after too many tries. Wait a few minutes.');
    }
    throw unexpectedAnswer('The server', res.status, 'a token');
  }
  throw refuseSignIn(
    'unsupported',
    `There are already tokens named ${base} to ${nthName(base, MAX_NAME_TRIES, '-')}. Make a token by hand instead.`,
  );
};
