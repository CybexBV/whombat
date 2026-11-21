/**
 * Kept sites on the runner (kept-sites.md): only a site's own cookies are ever read out or put back; a fresh browser
 * gets the sites the server still keeps before any client; a used site is renewed, one the server dropped leaves the
 * live browser; nothing is captured or restored for a pod that keeps nothing.
 */
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunnerApiError } from './api';
import { Browser } from './browser';
import {
  type BrowserCookie,
  cookieBelongs,
  cookiesFor,
  KEPT_NOTHING_SIGNED_IN,
  keptOrigins,
  PodKeptSites,
} from './kept-sites';
import { StandInChromium, StandInChromiumHost, StandInKeptServer as StandInServer } from './test-devtools';

const HETZNER = ['https://accounts.hetzner.com', 'https://konsoleh.hetzner.com'];

const cookie = (name: string, domain: string, over: Partial<BrowserCookie> = {}): BrowserCookie => ({
  name,
  value: `secret-${name}`,
  domain,
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  ...over,
});

describe('which cookies belong to a site', () => {
  it('takes a host-only cookie of exactly one of its hosts, and a domain cookie its hosts get', () => {
    expect(cookieBelongs({ domain: 'accounts.hetzner.com' }, HETZNER)).toBe(true);
    expect(cookieBelongs({ domain: 'konsoleh.hetzner.com' }, HETZNER)).toBe(true);
    // Host-only on another host of the same domain: not the site's.
    expect(cookieBelongs({ domain: 'robot.hetzner.com' }, HETZNER)).toBe(false);
    expect(cookieBelongs({ domain: 'hetzner.com' }, HETZNER)).toBe(false);
    // Domain cookies: the domain itself or a parent of one of its hosts.
    expect(cookieBelongs({ domain: '.hetzner.com' }, HETZNER)).toBe(true);
    expect(cookieBelongs({ domain: 'hetzner.com', hostOnly: false }, HETZNER)).toBe(true);
    expect(cookieBelongs({ domain: '.accounts.hetzner.com' }, HETZNER)).toBe(true);
    expect(cookieBelongs({ domain: '.robot.hetzner.com' }, HETZNER)).toBe(false);
    // Look-alikes and other sites.
    expect(cookieBelongs({ domain: '.etzner.com' }, HETZNER)).toBe(false);
    expect(cookieBelongs({ domain: 'accounts.hetzner.com.evil.test' }, HETZNER)).toBe(false);
    expect(cookieBelongs({ domain: '.google.com' }, HETZNER)).toBe(false);
    expect(cookieBelongs({ domain: '' }, HETZNER)).toBe(false);
    expect(cookieBelongs({ domain: '.' }, HETZNER)).toBe(false);
    // An origin with a port is its host for cookies.
    expect(cookieBelongs({ domain: 'example.com' }, ['https://example.com:8443'])).toBe(true);
  });

  it('keeps only the contract’s fields, and leaves out what it can’t hold', () => {
    const out = cookiesFor(
      [
        cookie('sid', 'accounts.hetzner.com', { size: 12, priority: 'High', sourcePort: 443 }),
        cookie('other', 'google.com'),
        cookie('huge', '.hetzner.com', { value: 'x'.repeat(20_000) }),
        cookie('odd', 'konsoleh.hetzner.com', { sameSite: 'Weird' }),
      ],
      HETZNER,
    );
    expect(out).toEqual([
      {
        name: 'sid',
        value: 'secret-sid',
        domain: 'accounts.hetzner.com',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
      {
        name: 'odd',
        value: 'secret-odd',
        domain: 'konsoleh.hetzner.com',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
      },
    ]);
  });

  it('takes https origins only, as the contract does', () => {
    expect(keptOrigins(['https://Accounts.Hetzner.com', 'https://accounts.hetzner.com'])).toEqual([
      'https://accounts.hetzner.com',
    ]);
    expect(keptOrigins(['http://accounts.hetzner.com'])).toBeNull();
    expect(keptOrigins(['https://accounts.hetzner.com/login'])).toBeNull();
    expect(keptOrigins([])).toBeNull();
    expect(keptOrigins('https://accounts.hetzner.com')).toBeNull();
  });
});

/** A plain DevTools request through the relay (as Hermes's client would make it). */
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

describe('a pod’s kept sites in its browser', () => {
  const closing: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of closing.splice(0).reverse()) await c();
  });

  async function setUp(server = new StandInServer()) {
    const chromium = await StandInChromium.open();
    closing.push(() => chromium.close());
    const host = new StandInChromiumHost(chromium);
    closing.push(() => host.kill());
    const logs: string[] = [];
    const log = (_level: string, msg: string, extra?: Record<string, unknown>) =>
      logs.push(`${msg} ${JSON.stringify(extra ?? {})}`);
    const kept = new PodKeptSites({ api: server.api, log, name: 'pod_test' });
    const browser = await Browser.open(
      {
        host,
        socket: join(mkdtempSync(join(tmpdir(), 'wb-kept-')), 'cdp.sock'),
        log,
        startMs: 5000,
        onStart: (connect) => kept.restore(connect),
      },
      { name: 'pod_test', sites: null },
    );
    closing.push(() => browser.close());
    const route = kept.route(browser, server.turn());
    /** The agent signs in: the site's cookies, another site's, and a page open on it. */
    const signIn = () => {
      chromium.cookies.push(
        cookie('sid', 'accounts.hetzner.com'),
        cookie('pref', '.hetzner.com'),
        cookie('robot', 'robot.hetzner.com'),
        cookie('gmail', '.google.com'),
      );
      chromium.pages = ['https://accounts.hetzner.com/overview'];
    };
    return { chromium, host, server, kept, browser, route, logs, signIn };
  }

  it('by default captures nothing, saves nothing and restores nothing', async () => {
    const { chromium, server, kept, browser, logs, signIn } = await setUp();
    // The browser isn't started for it: no Chromium, nothing asked.
    await kept.renew(browser);
    expect(server.calls).toEqual([]);
    expect(await relayGet(browser.socket, '/json/list')).toBe(200);
    signIn();
    // A fresh browser asked the server once; the empty answer set no cookie.
    expect(server.methods()).toEqual(['restore']);
    expect(chromium.heard.filter((h) => h.startsWith('Storage.'))).toEqual([]);
    // After a turn, at the stop: no site known, nothing read, nothing sent.
    await kept.renew(browser);
    expect(server.methods()).toEqual(['restore']);
    expect(chromium.heard.filter((h) => !h.startsWith('GET'))).toEqual([]);
    expect(logs.join('\n')).not.toContain('secret-');
  });

  it('keeps a site’s own cookies, and the next fresh browser has them before any client', async () => {
    const { chromium, host, server, browser, route, logs, signIn } = await setUp();
    await relayGet(browser.socket, '/json/list');
    signIn();
    const kept = await route.keep(HETZNER, 6);
    expect(kept).toMatchObject({ site: 'accounts.hetzner.com', origins: HETZNER, hours: 6 });
    // Only the site's cookies went to the server.
    expect(
      server.calls
        .at(-1)
        ?.cookies?.map((c) => c.name)
        .sort(),
    ).toEqual(['pref', 'sid']);
    // The pod's Chromium ends (a new pod's is as fresh): its jar is empty, and the next one starts signed in.
    await host.kill();
    // Something else of the site's sneaks into what the server answers: it isn't restored.
    server.kept
      .get(kept.id)
      ?.cookies.push({ name: 'gmail', value: 'secret-gmail', domain: '.google.com', path: '/' });
    chromium.heard.length = 0;
    expect(await relayGet(browser.socket, '/json/list')).toBe(200);
    expect(host.starts).toBe(2);
    expect(chromium.names()).toEqual(['pref', 'sid']);
    // Set before the client's request went through.
    expect(chromium.heard.indexOf('Storage.setCookies')).toBeGreaterThanOrEqual(0);
    expect(chromium.heard.indexOf('Storage.setCookies')).toBeLessThan(
      chromium.heard.indexOf('GET /json/list'),
    );
    expect(logs.join('\n')).not.toContain('secret-');
  });

  it('refuses to keep a site the browser isn’t signed in to', async () => {
    const { server, browser, route } = await setUp();
    // No Chromium running: nothing to read, and none started for it.
    await expect(route.keep(HETZNER, undefined)).rejects.toThrow(KEPT_NOTHING_SIGNED_IN);
    await relayGet(browser.socket, '/json/list');
    await expect(route.keep(['https://example.com'], undefined)).rejects.toThrow(KEPT_NOTHING_SIGNED_IN);
    expect(server.methods()).toEqual(['restore']);
  });

  it('renews a used site with its cookies as they are now, only while a page of it is open', async () => {
    const { chromium, server, kept, browser, route, signIn } = await setUp();
    await relayGet(browser.socket, '/json/list');
    signIn();
    chromium.cookies.push(cookie('shop', 'shop.example'));
    const hetzner = await route.keep(HETZNER, undefined);
    const shop = await route.keep(['https://shop.example'], undefined);
    expect(
      kept
        .known()
        .map((s) => s.id)
        .sort(),
    ).toEqual([hetzner.id, shop.id].sort());
    // A page of Hetzner's only: Hetzner is renewed, the shop isn't.
    chromium.cookies = chromium.cookies.map((c) => (c.name === 'sid' ? { ...c, value: 'secret-sid-2' } : c));
    await kept.renew(browser);
    const renewals = server.calls.filter((c) => c.method === 'renew');
    expect(renewals.map((c) => c.siteId)).toEqual([hetzner.id]);
    expect(renewals[0]?.cookies?.find((c) => c.name === 'sid')?.value).toBe('secret-sid-2');
    expect(renewals[0]?.cookies?.map((c) => c.name).sort()).toEqual(['pref', 'sid']);
    // No page open at all: nothing renewed.
    chromium.pages = ['about:blank'];
    await kept.renew(browser);
    expect(server.calls.filter((c) => c.method === 'renew')).toHaveLength(1);
  });

  it('drops a site the server no longer keeps: not restored, and a renewal’s 404 signs it out', async () => {
    const { chromium, host, server, kept, browser, route, signIn } = await setUp();
    await relayGet(browser.socket, '/json/list');
    signIn();
    const hetzner = await route.keep(HETZNER, undefined);
    // Stopped by the person (or expired): the renewal answers 404, and the site leaves the live browser.
    server.kept.clear();
    await kept.renew(browser);
    expect(kept.known()).toEqual([]);
    expect(chromium.names()).toEqual(['gmail', 'robot']);
    expect(server.calls.at(-1)).toMatchObject({ method: 'renew', siteId: hetzner.id });
    // Not known any more: nothing renewed again; and a fresh browser gets nothing of it.
    const before = server.calls.length;
    await kept.renew(browser);
    expect(server.calls.length).toBe(before);
    await host.kill();
    await relayGet(browser.socket, '/json/list');
    expect(server.methods().at(-1)).toBe('restore');
    expect(chromium.names()).toEqual([]);
  });

  it('forgets a site: the server deletes it and the live browser is signed out of it', async () => {
    const { chromium, server, kept, browser, route, signIn } = await setUp();
    await relayGet(browser.socket, '/json/list');
    signIn();
    await route.keep(HETZNER, undefined);
    const forgotten = await route.forget(['https://konsoleh.hetzner.com']);
    expect(forgotten.map((s) => s.site)).toEqual(['accounts.hetzner.com']);
    expect(server.methods()).toEqual(['restore', 'keep', 'forget']);
    expect(kept.known()).toEqual([]);
    // Every cookie of the site's origins is gone; the others' stay.
    expect(chromium.names()).toEqual(['gmail', 'robot']);
  });

  it('starts the browser even when the server can’t be asked', async () => {
    const server = new StandInServer();
    server.api.keptSiteRestore = async () => {
      throw new RunnerApiError(503, null, 'down');
    };
    const { browser, logs } = await setUp(server);
    expect(await relayGet(browser.socket, '/json/list')).toBe(200);
    expect(logs.join('\n')).toContain('its start’s work failed');
  });
});
