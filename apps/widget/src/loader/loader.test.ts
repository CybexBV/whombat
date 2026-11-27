import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_TAG, type WidgetContext } from '../shared/protocol';
import {
  collectContext,
  GLOBAL_NAME,
  install,
  LOAD_GRACE_MS,
  type LoaderHandle,
  READY_TIMEOUT_MS,
  readOptions,
  resetWarnings,
  siteContext,
  TRAIL_KEY,
  URL_POLL_MS,
} from './loader';

const WHOMBAT = 'https://whombat.example.com';
const SITE = 'fbs_abcdefghijklmnopqrstuvwx';
type Win = Window & typeof globalThis;

function script(
  attrs: Record<string, string> = {},
  src = `${WHOMBAT}/embed/v1/widget.js`,
): HTMLScriptElement {
  const s = document.createElement('script');
  s.setAttribute('src', src);
  s.setAttribute('data-site', SITE);
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  document.head.append(s);
  return s;
}

let handle: LoaderHandle | null = null;
let warn: ReturnType<typeof vi.spyOn>;

function load(attrs: Record<string, string> = {}, src?: string): LoaderHandle {
  const h = install(window as Win, script(attrs, src));
  if (!h) throw new Error('not installed');
  handle = h;
  return h;
}

/** Messages the loader posted to the frame: [data, targetOrigin]. */
function posted(h: LoaderHandle): ReturnType<typeof vi.fn> {
  const frame = h.frame();
  if (!frame?.contentWindow) throw new Error('no frame');
  const spy = vi.fn();
  frame.contentWindow.postMessage = spy as unknown as Window['postMessage'];
  return spy;
}

function fromFrame(
  h: LoaderHandle,
  type: string,
  payload: unknown = {},
  over: { origin?: string; source?: unknown; instance?: string; wb?: string } = {},
): void {
  const event = new MessageEvent('message', {
    data: { wb: over.wb ?? BRIDGE_TAG, instance: over.instance ?? h.instance, type, payload },
    origin: over.origin ?? WHOMBAT,
    source: (over.source === undefined ? h.frame()?.contentWindow : over.source) as MessageEventSource | null,
  });
  window.dispatchEvent(event);
}

function lastPayloadType(spy: ReturnType<typeof vi.fn>): string | undefined {
  const data = spy.mock.calls.at(-1)?.[0] as { payload: { type?: string } } | undefined;
  return data?.payload.type;
}

beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers();
  resetWarnings();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  document.title = 'Cart · Shop';
  history.replaceState(null, '', '/orders/12345678/items?token=secret#frag');
});

