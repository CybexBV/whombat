/**
 * Sign in once for Paperless-ngx (docs/decisions/connections-setup.md CS-24): `POST /api/token/` with the account's
 * password (and an authenticator code) answers the account's API token. Paperless keeps one per account, shared with
 * the person's other apps, and can't limit it (CS-07): the note says so. No session, nothing to clean up.
 */
import {
  AUTHENTICATOR_CODE,
  jsonRequest,
  ok,
  record,
  text,
  unexpected,
  WRONG_CODE,
  wrongPasswordOrSingleSignOn,
} from './home-common';
import { needSecondFactor, type Provisioner, refuseSignIn } from './types';

const SERVICE = 'Paperless-ngx';

const WRONG_LOGIN = 'Wrong username or password.';
const PAUSED = 'Paperless-ngx paused sign-ins after too many tries. Wait a minute, then try again.';

/** The one token per account (CS-24, CS-08). */
export const PAPERLESS_SHARED_NOTE =
  'Paperless keeps one API token per account, shared with your other apps: regenerating it in Paperless stops Whombat’s copy too.';

export const provisionPaperless: Provisioner = async (input) => {
  const code = input.code?.replace(/\s+/g, '');
  const res = await input.fetch(
    '/api/token/',
    jsonRequest('POST', {
      username: input.account.trim(),
      password: input.password,
      ...(code ? { code } : {}),
    }),
  );
  if (ok(res)) {
    const token = text(record(res.json())?.token);
    if (!token) throw unexpected(SERVICE);
    return { fields: {}, secret: token, limited: false, externalName: null, note: PAPERLESS_SHARED_NOTE };
  }
  if (res.status === 429) throw refuseSignIn('locked', PAUSED);
  if (res.status === 400) {
    const answer = res.text();
    if (/MFA code is required/i.test(answer)) throw needSecondFactor(AUTHENTICATOR_CODE);
    if (/Invalid MFA code/i.test(answer)) throw refuseSignIn('code', WRONG_CODE);
    // An account that signs in through another service has no password here: the same answer (SG-13).
    if (/Unable to log in|may not be blank/i.test(answer))
      throw wrongPasswordOrSingleSignOn(WRONG_LOGIN, SERVICE);
  }
  throw unexpected(SERVICE, res.status);
};
