/**
 * Random ids for requests. `crypto.getRandomValues` exists in browsers, Node and (polyfilled from expo-crypto,
 * apps/mobile/src/polyfills.ts) Hermes.
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Crockford-style base32 of `bytes`, most significant bit first. */
export function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** `req_` + 26 base32 characters (128 random bits). Idempotency keys (MA-09): unguessable, never reused. */
export function newRequestId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `req_${base32(bytes)}`;
}
