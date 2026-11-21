/**
 * Contracts 0.5.2 helpers for the trust scenarios: the error details the appliance answers with, raw session
 * operations, sessions of another device key (app or enrollment channel), and the push ref of an inbox item.
 */
import { hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pushRefFor } from '@whombat/protocol/session';
import type { Identity } from '@whombat/secure-channel';
import { envPath } from '../dev/env.ts';
import { type ApplianceSession, openSession, type SessionInfo, whenOpen } from './app-client.ts';
import type { SliceState } from './slice.ts';
import { type Persona, ticketSource } from './world.ts';

/** What a refused session operation answered (`OperationError`: protocol code, app code in `details.code`). */
export interface Refusal {
  status: number;
  code: string;
  appCode: string | null;
  message: string;
}

export function refusal(err: unknown): Refusal {
  const e = err as { status?: number; code?: string; details?: { code?: string }; message?: string };
  if (typeof e?.status !== 'number') throw err;
  return {
    status: e.status,
    code: e.code ?? '',
    appCode: e.details?.code ?? null,
    message: e.message ?? '',
  };
}

/** The refusal of `p`, or a failure when it succeeds. */
export async function refused(p: Promise<unknown>, what: string): Promise<Refusal> {
  let out: unknown;
  try {
    out = await p;
  } catch (err) {
    return refusal(err);
  }
  throw new Error(`${what} was accepted: ${JSON.stringify(out).slice(0, 400)}`);
}

/** A raw session operation (for an op the client has no helper for). */
export async function invokeOp(
  s: ApplianceSession,
  op: string,
  input: unknown,
  mutating = true,
): Promise<Record<string, unknown>> {
  const r = await s.invoke(op, input, { mutating });
  if (r.status >= 200 && r.status < 300) return r.body as Record<string, unknown>;
  const error = (r.body as { error?: { code?: string; message?: string; details?: { code?: string } } })
    ?.error;
  throw Object.assign(new Error(`${op}: ${r.status} ${error?.code ?? ''} ${error?.message ?? ''}`), {
    status: r.status,
    code: error?.code ?? 'failed',
    details: error?.details,
  });
}

/**
 * A session for `identity` (another device key of the person, or one the box doesn't know). Relay admission uses the
 * person's cloud org (control tickets route only; the appliance authenticates the endpoint key).
 */
export async function sessionFor(
  slice: SliceState,
  p: Persona,
  identity: Identity,
  channel: 'app' | 'enroll',
): Promise<{ session: ApplianceSession; info: SessionInfo }> {
  const session = openSession({
    tickets: ticketSource(p, slice.deviceId),
    identity,
    appliance: { peerId: slice.peerId },
    channel,
    ...(channel === 'enroll' ? { expect: 'any' as const } : {}),
  });
  const info = await whenOpen(session);
  return { session, info };
}

/**
 * The push ref the appliance sends for an inbox item (runtime `opaqueRef('ref', id)`): HMAC with the key the
 * runtime derives from its master key (HKDF-SHA256, salt `whombat`, info `push-ref/1`). The dev environment
 * generated that master key (`env/runtime/secrets.json`); control's local push sender keeps delivered refs in memory
 * only, so the scenario derives the ref the same way the appliance does.
 */
export function pushRefOf(notificationId: string): string {
  const { masterKey } = JSON.parse(readFileSync(envPath('runtime', 'secrets.json'), 'utf8')) as {
    masterKey: string;
  };
  const key = new Uint8Array(hkdfSync('sha256', Buffer.from(masterKey, 'utf8'), 'whombat', 'push-ref/1', 32));
  return pushRefFor(key, `ref:${notificationId}`);
}