afterEach(() => {
  handle?.api.destroy();
  handle = null;
  delete (window as unknown as Record<string, unknown>)[GLOBAL_NAME];
  document.documentElement.removeAttribute('lang');
  document.head.replaceChildren();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('options', () => {
  it('refuses a missing or invalid site id', () => {
    expect(readOptions(null)).toBeTypeOf('string');
    const s = script();
    s.setAttribute('data-site', 'fbs_short');
    expect(readOptions(s)).toMatch(/data-site/);
    s.removeAttribute('data-site');
    expect(readOptions(s)).toMatch(/data-site/);
  });
});

describe('the visitor’s language', () => {
  it.each([
    { explicit: 'nl-BE', page: 'en-GB', languages: ['en-US'], browser: 'en-US', expected: 'nl-BE' },
    { explicit: 'en', page: 'nl', languages: ['nl'], browser: 'nl', expected: 'en' },
    { explicit: 'fr', page: 'nl-NL', languages: ['en'], browser: 'en', expected: 'nl-NL' },
    { explicit: 'nl-?', page: 'fr', languages: ['fr', 'en-US', 'nl'], browser: 'nl', expected: 'en-US' },
    { page: 'fr', languages: ['de', 'nl'], browser: 'en', expected: 'nl' },
    { languages: ['de'], browser: 'nl-NL', expected: 'nl-NL' },
    { languages: ['de'], browser: 'fr', expected: 'en', omit: true },
    { page: 'en', languages: ['nl'], browser: 'nl', expected: 'en' },
    { explicit: 'pseudo', page: 'nl', languages: ['en'], browser: 'en', expected: 'pseudo' },
    { explicit: 'en-XA', languages: ['en'], browser: 'en', expected: 'pseudo' },
  ])('resolves $explicit / $page / $languages to $expected', (example) => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(example.languages);
    vi.spyOn(navigator, 'language', 'get').mockReturnValue(example.browser);
    if (example.page) document.documentElement.lang = example.page;
    const h = load(example.explicit ? { 'data-lang': example.explicit } : {});
    expect(h.options?.lang).toBe(example.expected);
    h.api.open();
    expect(new URL(h.frame()?.src ?? '').searchParams.get('lang')).toBe(
      example.omit ? null : example.expected,
    );
  });

  it('shows a Dutch loading label, unavailable notice, close button and iframe title', () => {
    const h = load({ 'data-lang': 'nl', 'data-label': 'Opmerkingen' });
    h.api.open();
    const shadow = h.shadow();
    expect(h.host()?.lang).toBe('nl');
    expect(shadow?.querySelector('.launcher')?.textContent).toBe('Opmerkingen');
    expect(shadow?.querySelector('.status')?.textContent).toBe('Laden…');
    expect(h.frame()?.title).toBe('Formulier voor Opmerkingen');
    vi.advanceTimersByTime(READY_TIMEOUT_MS);
    expect(shadow?.querySelector('.panel')?.getAttribute('data-state')).toBe('unavailable');
    expect(shadow?.querySelector('#wb-notice-text')?.textContent).toMatch(/geen feedback/);
    expect(shadow?.querySelector('.close')?.textContent).toBe('Sluiten');
  });
});

describe('the site key (drop mode, Whombat FD-27)', () => {
  const KEY = 'fbk_AbCdEfGhIjKlMnOpQrSt_-';

  it('adds data-key to the frame’s URL; without one the URL is the direct widget’s', () => {
    const h = load({ 'data-key': KEY });
    expect(h.options?.key).toBe(KEY);
    h.api.open();
    const src = new URL(h.frame()?.src ?? '');
    expect(src.searchParams.get('key')).toBe(KEY);
    h.api.destroy();
    delete (window as unknown as Record<string, unknown>)[GLOBAL_NAME];
    const direct = load();
    direct.api.open();
    expect(direct.frame()?.src).toBe(
      `${WHOMBAT}/embed/v1/frame.html?site=${SITE}&parent=${encodeURIComponent(location.origin)}&theme=auto#instance=${direct.instance}`,
    );
  });

  it('ignores anything that isn’t a key', () => {
    for (const bad of ['fbk_short', 'fbs_AbCdEfGhIjKlMnOpQrSt_-', `${KEY}x`, 'fbk_AbCdEfGhIjKlMnOpQrSt/='])
      expect((readOptions(script({ 'data-key': bad })) as { key: string | null }).key).toBeNull();
  });
});

describe('the global', () => {
  it('keeps Feedback available when the site’s control is hidden or disabled', async () => {
    const menu = document.createElement('div');
    const button = document.createElement('button');
    button.setAttribute('data-whombat-feedback', '');
    menu.append(button);
    menu.hidden = true;
    document.body.append(menu);
    const h = load();
    const floating = h.shadow()?.querySelector<HTMLButtonElement>('.launcher');
    expect(floating?.hidden).toBe(false);
    menu.hidden = false;
    await Promise.resolve();
    expect(floating?.hidden).toBe(true);
    button.disabled = true;
    await Promise.resolve();
    expect(floating?.hidden).toBe(false);
    button.disabled = false;
    menu.style.display = 'none';
    await Promise.resolve();
    expect(floating?.hidden).toBe(false);
    menu.style.display = '';
    await Promise.resolve();
    expect(floating?.hidden).toBe(true);
  });

  it('keeps one launcher when an SPA adds or removes its feedback control', async () => {
    const h = load();
    h.api.open();
    h.frame()?.dispatchEvent(new Event('load'));
    fromFrame(h, 'ready');
    h.api.close();
    const floating = h.shadow()?.querySelector<HTMLButtonElement>('.launcher');
    expect(floating?.hidden).toBe(false);
    const button = document.createElement('button');
    button.textContent = 'Feedback';
    document.body.append(button);
    button.setAttribute('data-whombat-feedback', '');
    await Promise.resolve();
    expect(floating?.hidden).toBe(true);
    button.removeAttribute('data-whombat-feedback');
    await Promise.resolve();
    expect(floating?.hidden).toBe(false);
    button.setAttribute('data-whombat-feedback', '');
    await Promise.resolve();
    expect(floating?.hidden).toBe(true);
    button.remove();
    await Promise.resolve();
    expect(floating?.hidden).toBe(false);
    h.api.destroy();
    document.body.append(button);
    await Promise.resolve();
    expect(h.host()).toBeNull();
  });

  it('reuses a site’s feedback button instead of adding a visible floating launcher', () => {
    const button = document.createElement('button');
    button.setAttribute('data-whombat-feedback', '');
    button.textContent = 'Feedback';
    document.body.append(button);
    const h = load();
    const floating = h.shadow()?.querySelector<HTMLButtonElement>('.launcher');
    expect(floating?.hidden).toBe(true);
    button.focus();
    button.click();
    const spy = posted(h);
    fromFrame(h, 'ready');
    expect(lastPayloadType(spy)).toBeUndefined();
    h.api.close();
    expect(document.activeElement).toBe(button);
  });

  it('a second copy is a no-op that warns once', () => {
    const h = load();
    expect(install(window as Win, script())).toBeNull();
    expect(install(window as Win, script())).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/more than once/);
    expect(document.querySelectorAll('whombat-feedback')).toHaveLength(1);
    h.api.open();
    expect(document.querySelectorAll('whombat-feedback')).toHaveLength(1);
    expect(h.shadow()?.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('an invalid site leaves an inert global and warns once', async () => {
    const s = script();
    s.setAttribute('data-site', 'nope');
    const h = install(window as Win, s);
    handle = h;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(h?.api.isOpen()).toBe(false);
    h?.api.open();
    expect(h?.api.isOpen()).toBe(false);
    expect(document.querySelector('whombat-feedback')).toBeNull();
    await expect(h?.api.ready()).rejects.toThrow();
  });
});

describe('open, close and the bridge', () => {
  it('close before open is a no-op; close tells the frame and restores focus', () => {
    const h = load();
    h.api.close();
    expect(h.frame()).toBeNull();
    const trigger = document.createElement('button');
    trigger.textContent = 'Help';
    document.body.append(trigger);
    trigger.focus();
    h.api.open();
    const spy = posted(h);
    fromFrame(h, 'ready');
    expect(h.api.isOpen()).toBe(true);
    fromFrame(h, 'close');
    expect(h.api.isOpen()).toBe(false);
    expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({
      wb: BRIDGE_TAG,
      instance: h.instance,
      type: 'close',
      payload: {},
    });
    expect(spy.mock.calls.every((c) => c[1] === WHOMBAT)).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(h.shadow()?.querySelector('.panel')?.hasAttribute('hidden')).toBe(true);
  });

  it('follows SPA navigation while open, without touching history', () => {
    const pushState = history.pushState;
    const h = load();
    h.api.open();
    const spy = posted(h);
    fromFrame(h, 'ready');
    const before = spy.mock.calls.length;
    history.pushState(null, '', '/account/settings?tab=billing');
    vi.advanceTimersByTime(URL_POLL_MS + 10);
    const last = spy.mock.calls.at(-1)?.[0] as { type: string; payload: { context: WidgetContext } };
    expect(spy.mock.calls.length).toBe(before + 1);
    expect(last.type).toBe('context');
    expect(last.payload.context.page?.url).toBe(`${location.origin}/account/settings`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(spy.mock.calls.length).toBe(before + 1); // unchanged context is not resent
    expect(history.pushState).toBe(pushState);
    h.api.close();
    const closed = spy.mock.calls.length;
    history.pushState(null, '', '/elsewhere');
    vi.advanceTimersByTime(URL_POLL_MS * 3);
    expect(spy.mock.calls.length).toBe(closed); // no polling while closed
  });

  it('ignores messages with the wrong origin, source, instance, tag, type or payload', () => {
    const h = load();
    h.api.open();
    const spy = posted(h);
    const cases: [string, unknown, Parameters<typeof fromFrame>[3]][] = [
      ['ready', {}, { origin: 'https://whombat.example.com.evil.com' }],
      ['ready', {}, { origin: 'https://evil.example.com' }],
      ['ready', {}, { origin: 'null' }],
      ['ready', {}, { origin: 'https://whombat.example.com.' }],
      ['ready', {}, { origin: 'https://whombat.example.com:443' }],
      ['ready', {}, { origin: 'http://whombat.example.com' }],
      ['ready', {}, { origin: '' }],
      ['ready', {}, { source: window }],
      ['ready', {}, { source: null }],
      ['ready', {}, { instance: 'AAAAAAAAAAAAAAAAAAAAAA' }],
      ['ready', {}, { wb: 'something-else' }],
      ['launch', {}, {}],
      ['ready', { x: 1 }, {}],
      ['ready', 'yes', {}],
    ];
    for (const [type, payload, over] of cases) fromFrame(h, type, payload, over);
    expect(spy).not.toHaveBeenCalled();
    expect(h.shadow()?.querySelector('.panel')?.getAttribute('data-state')).toBe('loading');
    fromFrame(h, 'close', {}, { origin: 'https://evil.example.com' });
    expect(h.api.isOpen()).toBe(true);
    fromFrame(h, 'ready');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('declarative triggers open it with their type', () => {
    const h = load({ 'data-launcher': 'custom' });
    const link = document.createElement('a');
    link.href = '#feedback';
    link.setAttribute('data-whombat-feedback', 'feature');
    const inner = document.createElement('span');
    inner.textContent = 'Suggest';
    link.append(inner);
    const plain = document.createElement('button');
    plain.setAttribute('data-whombat-feedback', '');
    const odd = document.createElement('button');
    odd.setAttribute('data-whombat-feedback', 'delete-everything');
    document.body.append(link, plain, odd);
    inner.click();
    expect(h.api.isOpen()).toBe(true);
    expect(location.hash).not.toBe('#feedback');
    const spy = posted(h);
    fromFrame(h, 'ready');
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ type: 'open', payload: { type: 'feature' } });
    h.api.close();
    plain.click();
    expect(lastPayloadType(spy)).toBeUndefined();
    h.api.close();
    odd.click();
    expect(lastPayloadType(spy)).toBeUndefined();
  });

  it('a site the frame says is unavailable gets a compact panel', () => {
    const h = load();
    h.api.open();
    fromFrame(h, 'ready');
    fromFrame(h, 'unavailable');
    expect(h.shadow()?.querySelector('.panel')?.getAttribute('data-size')).toBe('compact');
    expect(h.api.isOpen()).toBe(true);
  });

  it('a frame that loads but never says ready is unavailable soon after load', () => {
    const h = load();
    h.api.open();
    h.frame()?.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(LOAD_GRACE_MS);
    expect(h.shadow()?.querySelector('.panel')?.getAttribute('data-state')).toBe('unavailable');
  });

  it('Escape in the notice closes it', () => {
    const h = load();
    h.api.open();
    vi.advanceTimersByTime(READY_TIMEOUT_MS);
    const close = h.shadow()?.querySelector('button.close') as HTMLButtonElement;
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.api.isOpen()).toBe(false);
  });
});

describe('destroy', () => {
  it('removes everything; the API becomes inert and ready rejects', async () => {
    const h = load();
    const trigger = document.createElement('button');
    trigger.setAttribute('data-whombat-feedback', 'bug');
    document.body.append(trigger);
    h.api.open();
    const spy = posted(h);
    fromFrame(h, 'ready');
    const frameWindow = h.frame()?.contentWindow;
    const remove = vi.spyOn(window, 'removeEventListener');
    h.api.destroy();
    expect(document.querySelector('whombat-feedback')).toBeNull();
    expect(h.frame()).toBeNull();
    expect(remove.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['message', 'popstate', 'hashchange']),
    );
    expect(h.api.isOpen()).toBe(false);
    await expect(h.api.ready()).rejects.toThrow();
    h.api.open();
    h.api.setContext({ references: ['x'] });
    trigger.click();
    expect(h.api.isOpen()).toBe(false);
    expect(document.querySelector('whombat-feedback')).toBeNull();
    const calls = spy.mock.calls.length;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { wb: BRIDGE_TAG, instance: h.instance, type: 'ready', payload: {} },
        origin: WHOMBAT,
        source: frameWindow as MessageEventSource,
      }),
    );
    vi.advanceTimersByTime(READY_TIMEOUT_MS * 2);
    expect(spy.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
    h.api.destroy();
  });
});

