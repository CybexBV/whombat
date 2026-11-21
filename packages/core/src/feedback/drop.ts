/**
 * `@whombat/core/feedback/drop` — the encrypted feedback drop (Whombat `docs/decisions/feedback-drop.md` FD-07 …
 * FD-16, CT-91): HPKE (RFC 9180 base mode, `DHKEM(X25519, HKDF-SHA256)`, `HKDF-SHA256`, `AES-128-GCM`), the envelope
 * v1, site cards (Ed25519 over canonical JSON, pinned by `data-key`) and the derived report reference.
 *
 * Pure and Zod-free, so the widget frame can bundle it: `@noble/curves`, `@noble/hashes` and, for AES-GCM only, the
 * standard WebCrypto `crypto.subtle` (browsers in secure contexts, Node). Everything except sealing and opening is
 * synchronous and runs anywhere, React Native included; `hpke*Seal`/`*Open`, `sealDropEnvelope` and
 * `openDropEnvelope` need `crypto.subtle` and throw `HpkeError` `unsupported` without it.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { expand, extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson } from '../audit/canonical.js';
import { verifyEd25519Strict } from '../audit/crypto.js';
import type { FeedbackDropHeader, FeedbackSiteCard, SignedFeedbackSiteCard } from '../domain/feedback.js';
import { decodeUtf8OrNull } from '../text/utf8.js';
import { FEEDBACK_REFERENCE_ALPHABET } from './install.js';
import { normalizeOrigin } from './sanitize.js';

// ---------------------------------------------------------------------------------------------------------
// Constants

/** The one suite of envelope v1 (FD-13): KEM 0x0020, KDF 0x0001, AEAD 0x0001. */
export const FEEDBACK_DROP_SUITE = 'hpke-base-x25519-sha256-aes128gcm';
/** HPKE `info` of every drop (UTF-8). */
export const FEEDBACK_DROP_INFO = 'whombat-feedback-drop/1';
/** Envelope and card version. */
export const FEEDBACK_DROP_VERSION = 1;
/** `purpose` inside every signed site card (the domain separation of its signature). */
export const FEEDBACK_SITE_CARD_PURPOSE = 'whombat-feedback-site-card';
/** Domain separation of `feedbackReferenceFor` (followed by a NUL byte). */
export const FEEDBACK_REFERENCE_CONTEXT = 'whombat-feedback-reference/1';

/** Envelope header bounds (bytes of the canonical JSON header). */
export const FEEDBACK_DROP_HEADER_MIN = 16;
export const FEEDBACK_DROP_HEADER_MAX = 512;
/** Length of `enc` (an X25519 public key) and of the AEAD tag. */
export const FEEDBACK_DROP_ENC_BYTES = 32;
export const FEEDBACK_DROP_TAG_BYTES = 16;
/** The smallest padded plaintext (FD-14). */
export const FEEDBACK_DROP_MIN_PADDED = 4096;
/**
 * Room for what the drop plaintext adds around the `FeedbackSubmission` (`{v, submission, frame}`, CT-91): the frame
 * evidence is bounded (`FeedbackDropPlaintext`) well below this.
 */
export const FEEDBACK_DROP_WRAPPER_BYTES = 4096;
/** A signed card (`canonicalJson({card, sig})`, UTF-8) is at most this large (FD-10). */
export const FEEDBACK_CARD_MAX_BYTES = 16_384;
/** `expiresAt − issuedAt` of a card is at most 14 days (FD-12). */
export const FEEDBACK_CARD_MAX_LIFETIME_S = 1_209_600;
/** At most this many allowed origins per card (as per integration). */
export const FEEDBACK_CARD_MAX_ORIGINS = 20;

/** Key lifecycle in the runtime (FD-08, FD-11). */
export const FEEDBACK_DROP_KEY_ROTATE_S = 30 * 86_400;
export const FEEDBACK_DROP_KEY_RETAIN_S = 22 * 86_400;
/** A card is re-issued when it has less than this left. */
export const FEEDBACK_CARD_REISSUE_S = 7 * 86_400;

/** `data-key`: `fbk_` + base64url of the first 16 bytes of `sha256(signingPublicKey)` (FD-07). */
export const FEEDBACK_SITE_KEY_PATTERN = /^fbk_[A-Za-z0-9_-]{22}$/;
/** Encryption key id: `fdk_` + base64url of the first 12 bytes of `sha256(publicKey)` (FD-08). */
export const FEEDBACK_DROP_KID_PATTERN = /^fdk_[A-Za-z0-9_-]{16}$/;
const SITE_PATTERN = /^fbs_[A-Za-z0-9]{24}$/;

