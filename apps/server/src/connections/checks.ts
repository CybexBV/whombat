/**
 * The one cheap read that proves a connection's credential works (CX-01, CX-72), run when it is saved, when its token is
 * replaced, after an OAuth sign-in and on “Check again”: the entry's `request` check, MCP `initialize` (a Custom MCP
 * server, every MCP sign-in) or `reach` (a Custom API whose root may 404). Also the Custom MCP probe (CX-61) and the
 * choices of a `fromService` field (Moneybird's administrations, CT-268).
 */
import {
  type CatalogCheckResult,
  type CatalogEntry,
  catalogCheckFor,
  checkAnswerOk,
  checkFailure,
  connectionTransport,
  fieldsFromCheck,
  jsonPathValue,
  ONEPASSWORD_WORDS,
  resolveCheckPath,
  type SignInKind,
  sessionCredential,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { catalogConnections } from '../db/schema/index';
import { runMacCheck } from '../hosts/findmy-connection';
import { hostsFor } from '../hosts/service';
import { OutboundError, type OutboundResponse } from '../lib/outbound';
import type { Services } from '../services';
import { bindDriver } from '../trackers/drivers';
import { OnePasswordError } from '../vault/onepassword/pool';
import { onePasswordSyncFor } from '../vault/onepassword/sync';
import { connectionCertificate, connectionFetch, jsonOf, outboundText, pinOf } from './http';
import { parseWwwAuthenticate } from './oauth';
import {
  accountRefused,
  type SessionAuth,
  SessionError,
  type SessionToken,
  sessionRefusalText,
  sessionSend,
  signInSession,
} from './session';
import { socketLogin } from './socket/call';
import { socketCheck, socketCheckOf } from './socket/check';
import type { CatalogConnectionRow } from './types';

/** How one request proves who it is (`tokenCredential`, or an OAuth access token as bearer). */
export interface CheckCredential {
  headers: Record<string, string>;
  query: Record<string, string>;
  /** The token as it is, for a socket's sign-in templates (CM-13) and a session's sign-in (CM-10). */
  secret?: string | undefined;
  /**
   * Sign in with `secret` for a session first, then check with it (CM-11): a new password or address, before it is
   * stored. A stored connection's session comes ready in `headers` instead (`credentials.ts`). With the two-step code
   * the person typed, or the trusted-device token the connection keeps (SG-09).
   */
  session?:
    | { auth: SessionAuth; code?: string | undefined; remembered?: string | null | undefined }
    | undefined;
}

export const NO_CREDENTIAL: CheckCredential = { headers: {}, query: {} };

export interface CheckOutcome {
  ok: boolean;
  /** The service refused the credential (401/403): the token is wrong or was revoked. */
  refused: boolean;
  status: number | null;
  /** A sentence for the form when it failed. */
  message: string | null;
  /** The answer's JSON, when there was one (field choices, who the credential is). */
  json: unknown;
  checks: CatalogCheckResult[];
  /**
   * The fingerprint a home-network server presented when its certificate couldn't be verified or wasn't the pinned
   * one, for an entry with a certificate fingerprint field (CX-D33): the form offers to use it.
   */
  certificateSha256?: string;
  /** The session the check signed in for (`CheckCredential.session`), for the connection to keep (CM-11). */
  session?: SessionToken;
  /**
   * The session's service asks for a two-step code (`asked`), or refused the one sent (`wrong_code`) (SG-09): the form
   * asks for one (`second_factor_needed`, or `sign_in_refused` with reason `code`).
   */
  twoStep?: 'asked' | 'wrong_code';
  /**
   * The entry's `fromCheck` fields this answer filled (connection-signin.md SG-15a, CT-737): Nextcloud's `userId` from
   * `ocs.data.id`. Empty when it failed or the entry has none. Saved with the connection (`saveNewConnection`) and after
   * every later check that passed (`recordFromCheck`).
   */
  fromCheck?: Record<string, string>;
}

function withQuery(url: string, query: Record<string, string>): string {
  const keys = Object.keys(query);
  if (!keys.length) return url;
  const u = new URL(url);
  for (const k of keys) u.searchParams.set(k, query[k] as string);
  return u.toString();
}

function failed(status: number | null, refused: boolean, message: string): CheckOutcome {
  return {
    ok: false,
    refused,
    status,
    message,
    json: null,
    checks: [{ id: 'credential', state: 'error', message }],
  };
}

function statusText(status: number, kind: 'request' | 'mcp' | 'reach'): string {
  if (status === 401 || status === 403) return 'The service refused the token. Check it and try again.';
  if (status === 404)
    return kind === 'mcp'
      ? 'There is no MCP server at that address (it answered 404).'
      : 'The service answered 404. Check the address.';
  if (status >= 300 && status < 400) return `The service answered ${status} (a redirect). Check the address.`;
  return `The service answered ${status}.`;
}

/** The JSON-RPC answer of an MCP request: a JSON body, or the first `data:` event with an id in an SSE stream. */
export function mcpAnswer(res: Pick<OutboundResponse, 'body' | 'headers'>): Record<string, unknown> | null {
  const type = String(res.headers['content-type'] ?? '');
  const text = res.body.toString('utf8');
  const parse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  if (type.includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const msg = parse(line.slice(5).trim());
      if (msg && 'id' in msg) return msg;
    }
    return null;
  }
  return parse(text);
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'Whombat', version: '1' },
  },
});

