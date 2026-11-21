/**
 * A minimal, safe renderer for the legal pages the hosted app serves (LC-17): the Markdown the terms are written in —
 * `#`/`##` headings, paragraphs whose lines are wrapped (joined with spaces), `-` and `1.` lists, `>` quotes — into
 * blocks whose inline text goes through core's message parser (bold, code, links). No HTML is ever interpreted:
 * everything becomes React text nodes.
 */
import { type Inline, parseInline } from '@whombat/core';

export type LegalBlock =
  | { type: 'heading'; level: 1 | 2; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] };

export function parseLegal(text: string): LegalBlock[] {
  const out: LegalBlock[] = [];
  const chunks = text.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  for (const chunk of chunks) {
    const lines = chunk.split('\n').filter((l) => l.trim() !== '');
    const first = lines[0];
    if (!first) continue;
    const heading = /^(#{1,2})\s+(.*)$/.exec(first);
    if (heading?.[1] && heading[2] !== undefined && lines.length === 1) {
      out.push({ type: 'heading', level: heading[1].length as 1 | 2, children: parseInline(heading[2]) });
      continue;
    }
    if (first.startsWith('>')) {
      out.push({
        type: 'quote',
        children: parseInline(lines.map((l) => l.replace(/^>\s?/, '').trim()).join(' ')),
      });
      continue;
    }
    const bullet = /^\s*(?:[-*]|(\d+)\.)\s+/;
    const marker = bullet.exec(first);
    if (marker) {
      const items: string[] = [];
      for (const line of lines) {
        const m = bullet.exec(line);
        if (m) items.push(line.slice(m[0].length).trim());
        else items[items.length - 1] = `${items.at(-1) ?? ''} ${line.trim()}`;
      }
      out.push({ type: 'list', ordered: marker[1] !== undefined, items: items.map((i) => parseInline(i)) });
      continue;
    }
    out.push({ type: 'paragraph', children: parseInline(lines.map((l) => l.trim()).join(' ')) });
  }
  return out;
}