// ---------------------------------------------------------------------------------------------------------
// Errors

/**
 * - `malformed`: framing, header, padding or UTF-8 is wrong, the version or suite is unknown, or the header names
 *   another site than expected;
 * - `unknown_key`: no private key for the header's `kid`;
 * - `undecryptable`: the AEAD refused (wrong key, tampered header, `enc` or ciphertext);
 * - `too_large`: sealing would exceed the card's `maxEnvelopeBytes`.
 */
export type FeedbackDropErrorCode = 'malformed' | 'unknown_key' | 'undecryptable' | 'too_large';

export class FeedbackDropError extends Error {
  constructor(
    readonly code: FeedbackDropErrorCode,
    detail?: string,
  ) {
    super(detail ? `feedback drop ${code}: ${detail}` : `feedback drop ${code}`);
    this.name = 'FeedbackDropError';
  }
}

/** `invalid_key`: a key has the wrong length or is low order; `open_failed`: the AEAD refused. */
export type HpkeErrorCode = 'invalid_key' | 'open_failed' | 'unsupported';

export class HpkeError extends Error {
  constructor(
    readonly code: HpkeErrorCode,
    detail?: string,
  ) {
    super(detail ? `hpke ${code}: ${detail}` : `hpke ${code}`);
    this.name = 'HpkeError';
  }
}

// ---------------------------------------------------------------------------------------------------------
// Bytes: strict base64url (no padding, canonical trailing bits) and strict UTF-8, without Buffer, atob or TextDecoder

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < B64URL.length; i++) B64URL_INDEX[B64URL.charCodeAt(i)] = i;

function b64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out +=
      B64URL.charAt(n >> 18) +
      B64URL.charAt((n >> 12) & 63) +
      B64URL.charAt((n >> 6) & 63) +
      B64URL.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += B64URL.charAt(n >> 18) + B64URL.charAt((n >> 12) & 63);
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += B64URL.charAt(n >> 18) + B64URL.charAt((n >> 12) & 63) + B64URL.charAt((n >> 6) & 63);
  }
  return out;
}

/** Strict base64url decoding; null for anything else (padding, other characters, non-canonical trailing bits). */
function unb64(text: string): Uint8Array | null {
  const len = text.length;
  if (len % 4 === 1) return null;
  const val = (k: number) => {
    const c = text.charCodeAt(k);
    return c < 128 ? (B64URL_INDEX[c] as number) : -1;
  };
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 3 < len; i += 4) {
    const a = val(i);
    const b = val(i + 1);
    const c = val(i + 2);
    const d = val(i + 3);
    if ((a | b | c | d) < 0) return null;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = n >> 16;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  const rem = len - i;
  if (rem === 2) {
    const a = val(i);
    const b = val(i + 1);
    if ((a | b) < 0 || (b & 15) !== 0) return null;
    out[o++] = (a << 2) | (b >> 4);
  } else if (rem === 3) {
    const a = val(i);
    const b = val(i + 1);
    const c = val(i + 2);
    if ((a | b | c) < 0 || (c & 3) !== 0) return null;
    const n = (a << 18) | (b << 12) | (c << 6);
    out[o++] = n >> 16;
    out[o++] = (n >> 8) & 255;
  }
  return out;
}

/** A base64url string of exactly `n` bytes, decoded; null otherwise. */
function keyBytes(text: unknown, n: number): Uint8Array | null {
  if (typeof text !== 'string' || text.length !== Math.ceil((n * 4) / 3)) return null;
  const bytes = unb64(text);
  return bytes && bytes.length === n ? bytes : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(v, k));
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

// ---------------------------------------------------------------------------------------------------------
// HPKE, RFC 9180, base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM

const i2osp2 = (n: number) => new Uint8Array([(n >> 8) & 255, n & 255]);
const HPKE_V1 = utf8ToBytes('HPKE-v1');
const KEM_SUITE_ID = concatBytes(utf8ToBytes('KEM'), i2osp2(0x0020));
const HPKE_SUITE_ID = concatBytes(utf8ToBytes('HPKE'), i2osp2(0x0020), i2osp2(0x0001), i2osp2(0x0001));
const EMPTY = new Uint8Array(0);
const N_SK = 32;
const N_K = 16;
const N_N = 12;
const N_H = 32;

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array {
  return extract(sha256, concatBytes(HPKE_V1, suite, utf8ToBytes(label), ikm), salt);
}

