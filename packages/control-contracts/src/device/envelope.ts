/**
 * Device-signed requests (MA-03): the manager signs every control API call with the appliance management key.
 * `sig = Ed25519(canonicalJson({purpose, v, aud, device, op, ts, nonce, body}))`, where `aud` is
 * `whombat-api:<env>` (no cross-environment replay), `ts` must be within ±300 s of control's clock and
 * `(device, nonce)` is single-use for 600 s. Bodies are integer-only JSON so canonical JSON matches in Go.
 */
import { canonicalJson, signBytes, utf8ToBytes, verifyBytes } from '@whombat/core/audit';
import { EpochSeconds, SignatureHex } from '@whombat/release';
import { z } from 'zod';
import { DeviceId, NonceHex } from '../common.js';
import { FEEDBACK_CARDS_SYNC_MAX_BYTES } from './feedback.js';
import { DEVICE_OPS, type DeviceOp, DeviceOpName } from './ops.js';
import { SHARE_PUT_MAX_BYTES } from './share.js';

export const DEVICE_REQUEST_PURPOSE = 'whombat-device-request/v1';
export const DEVICE_REQUEST_MAX_SKEW_S = 300;
export const DEVICE_NONCE_TTL_S = 600;
/** Largest device request (canonical JSON bytes of the signed envelope), except where `deviceRequestMaxBytes` says. */
export const DEVICE_REQUEST_MAX_BYTES = 65_536;

/**
 * The size limit of one op's request: `FEEDBACK_CARDS_SYNC_MAX_BYTES` for `feedback.cards.sync` (CT-91),
 * `SHARE_PUT_MAX_BYTES` for `share.put` (a sealed copy with its pictures).
 */
export function deviceRequestMaxBytes(op: string): number {
  if (op === 'feedback.cards.sync') return FEEDBACK_CARDS_SYNC_MAX_BYTES;
  if (op === 'share.put') return SHARE_PUT_MAX_BYTES;
  return DEVICE_REQUEST_MAX_BYTES;
}

export const ControlAudience = z
  .string()
  .max(64)
  .regex(/^whombat-api:[a-z0-9-]{1,32}$/);

export const DeviceRequestEnvelope = z.strictObject({
  v: z.literal(1),
  aud: ControlAudience,
  device: DeviceId,
  op: DeviceOpName,
  ts: EpochSeconds,
  nonce: NonceHex,
  /** Validated against `DEVICE_OPS[op].body`. */
  body: z.record(z.string(), z.unknown()),
  sig: SignatureHex,
});
export type DeviceRequestEnvelope = z.infer<typeof DeviceRequestEnvelope>;

type Unsigned = Omit<DeviceRequestEnvelope, 'sig'>;

/** The bytes the management key signs. */
export function deviceRequestSigningBytes(req: Unsigned): Uint8Array {
  const { v, aud, device, op, ts, nonce, body } = req;
  return utf8ToBytes(canonicalJson({ purpose: DEVICE_REQUEST_PURPOSE, v, aud, device, op, ts, nonce, body }));
}

export function signDeviceRequest<Op extends DeviceOp>(
  req: Omit<Unsigned, 'op' | 'body' | 'v'> & { op: Op; body: z.input<(typeof DEVICE_OPS)[Op]['body']> },
  managementSecretKeyHex: string,
): DeviceRequestEnvelope {
  const unsigned: Unsigned = { v: 1, ...req, body: req.body as Record<string, unknown> };
  return { ...unsigned, sig: signBytes(deviceRequestSigningBytes(unsigned), managementSecretKeyHex) };
}

export type DeviceRequestError =
  | 'bad_envelope'
  | 'too_large'
  | 'wrong_audience'
  | 'unknown_device'
  | 'bad_signature'
  | 'stale'
  | 'replayed'
  | 'bad_body';

/**
 * Control side. `publicKeyOf` returns the device's current management key (hex) or undefined (unknown or
 * retired); `claimNonce` records `(device, nonce)` and returns false when it was already seen within the TTL.
 * Order: schema, size, audience, key, signature, time, nonce, body — the nonce is only spent on a valid request.
 */
export function verifyDeviceRequest(
  raw: unknown,
  ctx: {
    audience: string;
    now: number;
    publicKeyOf: (device: string) => string | undefined;
    claimNonce: (device: string, nonce: string) => boolean;
    maxSkewS?: number;
  },
):
  | { ok: true; device: string; op: DeviceOp; body: unknown; envelope: DeviceRequestEnvelope }
  | { ok: false; error: DeviceRequestError } {
  const parsed = DeviceRequestEnvelope.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'bad_envelope' };
  const env = parsed.data;
  let bytes: Uint8Array;
  try {
    bytes = deviceRequestSigningBytes(env);
  } catch {
    return { ok: false, error: 'bad_envelope' };
  }
  if (bytes.length > deviceRequestMaxBytes(env.op)) return { ok: false, error: 'too_large' };
  if (env.aud !== ctx.audience) return { ok: false, error: 'wrong_audience' };
  const key = ctx.publicKeyOf(env.device);
  if (!key) return { ok: false, error: 'unknown_device' };
  if (!verifyBytes(env.sig, bytes, key)) return { ok: false, error: 'bad_signature' };
  if (Math.abs(ctx.now - env.ts) > (ctx.maxSkewS ?? DEVICE_REQUEST_MAX_SKEW_S))
    return { ok: false, error: 'stale' };
  if (!ctx.claimNonce(env.device, env.nonce)) return { ok: false, error: 'replayed' };
  const op = env.op as DeviceOp;
  const body = DEVICE_OPS[op].body.safeParse(env.body);
  if (!body.success) return { ok: false, error: 'bad_body' };
  return { ok: true, device: env.device, op, body: body.data, envelope: env };
}
