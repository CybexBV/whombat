/**
 * Dev manager stand-in (IN-09): serves the appliance-local IPC contract's manager socket
 * (`@whombat/control-contracts/local` MANAGER_PATHS, docs/local-ipc.md) for the runtime and calls the runtime's
 * admin socket (`/claim-window`, `/facts`, `/health`), signing device requests to control with the dev
 * appliance's management key exactly as the manager does (`signDeviceRequest`). It has no update engine, TUF or
 * helper: `dev/up --manager=real` runs the real Go manager when its dev configuration is ready.
 *
 * Differences from the real manager, by design of a dev stand-in: peer credentials are not checked (the socket
 * is 0600 and owned by the developer, who is both "runtime" and "manager"); facts are fixed (no backup service
 * status, no update journal).
 *
 * The claim-code lookup lease (CC-03, MG-28) works like the real manager's: `claim.lookup` while unclaimed, renewed
 * after `renewAfterS` (at most half the remaining lifetime), pushed to the runtime (`POST /claim-lookup`) after every
 * renewal and whenever the runtime comes (back) up, `{lookup: null}` once it ran out; released for good on
 * `already_claimed`, on the runtime's claim report, or when the runtime's facts say it is claimed. Like the real manager
 * (MG-32), every successful renewal is followed by one `claim.lookup` forced over the other address family, so control
 * has the box's network tag of both (control CL-36); a family without a route or DNS record is skipped quietly (an IP
 * literal in `controlUrl` has only its own family).
 *
 * The licence (LC-06, LC-08) works like the real manager's (MG-34…MG-36): once claimed it renews with `licence.renew`
 * at once, then every `renewAfterS` (±10 %); failures back off 60 s → 1 h, `device_unclaimed` and
 * `devices_allowed_reached` wait an hour, `device_revoked` stops. Every token is verified against the pinned key set
 * (`licenceKeysFile`) for this device, an older `iat` is `stale`; `{v, token, highWater}` goes to `licenceStateFile`
 * (0600, atomic) with highWater = max(accepted iats, control's now); `POST /licence` after every change, whenever the
 * runtime comes (back) up and every 5 min; `POST /v1/licence/renew` renews now (once a minute, else 429 `busy`).
 *
 *   node dev-manager.ts --config <file>
 *   config: { controlUrl, deviceFile, managementKey, socket, adminSocket, env, statusFile,
 *             licenceKeysFile?, licenceStateFile? }
 */
