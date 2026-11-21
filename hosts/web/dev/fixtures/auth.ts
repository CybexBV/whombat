// Authentication in fixture mode (CONTRACT 2 + 7.2): setup, password and
// passkey sign-in, passkey management, plus the page-URL toggles (?setup=1,
// ?signedout=1, ?role=) that put a browser into a given auth state.

import type { Role } from '../../src/api/types.ts';
import { appendAudit } from './audit.ts';
import type { Ctx } from './ctx.ts';
import { bodyObject, type FxResponse, json, noContent, problem } from './http.ts';
import { applyAssistToggle } from './assist.ts';
import { closeSessions } from './remote.ts';
import { type BrowserState, iso, randomToken, ROLE_RANK } from './state.ts';

export const CSRF_TOKEN = 'fixture-csrf-token';
export const SETUP_TOKEN = 'fixture-setup-token';
export const WRONG_PASSWORD = 'wrong-password';
// Same rule as the hub (internal/hub ValidateCredentials).
const MIN_PASSWORD = 10;

const isRole = (v: string | null): v is Role => v !== null && Object.hasOwn(ROLE_RANK, v);

/**
 * Query toggles on HTML page loads: ?setup=1, ?signedout=1,
 * ?role=viewer|operator|admin, ?reauth=1 (the next sensitive change asks to
 * confirm the password) and ?assistant=1|nosandbox (assist.ts).
 */
export function applyPageToggles(st: BrowserState, q: URLSearchParams): void {
  if (q.get('setup') === '1') {
    st.setupRequired = true;
    st.authenticated = false;
  }
  if (q.get('signedout') === '1') {
    st.setupRequired = false;
    st.authenticated = false;
  }
  const role = q.get('role');
  if (isRole(role)) {
    st.setupRequired = false;
    st.authenticated = true;
    st.user = { name: st.user.name, role };
    st.roleToggle = role;
  }
  if (q.get('reauth') === '1') st.reauthRequired = true;
  applyAssistToggle(st, q.get('assistant'));
}


