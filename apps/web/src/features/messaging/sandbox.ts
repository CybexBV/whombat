/**
 * The HTML preview frame's protocol and the documents the app writes into it (AP-320, AP-323). The frame is the static
 * `/sandbox/html-frame.html` (public/sandbox/) in `<iframe sandbox="allow-scripts">`: an opaque origin under its own
 * Content-Security-Policy, so an agent's page runs its scripts with embedded assets, but can't
 * reach the app, its storage or the network (hosted.ts `sandboxContentSecurityPolicy`).
 *
 * - The frame says `{type: 'whombat.ready'}` whenever its page starts: first, and again when moving the frame in the
 *   app's document reloaded it (AP-5348).
 * - The app answers `{type: 'whombat.html', html}` to that frame's window, with target origin `*` (the frame's origin
 *   is opaque: no other target would match). A page that says it's ready itself gets its own HTML again, nothing more.
 *   An agent's page carries the app's theme as its first style (`withPageStyle`, docs/decisions/visual-replies.md).
 * - When the app's theme changes it sends `{type: 'whombat.theme', css}`: the frame puts that text in the page's theme
 *   style (`PAGE_STYLE_ID`), so the page follows light and dark without starting again.
 * - The frame reports `{type: 'whombat.height', height}`. The app reads nothing else, and only from that frame's
 *   window; the height is clamped, so a page can't make the message taller than the limit.
 */

import { PAGE_MAX_HEIGHT, PAGE_MIN_HEIGHT } from '@whombat/core';

/** The frame page (public/sandbox/html-frame.html). */
export const SANDBOX_FRAME_URL = '/sandbox/html-frame.html';

/** Every frame of an HTML page or a diagram gets exactly this: scripts, nothing else (no same-origin, popups, forms). */
export const SANDBOX_FLAGS = 'allow-scripts';

export interface HtmlMessage {
  type: 'whombat.html';
  html: string;
}

export interface ThemeMessage {
  type: 'whombat.theme';
  css: string;
}

/** Whether a frame message says the frame page has started and wants its page. */
export function frameReady(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { type?: unknown }).type === 'whombat.ready';
}

/** A page's height in a message: at least this, at most {@link FRAME_MAX_HEIGHT} (full screen fills the window). */
export const FRAME_MIN_HEIGHT = PAGE_MIN_HEIGHT;
export const FRAME_MAX_HEIGHT = PAGE_MAX_HEIGHT;
/** Before the page has said how tall it is. */
export const FRAME_INITIAL_HEIGHT = 320;

/** The height a frame message asks for, clamped; null when the message isn't a height report. */
export function frameHeight(data: unknown, min = FRAME_MIN_HEIGHT, max = FRAME_MAX_HEIGHT): number | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { type?: unknown; height?: unknown };
  if (d.type !== 'whombat.height' || typeof d.height !== 'number' || !Number.isFinite(d.height)) return null;
  return Math.min(max, Math.max(min, Math.ceil(d.height)));
}

export { type DiagramTheme, escapeHtml, mermaidDocument } from '@whombat/client';

/** A file name for a page's download: its title as a slug, else `page`. */
export function htmlFileName(title: string | null): string {
  const slug = (title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${slug || 'page'}.html`;
}
