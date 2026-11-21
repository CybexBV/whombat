/**
 * A `browser_preview`'s screenshot in the agent's Chromium (hermes-engine.md HE-S142, browser.md BT-48…BT-50; one-person.md
 * OP-S113): the folder's files, read by the runner, open there as a website of their own, in a browser context of
 * their own (no cookies, nothing of Hermes's pages), served from memory by CDP's `Fetch` domain at
 * `https://preview.whombat.invalid` — no port, no file for the commands, a secure context. Offline, every request to
 * another address fails; online, it goes out like any page of the agent's browser (the commands' network). A 1280×800
 * screenshot, the title, and whether `find` was on the page.
 */
import {
  PAGE_MAX_HEIGHT,
  PAGE_MIN_HEIGHT,
  PAGE_PREVIEW_CONSOLE_LINE,
  PAGE_PREVIEW_MAX_CONSOLE,
  type PreviewPage,
} from '@whombat/core';
import type { CdpClient, CdpEvent } from './cdp';

/** Where a preview's files are served, in the agent's Chromium only (never a real address). */
export const PREVIEW_ORIGIN = 'https://preview.whombat.invalid';
const VIEWPORT = { width: 1280, height: 800 } as const;
/** How long the page may take to load before the screenshot is taken anyway. */
const LOAD_MS = 20_000;

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  pdf: 'application/pdf',
};

export function typeOf(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

/**
 * What a preview serves for a path (BT-49): `/` and `/dir/` → `index.html`; `/route` → `route`, `route.html`,
 * `route/index.html`; else the folder's `404.html` (404) or a plain 404.
 */
export function servedFile(
  files: ReadonlyMap<string, unknown>,
  pathname: string,
): { status: number; path: string | null } {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    rel = pathname.replace(/^\/+/, '');
  }
  const candidates =
    rel === '' || rel.endsWith('/') ? [`${rel}index.html`] : [rel, `${rel}.html`, `${rel}/index.html`];
  for (const c of candidates) if (files.has(c)) return { status: 200, path: c };
  return files.has('404.html') ? { status: 404, path: '404.html' } : { status: 404, path: null };
}

export interface PreviewRender {
  path: string;
  find: string | null;
  online: boolean;
}

export interface PreviewShotResult {
  /** base64 */
  png: string;
  title: string;
  found: boolean | null;
}

/** The script that scrolls the first text containing `find` into view: whether it found one. */
function findScript(find: string): string {
  return `(() => {
  const want = ${JSON.stringify(find.toLowerCase())};
  const walk = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if ((n.textContent || '').toLowerCase().includes(want) && n.parentElement) {
      n.parentElement.scrollIntoView({ block: 'center' });
      return true;
    }
  }
  return false;
})()`;
}

/** A file to serve: base64 (a preview's upload) or its bytes (a page set's, made base64 only when the page asks). */
export type ServedData = string | Uint8Array;

