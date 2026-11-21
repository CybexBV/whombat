/**
 * A token sign-in whose secret is a password traded for a session (docs/decisions/connections-more.md CM-10…CM-12;
 * desk-found.md NS-03, NS-04, NS-S*): Pi-hole v6 (`POST /api/auth {"password"}` → `session.sid`, sent as `X-FTL-SID`),
 * Nginx Proxy Manager (`POST /api/tokens {"identity","secret"}` → `token`, a bearer that lasts a day), Synology DSM
 * (`GET /webapi/entry.cgi?api=SYNO.API.Auth&method=login…` → `data.sid`, applied as `_sid`) and QNAP (`POST
 * /cgi-bin/authLogin.cgi` as a form with a base64 `pwd` → the XML `authSid`, applied as `sid`).
 *
 * - The sign-in: the entry's `login` request relative to the base, as core's `sessionLoginRequest` builds it (a JSON or
 *   form body, or a query; `{secret}`, the fields and `{id:base64}` filled); the token from the JSON answer
 *   (`tokenJsonPath`) or its XML (`tokenXmlTag`); its lifetime at `expiresJsonPath` (seconds, or an ISO time) or
 *   `ttlSeconds`, never more than a day. Signing in changes nothing in the service, so it is an idempotent effect.
 * - Why a sign-in was refused (NS-04): the entry's `failures` read from the answer whatever its status (Synology and
 *   QNAP answer 200), else the status as before, each with the person's words.
 * - The server keeps the session sealed in the OAuth access-token columns with its expiry (as `client_credentials` does,
 *   CS-12) and uses it while more than a minute is left, else signs in again: one sign-in at a time per connection,
 *   outside any caller's session command. A 401 or 403, or a 2xx answer the entry's `stale` rules read as a session
 *   that ended (NS-03), is tried once more with a fresh session (`http.ts`).
 * - A password the service refuses (400/401/403) marks the connection `needs_reauth` (`token_invalid`, “Needs a new
 *   password”), as a refused pasted token does; a replaced session is signed out (`logout`, best effort, so Pi-hole's
 *   seats don't fill up).
 * - Answers are checked against the password and the session token (CM-12).
 * - Two-step sign-in asked once (connection-signin.md SG-09, `twoStep`: Synology DSM): an answer that asks for a code is
 *   `code_needed` (the form asks for one; a stored connection needs a new sign-in in the entry's words), one that refused
 *   the code `wrong_code`. A sign-in with a code asks the service to remember Whombat, and the trusted-device token it
 *   answers is kept sealed (`remembered_enc`, AAD `catalog_connection:<id>:remembered`) and sent on every later sign-in
 *   instead of a code. It goes with the connection or a new password.
 */