function authState(st: BrowserState): FxResponse {
  return json(200, {
    setup_required: st.setupRequired,
    authenticated: st.authenticated,
    user: st.authenticated ? { ...st.user } : null,
    // Like the hub: the count is only known once signed in.
    passkeys: st.authenticated ? st.passkeys.length : 0,
    passkeys_available: true,
    csrf_token: CSRF_TOKEN,
  });
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const unauthenticated = (): FxResponse => problem(401, 'unauthenticated', 'Sign in to continue.');

function signIn(st: BrowserState, name: string): void {
  st.authenticated = true;
  st.setupRequired = false;
  st.user = { name, role: st.roleToggle ?? 'admin' };
}

/** Routes under /auth; null when the path is not an auth endpoint. */
export function authRoute(c: Ctx): FxResponse | null {
  const { store, st, req } = c;
  const { method, path } = req;
  const b = bodyObject(req);
  if (method !== 'GET' && method !== 'HEAD' && req.bodyInvalid) return problem(400, 'bad_request', 'Invalid JSON body.');

  if (path === '/auth/state' && (method === 'GET' || method === 'HEAD')) return authState(st);

  if (path === '/auth/setup' && method === 'POST') {
    if (!st.setupRequired) return problem(409, 'setup_done', 'The account already exists.');
    if (str(b.setup_token) !== SETUP_TOKEN) return problem(403, 'invalid_setup_token', 'The setup token is wrong. It is printed in the hub log.');
    const username = str(b.username).trim();
    if (!username) return problem(400, 'invalid_username', "User names are 1 to 64 letters, digits, '.', '_', '@' or '-'.");
    if (str(b.password).length < MIN_PASSWORD) return problem(400, 'weak_password', `Use at least ${MIN_PASSWORD} characters.`);
    st.roleToggle = null;
    signIn(st, username);
    appendAudit(store, st, { event: 'auth.setup' }, req);
    return noContent();
  }

  if (path === '/auth/login' && method === 'POST') {
    const username = str(b.username).trim();
    const password = str(b.password);
    if (!username || !password || password === WRONG_PASSWORD) {
      appendAudit(store, st, { event: 'auth.login', outcome: 'denied', code: 'invalid_credentials', user: username || null, role: null }, req);
      return problem(401, 'invalid_credentials', 'Wrong user name or password.');
    }
    signIn(st, username);
    appendAudit(store, st, { event: 'auth.login', details: { method: 'password' } }, req);
    return noContent();
  }

  if (path === '/auth/logout' && method === 'POST') {
    if (st.authenticated) {
      appendAudit(store, st, { event: 'auth.logout' }, req);
      closeSessions(st, () => true, 'revoked');
    }
    st.authenticated = false;
    // Like the hub: event streams end when the session is signed out.
    for (const res of st.events.clients) res.end();
    st.events.clients.clear();
    return noContent();
  }

  if (path === '/auth/reauth' && method === 'POST') {
    if (!st.authenticated) return unauthenticated();
    const password = str(b.password);
    if (!password || password === WRONG_PASSWORD) {
      appendAudit(store, st, { event: 'auth.reauth', outcome: 'denied', code: 'invalid_credentials' }, req);
      return problem(403, 'invalid_credentials', 'The password is wrong.');
    }
    st.reauthRequired = false;
    appendAudit(store, st, { event: 'auth.reauth', details: { method: 'password' } }, req);
    return noContent();
  }

  if (path === '/auth/password' && method === 'POST') {
    if (!st.authenticated) return unauthenticated();
    const current = str(b.current);
    if (!current || current === WRONG_PASSWORD) {
      appendAudit(store, st, { event: 'auth.password_changed', outcome: 'denied', code: 'invalid_credentials' }, req);
      return problem(403, 'invalid_credentials', 'The current password is wrong.');
    }
    if (str(b.new).length < MIN_PASSWORD) return problem(400, 'weak_password', `Use at least ${MIN_PASSWORD} characters.`);
    appendAudit(store, st, { event: 'auth.password_changed' }, req);
    return noContent();
  }

  // ---- passkeys (go-webauthn JSON shapes, base64url without padding)

  if (path === '/auth/passkey/login/begin' && method === 'POST') {
    return json(200, { publicKey: { challenge: randomToken(32), timeout: 60000, userVerification: 'preferred', allowCredentials: [] } });
  }

  if (path === '/auth/passkey/login/finish' && method === 'POST') {
    const id = str(b.id);
    if (!id || !b.response || typeof b.response !== 'object') {
      appendAudit(store, st, { event: 'auth.login', outcome: 'denied', code: 'invalid_passkey', user: null, role: null, details: { method: 'passkey' } }, req);
      return problem(401, 'invalid_credentials', 'The passkey was not accepted.');
    }
    const pk = st.passkeys.find((p) => p.id === id);
    if (pk) pk.last_used_at = iso(store.fxNow());
    signIn(st, st.user.name);
    appendAudit(store, st, { event: 'auth.login', details: { method: 'passkey' } }, req);
    return noContent();
  }

  if (path === '/auth/passkey/register/begin' && method === 'POST') {
    if (!st.authenticated) return unauthenticated();
    st.pendingPasskeyName = str(b.name).trim().slice(0, 64) || null;
    return json(200, {
      publicKey: {
        challenge: randomToken(32),
        rp: { name: 'Rackoon' },
        user: { id: st.webauthnUserId, name: st.user.name, displayName: st.user.name },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        timeout: 60000,
        excludeCredentials: st.passkeys.map((p) => ({ type: 'public-key', id: p.id })),
      },
    });
  }

  if (path === '/auth/passkey/register/finish' && method === 'POST') {
    if (!st.authenticated) return unauthenticated();
    const given = str(b.id);
    const id = /^[A-Za-z0-9_-]{8,1024}$/.test(given) && !st.passkeys.some((p) => p.id === given) ? given : randomToken(32);
    const now = store.fxNow();
    const name = st.pendingPasskeyName ?? `Passkey ${iso(now).slice(0, 10)}`;
    st.pendingPasskeyName = null;
    st.passkeys.push({ id, name, created_at: iso(now), last_used_at: null });
    appendAudit(store, st, { event: 'auth.passkey_added', details: { name } }, req);
    return json(201, { id, name });
  }

  if (path === '/auth/passkeys' && (method === 'GET' || method === 'HEAD')) {
    if (!st.authenticated) return unauthenticated();
    return json(200, st.passkeys);
  }

  const m = /^\/auth\/passkeys\/([^/]+)$/.exec(path);
  if (m && method === 'DELETE') {
    if (!st.authenticated) return unauthenticated();
    const id = decodeURIComponent(m[1] ?? '');
    const before = st.passkeys.length;
    st.passkeys = st.passkeys.filter((p) => p.id !== id);
    if (st.passkeys.length === before) return problem(404, 'not_found', 'Not found.');
    appendAudit(store, st, { event: 'auth.passkey_removed' }, req);
    return noContent();
  }

  return null;
}
