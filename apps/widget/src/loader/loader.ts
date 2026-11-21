/**
 * The loader behind `window.WhombatFeedback` (docs/decisions/feedback.md FB-03 … FB-07). One global, a closed
 * shadow root with an optional launcher, and a cross-origin iframe mounted on first open. It reads nothing from
 * the page but its own `<script>` attributes, the presence of declarative feedback controls and the context
 * listed in FB-07. The controls’ content is never collected or sent.
 *
 * The navigation trail (CT-161, AP-427): unless the script says `data-trail="off"`, the loader keeps the last 10 page
 * views of this tab on the site (sanitized URL, title, time) in the tab's `sessionStorage` and sends them with the
 * context; the frame sends them only when the site's config says `trail: true`.
 */
import type { WhombatFeedbackApi, WhombatFeedbackContextInput } from '@whombat/core/feedback';
import {
  cleanText,
  coarseBrowser,
  FEEDBACK_CONTEXT_LIMITS as LIMITS,
  sanitizeCustomContext,
  sanitizePageUrl,
  sanitizeReferences,
} from '@whombat/core/feedback/sanitize';
import {
  ATTRS,
  envelopeOf,
  type HostMessage,
  parseFrameMessage,
  parseTrail,
  READY_EVENT,
  type ReportType,
  randomToken,
  SITE_ID,
  SITE_KEY,
  type Theme,
  type TrailStep,
  type WidgetContext,
} from '../shared/protocol';
import { WIDGET_VERSION } from '../version';
import { FALLBACK_STYLES, loaderCss } from './styles';

export const GLOBAL_NAME = 'WhombatFeedback';
/** The frame has this long to say `ready` after it was mounted… */
export const READY_TIMEOUT_MS = 10_000;
/** …and this long after its document loaded (a refused `frame-ancestors` still fires `load`). */
export const LOAD_GRACE_MS = 4_000;
/**
 * How often the page address is compared (SPA navigation without events): always while the trail is recorded, else
 * while the panel is open.
 */
export const URL_POLL_MS = 1_000;
/** The host tab's `sessionStorage` key of the navigation trail (gone when the tab closes). */
export const TRAIL_KEY = 'whombat-feedback:trail';
const LOADER_PATH = '/embed/v1/';
const WARN = '[Whombat Feedback]';
/** The iframe's sandbox (FB-03; the handoff and docs/decisions/feedback.md FB-B03 explain each token). */
export const FRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';

export interface LoaderOptions {
  site: string;
  /**
   * The site key pin (`data-key`, `fbk_…`) of a managed Whombat's snippet: the frame runs in drop mode (Whombat
   * FD-27). Null for a self-hosted Whombat's snippet, and for anything that isn't a key (ignored).
   */
  key: string | null;
  /** Whombat's origin (`event.origin` of the frame's messages). */
  origin: string;
  /** Absolute URL ending in `/embed/v1/`. */
  base: string;
  theme: Theme;
  position: 'bottom-right' | 'bottom-left';
  launcher: 'floating' | 'custom';
  label: string;
  /** Record the navigation trail (`data-trail` isn't `off`). */
  trail: boolean;
}

/** Test and harness access to the internals of one installed loader (never exposed on the page). */
export interface LoaderHandle {
  api: WhombatFeedbackApi;
  options: LoaderOptions | null;
  instance: string;
  /** The shadow root (closed on the page), once mounted. */
  shadow(): ShadowRoot | null;
  host(): HTMLElement | null;
  frame(): HTMLIFrameElement | null;
}

type Win = Window & typeof globalThis;

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`${WARN} ${message}`);
}

/** Only for tests: forget which warnings were printed. */
export function resetWarnings(): void {
  warned.clear();
}

/** Our own `<script>`: `document.currentScript`, else the first `…/embed/v1/widget.js` with a `data-site`. */
export function findScript(doc: Document): HTMLScriptElement | null {
  const current = doc.currentScript;
  if (current && current.tagName === 'SCRIPT' && (current as HTMLScriptElement).src)
    return current as HTMLScriptElement;
  const candidates = Array.from(
    doc.querySelectorAll<HTMLScriptElement>('script[src*="/embed/v1/widget.js"]'),
  );
  return candidates.find((s) => s.hasAttribute(ATTRS.site)) ?? candidates[0] ?? null;
}

