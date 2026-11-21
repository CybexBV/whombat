/**
 * Sign in once for T3 Code (docs/decisions/t3code.md T3-02, T3-03, T3-05): a pairing code from the person's T3 Code,
 * exchanged on the server for a sign-in of Whombat's own, the way T3 Code links two of its own computers. Whombat reads
 * the computer's descriptor first (the code only goes to something that answers as T3 Code), registers itself as an
 * outside agent, approves the sign-in with the code (PKCE S256, a state, the `/mcp` resource) and exchanges what comes
 * back for a token. No browser and no redirect: the redirect is a loopback address nothing listens on, read from T3
 * Code's answer. The token lasts 30 days and can't be refreshed, so its end goes back with it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { type JsonObject, jsonObject, numberAt, originOf, stringAt } from './network-support';
import { type Provisioner, type ProvisionInput, type ProvisionResponse, refuseSignIn } from './types';

/** Where T3 Code sends the approval: never opened, T3 Code accepts http on a loopback address. */
export const T3_REDIRECT_URI = 'http://127.0.0.1/whombat';

const NOT_T3 =
  'That address doesn’t answer as T3 Code. Check the address and its port (3773 unless you chose another).';
const WRONG_CODE = 'That pairing code didn’t work: it works once, for 5 minutes. Make a new one in T3 Code.';
const RIGHTS =
  'That pairing code can’t give full access. Choose Look only, or make a code with full access in T3 Code.';
const RIGHTS_USED =
  'That pairing code can’t give full access, and T3 Code has used it up. Make a new code with full access, or choose Look only with a new code.';
const TOO_OLD = 'This T3 Code is too old for outside agents: update it (t3 update), then make a new code.';
const unexpected = (status: number) =>
  refuseSignIn(
    'unsupported',
    `T3 Code answered in a way Whombat doesn’t know (HTTP ${status}). Update it (t3 update), then make a new code.`,
  );

/** A pairing code as T3 Code makes them: 12 of these letters and digits, any case. */
const PAIRING_CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/i;

/**
 * The code as T3 Code takes it: trimmed, a pairing code in capitals (T3 Code matches those in any case, other
 * credentials exactly), or the code out of a whole pairing link pasted by mistake (`…#token=…`).
 */
export function pairingCode(given: string): string {
  const text = given.trim();
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const token =
        new URLSearchParams(url.hash.replace(/^#/, '')).get('token')?.trim() ||
        url.searchParams.get('token')?.trim();
      if (token) return PAIRING_CODE.test(token) ? token.toUpperCase() : token;
    } catch {
      // Not a link after all: sent as typed.
    }
  }
  const compact = text.replace(/[\s-]+/g, '');
  return PAIRING_CODE.test(compact) ? compact.toUpperCase() : text;
}

export const provisionT3Code: Provisioner = async (input) => {
  const descriptor = await readDescriptor(input);
  const clientId = await register(input);
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  // T3 Code issues tokens for its own origin's `/mcp`, as it saw the request.
  const resource = `${originOf(input.baseUrl)}/mcp`;
  const code = await approve(input, { clientId, verifier, state, resource });
  const token = await exchange(input, { clientId, verifier, code, resource });
  return {
    fields: {},
    secret: token.secret,
    // T3 Code itself holds the sign-in to Read only or Full access.
    limited: true,
    externalName: stringAt(descriptor, 'label'),
    note: null,
    expiresAt: token.expiresAt,
  };
};

function json(body: unknown) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  };
}