function labeledExpand(
  suite: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
): Uint8Array {
  return expand(sha256, prk, concatBytes(i2osp2(length), HPKE_V1, suite, utf8ToBytes(label), info), length);
}

export interface HpkeKeyPair {
  /** 32-byte X25519 private key. */
  privateKey: Uint8Array;
  /** 32-byte X25519 public key. */
  publicKey: Uint8Array;
}

/** RFC 9180 §7.1.3 `DeriveKeyPair(ikm)` for X25519 (`ikm` at least 32 bytes). */
export function deriveKeyPair(ikm: Uint8Array): HpkeKeyPair {
  if (!(ikm instanceof Uint8Array) || ikm.length < N_SK)
    throw new HpkeError('invalid_key', 'ikm must be at least 32 bytes');
  const prk = labeledExtract(KEM_SUITE_ID, EMPTY, 'dkp_prk', ikm);
  const privateKey = labeledExpand(KEM_SUITE_ID, prk, 'sk', EMPTY, N_SK);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32)
    throw new HpkeError('invalid_key', 'private keys are 32 bytes');
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32)
    throw new HpkeError('invalid_key', 'public keys are 32 bytes');
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(privateKey, publicKey);
  } catch (e) {
    throw new HpkeError('invalid_key', e instanceof Error ? e.message : 'X25519 refused the key');
  }
  // RFC 9180 §7.1.4 / RFC 7748 §6.1: the all-zero output is refused (noble already throws; kept as a guard).
  if (shared.every((b) => b === 0)) throw new HpkeError('invalid_key', 'all-zero shared secret');
  return shared;
}

function extractAndExpand(dhOut: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const prk = labeledExtract(KEM_SUITE_ID, EMPTY, 'eae_prk', dhOut);
  return labeledExpand(KEM_SUITE_ID, prk, 'shared_secret', kemContext, 32);
}

/** An HPKE context after setup (base mode); `seq` of every seal/open is the caller's. */
export interface HpkeContext {
  readonly sharedSecret: Uint8Array;
  readonly key: Uint8Array;
  readonly baseNonce: Uint8Array;
  readonly exporterSecret: Uint8Array;
}

export interface HpkeSenderContext extends HpkeContext {
  /** The encapsulated key (the ephemeral X25519 public key). */
  readonly enc: Uint8Array;
}

function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): HpkeContext {
  const pskIdHash = labeledExtract(HPKE_SUITE_ID, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE_ID, EMPTY, 'info_hash', info);
  const context = concatBytes(new Uint8Array([0x00]), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE_ID, sharedSecret, 'secret', EMPTY);
  return {
    sharedSecret,
    key: labeledExpand(HPKE_SUITE_ID, secret, 'key', context, N_K),
    baseNonce: labeledExpand(HPKE_SUITE_ID, secret, 'base_nonce', context, N_N),
    exporterSecret: labeledExpand(HPKE_SUITE_ID, secret, 'exp', context, N_H),
  };
}

/** `SetupBaseS(pkR, info)`; `ikmE` (≥ 32 bytes) makes the ephemeral key deterministic (test vectors only). */
export function hpkeSetupBaseS(
  publicKeyR: Uint8Array,
  info: Uint8Array,
  ikmE?: Uint8Array,
): HpkeSenderContext {
  const ephemeral = deriveKeyPair(ikmE ?? randomBytes(32));
  const dhOut = dh(ephemeral.privateKey, publicKeyR);
  const enc = ephemeral.publicKey;
  const shared = extractAndExpand(dhOut, concatBytes(enc, publicKeyR));
  return { enc, ...keySchedule(shared, info) };
}

/** `SetupBaseR(enc, skR, info)`. */
export function hpkeSetupBaseR(enc: Uint8Array, privateKeyR: Uint8Array, info: Uint8Array): HpkeContext {
  const dhOut = dh(privateKeyR, enc);
  const publicKeyR = x25519.getPublicKey(privateKeyR);
  const shared = extractAndExpand(dhOut, concatBytes(enc, publicKeyR));
  return keySchedule(shared, info);
}

/** `ComputeNonce(seq)`: `base_nonce XOR I2OSP(seq, Nn)`. */
function nonceFor(baseNonce: Uint8Array, seq: number): Uint8Array {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new RangeError('seq must be a non-negative safe integer');
  const nonce = baseNonce.slice();
  let rest = seq;
  for (let i = N_N - 1; i >= 0 && rest > 0; i--) {
    nonce[i] = (nonce[i] as number) ^ (rest % 256);
    rest = Math.floor(rest / 256);
  }
  return nonce;
}