describe('context', () => {
  it('holds only the listed fields, sanitized', () => {
    const ctx = collectContext(window as Win, siteContext({}));
    expect(Object.keys(ctx).sort()).toEqual(['app', 'browser', 'custom', 'page', 'references']);
    expect(ctx.page?.url).toBe(`${location.origin}/orders/:id/items`);
    expect(ctx.browser?.name).toMatch(/ · /);
    expect(ctx.browser?.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight });
    expect(JSON.stringify(ctx)).not.toMatch(/token|secret|frag|cookie/i);
  });

  it('keeps scalar custom values and sanitized references only', () => {
    const site = siteContext({
      app: { version: 'v'.repeat(100), environment: 'prod\u0000uction', build: 42 as unknown as string },
      custom: {
        plan: 'pro',
        'bad key': 1,
        nested: { a: 1 } as unknown as string,
        list: [1] as unknown as string,
      },
      references: ['req_1', 'has space', 'x'.repeat(200), 7 as unknown as string],
    });
    expect(site.app).toEqual({ version: 'v'.repeat(64), environment: 'production', build: null });
    expect(site.custom).toEqual({ plan: 'pro' });
    expect(site.references).toEqual(['req_1']);
    expect(siteContext(null)).toEqual({ app: null, custom: {}, references: [] });
  });
});

