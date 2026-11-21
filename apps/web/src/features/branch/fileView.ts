import type { Token } from '../messaging/highlight';

/*
 * The file view's logic (AP-664): which grammar a path gets, the highlighted file split back into its lines, where
 * each change starts, and the files before and after in Files changed.
 */

/** Names the highlighter knows by a file's name rather than its extension. */
const BY_NAME: Record<string, string> = { dockerfile: 'bash', makefile: 'bash' };

/** The language to highlight `path` as: its extension (`ts`, `html`, `yml`), or null without one. */
export function languageOf(path: string): string | null {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : null;
}

/**
 * A highlighted text split at its line breaks: one token per line, each keeping the colours of the spans it was cut
 * from. `count` is the number of lines of the text (a span over a line break is cut into one piece per line).
 */
export function splitTokenLines(tree: Token, count: number): Token[] {
  const lines: (string | Token)[][] = [[]];
  const walk = (children: (string | Token)[], wrap: (parts: (string | Token)[]) => string | Token) => {
    for (const child of children) {
      if (typeof child === 'string') {
        child.split('\n').forEach((part, i) => {
          if (i > 0) lines.push([]);
          if (part) (lines[lines.length - 1] as (string | Token)[]).push(wrap([part]));
        });
      } else {
        walk(child.children, (parts) => wrap([{ kind: child.kind, children: parts }]));
      }
    }
  };
  walk(tree.children, (parts) =>
    parts.length === 1 ? (parts[0] as string | Token) : { kind: null, children: parts },
  );
  return Array.from({ length: count }, (_, i) => ({ kind: null, children: lines[i] ?? [] }));
}

/** Where each change starts, the gutter's width and the files around one: shared with the phone (AP-712). */
export { changeStarts, gutterDigits, neighbours } from '@whombat/client';