interface AesGcmParams {
  name: 'AES-GCM';
  iv: Uint8Array;
  additionalData: Uint8Array;
  tagLength: 128;
}
interface SubtleLike {
  importKey(
    format: 'raw',
    key: Uint8Array,
    algorithm: { name: 'AES-GCM' },
    extractable: false,
    usages: ('encrypt' | 'decrypt')[],
  ): Promise<unknown>;
  encrypt(params: AesGcmParams, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(params: AesGcmParams, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

function subtle(): SubtleLike {
  const s = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
  if (!s) throw new HpkeError('unsupported', 'WebCrypto (crypto.subtle) is not available');
  return s;
}

/** `ContextS.Seal(aad, pt)` at sequence number `seq`. */
export async function hpkeContextSeal(
  ctx: HpkeContext,
  seq: number,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const s = subtle();
  const key = await s.importKey('raw', ctx.key, { name: 'AES-GCM' }, false, ['encrypt']);
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: nonceFor(ctx.baseNonce, seq),
    additionalData: aad,
    tagLength: 128,
  };
  return new Uint8Array(await s.encrypt(params, key, plaintext));
}

/** `ContextR.Open(aad, ct)` at sequence number `seq`; `HpkeError` `open_failed` when the AEAD refuses. */
export async function hpkeContextOpen(
  ctx: HpkeContext,
  seq: number,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const s = subtle();
  if (ciphertext.length < FEEDBACK_DROP_TAG_BYTES) throw new HpkeError('open_failed', 'shorter than the tag');
  const key = await s.importKey('raw', ctx.key, { name: 'AES-GCM' }, false, ['decrypt']);
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: nonceFor(ctx.baseNonce, seq),
    additionalData: aad,
    tagLength: 128,
  };
  try {
    return new Uint8Array(await s.decrypt(params, key, ciphertext));
  } catch {
    throw new HpkeError('open_failed');
  }
}

/** `Context.Export(exporter_context, L)`. */
export function hpkeExport(ctx: HpkeContext, exporterContext: Uint8Array, length: number): Uint8Array {
  return labeledExpand(HPKE_SUITE_ID, ctx.exporterSecret, 'sec', exporterContext, length);
}

/** Single-shot `SealBase(pkR, info, aad, pt)` (sequence 0). `ikmE` for test vectors only. */
export async function hpkeSealBase(
  publicKeyR: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  ikmE?: Uint8Array,
): Promise<{ enc: Uint8Array; ciphertext: Uint8Array }> {
  const ctx = hpkeSetupBaseS(publicKeyR, info, ikmE);
  return { enc: ctx.enc, ciphertext: await hpkeContextSeal(ctx, 0, aad, plaintext) };
}

/** Single-shot `OpenBase(enc, skR, info, aad, ct)` (sequence 0). */
export async function hpkeOpenBase(
  enc: Uint8Array,
  privateKeyR: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  return hpkeContextOpen(hpkeSetupBaseR(enc, privateKeyR, info), 0, aad, ciphertext);
}

// ---------------------------------------------------------------------------------------------------------
// Keys

/** 32 key bytes from bytes or base64url; a `TypeError` otherwise. */
function key32(input: Uint8Array | string, what: string): Uint8Array {
  const key = typeof input === 'string' ? keyBytes(input, 32) : input;
  if (key instanceof Uint8Array && key.length === 32) return key;
  throw new TypeError(`Expected a 32-byte ${what}`);
}

/** `fbk_…`, the `data-key` pin of a signing key (base64url string or 32 bytes). */
export function siteKeyFingerprint(signingPublicKey: Uint8Array | string): string {
  return `fbk_${b64(sha256(key32(signingPublicKey, 'Ed25519 public key')).subarray(0, 16))}`;
}

/** `fdk_…`, the key id of an X25519 encryption key (base64url string or 32 bytes). */
export function dropKeyId(publicKey: Uint8Array | string): string {
  return `fdk_${b64(sha256(key32(publicKey, 'X25519 public key')).subarray(0, 12))}`;
}

/** A new X25519 encryption key pair with its `kid` and the public key as a card carries it. */
export function generateDropKeyPair(): HpkeKeyPair & { kid: string; publicKeyB64: string } {
  const { privateKey, publicKey } = deriveKeyPair(randomBytes(32));
  return { privateKey, publicKey, kid: dropKeyId(publicKey), publicKeyB64: b64(publicKey) };
}

/** A new Ed25519 site signing key: the 32-byte seed, the public key as a card carries it, and the `data-key` pin. */
export function generateSiteSigningKey(): { seed: Uint8Array; publicKey: string; fingerprint: string } {
  return siteSigningKeyOf(randomBytes(32));
}

/** The public key (base64url) and pin of a signing seed. */
export function siteSigningKeyOf(seed: Uint8Array): {
  seed: Uint8Array;
  publicKey: string;
  fingerprint: string;
} {
  if (!(seed instanceof Uint8Array) || seed.length !== 32)
    throw new TypeError('Expected a 32-byte Ed25519 seed');
  const pub = ed25519.getPublicKey(seed);
  return { seed, publicKey: b64(pub), fingerprint: siteKeyFingerprint(pub) };
}

/** The public key of an X25519 private key, base64url (what `card.encryption.publicKey` carries). */
export function dropPublicKeyOf(privateKey: Uint8Array): string {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32)
    throw new TypeError('Expected a 32-byte X25519 private key');
  return b64(x25519.getPublicKey(privateKey));
}

