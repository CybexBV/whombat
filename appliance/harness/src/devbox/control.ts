/**
 * DEV control as the DEV box's person and the operator see it (IN-94, IN-101):
 *
 * - the operator API on loopback (`http://127.0.0.1:4701`, the instance's operator token): devices, internal,
 *   entitlement, retire;
 * - the public API (`https://api-dev.whombat.com`) over IPv4, the way the box itself reaches it through the Incus
 *   bridge's NAT: control keys “nearby” on the caller's public address and family (CC-04, CL-36), so the person's calls
 *   must leave this machine the same way;
 * - sign-in: the dev instance mails magic links through its real SMTP relay to real mailboxes, which nothing here can
 *   read. The tool therefore writes the magic-link row control itself writes (a random token's sha256, 10 minutes) into
 *   DEV control's database and redeems it through `POST /v1/auth/verify`: the session, the account and everything after
 *   are control's own. DEV only: it needs the dev instance's Postgres container, which PROD has no equivalent of.
 */
import { randomBytes } from 'node:crypto';
import { request } from 'node:https';
import { must } from '../lib/proc.ts';
import { type DevControl, devOp } from '../ship/context.ts';
import { sha256Hex } from '../ship/records.ts';

export const PG_CONTAINER = process.env.WB_DEVBOX_PG_CONTAINER ?? 'whombat-mgd-pg-stackdev';
export const CONTROL_DB = process.env.WB_DEVBOX_CONTROL_DB ?? 'whombat_control';

export class PublicApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, what: string) {
    const e = (body as { error?: { code?: string; message?: string; details?: { code?: string } } } | null)
      ?.error;
    super(
      `${what}: ${status} ${e?.code ?? ''}${e?.details?.code ? ` (${e.details.code})` : ''}${e?.message ? ` — ${e.message}` : ''}`,
    );
    this.status = status;
    this.body = body;
  }
}

/** One JSON exchange with the public control, over IPv4 (the box's family behind the Incus NAT). */
export function publicApi<T>(
  c: DevControl,
  method: string,
  path: string,
  o: { token?: string; body?: unknown } = {},
): Promise<T> {
  const url = new URL(path, c.publicUrl);
  const body = o.body === undefined ? undefined : JSON.stringify(o.body);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        family: 4,
        timeout: 30_000,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            // keep the text
          }
          if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) resolve(parsed as T);
          else reject(new PublicApiError(res.statusCode ?? 0, parsed, `${method} ${path}`));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${method} ${path}: timeout`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export interface CloudSession {
  token: string;
  expiresAt: string;
  account: { id: string; email: string };
  orgs: { orgId: string; name: string }[];
}

const sqlText = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A magic link for `email`, minted in DEV control's database and redeemed through its API (see above). */
export async function signIn(c: DevControl, email: string): Promise<CloudSession> {
  if (!/^[a-z0-9.+-]+@[a-z0-9.-]+$/.test(email)) throw new Error(`bad email ${email}`);
  const token = randomBytes(32).toString('base64url');
  const id = `ml_devbox${randomBytes(10).toString('hex')}`;
  await must(
    'docker',
    [
      'exec',
      PG_CONTAINER,
      'psql',
      '-U',
      'whombat',
      '-d',
      CONTROL_DB,
      '-v',
      'ON_ERROR_STOP=1',
      '-qAt',
      '-c',
      `insert into magic_links (id, email, token_hash, created_at, expires_at) values (${sqlText(id)}, ${sqlText(email)}, ${sqlText(sha256Hex(token))}, now(), now() + interval '10 minutes')`,
    ],
    { cwd: process.cwd(), timeoutMs: 30_000 },
  );
  return publicApi<CloudSession>(c, 'POST', '/v1/auth/verify', { body: { token } });
}

/** The session if control still takes it. */
export async function sessionAlive(c: DevControl, token: string): Promise<boolean> {
  try {
    await publicApi(c, 'GET', '/v1/auth/session', { token });
    return true;
  } catch {
    return false;
  }
}

export interface OperatorDevice {
  device: string;
  state: string;
  origin?: string;
  org: string | null;
  hardwareSerial?: string;
  contentPeerId?: string;
  internal?: boolean;
  registeredAt?: number;
  lastSeenAt?: number | null;
  status?: {
    release?: string;
    managerVersion?: string;
    uptimeS?: number;
    update?: {
      state?: string;
      candidate?: string | null;
      attempt?: number;
      failure?: string | null;
      failureDetail?: Record<string, unknown> | null;
    };
    health?: Record<string, string>;
    runtimeVersion?: string;
    [k: string]: unknown;
  };
}

export async function devices(c: DevControl): Promise<OperatorDevice[]> {
  return (await devOp<{ devices: OperatorDevice[] }>(c, 'GET', '/devices')).devices;
}

export async function deviceBySerial(c: DevControl, serial: string): Promise<OperatorDevice | null> {
  return (await devices(c)).find((d) => d.hardwareSerial === serial && d.state !== 'retired') ?? null;
}

export async function device(c: DevControl, id: string): Promise<OperatorDevice | null> {
  return (await devices(c)).find((d) => d.device === id) ?? null;
}