/** Renders `files` in the agent's Chromium and takes the screenshot. */
export async function previewShot(
  cdp: CdpClient,
  files: readonly { path: string; data: ServedData }[],
  render: PreviewRender,
  loadMs = LOAD_MS,
): Promise<PreviewShotResult> {
  const served = new Map(files.map((f) => [f.path.replace(/^\/+/, ''), f.data]));
  const { browserContextId } = await cdp.send<{ browserContextId: string }>('Target.createBrowserContext', {
    disposeOnDetach: true,
  });
  let sessionId: string | null = null;
  const off: (() => void)[] = [];
  try {
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    ({ sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    }));
    const session = sessionId;
    let loaded: () => void = () => {};
    const load = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    off.push(
      cdp.on((e: CdpEvent) => {
        if (e.sessionId !== session) return;
        if (e.method === 'Page.loadEventFired') loaded();
        if (e.method === 'Fetch.requestPaused') void answer(cdp, session, e.params, served, render.online);
      }),
    );
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, session);
    await cdp.send('Page.enable', {}, session);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { ...VIEWPORT, deviceScaleFactor: 1, mobile: false },
      session,
    );
    const nav = await cdp.send<{ errorText?: string }>(
      'Page.navigate',
      { url: `${PREVIEW_ORIGIN}${render.path || '/'}` },
      session,
    );
    if (nav.errorText) throw new Error(`the page didn’t load (${nav.errorText})`);
    await Promise.race([load, new Promise((r) => setTimeout(r, loadMs))]);
    // Fonts and late layout settle a moment.
    await new Promise((r) => setTimeout(r, 300));
    let found: boolean | null = null;
    if (render.find) {
      const r = await cdp.send<{ result: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: findScript(render.find), returnByValue: true },
        session,
      );
      found = r.result.value === true;
      await new Promise((r) => setTimeout(r, 150));
    }
    const title = await cdp.send<{ result: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: 'document.title', returnByValue: true },
      session,
    );
    const shot = await cdp.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'png', clip: { x: 0, y: 0, ...VIEWPORT, scale: 1 }, captureBeyondViewport: false },
      session,
    );
    return {
      png: shot.data,
      title: typeof title.result.value === 'string' ? title.result.value.slice(0, 300) : '',
      found,
    };
  } finally {
    for (const o of off) o();
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

export interface PageShotResult extends PreviewShotResult {
  /** The page's height as a message's frame measures it. */
  height: number;
  /** What the page wrote to the console, errors first. */
  console: string[];
  /** Requests refused because the page may not reach the internet. */
  blocked: number;
}

/** The page's own height, as the message's frame measures it (apps/web/public/sandbox/html-frame.js). */
const HEIGHT_SCRIPT = `(async () => {
  try { await document.fonts.ready; } catch {}
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const root = document.documentElement;
  return Math.ceil(Math.max(root ? root.getBoundingClientRect().height : 0, document.body ? document.body.scrollHeight : 0));
})()`;

/** A console line in a few words: its level and text, cut to the contract's length. */
function consoleLine(level: string, text: string): string {
  const line = `${level}: ${text.replace(/\s+/g, ' ').trim()}`;
  return line.length > PAGE_PREVIEW_CONSOLE_LINE ? `${line.slice(0, PAGE_PREVIEW_CONSOLE_LINE - 1)}…` : line;
}

/** A console call's arguments as text. */
function consoleText(args: unknown): string {
  if (!Array.isArray(args)) return '';
  return args
    .map((a: { value?: unknown; description?: string; type?: string }) =>
      a.value !== undefined
        ? typeof a.value === 'string'
          ? a.value
          : JSON.stringify(a.value)
        : (a.description ?? a.type ?? ''),
    )
    .join(' ');
}

/**
 * A page for `page_preview` (docs/decisions/visual-replies.md), drawn like a preview's folder (a context of its own,
 * served from memory, always offline) at the page's width: its height as a message measures it,
 * the screenshot of what a message shows (that height, within the frame's limits), its console lines and the requests
 * refused offline.
 */
export async function pageShot(cdp: CdpClient, page: PreviewPage, loadMs = LOAD_MS): Promise<PageShotResult> {
  const served = new Map([['index.html', Buffer.from(page.html, 'utf8').toString('base64')]]);
  const { browserContextId } = await cdp.send<{ browserContextId: string }>('Target.createBrowserContext', {
    disposeOnDetach: true,
  });
  const off: (() => void)[] = [];
  const errors: string[] = [];
  const others: string[] = [];
  const counts = { blocked: 0 };
  const note = (level: string, text: string) => {
    if (!text) return;
    (level === 'error' ? errors : others).push(consoleLine(level, text));
  };
  try {
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    const { sessionId: session } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    let loaded: () => void = () => {};
    const load = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    off.push(
      cdp.on((e: CdpEvent) => {
        if (e.sessionId !== session) return;
        const p = e.params;
        if (e.method === 'Page.loadEventFired') loaded();
        else if (e.method === 'Fetch.requestPaused') void answer(cdp, session, p, served, false, counts);
        else if (e.method === 'Runtime.consoleAPICalled') {
          const type = String(p.type ?? 'log');
          note(
            type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'warning' : 'log',
            consoleText(p.args),
          );
        } else if (e.method === 'Runtime.exceptionThrown') {
          const d = p.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
          note('error', d?.exception?.description ?? d?.text ?? 'an error');
        } else if (e.method === 'Log.entryAdded') {
          const entry = p.entry as { level?: string; text?: string } | undefined;
          // A request refused offline is counted in `blocked`, not repeated as a console line.
          const text = entry?.text ?? '';
          if (
            (entry?.level === 'error' || entry?.level === 'warning') &&
            !text.includes('ERR_BLOCKED_BY_CLIENT')
          )
            note(entry.level, text);
        }
      }),
    );
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, session);
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    await cdp.send('Log.enable', {}, session);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: page.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false },
      session,
    );
    const nav = await cdp.send<{ errorText?: string }>(
      'Page.navigate',
      { url: `${PREVIEW_ORIGIN}/` },
      session,
    );
    if (nav.errorText) throw new Error(`the page didn’t load (${nav.errorText})`);
    await Promise.race([load, new Promise((r) => setTimeout(r, loadMs))]);
    const measured = await cdp.send<{ result: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: HEIGHT_SCRIPT, awaitPromise: true, returnByValue: true },
      session,
    );
    // Late layout (charts drawn after load) settles a moment.
    await new Promise((r) => setTimeout(r, 300));
    const again = await cdp.send<{ result: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: HEIGHT_SCRIPT, awaitPromise: true, returnByValue: true },
      session,
    );
    const value = typeof again.result.value === 'number' ? again.result.value : measured.result.value;
    const height = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.ceil(value)) : 0;
    const shown = Math.min(PAGE_MAX_HEIGHT, Math.max(PAGE_MIN_HEIGHT, height));
    const title = await cdp.send<{ result: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression: 'document.title', returnByValue: true },
      session,
    );
    const shot = await cdp.send<{ data: string }>(
      'Page.captureScreenshot',
      {
        format: 'png',
        clip: { x: 0, y: 0, width: page.width, height: shown, scale: 1 },
        captureBeyondViewport: true,
      },
      session,
    );
    const lines = [...errors, ...others];
    return {
      png: shot.data,
      title: typeof title.result.value === 'string' ? title.result.value.slice(0, 300) : '',
      found: null,
      height,
      console:
        lines.length > PAGE_PREVIEW_MAX_CONSOLE
          ? [
              ...lines.slice(0, PAGE_PREVIEW_MAX_CONSOLE - 1),
              `${lines.length - PAGE_PREVIEW_MAX_CONSOLE + 1} more console lines left out`,
            ]
          : lines,
      blocked: counts.blocked,
    };
  } finally {
    for (const o of off) o();
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

/** One paused request: a preview file, or the web (online), or nothing (offline, counted in `counts`). */
async function answer(
  cdp: CdpClient,
  sessionId: string,
  params: Record<string, unknown>,
  served: ReadonlyMap<string, ServedData>,
  online: boolean,
  counts?: { blocked: number },
): Promise<void> {
  const requestId = String(params.requestId);
  const url = String((params.request as { url?: unknown } | undefined)?.url ?? '');
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {}
  try {
    if (parsed && parsed.origin === PREVIEW_ORIGIN) {
      const hit = servedFile(served, parsed.pathname);
      const data = hit.path ? (served.get(hit.path) ?? '') : Buffer.from('Not found').toString('base64');
      const body =
        typeof data === 'string'
          ? data
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
      await cdp.send(
        'Fetch.fulfillRequest',
        {
          requestId,
          responseCode: hit.status,
          responseHeaders: [
            { name: 'content-type', value: hit.path ? typeOf(hit.path) : 'text/plain; charset=utf-8' },
            { name: 'cache-control', value: 'no-store' },
          ],
          body,
        },
        sessionId,
      );
    } else if (online || url.startsWith('data:') || url.startsWith('blob:'))
      await cdp.send('Fetch.continueRequest', { requestId }, sessionId);
    else {
      if (counts) counts.blocked++;
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId);
    }
  } catch {
    // The page went on without it.
  }
}