// ---------------------------------------------------------------------------------------------------------
// Site cards (FD-10, FD-12)

export type SiteCardError =
  | 'bad_card'
  | 'too_large'
  | 'wrong_key'
  | 'wrong_site'
  | 'bad_signature'
  | 'expired';

const CARD_KEYS = [
  'purpose',
  'v',
  'site',
  'seq',
  'issuedAt',
  'expiresAt',
  'allowedOrigins',
  'config',
  'limits',
  'encryption',
  'signingKey',
] as const;
/** Bounds of `card.limits` (those of `FeedbackLimits`; the envelope cap up to the hard cap). */
const limitBounds = (): Record<string, readonly [number, number]> => ({
  maxEnvelopeBytes: [1, FEEDBACK_DROP_MAX_ENVELOPE_BYTES],
  reportsPerHour: [1, 1000],
  reportsPerDay: [1, 10_000],
  perSourcePerHour: [1, 100],
});

/** Structural check of a card (what the Zod `FeedbackSiteCard` also checks, minus the config's inside). */
function cardShapeOk(card: unknown): card is FeedbackSiteCard {
  if (!isPlainObject(card) || !hasExactKeys(card, CARD_KEYS)) return false;
  if (card.purpose !== FEEDBACK_SITE_CARD_PURPOSE || card.v !== FEEDBACK_DROP_VERSION) return false;
  if (typeof card.site !== 'string' || !SITE_PATTERN.test(card.site)) return false;
  if (!isInt(card.seq, 1, Number.MAX_SAFE_INTEGER)) return false;
  if (!isInt(card.issuedAt, 0, Number.MAX_SAFE_INTEGER) || !isInt(card.expiresAt, 0, Number.MAX_SAFE_INTEGER))
    return false;
  if (card.expiresAt <= card.issuedAt || card.expiresAt - card.issuedAt > FEEDBACK_CARD_MAX_LIFETIME_S)
    return false;
  const origins = card.allowedOrigins;
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > FEEDBACK_CARD_MAX_ORIGINS)
    return false;
  if (!origins.every((o) => typeof o === 'string' && normalizeOrigin(o) === o)) return false;
  if (new Set(origins).size !== origins.length) return false;
  if (!isPlainObject(card.config)) return false;
  const limits = card.limits;
  const bounds = limitBounds();
  if (!isPlainObject(limits) || !hasExactKeys(limits, Object.keys(bounds))) return false;
  for (const [k, [min, max]] of Object.entries(bounds)) if (!isInt(limits[k], min, max)) return false;
  const enc = card.encryption;
  if (!isPlainObject(enc) || !hasExactKeys(enc, ['suite', 'kid', 'publicKey'])) return false;
  if (enc.suite !== FEEDBACK_DROP_SUITE) return false;
  const pub = keyBytes(enc.publicKey, 32);
  if (!pub || typeof enc.kid !== 'string' || enc.kid !== dropKeyId(pub)) return false;
  return keyBytes(card.signingKey, 32) !== null;
}

/** The bytes a card's signature covers: UTF-8 of `canonicalJson(card)`. */
export function siteCardSigningBytes(card: FeedbackSiteCard): Uint8Array {
  return utf8ToBytes(canonicalJson(card));
}

function signedCardBytes(signed: { card: unknown; sig: unknown }): number {
  return utf8ToBytes(canonicalJson(signed)).length;
}

