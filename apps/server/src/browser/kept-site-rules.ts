/**
 * The pure rules of kept sites (docs/decisions/kept-sites.md): a site's name, which cookies belong to it, how long it
 * stays kept, and the words the person reads about it. No I/O.
 */
import { KEPT_SITE_DEFAULT_HOURS, type KeptCookie } from '@whombat/core';

const HOUR_MS = 3600_000;

/** Its origins once each, in the order given. */
export function uniqueOrigins(origins: readonly string[]): string[] {
  return [...new Set(origins)];
}

/** The host of an origin (`https://accounts.hetzner.com:8443` → `accounts.hetzner.com`). */
export function originHost(origin: string): string {
  return new URL(origin).hostname;
}

/** The name to show: the host of its first origin. */
export function siteName(origins: readonly string[]): string {
  const first = origins[0];
  return first ? originHost(first) : '';
}

/**
 * Whether a cookie's domain covers `host`, as a browser sends it (RFC 6265 domain-match): the host itself, or a parent
 * domain of it (`.hetzner.com` covers `accounts.hetzner.com`).
 */
export function cookieCoversHost(domain: string, host: string): boolean {
  const d = domain.toLowerCase().replace(/^\./, '');
  return d.length > 0 && (host === d || host.endsWith(`.${d}`));
}

/**
 * Only the cookies a browser would send to one of the site's origins: anything else the runner sent along is not the
 * site's, so it isn't kept.
 */
export function cookiesForOrigins(cookies: readonly KeptCookie[], origins: readonly string[]): KeptCookie[] {
  const hosts = origins.map(originHost);
  return cookies.filter((c) => hosts.some((h) => cookieCoversHost(c.domain, h)));
}

/** The hours a site stays kept from its last use. */
export function keptHours(hours: number | undefined): number {
  return hours ?? KEPT_SITE_DEFAULT_HOURS;
}

/** When a site used at `from` goes. */
export function keptUntil(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * HOUR_MS);
}

/** Whether a site that goes at `expiresAt` has gone by `now`. */
export function keptSiteExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

const hoursWords = (hours: number) => (hours === 1 ? '1 hour' : `${hours} hours`);

/** What the agent did, in the person's log and Done recently. */
export const keptWords = (site: string, hours: number) =>
  `Kept you signed in to ${site} for ${hoursWords(hours)}`;
export const forgotWords = (site: string) => `Forgot ${site}`;
export const stoppedWords = (site: string) => `Stopped keeping ${site} signed in`;
