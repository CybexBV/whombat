/**
 * CPace, cipher suite `CPACE-RISTR255-SHA512`, initiator–responder setting, exactly as draft-irtf-cfrg-cpace-21
 * (§6–§8.3, Appendix A; checked against Appendix B.3). Pure: `@noble/curves` ristretto255 and `@noble/hashes`
 * SHA-512, randomness injected. The claim ceremony's use of it is in `pake.ts` (CC-06).
 *
 * Group elements on the wire are the 32-byte ristretto255 encodings; scalars are 32-byte little-endian strings.
 * The implementation never exposes K (§10.3).
 */
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { utf8Encode } from '../bytes.js';

type Point = InstanceType<typeof ristretto255.Point>;

export const CPACE_SUITE = 'CPACE-RISTR255-SHA512';
/** `G_Ristretto255.DSI`. */
export const CPACE_DSI = 'CPaceRistretto255';
/** SHA-512's input block size (`H.s_in_bytes`). */
const S_IN_BYTES = 128;
const FIELD_SIZE_BYTES = 32;
const GROUP_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

/** `G.I`: the public encoding of the neutral element (32 zero bytes). */
export const CPACE_IDENTITY: Uint8Array = new Uint8Array(32);

export class CpaceError extends Error {
  constructor(
    /** `invalid_share`: the peer's share doesn't decode, or `scalar_mult_vfy` gave the neutral element (abort). */
    readonly code: 'invalid_share',
  ) {
    super('CPace: the peer’s share is invalid (abort)');
    this.name = 'CpaceError';
  }
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** `prepend_len(data)`: the LEB128 length of `data`, then `data` (A.1.1). */
export function cpacePrependLen(data: Uint8Array): Uint8Array {
  const len: number[] = [];
  let n = data.length;
  do {
    len.push(n < 128 ? n : (n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  } while (n !== 0);
  return concat(Uint8Array.from(len), data);
}

/** `lv_cat(a0, a1, …)` (A.1.3). */
export function cpaceLvCat(...parts: Uint8Array[]): Uint8Array {
  return concat(...parts.map(cpacePrependLen));
}

/** `generator_string(DSI, PRS, CI, sid, s_in_bytes)` (A.2). */
export function cpaceGeneratorString(
  dsi: Uint8Array,
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
  sInBytes = S_IN_BYTES,
): Uint8Array {
  const zpad = Math.max(0, sInBytes - 1 - cpacePrependLen(prs).length - cpacePrependLen(dsi).length);
  return cpaceLvCat(dsi, prs, new Uint8Array(zpad), ci, sid);
}

function generatorPoint(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Point {
  const genStr = cpaceGeneratorString(utf8Encode(CPACE_DSI), prs, ci, sid);
  // H.hash(gen_str, 2 * field_size_bytes): SHA-512 is exactly 64 bytes.
  const hash = sha512(genStr).subarray(0, 2 * FIELD_SIZE_BYTES);
  const derive = ristretto255_hasher.deriveToCurve;
  if (!derive) throw new Error('@noble/curves lacks ristretto255 element derivation');
  return derive(hash);
}

/** `G.calculate_generator(H, PRS, CI, sid)` (§8.3), encoded. */
export function cpaceGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  return generatorPoint(prs, ci, sid).toBytes();
}

const scalarOf = (y: Uint8Array): bigint => {
  if (y.length !== 32) throw new Error('CPace scalars are 32 bytes');
  let n = 0n;
  for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(y[i] as number);
  return n % GROUP_ORDER;
};

/**
 * `G.sample_scalar()` (§8.3, recommended form): 32 random bytes with the bits above `group_size_bits` (252) cleared,
 * little-endian. A zero scalar (probability 2⁻²⁵²) is drawn again.
 */
export function cpaceSampleScalar(randomBytes: (n: number) => Uint8Array): Uint8Array {
  for (let draw = 0; draw < 8; draw++) {
    const y = Uint8Array.from(randomBytes(32));
    if (y.length !== 32) throw new Error('randomBytes returned the wrong length');
    y[31] = (y[31] as number) & 0x0f;
    if (y.some((b) => b !== 0)) return y;
  }
  throw new Error('the randomness source keeps returning zero scalars');
}

/** `G.scalar_mult(y, g)` for the generator of (PRS, CI, sid): the public share `Y = encode(y · g)`. */
export function cpaceShare(y: Uint8Array, prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  const s = scalarOf(y);
  if (s === 0n) throw new Error('zero scalar');
  return generatorPoint(prs, ci, sid).multiply(s).toBytes();
}

/**
 * `G.scalar_mult_vfy(y, X)` (§8.3): `G.I` when `X` doesn't decode (non-canonical or not a ristretto255 encoding),
 * otherwise `encode(y · decode(X))` — which is `G.I` for the identity. Callers abort on `G.I`.
 */
export function cpaceScalarMultVfy(y: Uint8Array, x: Uint8Array): Uint8Array {
  const s = scalarOf(y);
  let point: Point;
  try {
    if (x.length !== 32) return CPACE_IDENTITY.slice();
    point = ristretto255.Point.fromBytes(x);
  } catch {
    return CPACE_IDENTITY.slice();
  }
  if (s === 0n || point.is0()) return CPACE_IDENTITY.slice();
  return point.multiply(s).toBytes();
}

const isIdentity = (k: Uint8Array) => k.length === 32 && k.every((b) => b === 0);

/** `transcript_ir(Ya, ADa, Yb, ADb) = lv_cat(Ya, ADa) ‖ lv_cat(Yb, ADb)` (A.3.4). */
export function cpaceTranscriptIr(
  ya: Uint8Array,
  adA: Uint8Array,
  yb: Uint8Array,
  adB: Uint8Array,
): Uint8Array {
  return concat(cpaceLvCat(ya, adA), cpaceLvCat(yb, adB));
}

/** `ISK = H.hash(lv_cat(G.DSI ‖ b"_ISK", sid, K) ‖ transcript)` (§7.2). */
export function cpaceIsk(sid: Uint8Array, k: Uint8Array, transcript: Uint8Array): Uint8Array {
  return sha512(concat(cpaceLvCat(utf8Encode(`${CPACE_DSI}_ISK`), sid, k), transcript));
}

/** The inputs both parties share: the password-related string, the channel identifier and the session id. */
export interface CpaceInputs {
  prs: Uint8Array;
  ci: Uint8Array;
  sid: Uint8Array;
}

/** What a party ends with: `ISK` and the transcript it was computed over. */
export interface CpaceResult {
  isk: Uint8Array;
  transcript: Uint8Array;
}

/** The initiator (A) between its message and B's answer. Keep it in memory only. */
export interface CpaceInitiatorState {
  readonly inputs: CpaceInputs;
  readonly y: Uint8Array;
  readonly share: Uint8Array;
  readonly ad: Uint8Array;
}

/** A: `ya = sample_scalar()`, `Ya = scalar_mult(ya, g)`; send `Ya` (and `ADa`). */
export function cpaceInitiatorStart(
  inputs: CpaceInputs,
  randomBytes: (n: number) => Uint8Array,
  ad: Uint8Array = new Uint8Array(0),
): CpaceInitiatorState {
  const y = cpaceSampleScalar(randomBytes);
  return { inputs, y, share: cpaceShare(y, inputs.prs, inputs.ci, inputs.sid), ad };
}

/** A, on B's `Yb`: `K = scalar_mult_vfy(ya, Yb)`, abort (`CpaceError`) if `K = G.I`, else `ISK`. */
export function cpaceInitiatorFinish(
  state: CpaceInitiatorState,
  yb: Uint8Array,
  adB: Uint8Array = new Uint8Array(0),
): CpaceResult {
  const k = cpaceScalarMultVfy(state.y, yb);
  if (isIdentity(k)) throw new CpaceError('invalid_share');
  const transcript = cpaceTranscriptIr(state.share, state.ad, yb, adB);
  return { isk: cpaceIsk(state.inputs.sid, k, transcript), transcript };
}

/**
 * B, on A's `Ya`: `Yb = scalar_mult(yb, g)`, `K = scalar_mult_vfy(yb, Ya)`, abort (`CpaceError`) if `K = G.I`, else
 * `ISK`. Send `Yb` (and `ADb`) back.
 */
export function cpaceResponderRespond(
  inputs: CpaceInputs,
  ya: Uint8Array,
  randomBytes: (n: number) => Uint8Array,
  adA: Uint8Array = new Uint8Array(0),
  adB: Uint8Array = new Uint8Array(0),
): CpaceResult & { share: Uint8Array } {
  const y = cpaceSampleScalar(randomBytes);
  const share = cpaceShare(y, inputs.prs, inputs.ci, inputs.sid);
  const k = cpaceScalarMultVfy(y, ya);
  if (isIdentity(k)) throw new CpaceError('invalid_share');
  const transcript = cpaceTranscriptIr(ya, adA, share, adB);
  return { share, isk: cpaceIsk(inputs.sid, k, transcript), transcript };
}