/**
 * Signs a card with the runtime's signing seed. Throws a `TypeError` when the card is malformed, when `signingKey`
 * isn't the seed's public key, or when the signed card would exceed `FEEDBACK_CARD_MAX_BYTES`.
 */
export function signSiteCard(card: FeedbackSiteCard, signingSeed: Uint8Array): SignedFeedbackSiteCard {
  const { publicKey } = siteSigningKeyOf(signingSeed);
  if (!cardShapeOk(card)) throw new TypeError('Malformed feedback site card');
  if (card.signingKey !== publicKey)
    throw new TypeError('card.signingKey is not the public key of this seed');
  const signed = { card, sig: b64(ed25519.sign(siteCardSigningBytes(card), signingSeed)) };
  if (signedCardBytes(signed) > FEEDBACK_CARD_MAX_BYTES) throw new TypeError('The signed card is too large');
  return signed;
}

export type SiteCardVerification = { ok: true; card: FeedbackSiteCard } | { ok: false; error: SiteCardError };

/**
 * Verifies a signed card: its shape (`bad_card`), size (`too_large`), the `data-key` pin (`wrong_key`, when
 * `expectedKey` is given), the site (`wrong_site`, when `options.site` is given), the strict Ed25519 signature by
 * `card.signingKey` (`bad_signature`), and expiry (`expired`, only when `options.now` in epoch seconds is given: the
 * frame doesn't check times, FD-28). The card's `config` is only checked to be an object here; control and the
 * runtime parse the whole card with `SignedFeedbackSiteCard`, the frame checks the config as it does in direct mode.
 */
export function verifySiteCard(
  signed: unknown,
  expectedKey?: string | null,
  options: { site?: string; now?: number } = {},
): SiteCardVerification {
  const fail = (error: SiteCardError): SiteCardVerification => ({ ok: false, error });
  if (!isPlainObject(signed) || !hasExactKeys(signed, ['card', 'sig'])) return fail('bad_card');
  const sig = keyBytes(signed.sig, 64);
  if (!sig || !cardShapeOk(signed.card)) return fail('bad_card');
  const card = signed.card;
  let size: number;
  let message: Uint8Array;
  try {
    size = signedCardBytes(signed as { card: unknown; sig: unknown });
    message = siteCardSigningBytes(card);
  } catch {
    return fail('bad_card');
  }
  if (size > FEEDBACK_CARD_MAX_BYTES) return fail('too_large');
  if (expectedKey != null && siteKeyFingerprint(card.signingKey) !== expectedKey) return fail('wrong_key');
  if (options.site !== undefined && card.site !== options.site) return fail('wrong_site');
  const key = keyBytes(card.signingKey, 32) as Uint8Array;
  if (!verifyEd25519Strict(sig, message, key)) return fail('bad_signature');
  if (options.now !== undefined && card.expiresAt <= options.now) return fail('expired');
  return { ok: true, card };
}

// ---------------------------------------------------------------------------------------------------------
// Envelope v1 (FD-14)

/** Padded plaintext length for `n` bytes (`4 + L`): ≤ 4 KiB → 4 KiB; ≤ 64 KiB → multiple of 16 KiB; else of 256 KiB. */
export function padLength(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('padLength takes a non-negative integer');
  if (n <= FEEDBACK_DROP_MIN_PADDED) return FEEDBACK_DROP_MIN_PADDED;
  if (n <= 65_536) return Math.ceil(n / 16_384) * 16_384;
  return Math.ceil(n / 262_144) * 262_144;
}

const envelopeOverhead = 2 + FEEDBACK_DROP_HEADER_MAX + FEEDBACK_DROP_ENC_BYTES + FEEDBACK_DROP_TAG_BYTES;

/**
 * The largest envelope a submission body of `bodyCap` bytes can produce (the card's `maxEnvelopeBytes`): the longest
 * header, `enc`, the tag and the padded plaintext with room for the drop wrapper (`FEEDBACK_DROP_WRAPPER_BYTES`).
 */
export function dropEnvelopeCap(bodyCap: number): number {
  return envelopeOverhead + padLength(4 + bodyCap + FEEDBACK_DROP_WRAPPER_BYTES);
}

/** `dropEnvelopeCap(FEEDBACK_MAX_BODY_BYTES)` (32 MiB): no card may allow more, control's hard cap (FD-18). */
export const FEEDBACK_DROP_MAX_ENVELOPE_BYTES = dropEnvelopeCap(32 * 1024 * 1024);

