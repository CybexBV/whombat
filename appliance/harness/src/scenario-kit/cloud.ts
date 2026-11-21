/**
 * Control (cloud) as a client uses it: magic-link sign-in through the shared Mailpit, orgs, claims and client
 * tickets (`@whombat/control-contracts` shapes). Sessions are cached per email in the environment
 * (`env/sessions.json`) so repeated runs stay under control's magic-link rate limits (5/email, 30/IP per hour);
 * `signIn(email, {fresh: true})` always does a real magic-link round trip.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import {
  APPLIANCE_TERMS_VERSION,
  CloudSession,
  LinkAccount,
  LinkedBox,
  LinkLookup,
  PendingClaim,
  SUBSCRIPTION_TERMS_VERSION,
} from '@whombat/control-contracts';
import { TicketResponse } from '@whombat/control-contracts/device';
import { z } from 'zod';
import { envPath } from '../dev/env.ts';
import { mailpit } from '../lib/paths.ts';
import { sleep } from '../lib/proc.ts';
import { contractsAtLeast } from '../manifest/version.ts';

export class ControlError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string | null;
  readonly body: unknown;
  constructor(status: number, code: string, reason: string | null, body: unknown, what: string) {
    super(`${what}: ${status} ${code}${reason ? ` (${reason})` : ''}`);
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.body = body;
  }
}

/** One HTTP exchange from a chosen local address (another "network" for control's nearby tag, CC-04). */
function requestFrom(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  localAddress: string,
): Promise<{ ok: boolean; status: number; text: string; header(n: string): string | null }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: init.method, headers: init.headers, localAddress, timeout: 15_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
            header: (n) => {
              const v = res.headers[n.toLowerCase()];
              return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
            },
          }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (init.body) req.write(init.body);
    req.end();
  });
}

export async function controlApi<T>(
  base: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; schema?: z.ZodType<T>; localAddress?: string } = {},
): Promise<T> {
  const init = {
    method,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    } as Record<string, string>,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  };
  const res = options.localAddress
    ? await requestFrom(`${base}${path}`, init, options.localAddress)
    : await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(15_000) }).then(async (r) => ({
        ok: r.ok,
        status: r.status,
        text: await r.text(),
        header: (n: string) => r.headers.get(n),
      }));
  const text = res.text;
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  if (!res.ok) {
    const code = (body as { error?: { code?: string } } | null)?.error?.code ?? 'error';
    // The precise reason is in the body since contracts 0.5.0 (CT-33); older controls sent a header.
    const reason =
      (body as { error?: { details?: { code?: string } } } | null)?.error?.details?.code ??
      res.header('x-whombat-reason');
    throw new ControlError(res.status, code, reason, body, `${method} ${path}`);
  }
  return options.schema ? options.schema.parse(body) : (body as T);
}

/* Mailpit ------------------------------------------------------------------------------------------------ */

interface MailpitSummary {
  ID: string;
  Created: string;
  To: { Address: string }[];
  Subject: string;
}

/**
 * The newest message to `email` created after `since` (and whose text matches `match`, when given), polled until
 * `timeoutMs`. `match` keeps a mail sent just before (within Mailpit's 2 s slack, e.g. a signup code right before a
 * sign-in link) from being taken for the one asked for.
 */
export async function waitForMail(
  email: string,
  since: number,
  timeoutMs = 20_000,
  match?: RegExp,
): Promise<{ id: string; text: string }> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await fetch(
      `${mailpit.api}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=5`,
    );
    if (res.ok) {
      const data = (await res.json()) as { messages: MailpitSummary[] };
      for (const m of data.messages.filter((x) => Date.parse(x.Created) >= since - 2000)) {
        const full = (await (await fetch(`${mailpit.api}/api/v1/message/${m.ID}`)).json()) as {
          Text: string;
        };
        if (!match || match.test(full.Text)) return { id: m.ID, text: full.Text };
      }
    }
    await sleep(300);
  }
  throw new Error(`no mail to ${email} in Mailpit (${mailpit.api}) within ${timeoutMs} ms`);
}

export function magicTokenOf(text: string): string {
  const m = /\/auth\/verify#token=([A-Za-z0-9_-]+)/.exec(text);
  if (!m?.[1]) throw new Error(`no magic link in mail:\n${text}`);
  return m[1];
}

/* Sign-in ---------------------------------------------------------------------------------------------- */

const SESSIONS = () => envPath('sessions.json');

