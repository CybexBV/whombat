/**
 * Kept sites on the runner (Whombat kept-sites.md): a website the agent keeps signed in between its turns, only when it
 * asks for it, for a few hours. The person's pod's browser is fresh in every new pod; for a kept site the runner reads
 * that site's cookies (HttpOnly ones too) from Chromium, the server keeps them sealed, and the runner puts them back
 * into the next fresh browser.
 *
 * - Only a site's own cookies ever leave Chromium or go back into it (`cookiesFor`): a host-only cookie of one of its
 *   hosts, or a domain cookie those hosts get. Another site's cookies are never read out, sent or restored.
 * - Restore (`PodKeptSites.restore`): every (re)start of the pod's Chromium, before any client gets it — the sites the
 *   server still keeps; one it no longer answers has expired or was stopped and is gone from the pod too.
 * - Renew (`PodKeptSites.renew`): when a turn leaves the pod and when the pod stops, a known site with a page open on
 *   one of its origins sends its cookies as they are now; the server keeps it for its hours again. One the server no
 *   longer has (404) is dropped and its cookies leave the live browser. A site with no page open isn't renewed: it
 *   expires by itself.
 * - Keep, forget and list come from the agent's tool over the logins socket (`logins.ts`), in a person's turn only.
 * - Nothing kept, nothing captured: a pod that never kept a site reads no cookie and sends none.
 *
 * Cookie values are secrets: never logged, never in an answer to the agent.
 */
import type { Socket } from 'node:net';
import type { KeptCookie, KeptSite, KeptSiteRestore } from '@whombat/core';
import { KEPT_SITE_COOKIES_MAX, KeptCookie as KeptCookieSchema, KeptSiteOrigins } from '@whombat/core';
import type { RunnerApi } from './api';
import { CdpClient } from './cdp';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', msg: string, extra?: Record<string, unknown>) => void;

/** How long one piece of cookie work on Chromium may take (opening DevTools, and then all its commands). */
const CDP_MS = 10_000;

/** `p`, or a rejection once `ms` passed (Chromium that stopped answering never holds a turn or a stop). */
function within<T>(p: Promise<T>, ms = CDP_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the browser didn’t answer')), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A cookie as Chromium's DevTools give it (`Storage.getCookies`): the kept fields and whatever else it has. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  /** Some sources say it outright; Chromium says it by the domain's leading dot. */
  hostOnly?: boolean;
  [more: string]: unknown;
}

/** An https origin's host, lower case, without its port; null when it isn't one. */
export function originHost(origin: string): string | null {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' ? u.hostname.toLowerCase().replace(/\.$/, '') : null;
  } catch {
    return null;
  }
}

/**
 * Whether a cookie belongs to one of the origins: a host-only cookie (`accounts.example.com`) of exactly one of their
 * hosts; a domain cookie (`.example.com`, or `example.com` marked not host-only) that one of their hosts gets — the host
 * is that domain or under it.
 */
export function cookieBelongs(
  cookie: Pick<BrowserCookie, 'domain' | 'hostOnly'>,
  origins: readonly string[],
): boolean {
  const raw = (cookie.domain ?? '').toLowerCase().replace(/\.$/, '');
  if (!raw) return false;
  const domainCookie = raw.startsWith('.') || cookie.hostOnly === false;
  const domain = raw.replace(/^\.+/, '');
  if (!domain) return false;
  return origins.some((origin) => {
    const host = originHost(origin);
    if (!host) return false;
    if (!domainCookie) return host === domain;
    return host === domain || host.endsWith(`.${domain}`);
  });
}

/**
 * The cookies of these origins (`cookieBelongs`), as the contract keeps them (`KeptCookie`): only its fields, a cookie it
 * can't hold left out, at most `KEPT_SITE_COOKIES_MAX`.
 */
export function cookiesFor(cookies: readonly BrowserCookie[], origins: readonly string[]): KeptCookie[] {
  const out: KeptCookie[] = [];
  for (const c of cookies) {
    if (out.length >= KEPT_SITE_COOKIES_MAX) break;
    if (!c || typeof c !== 'object' || !cookieBelongs(c, origins)) continue;
    const kept = KeptCookieSchema.safeParse({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      ...(typeof c.expires === 'number' ? { expires: c.expires } : {}),
      ...(typeof c.httpOnly === 'boolean' ? { httpOnly: c.httpOnly } : {}),
      ...(typeof c.secure === 'boolean' ? { secure: c.secure } : {}),
      ...(c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None'
        ? { sameSite: c.sameSite }
        : {}),
    });
    if (kept.success) out.push(kept.data);
  }
  return out;
}

/** Whether two sites share an origin. */
const overlaps = (a: readonly string[], b: readonly string[]) => a.some((o) => b.includes(o));

/** The origin of a page's address, or null (`about:blank`, `chrome://…`). */
function pageOrigin(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Every cookie of Chromium's default context (the browser target's `Storage.getCookies`). */
export async function readCookies(cdp: CdpClient): Promise<BrowserCookie[]> {
  const got = await cdp.send<{ cookies?: BrowserCookie[] }>('Storage.getCookies');
  return Array.isArray(got.cookies) ? got.cookies : [];
}