/** `u32be L ‖ UTF-8 JSON ‖ zeros` up to `padLength(4 + L)`. */
export function encodeDropPlaintext(plaintextJson: string): Uint8Array {
  const body = utf8ToBytes(plaintextJson);
  const out = new Uint8Array(padLength(4 + body.length));
  const L = body.length;
  out[0] = (L >>> 24) & 255;
  out[1] = (L >>> 16) & 255;
  out[2] = (L >>> 8) & 255;
  out[3] = L & 255;
  out.set(body, 4);
  return out;
}

/** The JSON text of a padded plaintext; `malformed` unless the length is exact, the padding zero and the UTF-8 valid. */
export function decodeDropPlaintext(padded: Uint8Array): string {
  if (padded.length < 4) throw new FeedbackDropError('malformed', 'plaintext too short');
  const L =
    (((padded[0] as number) << 24) >>> 0) +
    ((padded[1] as number) << 16) +
    ((padded[2] as number) << 8) +
    (padded[3] as number);
  if (4 + L > padded.length || padLength(4 + L) !== padded.length)
    throw new FeedbackDropError('malformed', 'padding length');
  for (let i = 4 + L; i < padded.length; i++)
    if (padded[i] !== 0) throw new FeedbackDropError('malformed', 'padding not zero');
  const text = decodeUtf8OrNull(padded.subarray(4, 4 + L));
  if (text === null) throw new FeedbackDropError('malformed', 'invalid UTF-8');
  return text;
}

function headerOk(h: unknown): h is FeedbackDropHeader {
  return (
    isPlainObject(h) &&
    hasExactKeys(h, ['kid', 'site', 'suite', 'v']) &&
    typeof h.kid === 'string' &&
    FEEDBACK_DROP_KID_PATTERN.test(h.kid) &&
    typeof h.site === 'string' &&
    SITE_PATTERN.test(h.site) &&
    h.suite === FEEDBACK_DROP_SUITE &&
    h.v === FEEDBACK_DROP_VERSION
  );
}

/** The header bytes (canonical JSON, the AAD) of `{kid, site, suite, v}`. */
export function encodeDropHeader(header: FeedbackDropHeader): Uint8Array {
  const h = { kid: header.kid, site: header.site, suite: header.suite, v: header.v };
  if (!headerOk(h)) throw new FeedbackDropError('malformed', 'header');
  return utf8ToBytes(canonicalJson(h));
}

export interface FeedbackDropEnvelopeParts {
  header: FeedbackDropHeader;
  /** The exact header bytes (the AAD). */
  headerBytes: Uint8Array;
  /** 32 bytes. */
  enc: Uint8Array;
  /** AEAD output, tag included. */
  ciphertext: Uint8Array;
}

/**
 * Splits an envelope and checks everything readable without a key (what control checks before storing, FD-17):
 * framing, `16 ≤ H ≤ 512`, a header that is exactly the canonical JSON of `{kid, site, suite, v: 1}` with the known
 * suite, and a ciphertext whose length is a padding bucket plus the tag. `FeedbackDropError` `malformed` otherwise.
 */
export function parseDropHeader(envelope: Uint8Array): FeedbackDropEnvelopeParts {
  if (!(envelope instanceof Uint8Array) || envelope.length < 2)
    throw new FeedbackDropError('malformed', 'framing');
  const H = ((envelope[0] as number) << 8) | (envelope[1] as number);
  if (H < FEEDBACK_DROP_HEADER_MIN || H > FEEDBACK_DROP_HEADER_MAX)
    throw new FeedbackDropError('malformed', 'header length');
  const ctStart = 2 + H + FEEDBACK_DROP_ENC_BYTES;
  const ctLength = envelope.length - ctStart;
  const padded = ctLength - FEEDBACK_DROP_TAG_BYTES;
  if (padded < FEEDBACK_DROP_MIN_PADDED || padLength(padded) !== padded)
    throw new FeedbackDropError('malformed', 'ciphertext length');
  const headerBytes = envelope.subarray(2, 2 + H);
  const text = decodeUtf8OrNull(headerBytes);
  let header: unknown;
  try {
    header = text === null ? null : JSON.parse(text);
  } catch {
    header = null;
  }
  if (!headerOk(header)) throw new FeedbackDropError('malformed', 'header');
  if (canonicalJson(header) !== text) throw new FeedbackDropError('malformed', 'header not canonical');
  return {
    header,
    headerBytes,
    enc: envelope.subarray(2 + H, ctStart),
    ciphertext: envelope.subarray(ctStart),
  };
}

