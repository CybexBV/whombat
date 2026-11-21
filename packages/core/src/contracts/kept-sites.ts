/**
 * Kept sites (Whombat kept-sites.md KS-01…): a website the agent keeps signed in between its turns, only when it asks
 * for it, for a few hours. The agent's browser is fresh in every new pod (one-person.md OP-S113); for a kept site the
 * runner saves that site's cookies (HttpOnly ones too) from the browser, the server keeps them sealed with the Vault's
 * key, and the runner puts them back into the next fresh browser. Nothing else of the browser is kept.
 *
 * - The runner's side (`runner.keptSite*`): keep and forget in the agent's turn (live lease), list for the agent (no
 *   cookies), renew and restore from the pod (runner token only: a pod outlives its turns).
 * - The person's side (`keptSites.*`): the kept sites in Settings, and stopping one.
 */
import { z } from 'zod';
import { Timestamp } from '../domain/common.js';
import { DispatchId, KeptSiteId, PrincipalId } from '../ids.js';
import { BurrowParam, endpoint, RUNNER_PREFIX } from './endpoint.js';
import { RunnerLease } from './runner.js';

/** Hours a site stays kept from its last use when the agent names none. */
export const KEPT_SITE_DEFAULT_HOURS = 4;
/** The most hours a site stays kept from its last use. */
export const KEPT_SITE_MAX_HOURS = 24;
/** The most origins one kept site has (a site's sign-in host and the hosts it signs in for). */
export const KEPT_SITE_ORIGINS_MAX = 10;
/** The most cookies kept for one site. */
export const KEPT_SITE_COOKIES_MAX = 300;

/** An https origin: scheme and host (and port), no path, lower case. */
export const KeptSiteOrigin = z
  .string()
  .max(300)
  .regex(/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/, 'An https origin: scheme and host, no path.');
export type KeptSiteOrigin = z.infer<typeof KeptSiteOrigin>;

export const KeptSiteOrigins = z.array(KeptSiteOrigin).min(1).max(KEPT_SITE_ORIGINS_MAX);

export const KeptSiteHours = z.number().int().min(1).max(KEPT_SITE_MAX_HOURS);

/**
 * One cookie as Chromium's DevTools give it (`Storage.getCookies`) and take it back (`Storage.setCookies`). The value
 * is a secret: it never leaves the runner and the server except sealed, and is never logged or shown.
 */
export const KeptCookie = z.object({
  name: z.string().max(4096),
  value: z.string().max(16384),
  domain: z.string().min(1).max(255),
  path: z.string().max(1024),
  /** Seconds since the epoch; -1 (or absent) for a session cookie. */
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
});
export type KeptCookie = z.infer<typeof KeptCookie>;

export const KeptCookies = z.array(KeptCookie).max(KEPT_SITE_COOKIES_MAX);

/** A kept site as the person and the agent see it: never its cookies. */
export const KeptSite = z.object({
  id: KeptSiteId,
  /** The site's name to show: the host of its first origin (`accounts.hetzner.com`). */
  site: z.string().max(253),
  origins: KeptSiteOrigins,
  /** The agent that asked to keep it. */
  agentId: PrincipalId,
  /** Hours it stays kept from its last use (`KEPT_SITE_DEFAULT_HOURS`, at most `KEPT_SITE_MAX_HOURS`). */
  hours: KeptSiteHours,
  keptAt: Timestamp,
  lastUsedAt: Timestamp,
  /** After this it is gone: never restored again, deleted. */
  expiresAt: Timestamp,
});
export type KeptSite = z.infer<typeof KeptSite>;

/** A kept site with its cookies, for the runner to put into a fresh browser. */
export const KeptSiteRestore = z.object({
  site: KeptSite,
  cookies: KeptCookies,
});
export type KeptSiteRestore = z.infer<typeof KeptSiteRestore>;