describe('the navigation trail (CT-161, AP-427)', () => {
  const stored = () => JSON.parse(sessionStorage.getItem(TRAIL_KEY) ?? 'null');
  const go = (path: string, title?: string) => {
    history.pushState(null, '', path);
    if (title !== undefined) document.title = title;
    vi.advanceTimersByTime(URL_POLL_MS + 10);
  };

  it('records the page on install and every new address, sanitized, in the tab’s sessionStorage', () => {
    vi.setSystemTime(new Date('2026-09-30T10:00:00.000Z'));
    load();
    expect(stored()).toEqual([
      { url: `${location.origin}/orders/:id/items`, title: 'Cart · Shop', at: '2026-09-30T10:00:00.000Z' },
    ]);
    go('/account/settings?tab=billing#x', 'Settings');
    window.dispatchEvent(new PopStateEvent('popstate'));
    const trail = stored();
    expect(trail).toHaveLength(2);
    expect(trail[1]).toMatchObject({ url: `${location.origin}/account/settings`, title: 'Settings' });
    expect(JSON.stringify(trail)).not.toMatch(/token|secret|frag|billing/);
  });

  it('the same address only refreshes the title; the last 10 are kept', () => {
    load();
    document.title = 'Cart (2) · Shop';
    vi.advanceTimersByTime(URL_POLL_MS + 10);
    expect(stored()).toHaveLength(1);
    expect(stored()[0].title).toBe('Cart (2) · Shop');
    for (let i = 1; i <= 12; i++) go(`/page/${'abcdefghijkl'[i - 1]}`, `Page ${i}`);
    const trail = stored();
    expect(trail).toHaveLength(10);
    expect(trail[0].title).toBe('Page 3');
    expect(trail[9]).toMatchObject({ url: `${location.origin}/page/l`, title: 'Page 12' });
  });

  it('keeps recording while closed and sends the trail with the context, current page last', () => {
    const h = load();
    go('/checkout', 'Checkout');
    h.api.open();
    const spy = posted(h);
    fromFrame(h, 'ready');
    const open = spy.mock.calls.at(-1)?.[0] as { type: string; payload: { context: WidgetContext } };
    expect(open.type).toBe('open');
    expect(open.payload.context.trail?.map((s) => s.url)).toEqual([
      `${location.origin}/orders/:id/items`,
      `${location.origin}/checkout`,
    ]);
    go('/checkout/pay', 'Pay');
    const update = spy.mock.calls.at(-1)?.[0] as { type: string; payload: { context: WidgetContext } };
    expect(update.type).toBe('context');
    expect(update.payload.context.trail?.at(-1)?.url).toBe(`${location.origin}/checkout/pay`);
  });

  it('continues a stored trail and ignores one that isn’t valid', () => {
    const earlier = { url: 'https://shop.example.com/', title: null, at: '2026-09-30T09:00:00.000Z' };
    sessionStorage.setItem(TRAIL_KEY, JSON.stringify([earlier]));
    load();
    expect(stored()[0]).toEqual(earlier);
    expect(stored()).toHaveLength(2);
    handle?.api.destroy();
    delete (window as unknown as Record<string, unknown>)[GLOBAL_NAME];
    sessionStorage.setItem(TRAIL_KEY, JSON.stringify([{ ...earlier, cookie: 'a=b' }]));
    load();
    expect(stored()).toHaveLength(1);
    expect(stored()[0].url).toBe(`${location.origin}/orders/:id/items`);
  });

  it('data-trail="off" records nothing, removes a stored trail and sends none', () => {
    sessionStorage.setItem(TRAIL_KEY, '[]');
    const h = load({ 'data-trail': 'off' });
    expect(h.options?.trail).toBe(false);
    expect(sessionStorage.getItem(TRAIL_KEY)).toBeNull();
    go('/elsewhere');
    expect(sessionStorage.getItem(TRAIL_KEY)).toBeNull();
    expect(vi.getTimerCount()).toBe(0); // nothing is watched while closed
    h.api.open();
    const spy = posted(h);
    fromFrame(h, 'ready');
    const open = spy.mock.calls.at(-1)?.[0] as { payload: { context: WidgetContext } };
    expect(open.payload.context).not.toHaveProperty('trail');
  });

  it('works without storage: the trail stays in memory', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const h = load();
    go('/two', 'Two');
    h.api.open();
    const spy = posted(h);
    fromFrame(h, 'ready');
    const open = spy.mock.calls.at(-1)?.[0] as { payload: { context: WidgetContext } };
    expect(open.payload.context.trail?.map((s) => s.title)).toEqual(['Cart · Shop', 'Two']);
  });

  it('stops watching on destroy', () => {
    const h = load();
    expect(vi.getTimerCount()).toBe(1);
    h.api.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