import { createPrivateKey, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, request, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { DEVICE_OPS, type DeviceOp, signDeviceRequest } from '@whombat/control-contracts/device';
import {
  ADMIN_PATHS,
  LicenceRenewNowRequest,
  LocalOk,
  MANAGER_PATHS,
  RuntimeClaimedRequest,
  RuntimePushRequest,
  RuntimeRevocationRequest,
  RuntimeTicketRequest,
  type RuntimeTicketResponse,
  revocationRef,
} from '@whombat/control-contracts/local';
import { LicenceKeySet, verifyLicenceToken } from '@whombat/protocol/licence';

interface Config {
  controlUrl: string;
  deviceFile: string;
  managementKey: string;
  socket: string;
  adminSocket: string;
  env: 'local';
  statusFile: string;
  /** The pinned licence key set (the dev image's, IN-39); absent: no licence loop. */
  licenceKeysFile?: string;
  licenceStateFile?: string;
}

const cfg = JSON.parse(
  readFileSync(process.argv[process.argv.indexOf('--config') + 1] ?? '', 'utf8'),
) as Config;
const device = JSON.parse(readFileSync(cfg.deviceFile, 'utf8')) as { deviceId: string };
const der = createPrivateKey(readFileSync(cfg.managementKey, 'utf8')).export({
  format: 'der',
  type: 'pkcs8',
});
const seedHex = Buffer.from(der.subarray(der.length - 32)).toString('hex');

const stats = {
  startedAt: new Date().toISOString(),
  tickets: 0,
  ticketErrors: 0,
  claimed: [] as string[],
  revocations: [] as string[],
  pushes: 0,
  lease: { lookup: null as string | null, expiresAt: null as string | null, state: 'pending' as string },
  /** Answered `claim.lookup` calls by the address family they went over (MG-32). */
  lookups: { ipv4: 0, ipv6: 0 },
  adminSocket: {
    claimWindow: 'pending',
    facts: 'pending',
    health: 'unknown' as string,
    lastHealth: null as unknown,
  },
  lastError: null as string | null,
  licence: {
    held: false,
    iat: null as number | null,
    exp: null as number | null,
    state: null as string | null,
    plan: null as string | null,
    highWater: null as string | null,
    last: '' as string,
    renewals: 0,
    attempts: 0,
    pushes: 0,
    stopped: false,
    runtime: null as unknown,
  },
};
const saveStats = () => writeFileSync(cfg.statusFile, `${JSON.stringify(stats, null, 2)}\n`);
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), msg, ...extra })}\n`);

class ControlError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, message: string, body = '') {
    super(message);
    this.status = status;
    this.body = body;
  }
  /** Control's `{error: {code, details: {code}}}`. */
  codes(): { code: string; detail: string } {
    try {
      const e = (JSON.parse(this.body) as { error?: { code?: string; details?: { code?: string } } }).error;
      return { code: e?.code ?? '', detail: e?.details?.code ?? '' };
    } catch {
      return { code: '', detail: '' };
    }
  }
}

type Family = 4 | 6;

/** POST to control over `family` (default: whichever the resolver picks); the answer and the family it came over. */
function postControl(
  url: string,
  body: string,
  family?: Family,
): Promise<{ status: number; text: string; reason: string; family: Family | null }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? httpsRequest : request)(
      u,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: 10_000,
        ...(family ? { family } : {}),
      },
      (res) => {
        const remote = res.socket?.remoteFamily;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
            reason: String(res.headers['x-whombat-reason'] ?? ''),
            family: remote === 'IPv6' ? 6 : remote === 'IPv4' ? 4 : null,
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function deviceOp<Op extends DeviceOp>(op: Op, body: unknown): Promise<unknown> {
  return (await deviceOpOver(op, body)).body;
}

async function deviceOpOver<Op extends DeviceOp>(
  op: Op,
  body: unknown,
  family?: Family,
): Promise<{ body: unknown; family: Family | null }> {
  const envelope = signDeviceRequest(
    {
      aud: `whombat-api:${cfg.env}`,
      device: device.deviceId,
      op,
      ts: Math.floor(Date.now() / 1000),
      nonce: randomBytes(16).toString('hex'),
      body: body as never,
    },
    seedHex,
  );
  let res: Awaited<ReturnType<typeof postControl>>;
  try {
    res = await postControl(`${cfg.controlUrl}/v1/device/${op}`, JSON.stringify(envelope), family);
  } catch (err) {
    throw new ControlError(503, `control unreachable: ${String(err)}`);
  }
  if (res.status < 200 || res.status > 299)
    throw new ControlError(
      res.status,
      `${op}: ${res.status} ${res.reason} ${res.text.slice(0, 300)}`,
      res.text,
    );
  return { body: DEVICE_OPS[op].response.parse(JSON.parse(res.text)), family: res.family };
}

const tickets = new Map<string, { value: RuntimeTicketResponse; exp: number }>();

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 65_536) throw new Error('too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
const localError = (res: ServerResponse, status: number, code: string, message: string) =>
  send(res, status, { error: { code, message: message.replace(/[^\x20-\x7e]/g, '?').slice(0, 500) } });

const server = createServer(async (req, res) => {
  try {
    const path = req.url ?? '/';
    if (req.method === 'GET' && path === '/v1/dev/status') return send(res, 200, stats);
    if (req.method !== 'POST') return localError(res, 405, 'bad_request', 'method not allowed');
    let raw: unknown;
    try {
      raw = await readJson(req);
    } catch {
      return localError(res, 400, 'bad_request', 'invalid JSON');
    }
    switch (path) {
      case MANAGER_PATHS.ticket: {
        const input = RuntimeTicketRequest.safeParse(raw);
        if (!input.success) return localError(res, 400, 'bad_request', input.error.message);
        const cached = tickets.get(input.data.class);
        // Appliance tickets may open data connections until exp: reuse until 60 s before it.
        if (cached && cached.exp - Date.now() > 60_000) return send(res, 200, cached.value);
        try {
          const t = (await deviceOp('ticket.issue', { class: input.data.class })) as {
            ticket: string;
            expiresAt: number;
            relay: { worker: string; url: string };
          };
          const value: RuntimeTicketResponse = {
            ticket: t.ticket,
            relayUrl: t.relay.url,
            worker: t.relay.worker,
            expiresAt: new Date(t.expiresAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          };
          tickets.set(input.data.class, { value, exp: t.expiresAt * 1000 });
          stats.tickets++;
          saveStats();
          return send(res, 200, value);
        } catch (err) {
          stats.ticketErrors++;
          stats.lastError = String(err);
          saveStats();
          const status = err instanceof ControlError && err.status >= 500 ? 503 : 502;
          return localError(res, status, status === 503 ? 'unavailable' : 'control_refused', String(err));
        }
      }
      case MANAGER_PATHS.claimed: {
        const input = RuntimeClaimedRequest.safeParse(raw);
        if (!input.success) return localError(res, 400, 'bad_request', input.error.message);
        try {
          await deviceOp('claim.claimed', {
            claimId: input.data.claimId,
            claimedAt: Math.floor(Date.parse(input.data.claimedAt) / 1000),
          });
        } catch (err) {
          stats.lastError = String(err);
          saveStats();
          return localError(res, 503, 'unavailable', String(err));
        }
        stats.claimed.push(input.data.claimedAt);
        lease.done = 'claimed';
        void pushLease();
        // The claim reached control: renew the licence right away (LC-06).
        if (lic.last === 'device_unclaimed' || !lic.token) lic.next = 0;
        saveStats();
        return send(res, 200, LocalOk.parse({ ok: true }));
      }
      case MANAGER_PATHS.revocations: {
        const input = RuntimeRevocationRequest.safeParse(raw);
        if (!input.success) return localError(res, 400, 'bad_request', input.error.message);
        const at = Math.floor(Date.parse(input.data.revokedAt) / 1000);
        try {
          await deviceOp('revocations.report', {
            revocations: [
              {
                ref: revocationRef(input.data.peerId),
                kind: 'endpoint',
                state: 'applied',
                requestedAt: at,
                appliedAt: at,
              },
            ],
          });
        } catch (err) {
          stats.lastError = String(err);
          saveStats();
          return localError(res, 503, 'unavailable', String(err));
        }
        stats.revocations.push(input.data.peerId);
        saveStats();
        return send(res, 200, { ok: true });
      }
      case MANAGER_PATHS.licenceRenew: {
        if (!keySet)
          return localError(res, 404, 'unavailable', 'this appliance has no licence configuration');
        const input = LicenceRenewNowRequest.safeParse(raw);
        if (!input.success) return localError(res, 400, 'bad_request', input.error.message);
        if (Date.now() - lic.forcedAt < 60_000) {
          res.setHeader('retry-after', '60');
          return localError(res, 429, 'busy', 'a licence renewal was asked for less than a minute ago');
        }
        lic.forcedAt = Date.now();
        if (lic.stopped) return send(res, 200, { v: 1, renewed: false, error: 'device_revoked' });
        const r = await renewLicence();
        return send(res, 200, { v: 1, renewed: r.renewed, ...(r.error ? { error: r.error } : {}) });
      }
      case MANAGER_PATHS.push: {
        const input = RuntimePushRequest.safeParse(raw);
        if (!input.success) return localError(res, 400, 'bad_request', input.error.message);
        try {
          const out = await deviceOp('push.send', input.data);
          stats.pushes++;
          saveStats();
          return send(res, 200, out);
        } catch (err) {
          return localError(res, 503, 'unavailable', String(err));
        }
      }
      default:
        return localError(res, 404, 'not_found', 'unknown path');
    }
  } catch (err) {
    return localError(res, 500, 'internal', String(err));
  }
});

/** A JSON call on the runtime's admin socket. */
function admin(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath: cfg.adminSocket,
        path,
        method,
        headers: data
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
          : {},
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

/* The claim-code lookup lease (CC-03) ------------------------------------------------------------------------ */

const lease = {
  lookup: null as string | null,
  expiresAt: 0,
  next: 0,
  failures: 0,
  done: null as null | 'claimed' | 'retired',
};

function leaseBody() {
  const live = !lease.done && lease.lookup && Date.now() < lease.expiresAt;
  return live
    ? {
        v: 1,
        lookup: lease.lookup,
        expiresAt: new Date(lease.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      }
    : { v: 1, lookup: null };
}

async function pushLease(): Promise<void> {
  const body = leaseBody();
  stats.lease = { lookup: body.lookup, expiresAt: body.expiresAt ?? null, state: lease.done ?? 'unclaimed' };
  if (!existsSync(cfg.adminSocket)) return;
  try {
    const r = await admin('POST', ADMIN_PATHS.claimLookup, body);
    // 404: a runtime before contracts 0.7 has no lease to show.
    if (r.status !== 200 && r.status !== 404)
      log('claim-lookup push refused', { status: r.status, body: r.body });
  } catch (err) {
    log('claim-lookup push failed', { err: String(err) });
  }
}

async function leaseTick(): Promise<void> {
  if (lease.done || Date.now() < lease.next) {
    if (!lease.done && lease.lookup && Date.now() >= lease.expiresAt) {
      lease.lookup = null;
      await pushLease();
    }
    return;
  }
  try {
    const f = await admin('GET', ADMIN_PATHS.facts);
    if (f.status === 200 && (f.body as { claimed?: boolean }).claimed === true) {
      lease.done = 'claimed';
      log('the runtime is claimed: no claim-code lease');
      return pushLease();
    }
  } catch {
    // runtime not up: control still leases; the push follows when it answers
  }
  try {
    const answer = await deviceOpOver('claim.lookup', {});
    const r = answer.body as {
      lookup: string;
      expiresAt: number;
      renewAfterS: number;
    };
    countLookup(answer.family);
    await lookupOverOtherFamily(answer.family);
    if (r.lookup !== lease.lookup) log('claim-code lookup leased', { expiresAt: r.expiresAt });
    lease.lookup = r.lookup;
    lease.expiresAt = r.expiresAt * 1000;
    lease.failures = 0;
    lease.next = Date.now() + Math.min(r.renewAfterS * 1000, (lease.expiresAt - Date.now()) / 2);
  } catch (err) {
    const c = err instanceof ControlError ? err.codes() : { code: '', detail: '' };
    if (err instanceof ControlError && err.status === 409 && c.detail === 'already_claimed')
      lease.done = 'claimed';
    else if (err instanceof ControlError && err.status === 403 && c.code === 'device_revoked')
      lease.done = 'retired';
    else {
      lease.failures++;
      lease.next = Date.now() + Math.min(15_000 * 2 ** (lease.failures - 1), 300_000);
      stats.lastError = String(err);
    }
    if (lease.done) log('claim-code lease released', { why: lease.done });
  }
  await pushLease();
}

function countLookup(family: Family | null) {
  if (family === 4) stats.lookups.ipv4++;
  if (family === 6) stats.lookups.ipv6++;
}

let otherFamilySkipped = '';
/** One `claim.lookup` over the family the normal one didn't use (MG-32); failures are skipped, logged once. */
async function lookupOverOtherFamily(used: Family | null): Promise<void> {
  if (!used) return;
  const other: Family = used === 4 ? 6 : 4;
  const skip = (why: string) => {
    if (why !== otherFamilySkipped)
      log(`claim.lookup over IPv${other} skipped`, { level: 'debug', err: why });
    otherFamilySkipped = why;
  };
  // An address literal has one family only.
  if (isIP(new URL(cfg.controlUrl).hostname.replace(/^\[|\]$/g, ''))) return skip('address literal');
  try {
    countLookup((await deviceOpOver('claim.lookup', {}, other)).family);
    otherFamilySkipped = '';
  } catch (err) {
    skip(String(err));
  }
}

/* The licence (LC-06, LC-08, MG-34…MG-36) ------------------------------------------------------------------------ */

const keySet = cfg.licenceKeysFile
  ? LicenceKeySet.parse(JSON.parse(readFileSync(cfg.licenceKeysFile, 'utf8')))
  : null;
const lic = {
  token: null as string | null,
  iat: 0,
  highWater: 0,
  next: 0,
  failures: 0,
  last: '',
  stopped: false,
  forcedAt: 0,
  pushedAt: 0,
  chain: Promise.resolve() as Promise<unknown>,
};
const nowS = () => Math.floor(Date.now() / 1000);
const rfc = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const jitter10 = (ms: number) => ms * (0.9 + Math.random() * 0.2);

function licenceStats(claims?: { iat: number; exp: number; state: string; plan: string }) {
  stats.licence.held = !!lic.token;
  stats.licence.highWater = lic.highWater ? rfc(lic.highWater) : null;
  stats.licence.last = lic.last;
  stats.licence.stopped = lic.stopped;
  if (claims) {
    stats.licence.iat = claims.iat;
    stats.licence.exp = claims.exp;
    stats.licence.state = claims.state;
    stats.licence.plan = claims.plan;
  }
}

function loadLicence(): void {
  if (!keySet || !cfg.licenceStateFile || !existsSync(cfg.licenceStateFile)) return;
  try {
    const f = JSON.parse(readFileSync(cfg.licenceStateFile, 'utf8')) as {
      token: string | null;
      highWater?: string;
      renewAt?: number;
    };
    lic.highWater = f.highWater ? Math.floor(Date.parse(f.highWater) / 1000) : 0;
    if (f.token) {
      const v = verifyLicenceToken(f.token, {
        keySet,
        device: device.deviceId,
        now: Math.max(nowS(), lic.highWater),
      });
      if (v.ok) {
        lic.token = f.token;
        lic.iat = v.claims.iat;
        lic.highWater = Math.max(lic.highWater, v.claims.iat);
        // MG-38: a restart renews when the stored renewal is due (at most a day away).
        if (f.renewAt)
          lic.next = Date.now() + Math.min(Math.max(f.renewAt * 1000 - Date.now(), 0), 86_400_000);
        licenceStats(v.claims);
      } else log('the stored licence token no longer verifies; dropped', { error: v.error });
    }
  } catch (err) {
    log('licence state unreadable; starting without a token', { err: String(err) });
  }
}

function saveLicence(): void {
  if (!cfg.licenceStateFile) return;
  const tmp = `${cfg.licenceStateFile}.tmp`;
  const renewAt = Math.floor(lic.next / 1000);
  writeFileSync(
    tmp,
    `${JSON.stringify({ v: 1, token: lic.token, highWater: rfc(lic.highWater), renewAt })}\n`,
    {
      mode: 0o600,
    },
  );
  renameSync(tmp, cfg.licenceStateFile);
}

/** `POST /licence` with what is held (nothing before the first renewal); 404 is a runtime before 0.10.0. */
async function pushLicence(): Promise<void> {
  if (!keySet || (!lic.token && !lic.highWater) || !existsSync(cfg.adminSocket)) return;
  try {
    const r = await admin('POST', ADMIN_PATHS.licence, {
      v: 1,
      token: lic.token,
      highWater: rfc(lic.highWater),
    });
    lic.pushedAt = Date.now();
    if (r.status === 200) {
      stats.licence.pushes++;
      stats.licence.runtime = (r.body as { licence?: unknown }).licence ?? null;
    } else if (r.status !== 404) log('licence push refused', { status: r.status, body: r.body });
  } catch (err) {
    log('licence push failed', { err: String(err) });
  }
  saveStats();
}

/** One `licence.renew` (serialized); the outcome as `LicenceRenewNowResult` reports it. */
function renewLicence(): Promise<{ renewed: boolean; error?: string }> {
  const run = lic.chain.then(renewOnce);
  lic.chain = run.catch(() => {});
  return run;
}

async function renewOnce(): Promise<{ renewed: boolean; error?: string }> {
  if (!keySet) return { renewed: false, error: 'not_configured' };
  stats.licence.attempts++;
  const fail = (error: string, retryMs?: number) => {
    lic.last = error;
    if (retryMs === undefined) {
      lic.failures++;
      retryMs = Math.min(60_000 * 2 ** (lic.failures - 1), 3_600_000);
    }
    lic.next = Date.now() + jitter10(retryMs);
    licenceStats();
    saveStats();
    log('licence.renew failed', { error });
    return { renewed: false, error };
  };
  let r: { token: string; expiresAt: number; renewAfterS: number; now: number };
  try {
    r = (await deviceOp('licence.renew', {})) as typeof r;
  } catch (err) {
    const c = err instanceof ControlError ? err.codes() : { code: '', detail: '' };
    const status = err instanceof ControlError ? err.status : 503;
    if (status === 403 && c.code === 'device_revoked') {
      lic.stopped = true;
      return fail('device_revoked', 3_600_000);
    }
    if (status === 429) return fail('rate_limited');
    if (status >= 500) return fail('unreachable');
    if (c.detail === 'device_unclaimed' || c.code === 'device_unclaimed')
      return fail('device_unclaimed', 3_600_000);
    if (c.detail === 'devices_allowed_reached') return fail('devices_allowed_reached', 3_600_000);
    return fail('control_refused');
  }
  const v = verifyLicenceToken(r.token, {
    keySet,
    device: device.deviceId,
    now: Math.max(nowS(), lic.highWater, r.now),
  });
  if (!v.ok) return fail('bad_token');
  if (lic.token && v.claims.iat < lic.iat) return fail('stale');
  lic.token = r.token;
  lic.iat = v.claims.iat;
  lic.highWater = Math.max(lic.highWater, v.claims.iat, r.now);
  lic.failures = 0;
  lic.last = '';
  lic.next = Date.now() + jitter10(Math.max(r.renewAfterS, 60) * 1000);
  saveLicence();
  stats.licence.renewals++;
  licenceStats(v.claims);
  log('licence renewed', {
    state: v.claims.state,
    plan: v.claims.plan,
    exp: v.claims.exp,
    renewAfterS: r.renewAfterS,
  });
  await pushLicence();
  return { renewed: true };
}

async function licenceTick(): Promise<void> {
  if (!keySet || lic.stopped || lease.done !== 'claimed') return;
  if (Date.now() >= lic.next) await renewLicence();
  else if (Date.now() - lic.pushedAt > 300_000) await pushLicence();
}

loadLicence();

let adminReady = false;
let adminSocketId = '';
async function adminLoop() {
  for (;;) {
    // A new socket file is a new runtime process (MG-31): hand everything over again.
    const id = existsSync(cfg.adminSocket)
      ? `${statSync(cfg.adminSocket).ino}:${statSync(cfg.adminSocket).ctimeMs}`
      : '';
    if (id !== adminSocketId) adminReady = false;
    adminSocketId = id;
    if (!existsSync(cfg.adminSocket)) {
      stats.adminSocket.health = 'no admin socket';
      adminReady = false;
    } else {
      try {
        if (!adminReady) {
          const cw = await admin('POST', ADMIN_PATHS.claimWindow, { v: 1, required: false, openUntil: null });
          stats.adminSocket.claimWindow = `${cw.status}`;
          const facts = await admin('POST', ADMIN_PATHS.facts, { v: 1, backup: null, update: null });
          stats.adminSocket.facts = `${facts.status}`;
          adminReady = cw.status === 200 && facts.status === 200;
          // A (re)started runtime has no lease: hand over the current one (or none) again; the licence too.
          await pushLease();
          await pushLicence();
          log('pushed claim window and facts to the runtime', {
            claimWindow: cw.status,
            facts: facts.status,
          });
        }
        await leaseTick();
        await licenceTick();
        const h = await admin('GET', ADMIN_PATHS.health);
        stats.adminSocket.health = h.status === 200 ? 'ok' : `status ${h.status}`;
        stats.adminSocket.lastHealth = h.body;
      } catch (err) {
        stats.adminSocket.health = `error: ${String(err)}`;
        adminReady = false;
      }
    }
    saveStats();
    await new Promise((r) => setTimeout(r, 2000));
  }
}

if (existsSync(cfg.socket)) rmSync(cfg.socket);
server.listen(cfg.socket, () => {
  chmodSync(cfg.socket, 0o600);
  log('dev manager listening', { socket: cfg.socket, device: device.deviceId });
  saveStats();
  void adminLoop();
});
const stop = () => {
  server.close();
  if (existsSync(cfg.socket)) rmSync(cfg.socket);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