/** MCP `initialize` over Streamable HTTP (one POST): the raw answer. Throws `OutboundError`. */
export async function mcpInitialize(
  services: Services,
  mcpUrl: string,
  credential: CheckCredential = NO_CREDENTIAL,
): Promise<OutboundResponse> {
  return connectionFetch(
    services,
    withQuery(mcpUrl, credential.query),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...credential.headers,
      },
      body: INITIALIZE,
    },
    { effect: 'connections.check' },
  );
}

function serverNameOf(answer: Record<string, unknown> | null): string | null {
  const result = answer?.result as { serverInfo?: { name?: unknown } } | undefined;
  const name = result?.serverInfo?.name;
  return typeof name === 'string' ? name.slice(0, 200) : null;
}

/** Runs an MCP check: `initialize` must answer a JSON-RPC result. */
async function mcpCheck(
  services: Services,
  mcpUrl: string,
  credential: CheckCredential,
): Promise<CheckOutcome> {
  let res: OutboundResponse;
  try {
    res = await mcpInitialize(services, mcpUrl, credential);
  } catch (err) {
    return failed(null, false, outboundText(err));
  }
  if (res.status < 200 || res.status >= 300)
    return failed(res.status, res.status === 401 || res.status === 403, statusText(res.status, 'mcp'));
  const answer = mcpAnswer(res);
  if (!answer?.result) return failed(res.status, false, 'That address answered, but not as an MCP server.');
  return {
    ok: true,
    refused: false,
    status: res.status,
    message: null,
    json: { serverName: serverNameOf(answer) },
    checks: [{ id: 'credential', state: 'ok', message: null }],
  };
}

/**
 * The check an entry runs for connections made this way: MCP sign-ins prove themselves on the MCP server; a socket
 * entry (ESPHome without a sign-in too) on its socket (CM-13).
 */
export function checkKindFor(
  entry: CatalogEntry,
  kind: SignInKind,
): 'request' | 'mcp' | 'reach' | 'socket' | 'driver' | 'mac' | 'onepassword' | null {
  if (socketCheckOf(entry)) return 'socket';
  if (kind === 'mcp_oauth' || (kind === 'none' && connectionTransport(entry, kind) === 'mcp')) return 'mcp';
  return entry.check?.kind ?? null;
}

export interface RunCheckInput {
  entry: CatalogEntry;
  signIn: SignInKind;
  baseUrl: string;
  mcpUrl: string | null;
  fields: Readonly<Record<string, string>>;
  credential: CheckCredential;
}

