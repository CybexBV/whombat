/** Number and stat formatting with the mock's typography (real minus sign, middle dot, Dutch euros). */

/** U+2212 MINUS SIGN, used in diff stats. */
export const MINUS = '−';
/** U+00B7 MIDDLE DOT separator. */
export const DOT = '·';

/** `+214` */
export function formatAdditions(n: number): string {
  return `+${n}`;
}

/** `−12` (real minus sign) */
export function formatDeletions(n: number): string {
  return `${MINUS}${n}`;
}

/** `+214 −12`, with `· 6 files` when `files` is given. */
export function formatDiffStat(stat: { add: number; del: number; files?: number }): string {
  const base = `${formatAdditions(stat.add)} ${formatDeletions(stat.del)}`;
  return stat.files === undefined ? base : `${base} · ${plural(stat.files, 'file')}`;
}

/** Scale for the files table mini bars: at least 140 lines (the mock's scale), or the largest file. */
export function diffBarScale(files: readonly { add: number; del: number }[]): number {
  return Math.max(140, ...files.map((f) => f.add + f.del));
}

/** Mini bar widths in percent for a files-table row. */
export function diffBarWidths(
  file: { add: number; del: number },
  scale: number,
): { add: number; del: number } {
  const s = scale > 0 ? scale : 1;
  return { add: Math.round((file.add / s) * 100), del: Math.round((file.del / s) * 100) };
}

/** `1 file`, `6 files`, `5 replies` (pass the plural for irregular words). */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** Thread link: `5 replies`. */
export function formatReplies(n: number): string {
  return plural(n, 'reply', 'replies');
}

/** `41 of 41` */
export function formatOf(passed: number, total: number): string {
  return `${passed} of ${total}`;
}

/** Run card / live log header: `38 of 41 passing`. */
export function formatTestsPassing(tests: { passed: number; total: number }): string {
  return `${formatOf(tests.passed, tests.total)} passing`;
}

/**
 * Euros in Dutch notation as the mock writes them: `€0,01`, `€24,00`, `€1.234,56`.
 * `space: true` gives `€ 1.234,56` (Typeset's nl-NL output).
 */
export function formatEuro(cents: number, options: { space?: boolean } = {}): string {
  // The sign of the rounded amount: -0.4 cents is €0,00, not -€0,00.
  const rounded = Math.round(cents);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  const euros = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}€${options.space ? ' ' : ''}${euros},${String(abs % 100).padStart(2, '0')}`;
}

/** Short commit sha as shown in cards: `7be20f`. */
export function shortSha(sha: string): string {
  return sha.slice(0, 6);
}

/** `01`, `02` — numbered WHAT HAPPENS steps. */
export function stepNumber(index: number): string {
  return String(index + 1).padStart(2, '0');
}
