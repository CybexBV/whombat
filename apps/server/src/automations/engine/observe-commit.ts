/** Which commit a review names on its verdict's line (report-trackers.md TA-57). */
import { parseVerdict, VERDICT_APPROVE, VERDICT_CHANGES } from '@whombat/core';

/**
 * The commit a review says it read, on its verdict's own line (“Approve — reviewed 8c94527”): a hex id of 7 to 40
 * digits there, else null (the verdict's line names none).
 *
 * A short id can be made only of digits (about one in sixty nine-character ids has no letter), so such an id counts
 * when the line clearly presents it as the commit: after “reviewed”, in backticks, or right after the verdict words.
 * A bare number anywhere else on the line (“2 of 1234567 tests failed”, “PR #1234567”) isn't taken for a commit.
 */
export function namedCommit(texts: readonly string[]): string | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i] ?? '';
    const verdict = parseVerdict(text);
    if (!verdict) continue;
    const line = text.trim().split('\n')[0] ?? '';
    const said = line.match(/\breviewed\s+`?([0-9a-f]{7,40})\b/i)?.[1];
    const ticked = line.match(/`([0-9a-f]{7,40})`/i)?.[1];
    const leading = afterVerdict(line, verdict === 'approve' ? VERDICT_APPROVE : VERDICT_CHANGES);
    // Elsewhere on the line only a hex id with letters and digits counts, so a plain number isn't a commit.
    const mixed = line.match(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i)?.[0];
    const found = said ?? ticked ?? leading ?? mixed;
    return found ? found.toLowerCase() : null;
  }
  return null;
}

/**
 * The hex id that follows the verdict words with only separators between (“Changes needed — 701385852”, “Approve:
 * commit 7013858”). An id of digits alone with no “commit” or “reviewed” before it must end the sentence or the
 * clause, so “Approve: 2026110912 tests pass.” stays a number.
 */
function afterVerdict(line: string, words: string): string | null {
  // As forgiving about what comes before the verdict as reading the verdict itself is.
  const start = line.replace(/^[\s>*_#`\-–—•"“'‘]+/u, '');
  if (!start.toLowerCase().startsWith(words.toLowerCase())) return null;
  const rest = start.slice(words.length);
  const match = rest.match(
    /^(?:[\s—–\-:,(*_]|(?:reviewed|commit|at|of|on)(?=\s))*([0-9a-f]{7,40})(?![0-9a-z])/i,
  );
  const id = match?.[1];
  if (!match || !id) return null;
  if (/[a-f]/i.test(id)) return id;
  const named = /[a-z]/i.test(match[0].slice(0, -id.length));
  const tail = rest.slice(match[0].length);
  return named || /^\s*(?:$|[.,;:!)\]—–-])/u.test(tail) ? id : null;
}

/** Whether a short or full commit id names the same commit as a full one. */
export function sameCommit(named: string, full: string): boolean {
  return full.toLowerCase().startsWith(named.toLowerCase());
}