/** Runs the entry's check once with this credential. Never throws for the service's answers. */
export async function runCatalogCheck(services: Services, input: RunCheckInput): Promise<CheckOutcome> {
  const { entry, credential } = input;
  const kind = checkKindFor(entry, input.signIn);
  if (kind === null) return { ok: true, refused: false, status: null, message: null, json: null, checks: [] };
  if (kind === 'mcp') {
    if (!input.mcpUrl) return failed(null, false, 'This connection has no MCP address.');
    return withTransportNote(input, await mcpCheck(services, input.mcpUrl, credential));
  }
  if (kind === 'socket') return runSocketCheck(services, input);
  if (kind === 'driver') return runDriverCheck(services, input);
  // A connection through a Mac (Find My) is checked against the hosts fleet, never over the network.
  if (kind === 'mac') return runMacConnectionCheck(services, input);
  // 1Password signs in only through its own SDK, in the sync's worker process: nothing is sent to its base URL.
  if (kind === 'onepassword') return runOnePasswordCheck(services, input);
  // A secret of another shape may have its own request (SG-12: Mollie's access tokens); a password never does.
  const secret = credential.secret !== undefined && !credential.session ? credential.secret : undefined;
  const check = secret !== undefined ? catalogCheckFor(entry, secret) : entry.check;
  const isRequest = check?.kind === 'request';
  const path = isRequest ? resolveCheckPath(entry, input.fields, secret) : '';
  if (path === null) return failed(null, false, 'A field the check needs is missing.');
  const method = isRequest ? check.method : 'GET';
  // A new password signs in for its session first (CM-11); the check then goes with that session.
  let session: SessionToken | undefined;
  let signed = { headers: credential.headers, query: credential.query };
  if (credential.session) {
    const signedIn = await signInForCheck(services, input, credential.session.auth);
    if ('outcome' in signedIn) return signedIn.outcome;
    session = signedIn.session;
    signed = sessionCredential(credential.session.auth.apply, session.token);
  }
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(entry.request?.headers ?? {}),
    ...(isRequest ? check.headers : {}),
    ...signed.headers,
  };
  let res: OutboundResponse;
  try {
    res = await connectionFetch(
      services,
      withQuery(`${input.baseUrl}${path}`, signed.query),
      { method, headers, ...(isRequest && check.body !== undefined ? { body: check.body } : {}) },
      { effect: 'connections.check', ...pinOf(input) },
    );
  } catch (err) {
    return (await certificateFailure(services, input, err)) ?? failed(null, false, outboundText(err));
  }
  const refused = res.status === 401 || res.status === 403;
  const ok =
    kind === 'reach'
      ? !refused && res.status < 500
      : isRequest && check.okStatus
        ? check.okStatus.includes(res.status)
        : res.status >= 200 && res.status < 300;
  if (!ok) {
    // The entry's own words for this answer (SG-11): a refusal that isn't the credential's never marks it.
    const named = checkFailure(check, res.status, res.body.toString('utf8'));
    return named
      ? failed(res.status, named.refused, named.text)
      : failed(res.status, refused, statusText(res.status, kind));
  }
  const json = jsonOf(res);
  // A GraphQL API (Unraid) answers a wrong key 200 with `errors`: the answer must hold the value (CT-313).
  if (isRequest && check.okJsonPath && (jsonPathValue(json, check.okJsonPath) ?? null) === null)
    return failed(res.status, true, statusText(401, kind));
  // QNAP's File Station answers 200 for an ended session too: the answer must hold one of the values (CT-709, NS-S04).
  if (isRequest && !checkAnswerOk(check, res.body.toString('utf8')))
    return failed(res.status, true, statusText(401, kind));
  return withTransportNote(input, {
    ok: true,
    refused: false,
    status: res.status,
    message: null,
    json,
    checks: [{ id: 'credential', state: 'ok', message: null }],
    ...(session ? { session } : {}),
    fromCheck: fieldsFromCheck(entry, json),
  });
}

/**
 * A connection through one of the person's Macs (Find My, docs/decisions/findmy-connection.md): its `mac` field's Mac
 * (or the only Mac) is one of Whombat's servers, runs macOS and has a new enough Whombat Helper. The answer is the
 * Macs as `{id, name}`, the `fromService` choices of that field. Nothing touches the Mac's screen.
 */
async function runMacConnectionCheck(services: Services, input: RunCheckInput): Promise<CheckOutcome> {
  const found = await runMacCheck(hostsFor(services), input.fields.mac);
  const json = found.macs.map((m) => ({ id: m.id, name: m.name }));
  // 409: the Mac isn't as the connection needs it (gone, not a Mac, an old helper); null: nothing answered.
  if (found.problem) return { ...failed(found.unanswered ? null : 409, false, found.problem), json };
  return {
    ok: true,
    refused: false,
    status: null,
    message: null,
    json,
    checks: [{ id: 'credential', state: 'ok', message: null }],
  };
}

/**
 * A 1Password connection (docs/decisions/onepassword-sync.md): the service account token signs in through the
 * sync's worker and lists the vaults it can see, as `{id, name}`, the `fromService` choices of the vault field.
 */
