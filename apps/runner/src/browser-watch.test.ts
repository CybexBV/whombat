/**
 * The watchdog of the relay's Chromium (one-person.md OP-S138) against the stand-in Chromium: a healthy one is left
 * alone, a page that stopped answering is closed, a Chromium that stopped answering or can't start pages is ended (the
 * pod's kept sites renewed from it first) and the next connection gets a fresh one with the kept sites put back.
 */
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Browser } from './browser';
import { BrowserWatch, pageLabel } from './browser-watch';
import { CdpClient } from './cdp';
import { type BrowserCookie, PodKeptSites } from './kept-sites';
import { StandInChromium, StandInChromiumHost, StandInKeptServer } from './test-devtools';

/** Short enough for a test, in the real ones' proportions. */
const FAST = { intervalMs: 20, commandMs: 100, closeMs: 200 };

const HETZNER = ['https://accounts.hetzner.com'];
const cookie = (name: string, domain: string): BrowserCookie => ({
  name,
  value: `secret-${name}`,
  domain,
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
});

/** A plain DevTools request through the relay. */
function relayGet(socketPath: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, headers: { host: '127.0.0.1' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Waits (in small steps) until `ok` holds. */
async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('the watchdog of the pod’s Chromium', () => {
  const closing: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of closing.splice(0).reverse()) await c();
  });

  async function setUp() {
    const chromium = await StandInChromium.open();
    closing.push(() => chromium.close());
    const host = new StandInChromiumHost(chromium);
    closing.push(() => host.kill());
    const server = new StandInKeptServer();
    const logs: string[] = [];
    const log = (level: string, msg: string, extra?: Record<string, unknown>) =>
      logs.push(`${level} ${msg} ${JSON.stringify(extra ?? {})}`);
    const kept = new PodKeptSites({ api: server.api, log, name: 'pod_test' });
    /** What happened, in order: each start's and each end's work, with how many Chromiums had ended by then. */
    const events: string[] = [];
    const browser = await Browser.open(
      {
        host,
        socket: join(mkdtempSync(join(tmpdir(), 'wb-watch-')), 'cdp.sock'),
        log,
        startMs: 5000,
        onStart: async (connect) => {
          events.push(`start (${host.ended} ended)`);
          await kept.restore(connect);
        },
        // As the pod does: the kept sites are renewed from the Chromium that is about to go.
        onStop: async (connect) => {
          events.push(`stop (${host.ended} ended)`);
          await kept.renew({ devtools: async () => connect });
        },
        onStopMs: 500,
        watch: FAST,
      },
      { name: 'pod_test', sites: null },
    );
    closing.push(() => browser.close());
    return { chromium, host, server, kept, browser, logs, events };
  }

  it('leaves a healthy browser alone', async () => {
    const { chromium, host, browser, events } = await setUp();
    expect(await relayGet(browser.socket, '/json/version')).toBe(200);
    chromium.pages = ['https://example.com/a', 'about:blank'];
    // Three checks of both pages.
    await until(() => chromium.count('Runtime.evaluate') >= 6);
    expect(chromium.count('Target.closeTarget')).toBe(0);
    // No page failed: no throwaway page either.
    expect(chromium.count('Target.createBrowserContext')).toBe(0);
    expect(host.starts).toBe(1);
    expect(host.ended).toBe(0);
    expect(events).toEqual(['start (0 ended)']);
  });

  it('never starts a Chromium itself, and stops when the browser closes', async () => {
    const { chromium, host, browser } = await setUp();
    // No connection yet: nothing to watch, nothing started.
    await new Promise((r) => setTimeout(r, 60));
    expect(host.starts).toBe(0);
    expect(chromium.heard).toEqual([]);
    await relayGet(browser.socket, '/json/version');
    await until(() => chromium.count('Target.getTargets') >= 2);
    await browser.close();
    const heard = chromium.heard.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(chromium.heard.length).toBe(heard);
    expect(host.starts).toBe(1);
  });

  it('closes a page that stopped answering, and the browser keeps running', async () => {
    const { chromium, host, browser, logs } = await setUp();
    await relayGet(browser.socket, '/json/version');
    chromium.pages = ['https://shop.example/cart?token=abc123', 'https://ok.example/'];
    chromium.stuckPages.add('https://shop.example/cart?token=abc123');
    await until(() => logs.some((l) => l.includes('closed a page')));
    expect(chromium.pages).toEqual(['https://ok.example/']);
    // Its origin only in the journal.
    const said = logs.join('\n');
    expect(said).toContain('https://shop.example');
    expect(said).not.toContain('token');
    expect(said).not.toContain('/cart');
    // The same Chromium goes on, and the healthy page with it.
    await until(() => chromium.count('Target.getTargets') >= 6);
    expect(chromium.pages).toEqual(['https://ok.example/']);
    // Three checks it didn't answer, each with a throwaway page (which answered, in a context that went again).
    expect(chromium.count('Target.createBrowserContext')).toBe(3);
    expect(chromium.count('Target.disposeBrowserContext')).toBe(3);
    expect(chromium.count('Target.closeTarget')).toBe(1);
    expect(host.starts).toBe(1);
    expect(host.ended).toBe(0);
    expect(await relayGet(browser.socket, '/json/version')).toBe(200);
    expect(host.starts).toBe(1);
  });

  it('ends a browser that stopped answering; the next connection gets a fresh one with the kept sites', async () => {
    const { chromium, host, server, kept, browser, logs, events } = await setUp();
    await relayGet(browser.socket, '/json/version');
    // The agent signed in and kept the site; a client (agent-browser) holds a connection through the relay.
    chromium.cookies.push(cookie('sid', 'accounts.hetzner.com'), cookie('gmail', '.google.com'));
    chromium.pages = ['https://accounts.hetzner.com/overview', 'https://mail.example/inbox'];
    await kept.route(browser, server.turn()).keep(HETZNER, undefined);
    const client = await CdpClient.open(browser.socket, 2000);
    closing.push(() => client.close());
    chromium.stuck = true;
    await until(() => host.ended === 1);
    // The end's work ran first, while that Chromium still ran.
    expect(events).toEqual(['start (0 ended)', 'stop (0 ended)']);
    expect(logs.join('\n')).toMatch(/warn browser pod_test: ending Chromium \(it didn’t list its pages/);
    // A stuck Chromium couldn't be read for the renewal: that work was cut short, and it went anyway.
    expect(logs.join('\n')).toContain('the work before its end failed');
    // The client's connection went with it: it connects again.
    await expect(client.send('Target.getTargets')).rejects.toThrow();
    // None started until a client asks.
    await new Promise((r) => setTimeout(r, 60));
    expect(host.starts).toBe(1);
    expect(await relayGet(browser.socket, '/json/version')).toBe(200);
    expect(host.starts).toBe(2);
    expect(events).toEqual(['start (0 ended)', 'stop (0 ended)', 'start (1 ended)']);
    // A fresh profile: the kept site's cookies only, none of the old pages.
    expect(chromium.names()).toEqual(['sid']);
    expect(chromium.pages).toEqual([]);
    expect(server.methods().filter((m) => m === 'restore')).toHaveLength(2);
    // And it is watched again.
    const checks = chromium.count('Target.getTargets');
    await until(() => chromium.count('Target.getTargets') > checks + 1);
    expect(host.ended).toBe(1);
    expect(logs.join('\n')).not.toContain('secret-');
  });

  it('ends a browser that can’t start a page that answers, renewing the kept sites from it first', async () => {
    const { chromium, host, server, kept, browser, logs } = await setUp();
    await relayGet(browser.socket, '/json/version');
    // The agent signed in and kept the site, then went on using it.
    chromium.cookies.push(cookie('sid', 'accounts.hetzner.com'));
    chromium.pages = ['https://accounts.hetzner.com/overview'];
    const site = await kept.route(browser, server.turn()).keep(HETZNER, undefined);
    chromium.cookies = chromium.cookies.map((c) => ({ ...c, value: 'secret-sid-2' }));
    // The renderers can't start any more: the open page and every new one are dead.
    chromium.stuckPages.add('https://accounts.hetzner.com/overview');
    chromium.noNewPages = true;
    await until(() => host.ended === 1);
    // Two checks whose new page didn't answer: ended before the page's three strikes.
    expect(chromium.count('Target.closeTarget')).toBe(0);
    expect(logs.join('\n')).toContain('it can’t start a page that answers');
    // Its cookies as they were went to the server before it went.
    const renew = server.calls.find((c) => c.method === 'renew');
    expect(renew).toMatchObject({ siteId: site.id });
    expect(renew?.cookies?.map((c) => c.value)).toEqual(['secret-sid-2']);
    await relayGet(browser.socket, '/json/version');
    expect(host.starts).toBe(2);
    expect(chromium.pages).toEqual([]);
    expect(chromium.names()).toEqual(['sid']);
    expect(chromium.cookies[0]?.value).toBe('secret-sid-2');
  });
});