/**
 * Seals `plaintextJson` (the JSON text of a `FeedbackDropPlaintext`) to a verified card's encryption key. Seal once
 * per draft and resend the same bytes on every retry (FD-28). `ikmE` (32 bytes) fixes the ephemeral key, for test
 * vectors only. `FeedbackDropError` `too_large` when the envelope would exceed `card.limits.maxEnvelopeBytes`.
 */
export async function sealDropEnvelope(
  card: FeedbackSiteCard,
  plaintextJson: string,
  ikmE?: Uint8Array,
): Promise<Uint8Array> {
  const publicKey = keyBytes(card.encryption.publicKey, 32);
  if (card.encryption.suite !== FEEDBACK_DROP_SUITE || !publicKey)
    throw new FeedbackDropError('malformed', 'card encryption');
  const headerBytes = encodeDropHeader({
    kid: card.encryption.kid,
    site: card.site,
    suite: FEEDBACK_DROP_SUITE,
    v: FEEDBACK_DROP_VERSION,
  });
  const plaintext = encodeDropPlaintext(plaintextJson);
  const size = 2 + headerBytes.length + FEEDBACK_DROP_ENC_BYTES + plaintext.length + FEEDBACK_DROP_TAG_BYTES;
  if (size > card.limits.maxEnvelopeBytes) throw new FeedbackDropError('too_large');
  const { enc, ciphertext } = await hpkeSealBase(
    publicKey,
    utf8ToBytes(FEEDBACK_DROP_INFO),
    headerBytes,
    plaintext,
    ikmE,
  );
  const out = new Uint8Array(size);
  out[0] = headerBytes.length >> 8;
  out[1] = headerBytes.length & 255;
  out.set(headerBytes, 2);
  out.set(enc, 2 + headerBytes.length);
  out.set(ciphertext, 2 + headerBytes.length + FEEDBACK_DROP_ENC_BYTES);
  return out;
}

/**
 * Opens an envelope (the runtime, FD-23). `privateKeyFor(kid)` returns the X25519 private key or null. Checks, in
 * FD-23's order: framing and header (`malformed`), the key (`unknown_key`), the AEAD (`undecryptable`), then the
 * header's site against `options.site` and the padding (`malformed`). Returns the header and the plaintext JSON text
 * (not parsed: the runtime runs its own shape checks first).
 */
export async function openDropEnvelope(
  envelope: Uint8Array,
  privateKeyFor: (kid: string) => Uint8Array | null | undefined | Promise<Uint8Array | null | undefined>,
  options: { site?: string } = {},
): Promise<{ header: FeedbackDropHeader; plaintextJson: string }> {
  const parts = parseDropHeader(envelope);
  const privateKey = await privateKeyFor(parts.header.kid);
  if (!privateKey) throw new FeedbackDropError('unknown_key');
  let padded: Uint8Array;
  try {
    padded = await hpkeOpenBase(
      parts.enc,
      privateKey,
      utf8ToBytes(FEEDBACK_DROP_INFO),
      parts.headerBytes,
      parts.ciphertext,
    );
  } catch (e) {
    if (e instanceof HpkeError && e.code === 'unsupported') throw e;
    throw new FeedbackDropError('undecryptable');
  }
  if (options.site !== undefined && parts.header.site !== options.site)
    throw new FeedbackDropError('malformed', 'header names another site');
  return { header: parts.header, plaintextJson: decodeDropPlaintext(padded) };
}

// ---------------------------------------------------------------------------------------------------------
// Reference (FD-16)

/**
 * The report reference of a dropped submission, derived so the frame can show it before the appliance has the
 * report: `FB-XXXX-XXXX` from the first 8 bytes of `sha256("whombat-feedback-reference/1\0" ‖ site ‖ "\0" ‖
 * submissionId)`, each byte's low 5 bits mapped like `newFeedbackReference` (40 bits).
 */
export function feedbackReferenceFor(site: string, submissionId: string): string {
  const digest = sha256(
    concatBytes(
      utf8ToBytes(FEEDBACK_REFERENCE_CONTEXT),
      new Uint8Array([0]),
      utf8ToBytes(site),
      new Uint8Array([0]),
      utf8ToBytes(submissionId),
    ),
  );
  let body = '';
  for (const b of digest.subarray(0, 8)) body += FEEDBACK_REFERENCE_ALPHABET[b & 31];
  return `FB-${body.slice(0, 4)}-${body.slice(4)}`;
}
