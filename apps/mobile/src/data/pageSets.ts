/**
 * Page sets on the phone (docs/decisions/page-sets.md): the pure half of the card and the viewer. A set is one file on a
 * message, a ZIP read file by file through the session (`@whombat/client/pages`); each page shows in a confined WebView
 * (`richPreview.ts`) that runs the viewer's script (`pages-runtime.js`, a data URL Metro makes) and asks the app for the
 * page's files. No React Native imports: unit-tested.
 */
import { PageSetError, type PagesHostMessage, pageFileName, type ReadRange } from '@whombat/client/pages';
import pagesRuntime from '@whombat/client/pages/pages-runtime.js';
import { type ApplianceSession, type ResourceRef, readResource } from '@whombat/client/session';
import { type Attachment, formatFileSize, PAGES_DEFAULT_OPEN, type PageSetManifest } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import { withPreviewPolicy } from './richPreview';
import { SHARED_CACHE_DIR } from './sharedCache';

/** What the card and the viewer say. */
export function pagesCopy(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    open: t('data.pageSets.open'),
    back: t('data.pageSets.back'),
    download: t('data.pageSets.download'),
    close: t('data.pageSets.close'),
    opening: t('data.pageSets.opening'),
    failed: t('data.pageSets.failed'),
    tryAgain: t('data.pageSets.tryAgain'),
    missing: t('data.pageSets.missing'),
    openHint: t('data.pageSets.openHint'),
  } as const;
}
export const PAGES_COPY = pagesCopy();

/** The card's quiet line: “Pages · 30 MB”. */
export function pageSetMeta(a: Pick<Attachment, 'size'>, locale?: string): string {
  return mobileTranslator(locale).t('data.pageSets.meta', { size: formatFileSize(a.size) });
}

/** A file of the set that a link offers to download: “report.pdf · 2.4 MB”. */
export function pageFileLine(path: string, size: number): string {
  return `${pageFileName(path)} · ${formatFileSize(size)}`;
}

/** Where a link out of the set goes: “This link goes to example.com.” */
export function externalLine(host: string, locale?: string): string {
  return mobileTranslator(locale).t('data.pageSets.external', { host });
}

/**
 * The host (and port) of an `http(s)` URL a page asked to open, or null for anything else. Read by hand: it is shown to
 * the person before they open it, and the platform's `URL` differs between React Native versions.
 */
export function externalHost(url: string): string | null {
  const m = /^https?:\/\/([^/?#\\]*)/i.exec(url.trim());
  if (!m?.[1]) return null;
  // Whoever is named before an `@` is not where it goes.
  const host = m[1].slice(m[1].lastIndexOf('@') + 1).toLowerCase();
  return host && !/[\s<>"]/.test(host) ? host : null;
}

/* The WebView ---------------------------------------------------------------------------------------- */

/** `&` and `"` can't end the attribute the runtime's URL is written into. */
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * The document every page's WebView loads: the page policy as its first element (and the viewport), then the viewer's
 * script, which writes the page itself into this document once the app has sent its files. The policy stays with the
 * document when the script writes the page, so the page runs under it too.
 */
export function pagesLoaderHtml(runtimeUrl: string = pagesRuntime): string {
  return withPreviewPolicy(
    `<html><head><title></title></head><body><script src="${attr(runtimeUrl)}"></script></body></html>`,
  );
}

/**
 * The script that hands the app's message to the viewer's script (`window.__whombatPages`). The message travels as a
 * JSON string inside a JavaScript string literal; the line and paragraph separators are escaped too, so no file name or
 * path from a page can end the literal on any engine.
 */
export function pagesInjection(message: PagesHostMessage): string {
  const literal = JSON.stringify(JSON.stringify(message))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `window.__whombatPages&&window.__whombatPages(${literal});true;`;
}

/* Reading the set ------------------------------------------------------------------------------------ */

/**
 * The reader's ranges through the Whombat's session: `[start, end)` of the set's file, exactly that many bytes. A read
 * that comes back short or longer (the range not honoured) is refused, never handed to the reader.
 */
export function sessionReadRange(session: ApplianceSession, ref: ResourceRef): ReadRange {
  return async ({ start, end }, signal) => {
    const want = end - start;
    const got = await readResource(session, ref, {
      maxBytes: want,
      range: { start, end },
      ...(signal ? { signal } : {}),
    });
    if (got.truncated || got.bytes.byteLength !== want)
      throw new PageSetError('The set’s file was cut short.');
    return got.bytes;
  };
}

/** A ZIP entry's local header: its fixed part, then its name and extra field. */
export const LOCAL_HEADER_BYTES = 30;

/**
 * Where an entry's bytes start in the set's file, from the fixed part of its local header (`header`, read at
 * `entry.offset`), or null when that isn't an entry's header as a page set has it (stored, no data descriptor).
 */
export function entryDataAt(entry: { offset: number }, header: Uint8Array): number | null {
  if (header.byteLength < LOCAL_HEADER_BYTES) return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== 0x04034b50 || view.getUint16(8, true) !== 0) return null;
  return entry.offset + LOCAL_HEADER_BYTES + view.getUint16(26, true) + view.getUint16(28, true);
}

/** The page a set opens on: the one it names, else its `index.html`. */
export function openingPage(manifest: Pick<PageSetManifest, 'open'> | null): string {
  return manifest?.open ?? PAGES_DEFAULT_OPEN;
}

/**
 * Where a file of a set is copied to be shared (bp-attachments.md BP-A19, BP-A21): `cache/shared/<attachment id>/<name>`,
 * its own name made safe, so the share sheet and other apps see “report.pdf”; the folder goes at sign-out and after a day.
 */
export function sharedCopyPath(attachmentId: string, path: string): { dir: string[]; name: string } {
  const safe = (s: string) => s.replace(/[/\\]/g, '_').replace(/^\.+/, '');
  return {
    dir: [SHARED_CACHE_DIR, safe(attachmentId).slice(0, 120) || 'file'],
    name: safe(pageFileName(path)).slice(0, 120) || 'file',
  };
}

/* The pages you went through ------------------------------------------------------------------------- */

export interface PageAt {
  path: string;
  hash: string;
  /** The page's `?…` (the web's frame puts it in the page's address; the phone's `about:blank` page can't have one). */
  query?: string;
}

/**
 * The pages opened in the viewer, the shown one last. Opening a page adds it; a page that sends you on before it was
 * shown (a redirect) takes its place, so Back never lands on it again.
 */
export function openedPage(pages: readonly PageAt[], page: PageAt, replace: boolean): PageAt[] {
  if (replace && pages.length > 0) return [...pages.slice(0, -1), page];
  return [...pages, page];
}

/** Back: the page before, or null when the first page is shown (Back closes the viewer then). */
export function pageBefore(pages: readonly PageAt[]): PageAt[] | null {
  return pages.length > 1 ? pages.slice(0, -1) : null;
}

/** The shown page's own title as the header's second line: only when it says something the set's title doesn't. */
export function pageSubtitle(setTitle: string, pageTitle: string | null | undefined): string | null {
  const t = pageTitle?.replace(/\s+/g, ' ').trim() ?? '';
  return t && t !== setTitle ? t : null;
}
