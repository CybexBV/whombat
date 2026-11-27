/**
 * A pull request's file, whole (CT-241): every line of the file with the lines the branch removed and added in place,
 * numbered in the base and the head version — the file view a person opens from Files changed. `fileViewLines` is the
 * one rule that turns the two versions into those lines (a line diff, Myers'), so the runtime and the fixtures agree.
 */
import { z } from 'zod';
import { coreWords } from '../i18n/catalog.js';
import { DiffLineKind } from './cards.js';
import { Count } from './common.js';

/** The most lines a file view carries (both versions together); a longer file is `too_large`. */
export const PR_FILE_MAX_LINES = 20_000;
/** Either version above this many bytes is `too_large`. */
export const PR_FILE_MAX_BYTES = 1_048_576;
/** A longer line is cut to this many characters and ends with `…`. */
export const PR_FILE_LINE_MAX = 2_000;

export const PrFileLine = z.object({
  kind: DiffLineKind,
  /** The line's number in the base version; null on an added line. */
  old: z.number().int().positive().nullable(),
  /** The line's number in the head version; null on a removed line. */
  new: z.number().int().positive().nullable(),
  /** Without its line ending. */
  text: z.string().max(PR_FILE_LINE_MAX + 1),
});
export type PrFileLine = z.infer<typeof PrFileLine>;

/** `added`: no base version; `deleted`: no head version. */
export const PrFileStatus = z.enum(['added', 'modified', 'deleted']);
export type PrFileStatus = z.infer<typeof PrFileStatus>;

/** `text`: `lines` holds the file. `binary` and `too_large`: no lines, the view says why. */
export const PrFileShown = z.enum(['text', 'binary', 'too_large']);
export type PrFileShown = z.infer<typeof PrFileShown>;

export const PrFileView = z.object({
  path: z.string().min(1),
  status: PrFileStatus,
  shown: PrFileShown,
  /** Added and removed lines in `lines` (0 unless `text`). */
  add: Count,
  del: Count,
  lines: z.array(PrFileLine).max(PR_FILE_MAX_LINES),
  /** The commit the base version was read at (the merge base); null when there is none. */
  baseSha: z.string().min(4).max(64).nullable(),
  headSha: z.string().min(4).max(64),
});
export type PrFileView = z.infer<typeof PrFileView>;

/** What the file view says instead of lines, in a locale. */
export function prFileShownText(
  locale?: string | null,
): Readonly<Record<Exclude<PrFileShown, 'text'>, string>> {
  return coreWords(locale, 'prFile', ['binary', 'too_large'] as const);
}

export const PR_FILE_SHOWN_TEXT: Record<Exclude<PrFileShown, 'text'>, string> = prFileShownText('en');

/** Whether bytes look binary: a NUL in the first 8 KiB (git's rule). */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** A file's lines without their endings (`\n` or `\r\n`); a final line ending adds no empty line. */
export function splitFileLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Beyond this many edits the middle of the file is shown as removed, then added (a rewrite). */
const MAX_EDITS = 2_000;

/**
 * The file view's lines: every line of `head`, with the lines of `base` it no longer has in place before the lines
 * that replaced them; `old`/`new` number them in their version. `null` is a version that doesn't exist (an added or a
 * deleted file). Long lines are cut at `PR_FILE_LINE_MAX`. The caller checks `PR_FILE_MAX_LINES`.
 */
export function fileViewLines(base: string | null, head: string | null): PrFileLine[] {
  const a = base === null ? [] : splitFileLines(base);
  const b = head === null ? [] : splitFileLines(head);
  const out: PrFileLine[] = [];
  const cut = (t: string) => (t.length > PR_FILE_LINE_MAX ? `${t.slice(0, PR_FILE_LINE_MAX)}…` : t);
  const push = (kind: DiffLineKind, i: number | null, j: number | null) =>
    out.push({
      kind,
      old: i === null ? null : i + 1,
      new: j === null ? null : j + 1,
      text: cut(kind === 'add' ? (b[j as number] as string) : (a[i as number] as string)),
    });

  // The common start and end are context; only the middle is compared.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  for (let k = 0; k < start; k++) push('context', k, k);
  for (const [kind, i, j] of middle(a, b, start, endA, start, endB)) push(kind, i, j);
  for (let k = 0; endA + k < a.length; k++) push('context', endA + k, endB + k);
  return out;
}

type Step = [DiffLineKind, number | null, number | null];

/** Myers' shortest edit script over `a[a0..a1)` and `b[b0..b1)`, removals before additions in each change. */
function middle(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number): Step[] {
  const n = a1 - a0;
  const m = b1 - b0;
  const rewrite = (): Step[] => [
    ...Array.from({ length: n }, (_, k): Step => ['del', a0 + k, null]),
    ...Array.from({ length: m }, (_, k): Step => ['add', null, b0 + k]),
  ];
  if (n === 0 || m === 0) return rewrite();
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Step d's band of `v` (k from −d−1 to d+1, at k + d + 1): the walk back reads only that.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))
          ? (v[offset + k + 1] as number)
          : (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return rewrite();

  // Walk back from the end, then reverse; within a change removals come first.
  const steps: Step[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d] as Int32Array;
    const k = x - y;
    const down = k === -d || (k !== d && (vd[k + d] as number) < (vd[k + d + 2] as number));
    const prevK = down ? k + 1 : k - 1;
    const prevX = vd[prevK + d + 1] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      steps.push(['context', a0 + x, b0 + y]);
    }
    if (down) steps.push(['add', null, b0 + prevY]);
    else steps.push(['del', a0 + prevX, null]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    steps.push(['context', a0 + x, b0 + y]);
  }
  steps.reverse();
  return groupChanges(steps);
}

/** Within each run of changes, every removal before the additions (as a unified diff shows them). */
function groupChanges(steps: Step[]): Step[] {
  const out: Step[] = [];
  let dels: Step[] = [];
  let adds: Step[] = [];
  const flush = () => {
    out.push(...dels, ...adds);
    dels = [];
    adds = [];
  };
  for (const s of steps) {
    if (s[0] === 'del') dels.push(s);
    else if (s[0] === 'add') adds.push(s);
    else {
      flush();
      out.push(s);
    }
  }
  flush();
  return out;
}
