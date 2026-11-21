/**
 * The console claim code (MA-22, CC-01, CT-58): `LL-NNNN-LL`. `NNNN` is the lookup number control leases to an
 * unclaimed device (4–6 digits, no secret); the four `L` are the secret letters the appliance draws and shows only
 * on its console. The PAKE password (CC-06) is the four letters in order.
 */
import { z } from 'zod';
import { drawAlphabetLetters, foldTypedCode } from './alphabet.js';

// `CLAIM_CODE_ALPHABET`: 20 letters, no I L O S U Z. Four of them: 20⁴ = 160,000 codes (≈ 17.3 bits).
export { CLAIM_CODE_ALPHABET } from './alphabet.js';
export const CLAIM_LETTERS_LENGTH = 4;

/** Lookup number leased by control (`claim.lookup`): 4 decimal digits, up to 6 as the pool grows. A string. */
export const ClaimLookup = z.string().regex(/^[0-9]{4,6}$/);
export type ClaimLookup = z.infer<typeof ClaimLookup>;
/** The four secret letters, in order (the `code` method's PAKE password). */
export const ClaimLetters = z.string().regex(/^[ABCDEFGHJKMNPQRTVWXY]{4}$/);
export type ClaimLetters = z.infer<typeof ClaimLetters>;
/** The display form `L1L2-NNNN-L3L4` (`formatClaimCode`), as on the console. */
export const ClaimCode = z.string().regex(/^[ABCDEFGHJKMNPQRTVWXY]{2}-[0-9]{4,6}-[ABCDEFGHJKMNPQRTVWXY]{2}$/);
export type ClaimCode = z.infer<typeof ClaimCode>;

/** How a claim is authenticated (CC-02): the console letters, or the factory card's 26-character secret. */
export const ClaimMethod = z.enum(['code', 'card']);
export type ClaimMethod = z.infer<typeof ClaimMethod>;

const LETTERS_ONLY = /^[ABCDEFGHJKMNPQRTVWXY]{4}$/;
const FULL_CODE = /^([ABCDEFGHJKMNPQRTVWXY]{2})([0-9]{4,6})([ABCDEFGHJKMNPQRTVWXY]{2})$/;

/** `letters`: only the four letters were typed (the box was found nearby); `code`: the whole code. */
export type NormalizedClaimCode =
  | { kind: 'letters'; letters: ClaimLetters }
  | { kind: 'code'; letters: ClaimLetters; lookup: ClaimLookup }
  | { kind: 'invalid' };

/**
 * Typed input → claim code (CC-01): ASCII upper-case (`a–z` only); drop Unicode White_Space, U+FEFF and `-`; the
 * result must be 4 letters, or 2 letters + 4–6 digits + 2 letters, all letters from `CLAIM_CODE_ALPHABET`. Nothing is
 * repaired: a letter outside the alphabet (`O`, `I`, `S`, …) or a digit among the letters makes it `invalid`.
 */
export function normalizeClaimCode(input: string): NormalizedClaimCode {
  const s = foldTypedCode(input);
  if (LETTERS_ONLY.test(s)) return { kind: 'letters', letters: s };
  const m = FULL_CODE.exec(s);
  if (m) return { kind: 'code', letters: `${m[1]}${m[3]}`, lookup: m[2] as string };
  return { kind: 'invalid' };
}

/** `KX` + `4821` + `QM` → `KX-4821-QM`. Throws on letters or a lookup outside the contract. */
export function formatClaimCode(letters: string, lookup: string): ClaimCode {
  if (!LETTERS_ONLY.test(letters)) throw new Error('not claim letters');
  if (!ClaimLookup.safeParse(lookup).success) throw new Error('not a claim lookup number');
  return `${letters.slice(0, 2)}-${lookup}-${letters.slice(2)}`;
}

/**
 * Four letters from a CSPRNG, without modulo bias (CT-58): bytes are consumed in order; a byte `b < 240` (= 12 × 20)
 * gives `CLAIM_CODE_ALPHABET[b % 20]`, a byte ≥ 240 is skipped. `randomBytes(n)` is asked for 4 bytes, then for as
 * many as letters are still missing, so a byte stream gives the same letters in every implementation (Go
 * `protocol.GenerateClaimLetters`). Pass `crypto.getRandomValues`-backed randomness.
 */
export function generateClaimLetters(randomBytes: (n: number) => Uint8Array): ClaimLetters {
  return drawAlphabetLetters(CLAIM_LETTERS_LENGTH, randomBytes);
}