async function runOnePasswordCheck(services: Services, input: RunCheckInput): Promise<CheckOutcome> {
  const token = input.credential.secret?.trim();
  if (!token) return failed(null, true, 'Paste the service account token.');
  try {
    const { vaults } = await onePasswordSyncFor(services).api.check(token);
    return {
      ok: true,
      refused: false,
      status: null,
      message: null,
      json: vaults.map((v) => ({ id: v.id, name: v.title })),
      checks: [{ id: 'credential', state: 'ok', message: null }],
    };
  } catch (err) {
    const kind = err instanceof OnePasswordError ? err.kind : 'failed';
    if (kind === 'auth')
      return failed(null, true, '1Password didn’t accept this token. Check it and try again.');
    if (kind === 'limit')
      return failed(null, false, '1Password says this token made too many requests. Try again in a while.');
    if (kind === 'forbidden')
      return failed(null, true, 'This token can’t see any vault. Give it a vault and try again.');
    if (kind === 'stopped') return failed(null, false, ONEPASSWORD_WORDS.stopped);
    return failed(null, false, ONEPASSWORD_WORDS.unreachable);
  }
}

/**
 * Stores what a passing check of a stored connection filled (SG-15a): its `fromCheck` fields, when they differ from the
 * connection's. Like the check lines, a fact the service told, not a change anyone decided: no signed event, the
 * credential stays as it is. Returns the row as it is now.
 */
export async function recordFromCheck(
  services: Services,
  row: CatalogConnectionRow,
  outcome: Pick<CheckOutcome, 'ok' | 'fromCheck'>,
): Promise<CatalogConnectionRow> {
  const filled = outcome.ok ? (outcome.fromCheck ?? {}) : {};
  if (Object.entries(filled).every(([k, v]) => row.fields[k] === v)) return row;
  const fields = { ...row.fields, ...filled };
  const [updated] = await services.pipeline.transactAccount((tx) =>
    tx
      .update(catalogConnections)
      .set({ fields, updatedAt: services.clock() })
      .where(eq(catalogConnections.id, row.id))
      .returning(),
  );
  return updated ?? { ...row, fields };
}

/** Signs in for a session before a check (CM-11): the session, or the check's failure in the form's words. */
async function signInForCheck(
  services: Services,
  input: RunCheckInput,
  auth: SessionAuth,
): Promise<{ session: SessionToken } | { outcome: CheckOutcome }> {
  const secret = input.credential.secret;
  if (!secret) return { outcome: failed(null, false, 'Enter the password.') };
  try {
    return {
      session: await signInSession(sessionSend(services, input, 'connections.check'), {
        entry: input.entry,
        auth,
        baseUrl: input.baseUrl,
        secret,
        fields: input.fields,
        now: services.clock(),
        code: input.credential.session?.code,
        remembered: input.credential.session?.remembered,
      }),
    };
  } catch (err) {
    if (err instanceof SessionError && (err.reason === 'code_needed' || err.reason === 'wrong_code'))
      return {
        outcome: {
          ...failed(err.status, false, sessionRefusalText(input.entry, err, auth)),
          twoStep: err.reason === 'code_needed' ? 'asked' : 'wrong_code',
        },
      };
    if (err instanceof SessionError)
      return {
        outcome: failed(err.status, accountRefused(err), sessionRefusalText(input.entry, err, auth)),
      };
    return {
      outcome: (await certificateFailure(services, input, err)) ?? failed(null, false, outboundText(err)),
    };
  }
}

/** The socket check (CM-13, CM-17): the version in the check line, the entry's words when there is no socket. */
async function runSocketCheck(services: Services, input: RunCheckInput): Promise<CheckOutcome> {
  const login = socketLogin(input.credential, input.fields);
  const pin = pinOf(input);
  const result = await socketCheck(services, {
    entry: input.entry,
    baseUrl: input.baseUrl,
    login,
    ...pin,
  });
  if (result.kind === 'outbound')
    return (
      (await certificateFailure(services, input, result.error)) ??
      failed(null, false, outboundText(result.error))
    );
  if (result.kind === 'failed') return failed(result.status, result.refused, result.message);
  const outcome: CheckOutcome = {
    ok: true,
    refused: false,
    status: null,
    message: null,
    json: result.json,
    checks: [
      {
        id: 'credential',
        state: 'ok',
        message: result.version ? `${input.entry.name} ${result.version}` : null,
      },
    ],
  };
  // Nothing secret crosses the network when it signs in with nothing.
  return login ? withTransportNote(input, outcome) : outcome;
}

/**
 * A certificate that couldn't be verified, or isn't the pinned one, on a home-network server of an entry that takes a
 * certificate fingerprint (CX-D33): the failure names the fingerprint the server presents, for the person to compare
 * with what the device shows and use. Null for any other failure, or when the server's certificate can't be read.
 */