function cached(): Record<string, CloudSession> {
  return existsSync(SESSIONS()) ? JSON.parse(readFileSync(SESSIONS(), 'utf8')) : {};
}

export interface SignInResult {
  session: CloudSession;
  /** How the session was obtained (a real magic-link round trip, or the cache). */
  via: 'magic-link' | 'cache';
  mailId?: string;
}

export async function signIn(
  controlUrl: string,
  email: string,
  options: { fresh?: boolean } = {},
): Promise<SignInResult> {
  const all = cached();
  const prev = all[email];
  if (!options.fresh && prev && Date.parse(prev.expiresAt) > Date.now() + 3600_000) {
    try {
      await controlApi(controlUrl, 'GET', '/v1/auth/session', { token: prev.token });
      return { session: prev, via: 'cache' };
    } catch {
      // expired or signed out: sign in again
    }
  }
  const since = Date.now();
  await controlApi(controlUrl, 'POST', '/v1/auth/magic-link', { body: { email } });
  const mail = await waitForMail(email, since, 20_000, /\/auth\/verify#token=/);
  const session = await controlApi(controlUrl, 'POST', '/v1/auth/verify', {
    body: { token: magicTokenOf(mail.text) },
    schema: CloudSession,
  });
  all[email] = session;
  writeFileSync(SESSIONS(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  return { session, via: 'magic-link', mailId: mail.id };
}

/** Refreshes the cached org list of a session. */
export async function sessionInfo(controlUrl: string, token: string) {
  return controlApi(controlUrl, 'GET', '/v1/auth/session', {
    token,
    schema: CloudSession.omit({ token: true }),
  });
}

const Org = z.object({ orgId: z.string(), name: z.string() }).passthrough();

/**
 * The Subscription Terms accepted with every `orgs.create` from contracts 0.15.0 (BL-21, BL-24): the current version, as
 * the app sends it once its checkbox is ticked.
 */
export function orgTerms(): { terms?: { version: string } } {
  return contractsAtLeast('0.15.0') ? { terms: { version: SUBSCRIPTION_TERMS_VERSION } } : {};
}

/**
 * The caller's org of that name, created if there is none (with the current Subscription Terms from contracts 0.15.0);
 * `onCreate` runs once for a new org.
 */
export async function ensureOrg(
  controlUrl: string,
  s: CloudSession,
  name: string,
  onCreate?: (org: string) => Promise<void>,
): Promise<string> {
  const info = await sessionInfo(controlUrl, s.token);
  const existing = info.orgs.find((o) => o.name === name);
  if (existing) return existing.orgId;
  const org = await controlApi(controlUrl, 'POST', '/v1/orgs', {
    token: s.token,
    body: { name, ...orgTerms() },
    schema: Org,
  });
  await onCreate?.(org.orgId);
  return org.orgId;
}

/* Whombat Link on the account site ------------------------------------------------------------------------- */

/** `link.lookup`: which box the code on a screen belongs to, before the person confirms. */
export function linkLookup(controlUrl: string, token: string, code: string) {
  return controlApi(controlUrl, 'POST', '/v1/link/lookup', { token, body: { code }, schema: LinkLookup });
}

/**
 * `link.confirm`: the person adds the box whose screen shows `code` to their Whombat Link, as the account site's
 * `/link` page does once its terms box is ticked. `terms: null` sends none (an older page).
 */
export function linkConfirm(
  controlUrl: string,
  token: string,
  code: string,
  opts: { terms?: { version: string } | null } = {},
) {
  const terms = opts.terms === null ? {} : { terms: opts.terms ?? { version: SUBSCRIPTION_TERMS_VERSION } };
  return controlApi(controlUrl, 'POST', '/v1/link/confirm', {
    token,
    body: { code, ...terms },
    schema: LinkedBox,
  });
}

/** `link.boxes`: the account's Link plan and its boxes with their Link state. */
export function linkBoxes(controlUrl: string, token: string) {
  return controlApi(controlUrl, 'GET', '/v1/link/boxes', { token, schema: LinkAccount });
}

/** `link.remove`: the account takes a box out of its Link. */
export function linkRemove(controlUrl: string, token: string, device: string) {
  return controlApi(controlUrl, 'DELETE', `/v1/link/boxes/${device}`, { token, schema: LinkAccount });
}

/**
 * The account's Link org (its hidden billing record, made the first time it confirms a box), or null before that.
 * Tickets to a linked box are asked for under it.
 */
export async function linkOrgOf(controlUrl: string, token: string): Promise<string | null> {
  const info = await sessionInfo(controlUrl, token);
  return info.orgs.find((o) => o.link === true)?.orgId ?? null;
}

export const ClaimStart = z.object({ claim: PendingClaim, ticket: TicketResponse });
export type ClaimStart = z.infer<typeof ClaimStart>;

/** CT-43: base64url(SHA-256("whombat-claim-control/1\n" + device + "\n" + normalized secret)). */
export function claimProof(device: string, secret: string): string {
  const normalized = secret
    .toUpperCase()
    .replace(/[\s\uFEFF-]/g, '')
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/8/g, 'B');
  return createHash('sha256').update(`whombat-claim-control/1\n${device}\n${normalized}`).digest('base64url');
}

/**
 * The appliance terms accepted with every `claims.start` from contracts 0.10.0 (LC-18, CT-78): the current version,
 * as the app sends it once its checkbox is ticked. `terms` overrides it (a scenario sending an old version or none).
 */
export function claimTerms(terms?: { version: string } | null): { terms?: { version: string } } {
  if (terms === null) return {};
  if (terms) return { terms };
  return contractsAtLeast('0.10.0') ? { terms: { version: APPLIANCE_TERMS_VERSION } } : {};
}

/**
 * Starts a claim with the factory card: from contracts 0.5.1 control requires the claim proof computed from the
 * card's secret, from 0.7 the body names the method (`card`, CC-02/CC-05).
 */
export function startClaim(
  controlUrl: string,
  token: string,
  org: string,
  device: string,
  secret?: string,
  opts: { terms?: { version: string } | null } = {},
) {
  return controlApi(controlUrl, 'POST', `/v1/orgs/${org}/claims`, {
    token,
    body: {
      ...(contractsAtLeast('0.7.0') ? { method: 'card' } : {}),
      device,
      class: 'interactive',
      ...(secret && contractsAtLeast('0.5.1') ? { claimProof: claimProof(device, secret) } : {}),
      ...claimTerms(opts.terms),
    },
    schema: ClaimStart,
  });
}

/**
 * Starts a claim with the console code of a box on the caller's network (CC-05, CC-13): control admits it only for a
 * device `claims.nearby` lists for this caller (`device_not_nearby` otherwise); the letters never go to control.
 */
export function startCodeClaim(
  controlUrl: string,
  token: string,
  org: string,
  device: string,
  opts: { localAddress?: string; terms?: { version: string } | null } = {},
) {
  const { terms, ...rest } = opts;
  return controlApi(controlUrl, 'POST', `/v1/orgs/${org}/claims`, {
    token,
    body: { method: 'code', device, class: 'interactive', ...claimTerms(terms) },
    schema: ClaimStart,
    ...rest,
  });
}

export const Nearby = z.object({
  devices: z.array(
    z.object({
      device: z.string(),
      model: z.string(),
      registeredAt: z.number(),
      lastSeenAt: z.number().nullable(),
    }),
  ),
});

/** `claims.nearby` (CC-04): unclaimed boxes seen recently on the caller's public network, without lookup numbers. */
export function nearby(controlUrl: string, token: string, org: string, opts: { localAddress?: string } = {}) {
  return controlApi(controlUrl, 'GET', `/v1/orgs/${org}/claims/nearby`, { token, schema: Nearby, ...opts });
}

export function cancelClaim(controlUrl: string, token: string, org: string, claim: string) {
  return controlApi(controlUrl, 'DELETE', `/v1/orgs/${org}/claims/${claim}`, { token });
}

export function clientTicket(
  controlUrl: string,
  token: string,
  org: string,
  device: string,
  channel: 'app' | 'enroll',
  cls: 'interactive' | 'bulk',
) {
  return controlApi(controlUrl, 'POST', `/v1/orgs/${org}/tickets`, {
    token,
    body: { device, channel, class: cls },
    schema: TicketResponse,
  });
}

export function devices(controlUrl: string, token: string, org: string) {
  return controlApi<{
    devices: { device: string; state: string; org: string | null; revocations: unknown[] }[];
  }>(controlUrl, 'GET', `/v1/orgs/${org}/devices`, { token });
}

/** Decodes a compact JWS payload (claims) without verifying it (the relay verifies). */
export function jwtClaims(jws: string): Record<string, unknown> {
  const part = jws.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}
