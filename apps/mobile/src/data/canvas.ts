/**
 * A canvas on the phone, read-only (contracts 0.55 `canvases.content`, CT-303; mobile-parity.md MQ-05): its title, who
 * started it and when it last changed, and its text as Markdown — the text `canvas_read` gives agents — rendered with
 * the message renderer. Editing stays on the web (the collaborative editor). Pure.
 */
import { ApiError } from '@whombat/client';
import { type CanvasContentResponse, formatAgo } from '@whombat/core';
import type { ViewContext } from './people';

export const CANVAS_TEXT = {
  kicker: 'CANVAS',
  gone: 'This canvas isn’t here any more, or you can’t read it.',
  loadFailed: 'The canvas didn’t load.',
  openOnWeb: 'Open on the web',
  readOnly: 'Read-only on the phone. Edit it on the web.',
  empty: 'This canvas is empty.',
} as const;

/** “Started by Toffee · updated 2 h ago”. */
export function canvasMeta(
  content: Pick<CanvasContentResponse, 'canvas' | 'updatedAt'>,
  ctx: Pick<ViewContext, 'people' | 'now' | 'timeZone'>,
): string {
  const by = ctx.people.get(content.canvas.provenance.createdById);
  const updated = `updated ${formatAgo(content.updatedAt, ctx.now, ctx.timeZone)}`;
  return by ? `Started by ${by.name} · ${updated}` : `${updated.charAt(0).toUpperCase()}${updated.slice(1)}`;
}

/** Why a canvas didn't load: gone (no Try again) or anything else. */
export function canvasProblem(error: unknown): { text: string; retry: boolean } {
  if (error instanceof ApiError && (error.status === 404 || error.status === 403))
    return { text: CANVAS_TEXT.gone, retry: false };
  return { text: CANVAS_TEXT.loadFailed, retry: true };
}

/**
 * Canvas Markdown as the message renderer reads it (MQ-05 follow-up). The canvas dialect (`@whombat/canvas-schema`
 * `markdown.ts`) adds two things messages don't have: a plan block's fences `:::plan{id=…}` … `:::` (the lines between
 * are a readable listing of the steps, kept) and author-named highlights `==text==` / `==text=={author=prn_…}` (the
 * phone shows their words; the author's tint is the web editor's). Fenced code is left as it is.
 */
export function canvasReadingMarkdown(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const opener = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      continue;
    }
    if (opener) {
      fence = opener;
      out.push(line);
      continue;
    }
    if (/^\s*:::[a-z]+\{[^}]*\}\s*$/i.test(line) || /^\s*:::\s*$/.test(line)) continue;
    out.push(line.replace(/==(.+?)==(?:\{author=[^}]*\})?/g, '$1'));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