describe('the watchdog’s checks', () => {
  const closing: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of closing.splice(0).reverse()) await c();
  });

  async function watchOf(over: Partial<ConstructorParameters<typeof BrowserWatch>[0]> = {}) {
    const chromium = await StandInChromium.open();
    closing.push(() => chromium.close());
    const restarts: string[] = [];
    const watch = new BrowserWatch({
      ...FAST,
      connect: (): Socket => connect(chromium.port, '127.0.0.1'),
      log: () => {},
      name: 'test',
      restart: (why) => restarts.push(why),
      ...over,
    });
    closing.push(() => watch.stop());
    return { chromium, watch, restarts };
  }

  it('never runs two checks at once', async () => {
    const { chromium, watch } = await watchOf({ intervalMs: 5, commandMs: 60 });
    chromium.pages = ['https://slow.example/'];
    chromium.stuckPages.add('https://slow.example/');
    let running = 0;
    let most = 0;
    let checks = 0;
    const check = watch.check.bind(watch);
    watch.check = async () => {
      running++;
      checks++;
      most = Math.max(most, running);
      try {
        return await check();
      } finally {
        running--;
      }
    };
    watch.start();
    // Each check waits longer than the interval.
    await until(() => checks >= 4);
    expect(most).toBe(1);
  });

  it('ends the browser when a page can’t be closed', async () => {
    const { chromium, watch, restarts } = await watchOf();
    chromium.pages = ['https://stuck.example/x'];
    chromium.stuckPages.add('https://stuck.example/x');
    chromium.unclosable = true;
    watch.start();
    await until(() => restarts.length > 0);
    expect(restarts).toEqual(['a page of https://stuck.example stopped answering and couldn’t be closed']);
    expect(watch.stopped).toBe(true);
  });

  it('forgives a page that answers again, and a single missed check of the browser', async () => {
    const { chromium, watch, restarts } = await watchOf();
    chromium.pages = ['https://flaky.example/'];
    chromium.stuckPages.add('https://flaky.example/');
    expect(await watch.check()).toBeNull();
    expect(await watch.check()).toBeNull();
    chromium.stuckPages.clear();
    expect(await watch.check()).toBeNull();
    chromium.stuckPages.add('https://flaky.example/');
    expect(await watch.check()).toBeNull();
    expect(await watch.check()).toBeNull();
    expect(chromium.count('Target.closeTarget')).toBe(0);
    chromium.stuckPages.clear();
    chromium.stuck = true;
    expect(await watch.check()).toBeNull();
    chromium.stuck = false;
    expect(await watch.check()).toBeNull();
    chromium.stuck = true;
    expect(await watch.check()).toBeNull();
    expect(await watch.check()).toMatch(/didn’t list its pages/);
    expect(restarts).toEqual([]);
  });

  it('names a page by its origin only', () => {
    expect(pageLabel('https://shop.example:8443/cart?token=1#x')).toBe('https://shop.example:8443');
    expect(pageLabel('about:blank')).toBe('about:blank');
    expect(pageLabel('data:text/html,<p>secret</p>')).toBe('a data: page');
    expect(pageLabel('file:///home/agent/notes.txt')).toBe('a file: page');
    expect(pageLabel('nonsense')).toBe('a page');
  });
});