/** Puts cookies into Chromium's default context. */
export async function writeCookies(cdp: CdpClient, cookies: readonly KeptCookie[]): Promise<void> {
  if (cookies.length) await cdp.send('Storage.setCookies', { cookies });
}

/**
 * Takes these cookies out of Chromium's default context: each set again as expired, which removes it
 * (`Storage.clearCookies` would take every site's).
 */
export async function deleteCookies(cdp: CdpClient, cookies: readonly KeptCookie[]): Promise<void> {
  if (!cookies.length) return;
  await cdp.send('Storage.setCookies', {
    cookies: cookies.map((c) => ({
      name: c.name,
      value: '',
      domain: c.domain,
      path: c.path,
      expires: 1,
      ...(c.secure !== undefined ? { secure: c.secure } : {}),
      ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
      ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
    })),
  });
}

/** The origins of the pages open now (`Target.getTargets`, page targets). */
export async function openPageOrigins(cdp: CdpClient): Promise<Set<string>> {
  const got = await cdp.send<{ targetInfos?: { type?: string; url?: string }[] }>('Target.getTargets');
  const out = new Set<string>();
  for (const t of got.targetInfos ?? []) {
    if (t.type !== 'page') continue;
    const origin = pageOrigin(t.url);
    if (origin) out.add(origin);
  }
  return out;
}

/** What the agent hears when there is nothing to keep, or keeping isn't for this turn. */
export const KEPT_NOTHING_SIGNED_IN =
  'There’s no sign-in for that site in the browser yet: sign in first, then keep it.';
export const KEPT_NOT_HERE = 'Websites can’t be kept signed in in this conversation.';
export const KEPT_UNAVAILABLE = 'Whombat couldn’t do that right now.';

/** Why a keep didn't happen, in words for the agent. */
export class KeptSiteRefusal extends Error {}

/** The turn's side of keeping (its dispatch and live lease): `runner.keptSiteKeep`, `…Forget`, `…List`. */
export interface TurnKeptSites {
  keep(body: { origins: string[]; hours?: number; cookies: KeptCookie[] }): Promise<KeptSite>;
  forget(origins: string[]): Promise<KeptSite[]>;
  list(): Promise<KeptSite[]>;
}

/** The turn's side over `api` for one dispatch and lease, or null when the api lacks it. */
export function turnKeptSites(
  api: Pick<RunnerApi, 'keptSiteKeep' | 'keptSiteForget' | 'keptSiteList'>,
  dispatchId: string,
  lease: { runnerId: string; attempt: number },
): TurnKeptSites | null {
  const { keptSiteKeep, keptSiteForget, keptSiteList } = api;
  if (!keptSiteKeep || !keptSiteForget || !keptSiteList) return null;
  return {
    keep: async (body) => (await keptSiteKeep.call(api, dispatchId, { ...lease, ...body })).site,
    forget: async (origins) => (await keptSiteForget.call(api, dispatchId, { ...lease, origins })).forgotten,
    list: async () => (await keptSiteList.call(api, dispatchId, { ...lease })).sites,
  };
}

/** What the logins socket asks of a kept site for one turn (`LoginsRoute.kept`). */
export interface KeptSitesRoute {
  keep(origins: string[], hours: number | undefined): Promise<KeptSite>;
  forget(origins: string[]): Promise<KeptSite[]>;
  list(): Promise<KeptSite[]>;
}

/** The browser as kept sites use it: a way in to the Chromium that runs now, never starting one. */
export interface KeptSitesBrowser {
  devtools(): Promise<(() => Socket) | null>;
}

export interface PodKeptSitesDeps {
  api: Required<Pick<RunnerApi, 'keptSiteRestore' | 'keptSiteRenew'>>;
  log: Log;
  /** The pod's name (log lines). */
  name: string;
}

const status = (err: unknown) =>
  typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : null;
const why = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

/** The kept sites one pod knows (restored into its browser, or kept in it): see the file comment. */
export class PodKeptSites {
  readonly #deps: PodKeptSitesDeps;
  readonly #sites = new Map<string, KeptSite>();

  constructor(deps: PodKeptSitesDeps) {
    this.#deps = deps;
  }

