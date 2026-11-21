/**
 * Sign in once for Nextcloud (docs/decisions/connections-setup.md CS-23): `GET /ocs/v2.php/core/getapppassword` with
 * the account's password turns it into an app password, listed under the person's devices with Whombat's name (the
 * `User-Agent`). Nextcloud can't limit it (CS-07). No session is kept (no cookies are sent or read); nothing to clean
 * up. An account with two-step sign-in can't do this with a password: the person signs in with Nextcloud instead.
 *
 * One counted attempt per try (connection-signin.md SG-15c): Nextcloud counts every refused login against Whombat's
 * address, for every account (its other Nextcloud connections pause too), so WebDAV is asked first — its answer also
 * tells two-step sign-in from a wrong password — and `getapppassword` only after the password worked.
 */
import { ok, record, text, unexpected, wrongPasswordOrSingleSignOn } from './home-common';
import { headerOf } from './network-support';
import { type Provisioned, type Provisioner, type ProvisionResponse, refuseSignIn } from './types';

const SERVICE = 'Nextcloud';
const INSTEAD = 'sign in with Nextcloud';
/** The sign-in that works for every account: Nextcloud's own login page (SG-15e). */
const NEXTCLOUD_LOGIN = 'nextcloud_login';

const WRONG_LOGIN = 'Wrong username or password.';
const TWO_STEP = 'This account uses two-step sign-in. Sign in with Nextcloud instead.';
const NO_APP_PASSWORDS =
  'This Nextcloud doesn’t let this account make app passwords. Sign in with Nextcloud, or ask its administrator.';
const PAUSED =
  'Nextcloud paused sign-ins from Whombat’s address after too many tries. Wait a few minutes, then try again.';

/** WebDAV's smallest question: who is signed in (Depth 0). */
const PRINCIPAL_BODY =
  '<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';

/**
 * The password is an app password already (CS-23): Nextcloud won't make one with another. Before 32.0.12 / 33.0.6 it
 * says so; since, an app password doesn't confirm the password and the answer is 403 `X-NC-Auth-NotConfirmed: true`
 * (SG-15b). Either way the login itself worked.
 */
function typedAppPassword(res: ProvisionResponse): boolean {
  if (res.status !== 403) return false;
  if (headerOf(res, 'x-nc-auth-notconfirmed')?.trim().toLowerCase() === 'true') return true;
  return /apppassword with an apppassword|password confirmation is required/i.test(res.text());
}

export const provisionNextcloud: Provisioner = async (input) => {
  const username = input.account.trim();
  const authorization = `Basic ${Buffer.from(`${username}:${input.password}`, 'utf8').toString('base64')}`;
  const stored = (secret: string): Provisioned => ({
    fields: { username },
    secret,
    limited: false,
    externalName: null,
    note: null,
  });

  const dav = await input.fetch('/remote.php/dav/', {
    method: 'PROPFIND',
    headers: {
      Authorization: authorization,
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8',
      'User-Agent': input.name,
    },
    body: PRINCIPAL_BODY,
  });
  if (dav.status === 429) throw refuseSignIn('locked', PAUSED);
  if (dav.status === 401) {
    if (/password login forbidden/i.test(dav.text()))
      throw refuseSignIn('second_factor', TWO_STEP, NEXTCLOUD_LOGIN);
    // Single sign-on accounts have no password here: the same answer (SG-13, SG-15e).
    throw wrongPasswordOrSingleSignOn(
      WRONG_LOGIN,
      SERVICE,
      NEXTCLOUD_LOGIN,
      'sign in with Nextcloud instead',
    );
  }
  if (dav.status !== 207 && !ok(dav)) throw unexpected(SERVICE, dav.status, INSTEAD);

  const res = await input.fetch('/ocs/v2.php/core/getapppassword', {
    method: 'GET',
    headers: {
      Authorization: authorization,
      'OCS-APIRequest': 'true',
      Accept: 'application/json',
      'User-Agent': input.name,
    },
  });
  if (ok(res)) {
    const appPassword = text(record(record(record(res.json())?.ocs)?.data)?.apppassword);
    if (!appPassword) throw unexpected(SERVICE, undefined, INSTEAD);
    return stored(appPassword);
  }
  if (typedAppPassword(res)) return stored(input.password);
  // App passwords off for this account (`auth_can_create_app_token`, impersonation): the login flow still works.
  if (res.status === 403) throw refuseSignIn('rights', NO_APP_PASSWORDS, NEXTCLOUD_LOGIN);
  if (res.status === 429) throw refuseSignIn('locked', PAUSED);
  throw unexpected(SERVICE, res.status, INSTEAD);
};
