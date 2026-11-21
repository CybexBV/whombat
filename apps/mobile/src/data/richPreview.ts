/**
 * Rich messages on mobile (assignment item 8, docs/decisions/ui-improvements.md AP-328): the pure half. An agent's
 * HTML page shows in a `react-native-webview` confined like the web's sandboxed frame: the same Content-Security-Policy
 * as a meta tag at the very top of the page (inline scripts and styles, bundled runtimes and embedded assets only), JavaScript on,
 * no storage, no files, no new windows, and no navigation at all once the page is loaded. No React Native imports:
 * unit-tested.
 */
import { framedPage, PAGE_MAX_HEIGHT, PAGE_MIN_HEIGHT, PAGE_POLICY } from '@whombat/core';

/** The web's frame policy (`PAGE_POLICY`, the web frame page's own meta; checked by the test). */
export const HTML_PREVIEW_CSP = PAGE_POLICY;

/**
 * The page with the policy as its very first element (right after a leading doctype, else at the start), no referrer,
 * the phone's width as the viewport, then the app's theme sheet (`css`, `pageThemeCss`) so the page looks like the app
 * (`framedPage`).
 */
export function withPreviewPolicy(html: string, css?: string): string {
  return framedPage(html, css);
}

/**
 * Whether the preview may load `url`: only the page itself, which both platforms load from the HTML string as
 * `about:blank` (Android doesn't even ask for it). Every other navigation (a link, `location = …`, a `data:` page that
 * would not carry the policy, a form, a new window) is refused, and never handed to the system either.
 */
export function previewMayLoad(url: string): boolean {
  return url === 'about:blank';
}

/**
 * The WebView's settings for a preview (react-native-webview 13 props). `originWhitelist` matches everything on
 * purpose: the library opens a URL that doesn't match it in the system browser (`Linking.openURL`), which would let a
 * page send people (and data in the URL) anywhere; with everything matching, `onShouldStartLoadWithRequest` refuses it
 * instead.
 */
export const PREVIEW_WEBVIEW_PROPS = {
  originWhitelist: ['*'] as string[],
  javaScriptEnabled: true,
  javaScriptCanOpenWindowsAutomatically: false,
  setSupportMultipleWindows: false,
  domStorageEnabled: false,
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  allowsLinkPreview: false,
  geolocationEnabled: false,
  incognito: true,
  cacheEnabled: false,
  thirdPartyCookiesEnabled: false,
  sharedCookiesEnabled: false,
  mediaPlaybackRequiresUserAction: true,
  mixedContentMode: 'never' as const,
  // An array: the native prop is a list (a bare string crashes the new architecture's prop parser).
  dataDetectorTypes: ['none'] as 'none'[],
  textZoom: 100,
  setBuiltInZoomControls: false,
  webviewDebuggingEnabled: false,
  onShouldStartLoadWithRequest: (request: { url: string }) => previewMayLoad(request.url),
};

/**
 * How many times a preview whose browser crashed starts again by itself before it waits for the person's “Try again”:
 * a page that keeps crashing its browser shouldn't loop.
 */
export const PREVIEW_AUTO_RESTARTS = 2;

/** How long a page must stay up after it loaded before its earlier crashes are forgotten. */
export const PREVIEW_STEADY_MS = 10_000;

/**
 * After a preview's browser went: `remount` when Android let it go for memory (nothing wrong with the page; it comes
 * back once the app is in front), `restart` after a crash while restarts are left, else `offer` “Try again”.
 */
export function afterPreviewGone(restarts: number, crashed: boolean): 'remount' | 'restart' | 'offer' {
  if (!crashed) return 'remount';
  return restarts < PREVIEW_AUTO_RESTARTS ? 'restart' : 'offer';
}

/** The card's page height in a message until the page says how tall it is (the full-screen view fills the screen). */
export const PREVIEW_CARD_HEIGHT = 300;

/**
 * Reports the page's own height to the app (docs/decisions/visual-replies.md), measured as the web's frame does: on
 * every resize, and now and then for pages that size themselves late. Injected by the WebView, outside the page's
 * policy; the page itself can post too, so the app reads only a clamped number ({@link pageHeight}).
 */
export const PAGE_HEIGHT_SCRIPT = `(function(){var last=-1;function r(){var root=document.documentElement;var h=Math.ceil(Math.max(root?root.getBoundingClientRect().height:0,document.body?document.body.scrollHeight:0));if(h===last)return;last=h;window.ReactNativeWebView.postMessage(JSON.stringify({type:'whombat.height',height:h}));}var o=new ResizeObserver(r);if(document.documentElement)o.observe(document.documentElement);if(document.body)o.observe(document.body);r();setInterval(r,1000);})();true;`;

/** The height a page's message asks for, within a message's limits; null for anything else. */
export function pageHeight(data: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const d = parsed as { type?: unknown; height?: unknown } | null;
  if (d?.type !== 'whombat.height' || typeof d.height !== 'number' || !Number.isFinite(d.height)) return null;
  return Math.min(PAGE_MAX_HEIGHT, Math.max(PAGE_MIN_HEIGHT, Math.ceil(d.height)));
}

/** Heading sizes for `#`…`######` in a bubble whose text is `base` (a modest chat scale, like the web). */
export function headingSize(level: number, base: number): { size: number; weight: 600 | 700 } {
  const scale = [1.25, 1.12, 1.03, 1, 0.94, 0.94][Math.min(6, Math.max(1, level)) - 1] ?? 1;
  return { size: Math.round(base * scale * 10) / 10, weight: level <= 3 ? 700 : 600 };
}

/** Whether this device draws AVIF images (Android 12+, iOS 16+). */
export function supportsAvif(os: string, version: string | number): boolean {
  const major = typeof version === 'number' ? version : Number.parseInt(version, 10);
  if (os === 'android') return major >= 31;
  if (os === 'ios') return major >= 16;
  return false;
}