import {
  type CatalogEntry,
  catalogEntry,
  type SessionLoginFailureReason,
  sessionAnswerExpiresAt,
  sessionAnswerToken,
  sessionLoginFailure,
  sessionLoginFailureText,
  sessionLoginRequest,
  sessionLogoutRequest,
  sessionRememberedToken,
  sessionTwoStepAgainText,
  sessionTwoStepAsk,
  type TokenAuth,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { outsideCommandScope } from '../commit/scope';
import { catalogConnections } from '../db/schema/index';
import type { OutboundInit, OutboundResponse } from '../lib/outbound';
import type { Services } from '../services';
import { markNeedsReauth } from './commands';
import { openConnectionSecret, sealConnectionSecret } from './crypto';
import { connectionFetch, jsonOf, pinOf } from './http';
import { REFRESH_MARGIN_MS } from './refresh';
import { type CatalogConnectionRow, ConnectionAuthError } from './types';

/** CM-10's `TokenAuth` `session` (contracts 0.97.0). */
export type SessionAuth = Extract<TokenAuth, { type: 'session' }>;

/** The session sign-in of a token's `auth`, or null for every other shape. */
export function sessionAuthOf(auth: TokenAuth | null | undefined): SessionAuth | null {
  return auth?.type === 'session' ? auth : null;
}

/** Why signing in gave no session. */
export class SessionError extends Error {
  constructor(
    /**
     * `refused`: the name or password (400/401/403, or the entry's `failures`); `disabled`, `denied`, `expired`: the
     * account is off, may not sign in there, its password ran out (the entry's `failures`, NS-04); `two_step`: the
     * account asks for a second factor (Nginx Proxy Manager's `requires_2fa`, a `failures` match); `locked`: too many
     * tries (429, or the service blocked Whombat's address); `no_session`: 2xx without a token; `missing`: no sign-in
     * there (404, an older service); `code_needed`, `wrong_code`: the session's `twoStep` asks for a two-step code, or
     * refused the one sent (SG-09).
     */
    readonly reason:
      | SessionLoginFailureReason
      | 'code_needed'
      | 'wrong_code'
      | 'no_session'
      | 'missing'
      | 'other',
    readonly status: number | null,
    message: string,
    /** The person's words for it when the answer said why (the entry's `failures`, NS-04). */
    readonly text: string | null = null,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

/**
 * A refusal that is the account's: a new password (or a change in the service) is needed before it can sign in. A
 * two-step code asked for again is too (SG-09: the person replaces the password and enters a code).
 */
export function accountRefused(err: SessionError): boolean {
  return ['refused', 'disabled', 'denied', 'two_step', 'expired', 'code_needed', 'wrong_code'].includes(
    err.reason,
  );
}

export interface SessionToken {
  token: string;
  expiresAt: Date;
  /**
   * The trusted-device token the answer gave (SG-09, `twoStep.remember`: Synology's device id), for the connection to
   * keep sealed and send instead of a code next time; absent when it gave none.
   */
  remembered?: string;
}

/**
 * The account asks for a second factor: Nginx Proxy Manager's `requires_2fa`. Pi-hole says so in its `error` object,
 * which the entry's `failures` read (connection-signin.md SG-10).
 */
export function asksTwoStep(json: unknown): boolean {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  return (json as Record<string, unknown>).requires_2fa === true;
}

/** One request to the service (the destination policy, the pin): what the sign-in and the sign-out send with. */
export type SessionSend = (url: string, init: OutboundInit) => Promise<OutboundResponse>;

/**
 * Signs in once with the password (CM-10, NS-03), and with a two-step code or the trusted-device token a sign-in with a
 * code was given where the session's `twoStep` takes them (SG-09). Throws `SessionError` (a code asked for or refused,
 * the entry's `failures` in the answer, the password refused, too many tries, no session in the answer, another status),
 * or what `send` throws (`OutboundError`).
 */
export async function signInSession(
  send: SessionSend,
  input: {
    entry: CatalogEntry;
    auth: SessionAuth;
    baseUrl: string;
    secret: string;
    fields: Readonly<Record<string, string>>;
    now: Date;
    /** A two-step code the person typed (SG-09). */
    code?: string | null | undefined;
    /** The trusted-device token an earlier sign-in with a code was given (SG-09). */
    remembered?: string | null | undefined;
  },
): Promise<SessionToken> {
  const code = input.code?.replace(/\s+/g, '') || undefined;
  const req = sessionLoginRequest(input.entry, input.auth, input.secret, input.fields, {
    ...(code ? { code } : {}),
    ...(input.remembered ? { remembered: input.remembered } : {}),
  });
  if (!req) throw new SessionError('other', null, 'A field the sign-in needs is missing.');
  const res = await send(`${input.baseUrl.replace(/\/+$/, '')}${req.path}`, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== null ? { body: req.body } : {}),
  });
  const text = res.body.toString('utf8');
  // A two-step code asked for, or the one sent refused (SG-09), before any other reason.
  const ask = sessionTwoStepAsk(input.auth, text);
  if (ask === 'wrong_code' || (ask === 'asked' && code))
    throw new SessionError('wrong_code', res.status, 'The two-step code was refused.');
  if (ask === 'asked')
    throw new SessionError('code_needed', res.status, 'The account asks for a two-step code.');
  // The service's own reason, whatever the status: Synology and QNAP refuse with 200 (NS-04).
  const failure = sessionLoginFailure(input.entry, input.auth, text, res.status);
  if (failure)
    throw new SessionError(
      failure.reason,
      res.status,
      `The sign-in was refused (${failure.reason}).`,
      failure.text,
    );
  if (res.status === 400 || res.status === 401 || res.status === 403)
    throw asksTwoStep(jsonOf(res))
      ? new SessionError('two_step', res.status, 'The account asks for a second factor.')
      : new SessionError('refused', res.status, 'The password was refused.');
  if (res.status === 429) throw new SessionError('locked', res.status, 'Too many sign-ins.');
  if (res.status === 404) throw new SessionError('missing', res.status, 'There is no sign-in there.');
  if (res.status < 200 || res.status >= 300)
    throw new SessionError('other', res.status, `The sign-in answered ${res.status}.`);
  const token = sessionAnswerToken(input.auth, text, res.headers['set-cookie']);
  if (!token || /[\r\n]/.test(token))
    throw asksTwoStep(jsonOf(res))
      ? new SessionError('two_step', res.status, 'The account asks for a second factor.')
      : new SessionError('no_session', res.status, 'The sign-in gave no session.');
  const remembered = sessionRememberedToken(input.auth, text);
  return {
    token,
    expiresAt: new Date(sessionAnswerExpiresAt(input.auth, text, input.now.getTime())),
    ...(remembered ? { remembered } : {}),
  };
}

/** Signs a session out (CM-11: a replaced or removed one), best effort: never throws. */
export async function signOutSession(
  send: SessionSend,
  input: { auth: SessionAuth; baseUrl: string; token: string },
): Promise<void> {
  const req = sessionLogoutRequest(input.auth, input.token);
  if (!req) return;
  try {
    await send(`${input.baseUrl.replace(/\/+$/, '')}${req.path}`, {
      method: req.method,
      headers: req.headers,
    });
  } catch {
    // The service may be down, or the session gone already: nothing to do.
  }
}

/* The connection's session ------------------------------------------------------------------------------------------ */

/** The form's words when a session's service asks for a two-step code, or refused the one typed (SG-09). */
export const TWO_STEP_CODE_TEXT = 'Enter the code from your authenticator app.';
export const WRONG_TWO_STEP_CODE_TEXT =
  'That code didn’t work. Enter the current code from your authenticator app.';

/** The service's sentence when a password stops working (CM-11). */
const NEEDS_NEW_PASSWORD = 'Needs a new password.';
const TWO_STEP_TEXT = 'Turn off two-step sign-in for the user Whombat signs in as.';
const REFUSED_TEXT = 'The service refused the password. Replace it in Settings → Connections.';

/** What the connection says it needs after the account was refused (CM-11, NS-04, SG-09, SG-10). */
export function reauthMessage(
  entry: Pick<CatalogEntry, 'name'>,
  err: SessionError,
  auth?: SessionAuth | null,
): string {
  switch (err.reason) {
    case 'code_needed':
    case 'wrong_code':
      // The service asks for a code again (the device was removed in DSM): a new sign-in with a code (SG-09).
      return auth
        ? sessionTwoStepAgainText(entry, auth)
        : `${entry.name} asks for a two-step code again. Replace the password and enter a code.`;
    case 'two_step':
      // The entry's own words when its answer said why (Pi-hole: make an app password, SG-10).
      return err.text ?? TWO_STEP_TEXT;
    case 'disabled':
    case 'denied':
    case 'expired':
      return err.text ?? sessionLoginFailureText(entry, err.reason);
    default:
      return NEEDS_NEW_PASSWORD;
  }
}

/** The send of a connection's sign-in and sign-out: unsigned, under its destination policy and pin. */
export function sessionSend(
  services: Services,
  row: Pick<CatalogConnectionRow, 'fields'>,
  effect = 'connections.session',
): SessionSend {
  // Signing in or out changes nothing anyone decided: harmless to repeat (CS-01).
  return (url, init) => connectionFetch(services, url, init, { effect, idempotent: true, ...pinOf(row) });
}

/**
 * Signs in for the connect side (create, Replace token, Check again of a new address): a refusal is the form's
 * sentence, in our words — the entry's own when its answer said why (NS-04).
 */
export function sessionRefusalText(
  entry: Pick<CatalogEntry, 'name'>,
  err: SessionError,
  auth?: Pick<SessionAuth, 'missing'>,
): string {
  if (err.text) return err.text;
  switch (err.reason) {
    case 'missing':
      return (
        auth?.missing ?? `${entry.name} has no sign-in at that address (it answered 404). Check the address.`
      );
    case 'refused':
      return `${entry.name} refused the password. Check it and try again.`;
    case 'two_step':
      return `${entry.name} asks for a two-step code for this account. Turn off two-step sign-in for the user Whombat signs in as.`;
    case 'code_needed':
      return TWO_STEP_CODE_TEXT;
    case 'wrong_code':
      return WRONG_TWO_STEP_CODE_TEXT;
    case 'locked':
      return `${entry.name} paused sign-ins after too many tries. Wait a few minutes, then try again.`;
    case 'disabled':
    case 'denied':
    case 'expired':
      return sessionLoginFailureText(entry, err.reason);
    case 'no_session':
      return `${entry.name} let Whombat in but gave it no session. Check the address, then try again.`;
    default:
      return err.status !== null
        ? `${entry.name} didn’t let Whombat sign in (it answered ${err.status}).`
        : `${entry.name} didn’t let Whombat sign in.`;
  }
}

const inflight = new WeakMap<Services, Map<string, Promise<SessionToken>>>();

function freshSession(services: Services, row: CatalogConnectionRow): SessionToken | null {
  if (!row.accessTokenEnc || !row.accessExpiresAt) return null;
  if (row.accessExpiresAt.getTime() - services.clock().getTime() <= REFRESH_MARGIN_MS) return null;
  return {
    token: openConnectionSecret(services.custody, row.id, 'access', row.accessTokenEnc),
    expiresAt: row.accessExpiresAt,
  };
}

/**
 * The connection's session: the kept one while it is good for another minute (unless `force`: the service refused
 * it), else one sign-in (single-flight). Throws `ConnectionAuthError` when the password is refused (the connection is
 * then `needs_reauth`).
 */
export async function sessionAccess(
  services: Services,
  row: CatalogConnectionRow,
  opts: { force?: boolean } = {},
): Promise<SessionToken> {
  const fresh = opts.force ? null : freshSession(services, row);
  if (fresh) return fresh;
  let map = inflight.get(services);
  if (!map) {
    map = new Map();
    inflight.set(services, map);
  }
  let pending = map.get(row.id);
  if (!pending) {
    const m = map;
    // Shared by every caller that joins it: it belongs to none of their session commands (CS-07).
    pending = outsideCommandScope(() => signInAgain(services, row.id, opts.force ?? false)).finally(() =>
      m.delete(row.id),
    );
    map.set(row.id, pending);
  }
  return pending;
}

async function currentRow(services: Services, id: string): Promise<CatalogConnectionRow | null> {
  const [row] = await services.db.select().from(catalogConnections).where(eq(catalogConnections.id, id));
  return row ?? null;
}

async function signInAgain(
  services: Services,
  id: string,
  force: boolean,
  again = false,
): Promise<SessionToken> {
  const row = await currentRow(services, id);
  if (!row?.secretEnc) throw new ConnectionAuthError('This connection has no password.');
  const fresh = force ? null : freshSession(services, row);
  if (fresh) return fresh;
  const auth = sessionAuthOf(row.auth);
  const entry = catalogEntry(row.catalogId);
  if (!auth || !entry) throw new ConnectionAuthError('This connection has no password.');
  const secret = openConnectionSecret(services.custody, row.id, 'secret', row.secretEnc);
  const remembered = rememberedOf(services, row);
  const send = sessionSend(services, row);
  let made: SessionToken;
  try {
    made = await signInSession(send, {
      entry,
      auth,
      baseUrl: row.baseUrl,
      secret,
      fields: row.fields,
      now: services.clock(),
      remembered,
    });
  } catch (err) {
    // Only the account's refusals need the person; too many tries or a service that is down pass (NS-S03).
    if (!(err instanceof SessionError) || !accountRefused(err)) throw err;
    // A new password (or address) that landed meanwhile decides, not the old one's refusal.
    const now = await currentRow(services, id);
    if (now && now.credentialVersion !== row.credentialVersion && !again)
      return signInAgain(services, id, true, true);
    await markNeedsReauth(services, row, 'token_invalid', { message: reauthMessage(entry, err, auth) });
    throw new ConnectionAuthError(REFUSED_TEXT);
  }
  const replaced = row.accessTokenEnc
    ? openConnectionSecret(services.custody, row.id, 'access', row.accessTokenEnc)
    : null;
  const stored = await services.pipeline.transactAccount((tx) =>
    tx
      .update(catalogConnections)
      .set({
        accessTokenEnc: sealConnectionSecret(services.custody, row.id, 'access', made.token),
        accessExpiresAt: made.expiresAt,
        // A new trusted-device token the service gave replaces the old one (SG-09).
        ...(made.remembered && made.remembered !== remembered
          ? { rememberedEnc: sealConnectionSecret(services.custody, row.id, 'remembered', made.remembered) }
          : {}),
        updatedAt: services.clock(),
      })
      .where(
        and(
          eq(catalogConnections.id, row.id),
          eq(catalogConnections.credentialVersion, row.credentialVersion),
        ),
      )
      .returning({ id: catalogConnections.id }),
  );
  if (stored.length === 0) {
    // Its password or address changed while the service answered: this session is the old one's.
    void signOutSession(send, { auth, baseUrl: row.baseUrl, token: made.token });
    if (!again) return signInAgain(services, id, true, true);
    throw new ConnectionAuthError('This connection changed. Try again.');
  }
  // The session it replaces is signed out, so the service's seats don't fill up (Pi-hole keeps 16).
  if (replaced && replaced !== made.token)
    services.guides.track('connection session', () =>
      signOutSession(send, { auth, baseUrl: row.baseUrl, token: replaced }),
    );
  return made;
}

/**
 * The trusted-device token a connection keeps (SG-09), or null: none, or one that no longer opens (the sign-in then
 * goes without it, and the service asks for a code if it needs one).
 */
export function rememberedOf(
  services: Pick<Services, 'custody'>,
  row: Pick<CatalogConnectionRow, 'id' | 'rememberedEnc'>,
): string | null {
  if (!row.rememberedEnc) return null;
  try {
    return openConnectionSecret(services.custody, row.id, 'remembered', row.rememberedEnc);
  } catch {
    return null;
  }
}

/** A removed connection's session, signed out (best effort, never throws). */
export async function endConnectionSession(services: Services, row: CatalogConnectionRow): Promise<void> {
  const auth = sessionAuthOf(row.auth);
  if (!auth || !row.accessTokenEnc) return;
  try {
    const token = openConnectionSecret(services.custody, row.id, 'access', row.accessTokenEnc);
    await signOutSession(sessionSend(services, row, 'connections.revoke'), {
      auth,
      baseUrl: row.baseUrl,
      token,
    });
  } catch {
    // Its secret can't be opened any more, or the service is gone: nothing to do.
  }
}
