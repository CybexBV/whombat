/**
 * Sign in once for Home Assistant (docs/decisions/connections-setup.md CS-22): its login flow with the account's
 * password (and an authenticator code) at the `homeassistant` provider, else `command_line` (the usual LDAP setup, the
 * same form; connection-signin.md SG-14), the code exchanged for a short session, and over the WebSocket API a
 * long-lived access token named after this Whombat (`Whombat`, or `Whombat 2`, … when that name is taken; an existing
 * token is never deleted). The session is revoked before the call ends, whatever happened. Home Assistant can't limit
 * a token: Whombat keeps it to the level (CS-07).
 */
import {
  AUTHENTICATOR_CODE,
  candidateNames,
  formRequest,
  jsonRequest,
  ok,
  quietly,
  record,
  text,
  unexpected,
  WRONG_CODE,
} from './home-common';
import {
  needSecondFactor,
  type Provisioner,
  type ProvisionInput,
  type ProvisionResponse,
  type ProvisionSocket,
  refuseSignIn,
} from './types';

const SERVICE = 'Home Assistant';

/**
 * Marks the long-lived tokens Whombat makes (`client_icon`; a valid icon, in case Home Assistant shows it). Only a
 * mark: Whombat never deletes a token because of it (CS-D33).
 */
export const HA_TOKEN_ICON = 'mdi:paw';

/** A long-lived token lives ten years (CS-22). */
const LIFESPAN_DAYS = 3650;

/** The sign-in that works for every provider and second factor, in the browser (SG-14). */
const HA_OAUTH = 'ha_oauth';

const WRONG_LOGIN = 'Wrong username or password.';
const NO_PASSWORDS =
  'This Home Assistant doesn’t sign in with a username and password here. Sign in with Home Assistant instead.';
const CLIENT_ID_REFUSED =
  'Home Assistant doesn’t accept this Whombat’s address. Use this Whombat’s name, or make a token by hand.';
const BLOCKED =
  'Home Assistant refused Whombat’s address, usually a ban after too many failed sign-ins. Lift the ban in Home Assistant, then try again.';
const LOCAL_ONLY = 'This account may only sign in from the home network.';
const NOT_ALLOWED = 'Home Assistant didn’t let this account sign in. Check that it’s active.';
const TOO_MANY_CODES =
  'Home Assistant stopped the sign-in after too many wrong codes. Try again in a moment.';
const NOTIFIED_CODES =
  'Home Assistant sends this account’s codes as notifications. Sign in with Home Assistant instead.';
const OTHER_CODE = 'Enter your Home Assistant sign-in code.';
const TOO_MANY_TOKENS =
  'This account already has 20 long-lived tokens named like this one. Remove the ones you don’t use, then try again.';

/** The module to answer `select_mfa_module` with: the authenticator app's when offered, else the first (CS-D33). */
function chooseModule(schema: unknown): string | null {
  const field = Array.isArray(schema)
    ? schema.map(record).find((f) => f?.name === 'multi_factor_auth_module')
    : null;
  const options = field?.options;
  let ids: string[] = [];
  if (Array.isArray(options)) {
    ids = options.map((o) => (Array.isArray(o) ? text(o[0]) : text(o))).filter((id): id is string => !!id);
  } else if (record(options)) {
    ids = Object.keys(options as object);
  }
  return ids.includes('totp') ? 'totp' : (ids[0] ?? null);
}

/** “Login blocked: User is local only” and “… cannot authenticate remotely” (SG-14), else “check that it's active”. */
const blocked = (res: ProvisionResponse) =>
  refuseSignIn('rights', /remote|local only/i.test(res.text()) ? LOCAL_ONLY : NOT_ALLOWED);

/** A 400 “Invalid client id”: Home Assistant doesn't take this Whombat's address as a client (an IP it can't trust). */
const clientIdRefused = (res: ProvisionResponse) =>
  res.status === 400 && /invalid client id/i.test(res.text());