async function certificateFailure(
  services: Services,
  input: Pick<RunCheckInput, 'entry' | 'baseUrl'>,
  err: unknown,
): Promise<CheckOutcome | null> {
  if (!(err instanceof OutboundError)) return null;
  if (err.reason !== 'untrusted_certificate' && err.reason !== 'certificate') return null;
  const field = input.entry.fields.find((f) => f.id === CERTIFICATE_FIELD);
  if (!field || !input.baseUrl.startsWith('https://')) return null;
  const presented = await connectionCertificate(services, input.baseUrl);
  if (!presented) return null;
  const message = `${outboundText(err)} It presents ${presented}; if ${input.entry.name} shows the same fingerprint, use it as the ${field.label.toLowerCase()}.`;
  return { ...failed(null, false, message), certificateSha256: presented };
}

/**
 * Sign in once's certificate first (docs/decisions/connections-setup.md CS-05): before a password goes to an https
 * address, one request with nothing secret in it (`HEAD /`) proves that the server's certificate verifies, or is the
 * pinned one. Null when it does (any answer will do) or the address is http; else the refusal, naming the fingerprint
 * the server presents when the entry takes one (CX-D33), for the person to compare and pin before signing in.
 */
export async function certificateFirst(
  services: Services,
  input: Pick<RunCheckInput, 'entry' | 'baseUrl' | 'fields'>,
): Promise<CheckOutcome | null> {
  if (!input.baseUrl.startsWith('https://')) return null;
  try {
    await connectionFetch(
      services,
      `${input.baseUrl.replace(/\/+$/, '')}/`,
      { method: 'HEAD', headers: { accept: '*/*' } },
      { effect: 'connections.certificate', ...pinOf(input) },
    );
    return null;
  } catch (err) {
    return (await certificateFailure(services, input, err)) ?? failed(null, false, outboundText(err));
  }
}

/** How long trusting a home-network certificate waits for the server: the check after it says what is wrong. */
const HOME_CERTIFICATE_DEADLINE_MS = 5_000;

/**
 * Trusts the certificate a server on the home network made for itself (docs/decisions/connections-setup.md):
 * servers there use self-signed certificates (Unraid, Proxmox, a NAS), and nobody can compare a fingerprint with what
 * the server shows, so when nothing is pinned yet and the certificate of an https address doesn't verify, the one it
 * presents is pinned. From then on only that certificate is accepted. A certificate that verifies is never pinned (it
 * renews), and an address that isn't on the home network gets nothing (`connectionCertificate` reads those only).
 */
export async function trustHomeCertificate(
  services: Services,
  input: Pick<RunCheckInput, 'entry' | 'baseUrl' | 'fields'>,
): Promise<Record<string, string>> {
  const fields = { ...input.fields };
  if (fields[CERTIFICATE_FIELD]?.trim() || !input.baseUrl.startsWith('https://')) return fields;
  if (!input.entry.fields.some((f) => f.id === CERTIFICATE_FIELD)) return fields;
  try {
    await connectionFetch(
      services,
      `${input.baseUrl.replace(/\/+$/, '')}/`,
      { method: 'HEAD', headers: { accept: '*/*' } },
      { effect: 'connections.certificate', idempotent: true, deadlineMs: HOME_CERTIFICATE_DEADLINE_MS },
    );
    return fields;
  } catch (err) {
    if (!(err instanceof OutboundError) || err.reason !== 'untrusted_certificate') return fields;
  }
  const presented = await connectionCertificate(services, input.baseUrl);
  return presented ? { ...fields, [CERTIFICATE_FIELD]: presented } : fields;
}

/** The catalog field that pins a self-signed certificate (Proxmox, CX-60; `pinOf`). */
const CERTIFICATE_FIELD = 'fingerprint';

/** A home-network service over plain http (CX-40): the token (or a password, CM-10, CM-13) crosses it unencrypted. */
function withTransportNote(input: RunCheckInput, outcome: CheckOutcome): CheckOutcome {
  if (!outcome.ok || input.signIn === 'none') return outcome;
  const url = input.mcpUrl ?? input.baseUrl;
  if (!url.startsWith('http://')) return outcome;
  const password =
    input.credential.session !== undefined ||
    checkKindFor(input.entry, input.signIn) === 'socket' ||
    input.entry.signIn.some((m) => m.kind === 'token' && m.auth.type === 'session');
  return {
    ...outcome,
    checks: [
      ...outcome.checks,
      {
        id: 'destination',
        state: 'warning',
        message: `This address uses http: the ${password ? 'password' : 'token'} crosses your network unencrypted.`,
      },
    ],
  };
}

