/**
 * A drawing shown once (docs/decisions/messaging.md MS-D01): an agent that attaches an SVG file it made and also writes
 * the same SVG in a fenced block shows the picture twice, the block as a drawing and the file under it. The block goes
 * and the file stays: it shows full width, is in the conversation's files and can be downloaded. Only a block holding
 * the same document as an attached SVG (whitespace aside) is dropped; another drawing or other code stays as written.
 */
import { svgImageDocument } from '@whombat/core';

/** Core's fence (`text/markdown.ts`): up to three spaces, three or more backticks or tildes, then the language. */
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;

/** The fence languages core shows an SVG document in as a drawing (CT-90). */
const DRAWING_LANGS = new Set(['', 'svg', 'xml', 'html', 'htm']);

/** The document as a client draws it, without whitespace between tags and the rest collapsed; null if it isn't one. */
function drawingOf(text: string): string | null {
  return svgImageDocument(text)?.replace(/>\s+</g, '><').replace(/\s+/g, ' ') ?? null;
}

/** `text` without the fenced blocks that hold the same SVG document as one of `files` (their text). */
export function dropSvgCopies(text: string, files: readonly string[]): string {
  if (!files.length || !text.includes('<svg')) return text;
  const attached = new Set(files.map(drawingOf).filter((d): d is string => d !== null));
  if (!attached.size) return text;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  let dropped = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fence = FENCE.exec(line);
    if (!fence) {
      // One blank line where a block was taken out between two paragraphs, not two.
      if (!(dropped && line.trim() === '' && kept.at(-1)?.trim() === '')) kept.push(line);
      continue;
    }
    const mark = fence[1] as string;
    const close = new RegExp(`^ {0,3}${mark[0]}{${mark.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end] as string)) end++;
    const body = lines.slice(i + 1, end).join('\n');
    const drawing = DRAWING_LANGS.has((fence[2] as string).toLowerCase()) ? drawingOf(body) : null;
    if (drawing !== null && attached.has(drawing)) dropped = true;
    else kept.push(...lines.slice(i, end + 1));
    i = end;
  }
  return dropped ? kept.join('\n').trim() : text;
}
