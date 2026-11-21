/**
 * The claim alphabet's rules, shared by the console claim code (`code.ts`, CC-01, CT-58) and the screen sign-in's
 * letters (`screen.ts`, BX-04, CT-620). Not exported from the index: each code names its own length and shape.
 */

/** 20 letters: no I L O S U Z (they read as 1 1 0 5 V 2). */
export const CLAIM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRTVWXY';

/**
 * Characters removed from a typed code: Unicode White_Space, U+FEFF and `-` (the same set as `normalizeClaimSecret`,
 * NX-24).
 */
const TYPED_CODE_DROP = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff-]/g;

/** ASCII upper-case (`a–z` only), then drop `TYPED_CODE_DROP`. Nothing else is repaired. */
export function foldTypedCode(input: string): string {
  return input
    .replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32))
    .replace(TYPED_CODE_DROP, '');
}

/**
 * `count` letters from a CSPRNG, without modulo bias (CT-58): bytes are consumed in order; a byte `b < 240` (= 12 × 20)
 * gives `CLAIM_CODE_ALPHABET[b % 20]`, a byte ≥ 240 is skipped. `randomBytes(n)` is asked for `count` bytes, then for as
 * many as letters are still missing, so a byte stream gives the same letters in every implementation.
 */
export function drawAlphabetLetters(count: number, randomBytes: (n: number) => Uint8Array): string {
  let letters = '';
  for (let draws = 0; letters.length < count; draws++) {
    if (draws > 64) throw new Error('randomness source keeps returning bytes ≥ 240');
    const need = count - letters.length;
    const bytes = randomBytes(need);
    if (bytes.length !== need) throw new Error('randomBytes returned the wrong length');
    for (const b of bytes) if (b < 240) letters += CLAIM_CODE_ALPHABET[b % 20];
  }
  return letters;
}
