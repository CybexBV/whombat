import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nl } from '../locales/nl';
import { t, tn } from './i18n';

/** The top-level arguments (source text) of every call `name(…)` in src. */
function callArgs(src: string, name: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`\\b${name}\\(`, 'g');
  for (const m of src.matchAll(re)) {
    const args: string[] = [];
    let depth = 0;
    let cur = '';
    let i = m.index + m[0].length;
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (c === "'" || c === '"' || c === '`') {
        let j = i + 1;
        while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
        cur += src.slice(i, j + 1);
        i = j;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      }
      if (c === ',' && depth === 0) {
        args.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    args.push(cur.trim());
    out.push(args);
  }
  return out;
}

/** The text of a plain string literal argument, else null. */
function literal(arg: string | undefined): string | null {
  const m = arg ? /^'((?:[^'\\]|\\.)*)'$|^"((?:[^"\\]|\\.)*)"$/.exec(arg) : null;
  if (!m) return null;
  return m[1] != null ? m[1].replace(/\\'/g, "'") : m[2]!.replace(/\\"/g, '"');
}

/**
 * Every translated literal in the UI sources: the text of t('…') and
 * tx('…'), the two texts of tn(n, '…', '…') and the words of
 * plural(n, '…', '…') and countWord(n, '…', '…') (the plural defaults to
 * the word plus "s").
 */
function keysInSources(): Set<string> {
  const root = new URL('..', import.meta.url).pathname;
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) {
        if (f !== 'vendor' && f !== 'locales') walk(p);
      } else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/\btx?\(\s*'((?:[^'\\]|\\.)*)'/g)) out.add(m[1]!.replace(/\\'/g, "'"));
        for (const m of src.matchAll(/\btx?\(\s*"((?:[^"\\]|\\.)*)"/g)) out.add(m[1]!.replace(/\\"/g, '"'));
        for (const a of callArgs(src, 'tn')) {
          for (const k of [literal(a[1]), literal(a[2])]) if (k != null) out.add(k);
        }
        for (const fn of ['plural', 'countWord']) {
          for (const a of callArgs(src, fn)) {
            const one = literal(a[1]);
            if (one == null) continue;
            out.add(one);
            out.add(a.length > 2 ? (literal(a[2]) ?? '') : `${one}s`);
          }
        }
      }
    }
  };
  walk(root);
  out.delete('');
  return out;
}

describe('i18n', () => {
  it('falls back to English and fills placeholders', () => {
    expect(t('Nothing like this exists')).toBe('Nothing like this exists');
    expect(t('{n} of {m}', { n: 2, m: 3 })).toBe('2 of 3');
    expect(tn(1, '{n} host', '{n} hosts')).toBe('1 host');
    expect(tn(3, '{n} host', '{n} hosts')).toBe('3 hosts');
    expect(t('Nothing like this exists|context')).toBe('Nothing like this exists');
  });

  it('has a Dutch text for every translated string in the UI', () => {
    const missing = [...keysInSources()].filter((k) => !(k in nl));
    expect(missing).toEqual([]);
  });

  it('keeps the placeholders of every Dutch text', () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const wrong = Object.entries(nl).filter(([en, d]) => names(en) !== names(d)).map(([en]) => en);
    expect(wrong).toEqual([]);
  });
});