/** The options of a loader `<script>`, or the reason it stays inert. */
export function readOptions(script: HTMLScriptElement | null): LoaderOptions | string {
  if (!script) return 'its <script> tag wasn’t found.';
  let url: URL;
  try {
    url = new URL(script.src);
  } catch {
    return 'its script address isn’t valid.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'load widget.js over https.';
  const site = (script.getAttribute(ATTRS.site) ?? '').trim();
  if (!SITE_ID.test(site)) return `data-site is missing or isn’t a site id (fbs_…). Copy the snippet again.`;
  const key = (script.getAttribute(ATTRS.key) ?? '').trim();
  const at = url.pathname.indexOf(LOADER_PATH);
  const prefix = at > 0 ? url.pathname.slice(0, at) : '';
  const theme = script.getAttribute(ATTRS.theme);
  const label = cleanText(script.getAttribute(ATTRS.label) ?? '', 40);
  return {
    site,
    key: SITE_KEY.test(key) ? key : null,
    origin: url.origin,
    base: `${url.origin}${prefix}${LOADER_PATH}`,
    theme: theme === 'light' || theme === 'dark' ? theme : 'auto',
    position: script.getAttribute(ATTRS.position) === 'bottom-left' ? 'bottom-left' : 'bottom-right',
    launcher: script.getAttribute(ATTRS.launcher) === 'custom' ? 'custom' : 'floating',
    label: label || 'Feedback',
    trail: script.getAttribute(ATTRS.trail) !== 'off',
  };
}

interface SiteContext {
  app: WidgetContext['app'];
  custom: WidgetContext['custom'];
  references: string[];
}

function appField(value: unknown): string | null {
  return typeof value === 'string' ? cleanText(value, LIMITS.appField) || null : null;
}

/** What `setContext` keeps: capped app fields, scalar custom values (the frame applies the allowlist), references. */
export function siteContext(input: unknown): SiteContext {
  const ctx = (input && typeof input === 'object' ? input : {}) as WhombatFeedbackContextInput;
  const app = ctx.app && typeof ctx.app === 'object' ? ctx.app : null;
  const custom = ctx.custom && typeof ctx.custom === 'object' ? ctx.custom : {};
  return {
    app: app
      ? { version: appField(app.version), environment: appField(app.environment), build: appField(app.build) }
      : null,
    // Its own keys as the allowlist: valid keys, scalar values, capped; the integration's list applies in the frame.
    custom: sanitizeCustomContext(custom, Object.keys(custom)),
    references: sanitizeReferences(ctx.references),
  };
}

function dimension(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(20_000, Math.round(n))) : 0;
}

/**
 * Everything the loader sends to the frame (FB-07): no query, fragment, cookies, storage or DOM; with `trail`, the
 * recorded page views (copied).
 */
export function collectContext(win: Win, site: SiteContext, trail?: TrailStep[]): WidgetContext {
  const url = sanitizePageUrl(win.location.href);
  let timeZone: string | null = null;
  try {
    timeZone = cleanText(Intl.DateTimeFormat().resolvedOptions().timeZone ?? '', 64) || null;
  } catch {
    timeZone = null;
  }
  return {
    page: url ? { url, title: cleanText(win.document.title ?? '', LIMITS.title) || null } : null,
    browser: {
      name: coarseBrowser(win.navigator.userAgent),
      language: cleanText(win.navigator.language ?? '', 35) || null,
      viewport: { width: dimension(win.innerWidth), height: dimension(win.innerHeight) },
      timeZone,
    },
    app: site.app,
    custom: { ...site.custom },
    references: [...site.references],
    ...(trail ? { trail: trail.map((s) => ({ ...s })) } : {}),
  };
}

function svgIcon(doc: Document): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = doc.createElementNS(ns, 'path');
  path.setAttribute('d', 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z');
  svg.append(path);
  return svg;
}

function inline(el: HTMLElement, decls: Record<string, string>): void {
  for (const [k, v] of Object.entries(decls)) el.style.setProperty(k, v);
}

/** An API whose methods do nothing (inert loader, destroyed loader). */
function inertApi(reason: string): WhombatFeedbackApi {
  return Object.freeze({
    version: WIDGET_VERSION,
    ready: () => Promise.reject(new Error(`Whombat Feedback: ${reason}`)),
    open() {},
    close() {},
    isOpen: () => false,
    setContext() {},
    destroy() {},
  });
}

