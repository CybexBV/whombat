/**
 * A box's own-address label (docs/decisions/own-address.md): three different words of `OWN_ADDRESS_WORDS`, joined by
 * hyphens, such as `maple-otter-river`. The box draws it once; control checks it before it registers it. Pure: the
 * caller brings the random numbers (`crypto.randomInt` on the box).
 */
import { OWN_ADDRESS_WORDS, OWN_ADDRESS_WORDS_RETIRED } from './words.js';

export { OWN_ADDRESS_WORDS, OWN_ADDRESS_WORDS_RETIRED };

/** A label's shape: three words of 3–10 lower-case letters, joined by hyphens (`@whombat/protocol` has the same). */
const LABEL_SHAPE = /^([a-z]{3,10})-([a-z]{3,10})-([a-z]{3,10})$/;

const ACCEPTED: ReadonlySet<string> = new Set([...OWN_ADDRESS_WORDS, ...OWN_ADDRESS_WORDS_RETIRED]);

/** The shape, three different words, each in `OWN_ADDRESS_WORDS` or `OWN_ADDRESS_WORDS_RETIRED`. */
export function isOwnAddressLabel(label: string): boolean {
  const m = LABEL_SHAPE.exec(label);
  if (!m) return false;
  const words = [m[1], m[2], m[3]] as [string, string, string];
  if (words[0] === words[1] || words[0] === words[2] || words[1] === words[2]) return false;
  return words.every((w) => ACCEPTED.has(w));
}

/**
 * Three different words of `OWN_ADDRESS_WORDS`, each draw uniform, joined by hyphens. `randomInt(n)` must return a
 * uniform integer in [0, n) (throws otherwise). Retired words are never drawn.
 */
export function drawOwnAddressLabel(randomInt: (n: number) => number): string {
  const words = OWN_ADDRESS_WORDS;
  const pick = (n: number): number => {
    const i = randomInt(n);
    if (!Number.isInteger(i) || i < 0 || i >= n)
      throw new Error('randomInt returned a number outside [0, n)');
    return i;
  };
  const n = words.length;
  const a = pick(n);
  // Each later draw picks among the words not yet taken, then skips over the taken ones in order.
  let b = pick(n - 1);
  if (b >= a) b += 1;
  let c = pick(n - 2);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  if (c >= lo) c += 1;
  if (c >= hi) c += 1;
  return `${words[a]}-${words[b]}-${words[c]}`;
}