/** `GET /.well-known/t3/environment`: T3 Code's own descriptor, answered without a sign-in. */
async function readDescriptor(input: ProvisionInput): Promise<JsonObject> {
  const res = await input.fetch('/.well-known/t3/environment', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const descriptor = res.status === 200 ? jsonObject(res) : null;
  const isT3 =
    descriptor !== null &&
    (numberAt(descriptor, 'orchestrationProtocolVersion') !== null ||
      stringAt(descriptor, 'environmentId') !== null);
  if (!descriptor || !isT3) throw refuseSignIn('unsupported', NOT_T3);
  return descriptor;
}

/** `POST /oauth/mcp/register`: Whombat as an outside agent, named as the person sees it in Sharing & access. */
async function register(input: ProvisionInput): Promise<string> {
  const res = await input.fetch(
    '/oauth/mcp/register',
    json({ client_name: input.name, redirect_uris: [T3_REDIRECT_URI] }),
  );
  // A T3 Code from before outside agents has no such route.
  if (res.status === 404 || res.status === 405) throw refuseSignIn('unsupported', TOO_OLD);
  const clientId = res.status === 200 || res.status === 201 ? stringAt(jsonObject(res), 'client_id') : null;
  if (!clientId) throw unexpected(res.status);
  return clientId;
}

/**
 * `POST /oauth/mcp/decision` with the pairing code: the approval's redirect, whose `code` (checked against our state)
 * is exchanged next. T3 Code refuses a code it doesn't know, one already used or expired, and one whose rights don't
 * cover the access asked (that one stays unused); told apart by its own wording, never shown.
 */
async function approve(
  input: ProvisionInput,
  sign: { clientId: string; verifier: string; state: string; resource: string },
): Promise<string> {
  const res = await input.fetch(
    '/oauth/mcp/decision',
    json({
      authorization: {
        response_type: 'code',
        client_id: sign.clientId,
        redirect_uri: T3_REDIRECT_URI,
        code_challenge: createHash('sha256').update(sign.verifier).digest('base64url'),
        code_challenge_method: 'S256',
        state: sign.state,
        resource: sign.resource,
      },
      decision: {
        _tag: 'pairing-code',
        access: input.access === 'read' ? 'read-only' : 'full-access',
        code: pairingCode(input.password),
      },
    }),
  );
  if (res.status === 404 || res.status === 405) throw refuseSignIn('unsupported', TOO_OLD);
  if (res.status !== 200) throw decisionRefusal(res);
  const redirectTo = stringAt(jsonObject(res), 'redirectTo');
  let back: URL;
  try {
    back = new URL(redirectTo ?? '');
  } catch {
    throw unexpected(res.status);
  }
  const code = back.searchParams.get('code');
  // An `error` instead of a code: T3 Code didn't take the request itself (its address, the resource).
  if (!code || back.searchParams.get('state') !== sign.state) throw unexpected(res.status);
  return code;
}

/**
 * A refused approval in the person's words. T3 Code's refusals of the code itself are 400 `AuthMcpApprovalError`; one
 * it doesn't word as below is taken for a code that didn't work, the common case.
 */
function decisionRefusal(res: ProvisionResponse) {
  const body = jsonObject(res);
  if (res.status !== 400 || stringAt(body, '_tag') !== 'AuthMcpApprovalError') return unexpected(res.status);
  const text = (stringAt(body, 'message') ?? '').toLowerCase();
  // “That pairing code cannot grant this access. It has not been used, …”; before 0.1.5 “…, and it is now used up.”
  if (/cannot grant|has not been used|scope/.test(text))
    return refuseSignIn('rights', /used up/.test(text) ? RIGHTS_USED : RIGHTS);
  // “The code could not be checked. Try again.”: T3 Code's own trouble, not the code.
  if (/could not be checked/.test(text)) return unexpected(res.status);
  // “That pairing code is unknown, expired, or already used.”, “That is not a one-time pairing code.”
  return refuseSignIn('password', WRONG_CODE);
}

/** `POST /oauth/mcp/token` (a form): the token and when it ends (`expires_in`, 30 days; there is no refresh). */
async function exchange(
  input: ProvisionInput,
  sign: { clientId: string; verifier: string; code: string; resource: string },
): Promise<{ secret: string; expiresAt: Date | null }> {
  const res = await input.fetch('/oauth/mcp/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: sign.code,
      redirect_uri: T3_REDIRECT_URI,
      client_id: sign.clientId,
      code_verifier: sign.verifier,
      resource: sign.resource,
    }).toString(),
  });
  const body = res.status === 200 ? jsonObject(res) : null;
  const secret = stringAt(body, 'access_token');
  if (!secret) throw unexpected(res.status);
  const seconds = numberAt(body, 'expires_in');
  return {
    secret,
    expiresAt: seconds !== null && seconds > 0 ? new Date(input.clock().getTime() + seconds * 1000) : null,
  };
}