function defineGlobal(win: Win, api: WhombatFeedbackApi): void {
  Object.defineProperty(win, GLOBAL_NAME, {
    value: api,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

/**
 * Installs the loader on `win` once. A second copy (the script included twice, or run again) changes nothing and
 * warns once. Returns the handle, or null when another copy is already installed.
 */
export function install(
  win: Win,
  script: HTMLScriptElement | null = findScript(win.document),
): LoaderHandle | null {
  if (GLOBAL_NAME in win) {
    warnOnce('duplicate', 'widget.js is included more than once; only the first copy runs.');
    return null;
  }
  const doc = win.document;
  const instance = randomToken();
  const parsed = readOptions(script);
  if (typeof parsed === 'string') {
    warnOnce('inert', `the widget is off: ${parsed}`);
    const api = inertApi('the widget isn’t configured on this page.');
    defineGlobal(win, api);
    return { api, options: null, instance, shadow: () => null, host: () => null, frame: () => null };
  }
  const options = parsed;

  let destroyed = false;
  let open = false;
  let site: SiteContext = siteContext({});
  let host: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  let wrap: HTMLDivElement | null = null;
  let launcher: HTMLButtonElement | null = null;
  let panel: HTMLDivElement | null = null;
  let iframe: HTMLIFrameElement | null = null;
  let closeButton: HTMLButtonElement | null = null;
  let frameState: 'none' | 'loading' | 'ready' | 'unavailable' = 'none';
  let pendingType: ReportType | undefined;
  let returnFocus: HTMLElement | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastContext = '';
  /** Constructable stylesheets work here (else the inline fallback styles are used). */
  let adopted = false;
  const trailOn = options.trail;
  /** The page views so far (storage unavailable: kept in memory for this page). */
  let trail: TrailStep[] = [];
  try {
    if (trailOn) trail = parseTrail(JSON.parse(win.sessionStorage.getItem(TRAIL_KEY) ?? '[]')) ?? [];
    else win.sessionStorage.removeItem(TRAIL_KEY);
  } catch {
    trail = [];
  }

  /** Adds the current page (same address as the last step: only a new title), keeps the last 10, stores them. */
  const record = () => {
    const url = trailOn && sanitizePageUrl(win.location.href);
    if (!url) return;
    const title = cleanText(doc.title ?? '', LIMITS.title) || null;
    const last = trail[trail.length - 1];
    if (last?.url === url) {
      if (!title || last.title === title) return;
      last.title = title;
    } else trail = [...trail, { url, title, at: new Date().toISOString() }].slice(-LIMITS.trail);
    try {
      win.sessionStorage.setItem(TRAIL_KEY, JSON.stringify(trail));
    } catch {
      // Storage full or blocked: the trail lives in memory for this page.
    }
  };

  const post = (message: HostMessage) => {
    const target = iframe?.contentWindow;
    if (!target || frameState !== 'ready') return;
    target.postMessage(envelopeOf(instance, message), options.origin);
  };

  const context = () => {
    record();
    return collectContext(win, site, trailOn ? trail : undefined);
  };

  const pushContext = (force = false) => {
    if (!open || frameState !== 'ready') return;
    const ctx = context();
    const text = JSON.stringify(ctx);
    if (!force && text === lastContext) return;
    lastContext = text;
    post({ type: 'context', payload: { context: ctx } });
  };

  const onNavigate = () => {
    record();
    pushContext();
  };

  const watch = (on: boolean) => {
    if (on) {
      win.addEventListener('popstate', onNavigate);
      win.addEventListener('hashchange', onNavigate);
      pollTimer ??= setInterval(onNavigate, URL_POLL_MS);
    } else {
      win.removeEventListener('popstate', onNavigate);
      win.removeEventListener('hashchange', onNavigate);
      if (pollTimer !== undefined) clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  const setPanelState = () => {
    if (!panel) return;
    panel.dataset.state =
      frameState === 'ready' ? 'ready' : frameState === 'unavailable' ? 'unavailable' : 'loading';
  };

  /** Our host element or something inside it has focus (or nothing does). */
  const focusIsOurs = () => {
    const active = doc.activeElement;
    return !active || active === doc.body || active === host;
  };

  const restoreFocus = () => {
    if (!focusIsOurs()) return;
    const target = returnFocus?.isConnected ? returnFocus : launcher;
    returnFocus = null;
    target?.focus({ preventScroll: true });
  };

  const sendOpen = () => {
    const ctx = context();
    lastContext = JSON.stringify(ctx);
    post({ type: 'open', payload: pendingType ? { type: pendingType, context: ctx } : { context: ctx } });
    pendingType = undefined;
    iframe?.focus({ preventScroll: true });
  };

  const markUnavailable = () => {
    if (frameState === 'ready' || destroyed) return;
    frameState = 'unavailable';
    setPanelState();
    if (open) closeButton?.focus({ preventScroll: true });
  };

  const onMessage = (event: MessageEvent) => {
    if (destroyed || !iframe) return;
    if (event.origin !== options.origin || event.source !== iframe.contentWindow || event.source === null)
      return;
    const message = parseFrameMessage(event.data, instance);
    if (!message) return;
    switch (message.type) {
      case 'ready':
        clearTimeout(readyTimer);
        clearTimeout(loadTimer);
        frameState = 'ready';
        setPanelState();
        if (open) sendOpen();
        break;
      case 'close':
        api.close();
        break;
      case 'request-context':
        pushContext(true);
        break;
      case 'unavailable':
        // The frame shows its own short notice: a smaller panel is enough.
        if (panel) panel.dataset.size = 'compact';
        break;
      case 'submitted':
        // The frame shows the receipt; the reference stays in the frame.
        break;
    }
  };

  const onTrigger = (event: MouseEvent) => {
    if (destroyed || event.defaultPrevented || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof win.Element)) return;
    const trigger = target.closest(`[${ATTRS.trigger}]`);
    if (!(trigger instanceof win.HTMLElement)) return;
    event.preventDefault();
    const value = trigger.getAttribute(ATTRS.trigger);
    returnFocus = trigger;
    api.open(value === 'bug' || value === 'feature' ? { type: value } : undefined);
  };

  const sheet = (): CSSStyleSheet | null => {
    try {
      const s = new win.CSSStyleSheet();
      s.replaceSync(loaderCss());
      return s;
    } catch {
      return null;
    }
  };

  /** Only trigger presence is inspected: no site content is read or sent. */
  const syncLauncher = () => {
    if (!launcher) return;
    const custom = [...doc.querySelectorAll<HTMLElement>(`[${ATTRS.trigger}]`)].some((trigger) => {
      for (let element: HTMLElement | null = trigger; element; element = element.parentElement) {
        const style = win.getComputedStyle(element);
        if (
          element.matches(':disabled,[hidden],[inert]') ||
          style.display === 'none' ||
          style.visibility !== 'visible'
        )
          return false;
      }
      return true;
    });
    launcher.hidden = custom;
    launcher.style.display = custom ? 'none' : '';
  };
  const launcherObserver = new win.MutationObserver(syncLauncher);

  /** The host element with its closed shadow root (launcher only for `floating`). */
  const mount = () => {
    if (host || destroyed) return;
    const body = doc.body ?? doc.documentElement;
    host = doc.createElement('whombat-feedback');
    // Keep the page's CSS off our host element (CSSOM: allowed under a strict style-src).
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('display', 'block', 'important');
    shadow = host.attachShadow({ mode: 'closed' });
    const styles = sheet();
    adopted = Boolean(styles && 'adoptedStyleSheets' in shadow);
    if (styles && adopted) shadow.adoptedStyleSheets = [styles];
    wrap = doc.createElement('div');
    wrap.className = 'wb';
    wrap.dataset.theme = options.theme;
    wrap.dataset.position = options.position;
    wrap.dataset.launcher = options.launcher;
    if (options.launcher === 'floating') {
      launcher = doc.createElement('button');
      launcher.type = 'button';
      launcher.className = 'launcher';
      launcher.setAttribute('aria-haspopup', 'dialog');
      launcher.setAttribute('aria-expanded', 'false');
      const text = doc.createElement('span');
      text.textContent = options.label;
      launcher.append(svgIcon(doc), text);
      launcher.addEventListener('click', () => {
        if (open) api.close();
        else {
          returnFocus = launcher;
          api.open();
        }
      });
      if (!adopted) {
        inline(launcher, FALLBACK_STYLES.launcher);
        launcher.style.setProperty(options.position === 'bottom-left' ? 'left' : 'right', '20px');
      }
      wrap.append(launcher);
    }
    panel = doc.createElement('div');
    panel.className = 'panel';
    panel.hidden = true;
    panel.dataset.state = 'loading';
    const status = doc.createElement('p');
    status.className = 'status';
    status.textContent = 'Loading…';
    const notice = doc.createElement('div');
    notice.className = 'notice';
    notice.setAttribute('role', 'dialog');
    notice.setAttribute('aria-labelledby', 'wb-notice-title');
    notice.setAttribute('aria-describedby', 'wb-notice-text');
    const title = doc.createElement('h2');
    title.id = 'wb-notice-title';
    title.textContent = options.label;
    const text = doc.createElement('p');
    text.id = 'wb-notice-text';
    text.setAttribute('role', 'status');
    text.textContent = 'Feedback is unavailable right now.';
    closeButton = doc.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'close';
    closeButton.textContent = 'Close';
    closeButton.addEventListener('click', () => api.close());
    notice.append(title, text, closeButton);
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        api.close();
      }
    });
    panel.append(status, notice);
    if (!adopted) {
      inline(panel, FALLBACK_STYLES.panel);
      panel.style.setProperty(options.position === 'bottom-left' ? 'left' : 'right', '20px');
    }
    wrap.append(panel);
    shadow.append(wrap);
    body.append(host);
    if (launcher) {
      syncLauncher();
      launcherObserver.observe(doc.documentElement, {
        childList: true,
        subtree: true,
        attributeFilter: [ATTRS.trigger, 'hidden', 'inert', 'disabled', 'class', 'style'],
      });
    }
  };

  const ensureFrame = () => {
    mount();
    if (iframe || !panel) return;
    iframe = doc.createElement('iframe');
    // Without a key the URL is exactly the direct widget's (a self-hosted Whombat's frame never sees `key`).
    const key = options.key ? `&key=${encodeURIComponent(options.key)}` : '';
    const query = `site=${encodeURIComponent(options.site)}&parent=${encodeURIComponent(win.location.origin)}&theme=${options.theme}${key}`;
    iframe.src = `${options.base}frame.html?${query}#instance=${instance}`;
    iframe.title = `${options.label} form`;
    iframe.setAttribute('allow', '');
    iframe.setAttribute('sandbox', FRAME_SANDBOX);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    if (!adopted) inline(iframe, FALLBACK_STYLES.frame);
    iframe.addEventListener('load', () => {
      if (frameState !== 'loading') return;
      clearTimeout(loadTimer);
      loadTimer = setTimeout(markUnavailable, LOAD_GRACE_MS);
    });
    frameState = 'loading';
    readyTimer = setTimeout(markUnavailable, READY_TIMEOUT_MS);
    panel.prepend(iframe);
    setPanelState();
  };

  const onDomReady = () => {
    doc.removeEventListener('DOMContentLoaded', onDomReady);
    if (!destroyed && options.launcher === 'floating') mount();
  };

  const api: WhombatFeedbackApi = Object.freeze({
    version: WIDGET_VERSION,
    ready(): Promise<WhombatFeedbackApi> {
      return destroyed
        ? Promise.reject(new Error('Whombat Feedback was removed from this page.'))
        : Promise.resolve(api);
    },
    open(opts?: { type?: 'bug' | 'feature' }) {
      if (destroyed) return;
      const type = opts && (opts.type === 'bug' || opts.type === 'feature') ? opts.type : undefined;
      pendingType = type;
      if (!open) {
        const active = doc.activeElement;
        if (!returnFocus && active instanceof win.HTMLElement && active !== doc.body && active !== host)
          returnFocus = active;
      }
      ensureFrame();
      if (!panel) return;
      const wasOpen = open;
      open = true;
      panel.hidden = false;
      launcher?.setAttribute('aria-expanded', 'true');
      if (!wasOpen) watch(true);
      if (frameState === 'ready') sendOpen();
      else if (frameState === 'unavailable') closeButton?.focus({ preventScroll: true });
    },
    close() {
      if (destroyed || !open) return;
      open = false;
      pendingType = undefined;
      watch(trailOn);
      if (panel) panel.hidden = true;
      launcher?.setAttribute('aria-expanded', 'false');
      post({ type: 'close', payload: {} });
      restoreFocus();
    },
    isOpen: () => !destroyed && open,
    setContext(input: WhombatFeedbackContextInput) {
      if (destroyed) return;
      site = siteContext(input);
      pushContext();
    },
    destroy() {
      if (destroyed) return;
      const hadFocus = open && focusIsOurs();
      const back = returnFocus;
      destroyed = true;
      open = false;
      launcherObserver.disconnect();
      watch(false);
      clearTimeout(readyTimer);
      clearTimeout(loadTimer);
      win.removeEventListener('message', onMessage);
      doc.removeEventListener('click', onTrigger);
      doc.removeEventListener('DOMContentLoaded', onDomReady);
      host?.remove();
      host = shadow = wrap = launcher = panel = iframe = closeButton = null;
      returnFocus = null;
      if (hadFocus && back?.isConnected) back.focus({ preventScroll: true });
    },
  });

  win.addEventListener('message', onMessage);
  doc.addEventListener('click', onTrigger);
  if (trailOn) {
    record();
    watch(true);
  }
  if (options.launcher === 'floating') {
    if (doc.body) mount();
    else doc.addEventListener('DOMContentLoaded', onDomReady);
  }
  defineGlobal(win, api);
  doc.dispatchEvent(new win.CustomEvent(READY_EVENT));
  return { api, options, instance, shadow: () => shadow, host: () => host, frame: () => iframe };
}