/** Who the service says the credential belongs to (an email or account name), when its check answer says. */
export function externalNameFrom(json: unknown): string | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
  const name = o.name;
  const nested =
    name && typeof name === 'object' ? pick((name as Record<string, unknown>).display_name) : null;
  return (
    pick(o.email) ??
    pick(o.login) ??
    pick(o.username) ??
    pick(o.full_name) ??
    pick(o.display_name) ??
    nested ??
    pick(typeof name === 'string' ? name : null)
  );
}

/** The choices of a `fromService` field from the check's answer: a list of `{id, name}` (Moneybird's administrations). */
export function serviceChoices(json: unknown): { value: string; label: string }[] {
  if (!Array.isArray(json)) return [];
  const out: { value: string; label: string }[] = [];
  for (const item of json.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'string' || typeof o.id === 'number' ? String(o.id) : null;
    if (!id) continue;
    const label = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : id;
    out.push({ value: id.slice(0, 200), label: label.slice(0, 200) });
  }
  return out;
}

export interface ProbeResult {
  needs: 'open' | 'oauth' | 'token' | 'unreachable';
  issuer: string | null;
  serverName: string | null;
  message: string | null;
}

/**
 * Does this MCP server need a sign-in (CX-61)? `initialize` without a credential: a result is `open`; a 401 that names
 * protected-resource metadata (or has it at the well-known address) is `oauth` with its authorization server; any other
 * 401/403 is `token`; anything else `unreachable`.
 */
export async function probeMcp(
  services: Services,
  mcpUrl: string,
  discover: (mcpUrl: string, header: string | null) => Promise<{ issuer: string } | null>,
): Promise<ProbeResult> {
  let res: OutboundResponse;
  try {
    res = await mcpInitialize(services, mcpUrl);
  } catch (err) {
    return {
      needs: 'unreachable',
      issuer: null,
      serverName: null,
      message: err instanceof OutboundError ? outboundText(err) : 'Whombat couldn’t reach it.',
    };
  }
  if (res.status >= 200 && res.status < 300) {
    const answer = mcpAnswer(res);
    if (answer?.result)
      return { needs: 'open', issuer: null, serverName: serverNameOf(answer), message: null };
    return {
      needs: 'unreachable',
      issuer: null,
      serverName: null,
      message: 'That address answered, but not as an MCP server.',
    };
  }
  if (res.status === 401 || res.status === 403) {
    const header = res.headers['www-authenticate'];
    const value = Array.isArray(header) ? header.join(', ') : (header ?? null);
    const challenge = value ? parseWwwAuthenticate(value) : null;
    if (res.status === 401) {
      const found = await discover(mcpUrl, challenge?.resourceMetadata ?? null).catch(() => null);
      if (found) return { needs: 'oauth', issuer: found.issuer, serverName: null, message: null };
    }
    return { needs: 'token', issuer: null, serverName: null, message: null };
  }
  return { needs: 'unreachable', issuer: null, serverName: null, message: statusText(res.status, 'mcp') };
}

/**
 * A report tracker's check (docs/decisions/report-trackers.md): its driver (the `driver` field) asks the tracker whether
 * the token works. A driver that isn't installed or didn't load fails it, so the connection's “Whether it answers”
 * says so.
 */
async function runDriverCheck(services: Services, input: RunCheckInput): Promise<CheckOutcome> {
  const id = (input.fields.driver ?? '').trim();
  const driver = id ? services.tracker.drivers.get(id) : null;
  if (!driver) {
    const failure = id ? services.tracker.drivers.failure(id) : null;
    return failed(
      null,
      false,
      !id
        ? 'It names no driver.'
        : failure
          ? `Its driver ${id} didn’t load: ${failure}`
          : `Its driver ${id} isn’t installed on this Whombat.`,
    );
  }
  const secret = input.credential.secret ?? '';
  try {
    const out = await bindDriver(driver, {
      id: 'check',
      label: driver.info.words.product,
      baseUrl: input.baseUrl.replace(/\/+$/, ''),
      token: secret,
    }).check();
    if (!out.ok)
      return failed(out.status, out.refused, out.message ?? statusText(out.status ?? 0, 'request'));
    return {
      ok: true,
      refused: false,
      status: out.status,
      message: null,
      json: null,
      checks: [{ id: 'credential', state: 'ok', message: null }],
    };
  } catch (err) {
    return failed(
      null,
      false,
      err instanceof Error ? err.message.slice(0, 300) : 'The tracker didn’t answer.',
    );
  }
}