export const KeepSiteBody = RunnerLease.required().extend({
  origins: KeptSiteOrigins,
  hours: KeptSiteHours.optional(),
  cookies: KeptCookies,
});
export type KeepSiteBody = z.infer<typeof KeepSiteBody>;

export const ForgetSiteBody = RunnerLease.required().extend({
  /** Any of the site's origins: every kept site with one of them goes. */
  origins: KeptSiteOrigins,
});
export type ForgetSiteBody = z.infer<typeof ForgetSiteBody>;

export const RenewSiteBody = z.object({
  cookies: KeptCookies,
});
export type RenewSiteBody = z.infer<typeof RenewSiteBody>;

const D = z.object({ dispatchId: DispatchId });
const B = z.object({ burrow: BurrowParam });

export const keptSiteRunnerEndpoints = {
  keptSiteKeep: endpoint({
    id: 'runner.keptSiteKeep',
    method: 'POST',
    path: '/dispatches/:dispatchId/kept-sites',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'The agent keeps a website signed in between its turns (KS-02): the cookies the runner read from its browser for these origins, sealed and kept for `hours` (default 4, at most 24) from now. A site with any of the same origins is replaced. Runner token and the live lease (409 when lost); not in an outsiders’ turn or an assessment (403). Never logged.',
    params: D,
    body: KeepSiteBody,
    response: z.object({ site: KeptSite }),
    status: 201,
  }),
  keptSiteForget: endpoint({
    id: 'runner.keptSiteForget',
    method: 'POST',
    path: '/dispatches/:dispatchId/kept-sites/forget',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'The agent forgets a kept website (KS-05): every kept site with one of these origins is deleted. Runner token and the live lease (409 when lost).',
    params: D,
    body: ForgetSiteBody,
    response: z.object({ forgotten: z.array(KeptSite) }),
  }),
  keptSiteList: endpoint({
    id: 'runner.keptSiteList',
    method: 'POST',
    path: '/dispatches/:dispatchId/kept-sites/list',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'The kept websites that haven’t expired, for the agent to see (no cookies). Runner token and the live lease.',
    params: D,
    body: RunnerLease.required(),
    response: z.object({ sites: z.array(KeptSite) }),
  }),
  keptSiteRestore: endpoint({
    id: 'runner.keptSiteRestore',
    method: 'POST',
    path: '/kept-sites/restore',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'Every kept website that hasn’t expired, with its cookies, for the runner to put into the person’s pod’s fresh browser (KS-03). Expired ones are deleted, never answered. Runner token only (a pod’s browser starts outside any one turn). Never logged.',
    body: z.object({}),
    response: z.object({ sites: z.array(KeptSiteRestore) }),
  }),
  keptSiteRenew: endpoint({
    id: 'runner.keptSiteRenew',
    method: 'POST',
    path: '/kept-sites/:siteId/renew',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary:
      'A kept website was used (a page on it was open after a turn or when the pod stopped, KS-04): its cookies as they are now, kept for its hours again from now. 404 when it was forgotten, stopped or expired (the runner keeps nothing then). Runner token only. Never logged.',
    params: z.object({ siteId: KeptSiteId }),
    body: RenewSiteBody,
    response: z.object({ site: KeptSite }),
  }),
};

export const keptSiteEndpoints = {
  list: endpoint({
    id: 'keptSites.list',
    method: 'GET',
    path: '/burrows/:burrow/kept-sites',
    summary:
      'The websites the person’s agent keeps signed in between its turns, soonest to expire first (KS-06).',
    params: B,
    response: z.object({ sites: z.array(KeptSite) }),
  }),
  stop: endpoint({
    id: 'keptSites.stop',
    method: 'DELETE',
    path: '/burrows/:burrow/kept-sites/:siteId',
    summary:
      'Stop keeping a website signed in (KS-06): its kept cookies are deleted now; the agent signs in again next time.',
    params: B.extend({ siteId: KeptSiteId }),
    response: z.object({ site: KeptSite }),
  }),
} as const;
