/**
 * Untrusted or owner-written text inside a Whombat block (`[[memory …]]`, `[[vault …]]`, `[[report …]]`, BP-07):
 * whatever tag a `[[` run would open or close, it can't. The same normalisation as the browser's page text (server
 * `browser/data.ts`, BT-07) — one implementation for the reports (feedback.md, review-3 NEW-4), skills, memory and
 * Vault entries (skills-library.md SL-D55).
 */

/** Double brackets that read like `[[` / `]]` to a model and that NFKC leaves alone. */
const DOUBLE_OPENERS = /[⟦〚]/gu;
const DOUBLE_CLOSERS = /[⟧〛]/gu;

/** Single brackets that read like `[` / `]` to a model and that NFKC leaves alone. */
const OPENER_LOOKALIKES = /[【〔⁅❲⦋⦍⦏⦗〘〖⎡⎣⌈⌊﹝]/gu;
const CLOSER_LOOKALIKES = /[】〕⁆❳⦌⦎⦐⦘〙〗⎤⎦⌉⌋﹞]/gu;

/**
 * Invisible characters: format characters (zero-width spaces and joiners, word joiner, bidi controls, soft hyphen,
 * BOM …) and every other default-ignorable code point (variation selectors, Hangul fillers, tag characters …).
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Two or more `[` in a row, with anything between them that doesn't show or doesn't separate them to a reader:
 * whitespace, combining marks (`[́[`), a braille blank. Whatever follows — `/report`, `/rероrt` in Cyrillic,
 * `∕report`, `/r️eport` — no longer matters: every such pair is broken (review-3 NEW-4).
 */
const BRACKET_RUN = /\[(?:[\s\p{M}⠀]*\[)+/gu;

/**
 * Text made safe to put inside a delimited block (review-2 F7, review-3 NEW-4): normalized (NFKC, so full-width
 * brackets and letters are plain ones; invisible characters removed; bracket look-alikes read as `[` and `]`, `⟦` as
 * `[[`), then every `[[`-like run, whatever tag name follows it, rewritten as `[·[` — so no Whombat block can be opened
 * or closed from inside, and normalizing again doesn't make one. Single brackets stay (`Totals [1] are [off]`). The
 * result is what the model reads; it is never stored.
 */
export function defuseDelimiters(text: string): string {
  const normalized = text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(DOUBLE_OPENERS, '[[')
    .replace(DOUBLE_CLOSERS, ']]')
    .replace(OPENER_LOOKALIKES, '[')
    .replace(CLOSER_LOOKALIKES, ']');
  return normalized.replace(BRACKET_RUN, (run) => Array.from(run.replace(/[^[]/gu, '')).join('·'));
}