/**
 * The login flow's handler (SG-14), from `GET /auth/providers` (public; a list, or `{providers}` since 2024.2):
 * `homeassistant`, else `command_line`; neither (trusted networks only, say) is refused with the browser sign-in named.
 * An answer Whombat can't read (before onboarding, say) leaves the default, as before.
 */
async function loginHandler(input: ProvisionInput): Promise<[string, string | null]> {
  const res = await input.fetch('/auth/providers', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const json = ok(res) ? res.json() : null;
  const list = Array.isArray(json) ? json : record(json)?.providers;
  if (!Array.isArray(list)) return ['homeassistant', null];
  const providers = list.map(record);
  for (const type of ['homeassistant', 'command_line']) {
    const found = providers.find((p) => p?.type === type);
    if (found) return [type, text(found.id)];
  }
  throw refuseSignIn('unsupported', NO_PASSWORDS, HA_OAUTH);
}

/** The login flow (CS-22) up to its authorization code. An unfinished flow is aborted. */
async function authorizationCode(input: ProvisionInput, clientId: string): Promise<string> {
  const handler = await loginHandler(input);
  const start = await input.fetch(
    '/auth/login_flow',
    jsonRequest('POST', { client_id: clientId, handler, redirect_uri: clientId }),
  );
  // No such provider: a 500 (an unknown handler isn't caught), a 404 in older words (SG-14).
  if (start.status === 404 || start.status === 500) throw refuseSignIn('unsupported', NO_PASSWORDS, HA_OAUTH);
  if (start.status === 403) throw refuseSignIn('locked', BLOCKED);
  if (clientIdRefused(start)) throw refuseSignIn('unsupported', CLIENT_ID_REFUSED, 'token');
  if (!ok(start)) throw unexpected(SERVICE, start.status);
  const flowId = text(record(start.json())?.flow_id);
  if (!flowId) throw unexpected(SERVICE);

  const path = `/auth/login_flow/${encodeURIComponent(flowId)}`;
  const step = (values: Record<string, string>) =>
    input.fetch(path, jsonRequest('POST', { client_id: clientId, ...values }));
  try {
    let res: ProvisionResponse = await step({ username: input.account.trim(), password: input.password });
    let codeSent = false;
    for (let round = 0; round < 4; round++) {
      if (res.status === 403) throw blocked(res);
      if (clientIdRefused(res)) throw refuseSignIn('unsupported', CLIENT_ID_REFUSED, 'token');
      if (!ok(res)) throw unexpected(SERVICE, res.status);
      const result = record(res.json());
      const type = text(result?.type);
      if (type === 'create_entry') {
        const code = text(result?.result);
        if (!code) throw unexpected(SERVICE);
        return code;
      }
      if (type === 'abort') {
        throw result?.reason === 'too_many_retry'
          ? refuseSignIn('locked', TOO_MANY_CODES)
          : unexpected(SERVICE);
      }
      const error = text(record(result?.errors)?.base);
      if (error === 'invalid_auth') throw refuseSignIn('password', WRONG_LOGIN);
      if (error === 'invalid_code') throw refuseSignIn('code', WRONG_CODE);
      const stepId = type === 'form' ? text(result?.step_id) : null;
      if (stepId === 'select_mfa_module') {
        const module = chooseModule(result?.data_schema);
        if (!module) throw unexpected(SERVICE);
        res = await step({ multi_factor_auth_module: module });
        continue;
      }
      if (stepId === 'mfa' && !codeSent) {
        const module = text(record(result?.description_placeholders)?.mfa_module_id);
        // The notify module sends a new code to each flow: the code the person reads can't reach a fresh one (CS-03).
        // The browser sign-in takes it in one flow (SG-14).
        if (module === 'notify') throw refuseSignIn('unsupported', NOTIFIED_CODES, HA_OAUTH);
        if (!input.code)
          throw needSecondFactor(!module || module === 'totp' ? AUTHENTICATOR_CODE : OTHER_CODE);
        codeSent = true;
        res = await step({ code: input.code.replace(/\s+/g, '') });
        continue;
      }
      throw unexpected(SERVICE);
    }
    throw unexpected(SERVICE);
  } catch (err) {
    await quietly(() => input.fetch(path, { method: 'DELETE' }));
    throw err;
  }
}

/** The code for a short session: an access token and the refresh token that ends it. */
async function session(
  input: ProvisionInput,
  clientId: string,
  code: string,
): Promise<{ access: string; refresh: string }> {
  const res = await input.fetch(
    '/auth/token',
    formRequest('POST', { grant_type: 'authorization_code', code, client_id: clientId }),
  );
  if (res.status === 403) throw blocked(res);
  if (!ok(res)) throw unexpected(SERVICE, res.status);
  const json = record(res.json());
  const access = text(json?.access_token);
  const refresh = text(json?.refresh_token);
  if (!access || !refresh) throw unexpected(SERVICE);
  return { access, refresh };
}

/** The WebSocket API as calls: `{id, type, …}` → the `result` with that id. */
function caller(ws: ProvisionSocket) {
  let id = 0;
  const next = () =>
    ws.next().then(record, () => {
      throw unexpected(SERVICE);
    });
  return {
    next,
    async call(message: Record<string, unknown>): Promise<unknown> {
      const callId = ++id;
      ws.send({ id: callId, ...message });
      // Skip anything else Home Assistant sends meanwhile.
      for (let skipped = 0; skipped < 50; skipped++) {
        const reply = await next();
        if (reply?.id !== callId) continue;
        if (reply.type !== 'result' || reply.success !== true) throw unexpected(SERVICE);
        return reply.result;
      }
      throw unexpected(SERVICE);
    },
  };
}

/**
 * The long-lived token (CS-22): the first name no long-lived token of the account has (Home Assistant allows one per
 * name). An existing token is never deleted or replaced, not even Whombat's own: another connection may still use it
 * (CS-06, CS-D33).
 */
async function longLivedToken(input: ProvisionInput, accessToken: string): Promise<string> {
  const ws = await input.socket('/api/websocket');
  try {
    const { next, call } = caller(ws);
    if ((await next())?.type !== 'auth_required') throw unexpected(SERVICE);
    ws.send({ type: 'auth', access_token: accessToken });
    if ((await next())?.type !== 'auth_ok') throw unexpected(SERVICE);

    const listed = await call({ type: 'auth/refresh_tokens' });
    const longLived = (Array.isArray(listed) ? listed.map(record) : []).filter(
      (t): t is Record<string, unknown> => t?.type === 'long_lived_access_token',
    );
    const taken = new Set(longLived.map((t) => t.client_name));
    const name = [...candidateNames(input.name, ' ')].find((candidate) => !taken.has(candidate));
    if (!name) throw refuseSignIn('unsupported', TOO_MANY_TOKENS);

    const token = text(
      await call({
        type: 'auth/long_lived_access_token',
        client_name: name,
        client_icon: HA_TOKEN_ICON,
        lifespan: LIFESPAN_DAYS,
      }),
    );
    if (!token) throw unexpected(SERVICE);
    return token;
  } finally {
    ws.close();
  }
}

export const provisionHomeAssistant: Provisioner = async (input) => {
  // Whombat's own address as the IndieAuth client (no PKCE: the code never leaves this call).
  const clientId = `${input.publicUrl.replace(/\/+$/, '')}/`;
  const code = await authorizationCode(input, clientId);
  const { access, refresh } = await session(input, clientId, code);
  try {
    const secret = await longLivedToken(input, access);
    return { fields: {}, secret, limited: false, externalName: null, note: null };
  } finally {
    await quietly(() => input.fetch('/auth/revoke', formRequest('POST', { token: refresh })));
  }
};
