/**
 * The look an agent's page gets in a message (docs/decisions/visual-replies.md): the app's colours, fonts and corner
 * radius as CSS variables, plus a small base sheet, in one `<style>` put first in the page so the page's own CSS wins.
 * The values come from `@whombat/tokens` (`pageThemeCss`); this side names the variables agents may use and puts the
 * sheet in place. Pure (no DOM), so web, mobile and the runner's page check share it.
 */

/** The id of the style element that carries the theme (the web frame swaps its text when the theme changes). */
export const PAGE_STYLE_ID = 'whombat-page';

/** The CSS variables every page gets, in both themes (`@whombat/tokens` `pageThemeVars` sets exactly these). */
export const PAGE_THEME_VARIABLES = [
  '--background',
  '--foreground',
  '--muted',
  '--muted-foreground',
  '--card',
  '--card-foreground',
  '--border',
  '--input',
  '--ring',
  '--primary',
  '--primary-foreground',
  '--accent',
  '--success',
  '--warning',
  '--destructive',
  '--code-background',
  '--code-foreground',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-wash',
  '--radius',
  '--font-sans',
  '--font-mono',
] as const;

/** A page's height in a message, in CSS pixels: the frame grows with the page between these (full screen shows all). */
export const PAGE_MIN_HEIGHT = 80;
export const PAGE_MAX_HEIGHT = 2000;

/** The width of a page in a message on a computer, in CSS pixels (about 360 on a phone). */
export const PAGE_WIDTH = 720;

/**
 * What an agent needs to know to draw a page that looks at home in a message (the tool descriptions and the prompt
 * carry it).
 */
export const PAGE_GUIDE = `It shows at the reply's width (about ${PAGE_WIDTH} px, 360 on a phone) in the reader's light or dark theme and grows to fit, up to ${PAGE_MAX_HEIGHT} px. Use the theme's CSS variables, not fixed colours: ${PAGE_THEME_VARIABLES.join(', ')}. The page already sets the background, text colour, font and margin: add no page background, outer card or title banner; use fluid widths and fixed chart heights in px, no vh. It runs inline scripts and styles without network access: embed assets as data URLs, draw charts with SVG or canvas, and put the data in the page.`;

/** A BOM, whitespace and comments, then a doctype: what may come before the style without leaving the head. */
const LEAD_DOCTYPE = /^﻿?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i;

/**
 * The policy every agent's page runs under (web AP-320, mobile AP-328; the web frame page's own meta,
 * apps/web/public/sandbox/html-frame.html, says the same): inline scripts and styles, bundled runtimes and embedded assets only.
 * Remote resource loads can carry private data in their URLs even when fetch is blocked.
 */
export const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' data:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join('; ');

/** The style element for `css` (nothing in it can end the element). */
export function pageStyleElement(css: string): string {
  return `<style id="${PAGE_STYLE_ID}">${css.replace(/</g, '\\3c ')}</style>`;
}

/**
 * The page with `css` as its first style (right after its doctype, given one when it has none): the parser puts it in
 * the head, and every rule of the page itself comes later and wins.
 */
export function withPageStyle(html: string, css: string): string {
  return withLead(html, pageStyleElement(css));
}

/**
 * A page that loads on its own (the phone's WebView, the runner's page check) as a message's frame shows it: the policy
 * as its very first element (a meta policy covers only what follows it), no referrer, the device's width as the
 * viewport unless the page sets its own (a later viewport meta wins), then the theme sheet when there is one.
 */
export function framedPage(html: string, css?: string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1">`;
  return withLead(html, css === undefined ? head : `${head}${pageStyleElement(css)}`);
}

/** The WHATWG URL parser every runtime has (browsers, Node, Hermes); core's lib names no DOM, so declared here. */
declare const URL: new (input: string) => { readonly origin: string };

/** A box's direct socket on its Tailscale name (`wss://<box>.<tailnet>.ts.net:<port>/v1/direct`, CT-1252). */
export const TAILSCALE_SOCKETS = 'wss://*.ts.net:*';

/** What the app's page policy depends on: where the hosted app talks to, or that it is a box's own page. */
export interface AppPagePolicyOptions {
  controlUrl: string;
  /** Relay origins (`wss://relay.whombat.com`, `wss://*.relay.whombat.com`). */
  relayOrigins: readonly string[];
  /** The box's own page: it talks only to its own origin's direct socket (`connect-src 'self'`). */
  box?: boolean;
}

/**
 * The app's own Content-Security-Policy (both builds; apps/web/hosted.ts explains each part). It lives here so the
 * box's server can send the same header on its own address as the web build writes. `forHeader` adds what a `<meta>`
 * can't carry.
 */
export function contentSecurityPolicy(o: AppPagePolicyOptions, forHeader: boolean): string {
  const connect = o.box ? ["'self'"] : [new URL(o.controlUrl).origin, ...o.relayOrigins, TAILSCALE_SOCKETS];
  const directives = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' blob: data:",
    // Audio and video attachments play from decrypted object URLs (AP-326).
    'media-src blob:',
    // The box itself, first, on its Tailscale name (HE-50; `directRoutesFor` keeps only `wss://` on an https page); the
    // box's own page only its own origin's socket.
    `connect-src ${connect.join(' ')}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    // The HTML preview frame only (AP-320): same origin, `sandbox="allow-scripts"`, its own policy below.
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    ...(forHeader ? ["frame-ancestors 'none'", ...(o.box ? [] : ['upgrade-insecure-requests'])] : []),
  ];
  return directives.join('; ');
}

/**
 * `lead` right after a leading doctype; a fragment without one gets one first, so it renders in standards mode (in
 * quirks mode the root fills the frame and the page could never say how tall it really is).
 */
function withLead(html: string, lead: string): string {
  const doctype = LEAD_DOCTYPE.exec(html);
  if (doctype) return `${doctype[0]}${lead}${html.slice(doctype[0].length)}`;
  return `<!doctype html>${lead}${html}`;
}
