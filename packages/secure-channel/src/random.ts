import { NoSecureRandomError } from './errors.js';

const PROBE_BYTES = 64;
/** A uniform 64-byte draw has ~56 distinct values; fewer than 16 has probability far below 2^-128. */
const MIN_DISTINCT = 16;

function suspicious(sample: Uint8Array): boolean {
  if (new Set(sample).size < MIN_DISTINCT) return true;
  // Counters and other arithmetic progressions (b[i+1] - b[i] constant mod 256).
  const step = ((sample[1] ?? 0) - (sample[0] ?? 0)) & 0xff;
  let progression = true;
  for (let i = 2; i < sample.length && progression; i++) {
    progression = (((sample[i] ?? 0) - (sample[i - 1] ?? 0)) & 0xff) === step;
  }
  return progression;
}

/**
 * Fail closed unless a plausible CSPRNG is installed as `globalThis.crypto.getRandomValues` (browsers, Node 24,
 * and React Native only after `expo-crypto`/`react-native-get-random-values` is installed). Every key and every
 * Noise ephemeral in this package comes from that source (via @noble or WebCrypto).
 *
 * The self-test draws two 64-byte samples and rejects a missing function, equal draws, a constant or
 * low-diversity draw, and counter-like progressions. It catches broken or stubbed polyfills; it cannot prove
 * that a source is cryptographically strong (a seeded PRNG passes).
 */
export function assertSecureRandom(): void {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (typeof c?.getRandomValues !== 'function') throw new NoSecureRandomError();
  const a = new Uint8Array(PROBE_BYTES);
  const b = new Uint8Array(PROBE_BYTES);
  try {
    c.getRandomValues(a);
    c.getRandomValues(b);
  } catch {
    throw new NoSecureRandomError();
  }
  if (suspicious(a) || suspicious(b) || a.every((x, i) => x === b[i])) throw new NoSecureRandomError();
}
