/**
 * Sign in once for Portainer (docs/decisions/connections-setup.md CS-33): `POST /api/auth` for a JWT (sent as a bearer
 * token, so Portainer's cookie CSRF check doesn't apply), the user's id, then an access token for that user (Portainer
 * asks for the password again), and the logout. The token has its user's rights (`limited: false`, CS-10); token
 * descriptions may repeat, so nothing can collide.
 */
import { bodyText, jsonObject, numberAt, quietly, stringAt, unexpectedAnswer } from './network-support';
import { type Provisioner, type ProvisionInput, refuseSignIn } from './types';

const WRONG_PASSWORD = 'Wrong username or password.';
const LOCKED = 'Portainer paused sign-ins after too many tries. Wait a few minutes, then try again.';
const SINGLE_SIGN_ON =
  'This Portainer signs in through single sign-on. Make an access token in Portainer instead.';
const RIGHTS = 'Portainer didn’t let this account make an access token.';
/**
 * Portainer's rate limit bans an address for an hour with a 403 “Access denied”, never a 429 (connection-signin.md
 * SG-17); it covers the sign-in and making tokens.
 */
const BANNED =
  'Portainer blocked Whombat’s address for an hour after too many requests. Wait, then try again.';
const isBan = (res: Parameters<typeof bodyText>[0] & { status: number }) =>
  res.status === 403 && /access denied/.test(bodyText(res));

export const provisionPortainer: Provisioner = async (input) => {
  const jwt = await signIn(input);
  const bearer = { Authorization: `Bearer ${jwt}`, Accept: 'application/json' };
  try {
    const me = await input.fetch('/api/users/me', { method: 'GET', headers: bearer });
    const user = me.status === 200 ? jsonObject(me) : null;
    const id = numberAt(user, 'Id') ?? numberAt(user, 'id') ?? idInJwt(jwt);
    if (id === null) throw unexpectedAnswer('Portainer', me.status, 'an access token');

    const res = await input.fetch(`/api/users/${id}/tokens`, {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: input.name, password: input.password }),
    });
    if (isBan(res)) throw refuseSignIn('locked', BANNED);
    if (res.status === 401 || res.status === 403) throw refuseSignIn('rights', RIGHTS);
    if (res.status !== 200 && res.status !== 201)
      throw unexpectedAnswer('Portainer', res.status, 'an access token');
    const token = stringAt(jsonObject(res), 'rawAPIKey');
    if (!token) throw unexpectedAnswer('Portainer', res.status, 'an access token');
    return {
      fields: {},
      secret: token,
      limited: false,
      externalName: stringAt(user, 'Username') ?? input.account,
      note: null,
    };
  } finally {
    await quietly(() => input.fetch('/api/auth/logout', { method: 'POST', headers: bearer }));
  }
};

/** `POST /api/auth {Username, Password}` → `jwt`; Portainer refuses with 422 and says why. */
async function signIn(input: ProvisionInput): Promise<string> {
  const res = await input.fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ Username: input.account, Password: input.password }),
  });
  if (res.status === 429) throw refuseSignIn('locked', LOCKED);
  if (isBan(res)) throw refuseSignIn('locked', BANNED);
  if (res.status === 422 || res.status === 401) {
    const text = bodyText(res);
    if (/initial admin|oauth|login method is not supported/.test(text)) {
      throw refuseSignIn('single_sign_on', SINGLE_SIGN_ON, 'token');
    }
    if (/too many/.test(text)) throw refuseSignIn('locked', LOCKED);
    throw refuseSignIn('password', WRONG_PASSWORD);
  }
  const jwt = res.status === 200 ? stringAt(jsonObject(res), 'jwt') : null;
  if (!jwt) throw unexpectedAnswer('Portainer', res.status, 'an access token');
  return jwt;
}

/** The user id in the JWT's claims (`id`), for a Portainer without `/api/users/me`. */
function idInJwt(jwt: string): number | null {
  const payload = jwt.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return typeof claims === 'object' && claims !== null
      ? numberAt(claims as Record<string, unknown>, 'id')
      : null;
  } catch {
    return null;
  }
}