  /** The sites known now (tests, status). */
  known(): KeptSite[] {
    return [...this.#sites.values()];
  }

  /**
   * A fresh Chromium (`connect`: its DevTools port) gets the sites the server still keeps, each only its own cookies.
   * Throws when it can't (the browser starts anyway: `Browser`'s `onStart`).
   */
  async restore(connect: () => Socket): Promise<void> {
    const { log, name } = this.#deps;
    const { sites } = await this.#deps.api.keptSiteRestore();
    // What the server answers is what is kept: a site it no longer answers expired or was stopped.
    this.#sites.clear();
    const cookies: KeptCookie[] = [];
    for (const kept of sites as KeptSiteRestore[]) {
      this.#sites.set(kept.site.id, kept.site);
      cookies.push(...cookiesFor(kept.cookies, kept.site.origins));
    }
    if (!cookies.length) return;
    const cdp = await CdpClient.open(connect, CDP_MS);
    try {
      await within(writeCookies(cdp, cookies));
    } finally {
      cdp.close();
    }
    log('info', `kept sites ${name}: restored ${sites.map((s) => s.site.site).join(', ')}`, {
      sites: sites.map((s) => s.site.id),
    });
  }

  /**
   * After a turn and when the pod stops: each known site with a page open on one of its origins sends its cookies as
   * they are now. One the server no longer keeps (404) is dropped and its cookies leave the live browser.
   */
  async renew(browser: KeptSitesBrowser): Promise<void> {
    if (!this.#sites.size) return;
    const connect = await browser.devtools();
    if (!connect) return;
    const { api, log, name } = this.#deps;
    const cdp = await CdpClient.open(connect, CDP_MS);
    try {
      const open = await within(openPageOrigins(cdp));
      const used = [...this.#sites.values()].filter((s) => s.origins.some((o) => open.has(o)));
      if (!used.length) return;
      const all = await within(readCookies(cdp));
      for (const site of used) {
        const cookies = cookiesFor(all, site.origins);
        try {
          const { site: renewed } = await api.keptSiteRenew(site.id, { cookies });
          this.#sites.set(site.id, renewed);
          log('debug', `kept sites ${name}: renewed ${site.site}`, { site: site.id });
        } catch (err) {
          if (status(err) !== 404) {
            log('warn', `kept sites ${name}: ${site.site} couldn’t be renewed (${why(err)})`, {
              site: site.id,
            });
            continue;
          }
          // Forgotten, stopped or expired: nothing of it stays in the pod.
          this.#sites.delete(site.id);
          await within(deleteCookies(cdp, cookies));
          log('info', `kept sites ${name}: ${site.site} is no longer kept`, { site: site.id });
        }
      }
    } finally {
      cdp.close();
    }
  }

  /** The logins socket's kept-site requests of one turn, on this pod's live browser. */
  route(browser: KeptSitesBrowser, turn: TurnKeptSites): KeptSitesRoute {
    return {
      keep: (origins, hours) => this.#keep(browser, turn, origins, hours),
      forget: (origins) => this.#forget(browser, turn, origins),
      list: () => turn.list(),
    };
  }

  async #keep(
    browser: KeptSitesBrowser,
    turn: TurnKeptSites,
    origins: string[],
    hours: number | undefined,
  ): Promise<KeptSite> {
    const connect = await browser.devtools();
    if (!connect) throw new KeptSiteRefusal(KEPT_NOTHING_SIGNED_IN);
    const cdp = await CdpClient.open(connect, CDP_MS);
    let cookies: KeptCookie[];
    try {
      cookies = cookiesFor(await within(readCookies(cdp)), origins);
    } finally {
      cdp.close();
    }
    if (!cookies.length) throw new KeptSiteRefusal(KEPT_NOTHING_SIGNED_IN);
    const site = await turn.keep({ origins, ...(hours !== undefined ? { hours } : {}), cookies });
    // The server replaced any site with one of the same origins.
    for (const [id, known] of this.#sites) if (overlaps(known.origins, site.origins)) this.#sites.delete(id);
    this.#sites.set(site.id, site);
    this.#deps.log('info', `kept sites ${this.#deps.name}: keeping ${site.site} for ${site.hours} h`, {
      site: site.id,
    });
    return site;
  }

  async #forget(browser: KeptSitesBrowser, turn: TurnKeptSites, origins: string[]): Promise<KeptSite[]> {
    const forgotten = await turn.forget(origins);
    const gone = new Set(origins);
    for (const s of forgotten) for (const o of s.origins) gone.add(o);
    for (const [id, known] of this.#sites)
      if (forgotten.some((s) => s.id === id) || overlaps(known.origins, [...gone])) this.#sites.delete(id);
    // Signed out in the live browser too.
    const connect = await browser.devtools();
    if (connect) {
      const cdp = await CdpClient.open(connect, CDP_MS);
      try {
        await within(deleteCookies(cdp, cookiesFor(await within(readCookies(cdp)), [...gone])));
      } finally {
        cdp.close();
      }
    }
    this.#deps.log(
      'info',
      `kept sites ${this.#deps.name}: forgot ${forgotten.map((s) => s.site).join(', ') || 'none'}`,
    );
    return forgotten;
  }
}

/** Origins as the contract takes them (`KeptSiteOrigins`): https, lower case, no path, deduplicated; null when not. */
export function keptOrigins(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const lower = [...new Set(value.map((v) => (typeof v === 'string' ? v.toLowerCase() : v)))];
  const parsed = KeptSiteOrigins.safeParse(lower);
  return parsed.success ? parsed.data : null;
}
