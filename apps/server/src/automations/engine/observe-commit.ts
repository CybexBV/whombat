/** Which commit a review names on its verdict's line (report-trackers.md TA-57). */
import { parseVerdict } from '@whombat/core';

/**
 * The commit a review says it read, on its verdict's own line (“Approve — reviewed 8c94527”): a hex id of 7 to 40
 * digits there, else null (the verdict's line names none).
 */
export function namedCommit(texts: readonly string[]): string | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i] ?? '';
    if (!parseVerdict(text)) continue;
    const line = text.trim().split('\n')[0] ?? '';
    // “reviewed 1234567” names it whatever its digits; else a hex id with letters and digits (not a plain number).
    const said = line.match(/\breviewed\s+`?([0-9a-f]{7,40})\b/i)?.[1];
    const found = said ?? line.match(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i)?.[0];
    return found ? found.toLowerCase() : null;
  }
  return null;
}

/** Whether a short or full commit id names the same commit as a full one. */
export function sameCommit(named: string, full: string): boolean {
  return full.toLowerCase().startsWith(named.toLowerCase());
}
