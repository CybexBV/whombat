/**
 * A canvas on the phone, read-only (contracts 0.55 `canvases.content`, CT-303; mobile-parity.md MQ-05): its title, who
 * started it and when it last changed, and its text as Markdown — the text `canvas_read` gives agents — rendered with
 * the message renderer. Editing stays on the web (the collaborative editor). Pure.
 */
import { ApiError } from '@whombat/client';
import { type CanvasContentResponse, formatAgo } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import type { ViewContext } from './people';

export function canvasText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    kicker: t('data.canvas.kicker'),
    gone: t('data.canvas.gone'),
    loadFailed: t('data.canvas.loadFailed'),
    openOnWeb: t('data.canvas.openOnWeb'),
    readOnly: t('data.canvas.readOnly'),
    empty: t('data.canvas.empty'),
  } as const;
}
export const CANVAS_TEXT = canvasText();

/** “Started by Toffee · updated 2 h ago”. */
export function canvasMeta(
  content: Pick<CanvasContentResponse, 'canvas' | 'updatedAt'>,
  ctx: Pick<ViewContext, 'people' | 'now' | 'timeZone' | 'locale'>,
): string {
  const { t } = mobileTranslator(ctx.locale);
  const by = ctx.people.get(content.canvas.provenance.createdById);
  const ago = formatAgo(content.updatedAt, ctx.now, ctx.timeZone, ctx.locale);
  return by
    ? t('data.canvas.startedBy', { name: by.name, updated: t('data.canvas.updated', { ago }) })
    : t('data.canvas.updatedAlone', { ago });
}

/** Why a canvas didn't load: gone (no Try again) or anything else. */
export function canvasProblem(error: unknown, locale?: string): { text: string; retry: boolean } {
  const text = canvasText(locale);
  if (error instanceof ApiError && (error.status === 404 || error.status === 403))
    return { text: text.gone, retry: false };
  return { text: text.loadFailed, retry: true };
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
