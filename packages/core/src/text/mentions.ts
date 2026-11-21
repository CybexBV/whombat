/**
 * Mentions. Segmentation is identical to the mock (`segs`): split on `@` followed by a capitalised word,
 * drop empty parts. Every `@Name` segment renders brand/600, whether or not it resolves to a principal.
 */

/** Same pattern as the mock: `@` + one capital letter + lowercase letters. */
export const MENTION_PATTERN = /@([A-Z][a-z]+)/g;

export interface TextSegment {
  text: string;
  mention: boolean;
}

/** "Morning. @Toffee can you…" → [{text:'Morning. '}, {text:'@Toffee', mention:true}, {text:' can you…'}]. */
export function segmentMentions(text: string): TextSegment[] {
  return String(text)
    .split(/(@[A-Z][a-z]+)/)
    .filter(Boolean)
    .map((part) => ({ text: part, mention: part[0] === '@' }));
}

/** Names mentioned, in order, without duplicates: "@Banjo go for it" → ["Banjo"]. */
export function mentionNames(text: string): string[] {
  const names: string[] = [];
  for (const m of String(text).matchAll(MENTION_PATTERN)) {
    const name = m[1] as string;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export interface MentionTarget {
  id: string;
  kind: 'person' | 'agent';
  name: string;
  shortName?: string;
}

/**
 * The word a target is mentioned by: an agent's name, a person's short name or else their first name (`@Mara`). It is
 * a mention only when it has the canonical shape (one capital, then lowercase letters, `MENTION_PATTERN`).
 */
export function mentionNameOf(target: MentionTarget): string {
  return target.kind === 'person' ? (target.shortName ?? target.name.split(/\s+/)[0] ?? '') : target.name;
}

/**
 * Resolves `@Name` mentions to principal ids: the agent by name, people by short name or first name. The agent wins
 * over a person with the same first name. Unknown names are ignored.
 *
 * Resolves on `canonicalizeMentions(text, principals)` (0.33, MS-C02), so `@dusty` and `@DUSTY` mention Dusty exactly
 * as `@Dusty` does.
 */
export function resolveMentions(text: string, principals: readonly MentionTarget[]): string[] {
  const ids: string[] = [];
  for (const name of mentionNames(canonicalizeMentions(text, principals))) {
    const agent = principals.find((p) => p.kind === 'agent' && p.name === name);
    const person = principals.find((p) => p.kind === 'person' && mentionNameOf(p) === name);
    const hit = agent ?? person;
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids;
}

/* Mentions in any letter case (0.33, Whombat messaging.md MS-C01…MS-C03) ------------------------------------------- */

/** The canonical shape of a mention name (`Banjo`): what `MENTION_PATTERN` finds. */
const CANONICAL_NAME = /^[A-Z][a-z]+$/;

/**
 * `@` + a word, in any letter case. Group 1 is what precedes the `@` (start of text, or a character that isn't a letter,
 * mark, digit, `_`, `.`, `@`, `/` or `-`: not `john@banjo.example`, not `x/@banjo`), group 2 the whole word (letters and
 * marks, so `@banjoé` is one word that names nobody). After the word: not a letter, mark, digit, `_`, `@` or `/` (`@banjo2`,
 * `@banjo_bot`, `@banjo@host`, `@banjo/pkg`), and not `.` or `-` + a letter or digit (`@banjo.example`, `@banjo-ci`).
 */
const ANY_CASE_MENTION =
  /(^|[^\p{L}\p{M}\p{N}_.@/-])@([\p{L}\p{M}]+)(?![\p{L}\p{M}\p{N}_@/])(?![.-][\p{L}\p{M}\p{N}])/gu;

/** One `@word` that mentions a target in another letter case: `text.slice(start, end)` is `@banjo`, `to` is `@Banjo`. */
export interface MentionCorrection {
  /** Index of the `@` (UTF-16 code units). */
  start: number;
  /** Index just after the word. */
  end: number;
  /** As typed: `@banjo`. */
  from: string;
  /** Canonical: `@Banjo` (always the same length as `from`). */
  to: string;
}

/**
 * `text` with fenced code blocks and inline code spans blanked out to spaces, same length (newlines kept), so indexes
 * still point into `text`. Fenced code blocks; a code span as the Markdown renderer reads it (a run
 * of backticks up to the next same run on that line, backticks inside included).
 */
function blankCode(text: string): string {
  const fenced = text.replace(
    /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\S\n]*$|(?![\s\S]))/gm,
    (block) => block.replace(/[^\n]/g, ' '),
  );
  if (!fenced.includes('`')) return fenced;
  let out = '';
  let i = 0;
  while (i < fenced.length) {
    const tick = fenced.indexOf('`', i);
    if (tick < 0) break;
    const run = (/^`+/.exec(fenced.slice(tick)) as RegExpExecArray)[0];
    const end = fenced.indexOf(run, tick + run.length);
    out += fenced.slice(i, tick);
    if (end >= 0 && !fenced.slice(tick, end).includes('\n')) {
      out += ' '.repeat(end + run.length - tick);
      i = end + run.length;
    } else {
      out += run;
      i = tick + run.length;
    }
  }
  return out + fenced.slice(i);
}

/** Lowercased mention name → canonical name, for every target whose mention name has the canonical shape. */
function canonicalNames(targets: readonly MentionTarget[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const t of targets) {
    const name = mentionNameOf(t);
    if (CANONICAL_NAME.test(name) && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  return names;
}

/**
 * Every `@word` in `text` that mentions one of `targets` in another letter case than its canonical one (MS-C01):
 * `@banjo`, `@BANJO`, `@bAnJo` for Banjo; in order. Words in code, unknown words
 * and canonical `@Banjo` are not corrections. The word is compared ASCII letter by letter (a target's mention name is
 * `[A-Z][a-z]+`), so no Unicode case folding can make a lookalike match.
 */
export function mentionCorrections(text: string, targets: readonly MentionTarget[]): MentionCorrection[] {
  const source = String(text);
  if (!source.includes('@')) return [];
  const names = canonicalNames(targets);
  if (names.size === 0) return [];
  const blanked = blankCode(source);
  const out: MentionCorrection[] = [];
  for (const m of blanked.matchAll(ANY_CASE_MENTION)) {
    const word = m[2] as string;
    if (!/^[A-Za-z]+$/.test(word)) continue;
    const name = names.get(word.toLowerCase());
    if (!name || name === word) continue;
    const start = (m.index as number) + (m[1] as string).length;
    out.push({ start, end: start + 1 + word.length, from: `@${word}`, to: `@${name}` });
  }
  return out;
}

/**
 * Rewrites every mention in another letter case to its canonical form (MS-C02): `@banjo hi` → `@Banjo hi`. Everything
 * else stays byte-identical, and canonicalising twice changes nothing. The server stores this text; `resolveMentions`
 * resolves on it.
 */
export function canonicalizeMentions(text: string, targets: readonly MentionTarget[]): string {
  const source = String(text);
  const corrections = mentionCorrections(source, targets);
  if (corrections.length === 0) return source;
  let out = '';
  let at = 0;
  for (const c of corrections) {
    out += source.slice(at, c.start) + c.to;
    at = c.end;
  }
  return out + source.slice(at);
}

/**
 * The composer's in-place auto-correct (MS-C03), the same rule on web and Android: when the character just typed (the
 * one before `caret`) ended an `@word` that mentions a target in another letter case, that word is replaced by its
 * canonical form. Returns the new text and caret, or null when there is nothing to correct.
 *
 * A word ends at whitespace or punctuation. After `.` or `-` it isn't decided yet (`@banjo.example`, `@banjo-ci`), so the
 * word is corrected one character later, when what follows shows it is a mention (`@banjo. ` → `@Banjo. `). Inside a
 * code span still open on its line (an unmatched backtick before the `@`) nothing is corrected. On send the whole text
 * goes through `canonicalizeMentions` too.
 */
export function autocorrectMentionAt(
  text: string,
  caret: number,
  targets: readonly MentionTarget[],
): { text: string; caret: number } | null {
  const source = String(text);
  if (caret < 2 || caret > source.length) return null;
  const hit = mentionCorrections(source, targets).find((c) => {
    if (c.end === caret - 1) return !/[.-]/.test(source[c.end] as string);
    return c.end === caret - 2 && /[.-]/.test(source[c.end] as string);
  });
  if (!hit) return null;
  const line = blankCode(source).slice(0, hit.start);
  if ((line.slice(line.lastIndexOf('\n') + 1).match(/`/g) ?? []).length > 0) return null;
  return { text: source.slice(0, hit.start) + hit.to + source.slice(hit.end), caret };
}

/** The `@` query being typed at the caret, for composer autocomplete: "hey @Ba|" → "Ba". */
export function mentionQueryAt(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([A-Za-z]*)$/.exec(before);
  if (!m) return null;
  return { query: m[2] as string, start: before.length - (m[2] as string).length - 1 };
}
