/**
 * Requests to the open services this Whombat reads for itself (docs/decisions/weather-news.md): MET Norway's forecast,
 * OpenStreetMap's Nominatim and the news sites the person turned on. Each goes through `outboundRequest` (https only,
 * public addresses, no redirects, 1 MiB, 10 s) and names Whombat the way those services ask: the product, its version
 * and its website, never the person or their address (`whombatUserAgent`). Tests answer them without the network
 * (`useOpenDataForTests`).
 */
import type { Services } from '../services';
import { buildInfo } from '../version';
import { outboundRequest } from './outbound';

/** Whombat's own website, the contact MET Norway and OpenStreetMap ask a User-Agent to name. */
export const WHOMBAT_WEBSITE = 'https://whombat.com';

/** `Whombat/0.309.0 (+https://whombat.com)`. */
export function whombatUserAgent(version: string = buildInfo().version): string {
  return `Whombat/${version} (+${WHOMBAT_WEBSITE})`;
}

/** An answer as the readers use it: any status (a 3xx included), its headers and its bytes. */
export interface OpenDataAnswer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** One GET with these headers (the User-Agent already among them). */
export type OpenDataRequest = (url: string, headers: Record<string, string>) => Promise<OpenDataAnswer>;

/** The most a forecast, a place look-up or a feed may be. */
export const OPEN_DATA_MAX_BYTES = 1024 * 1024;
const OPEN_DATA_DEADLINE_MS = 15_000;

const systemRequest: OpenDataRequest = async (url, headers) => {
  const res = await outboundRequest(
    url,
    { method: 'GET', headers },
    { maxBytes: OPEN_DATA_MAX_BYTES, timeoutMs: 10_000, deadlineMs: OPEN_DATA_DEADLINE_MS },
  );
  return { status: res.status, headers: res.headers, body: res.body };
};

const overrides = new WeakMap<Services, OpenDataRequest>();

const refusedInTests: OpenDataRequest = async (url) => {
  throw new Error(`No open data in tests without useOpenDataForTests: ${new URL(url).hostname}`);
};

/** Tests only: answers every open-data request without the network. Refused outside `NODE_ENV=test`. */
export function useOpenDataForTests(services: Services, request: OpenDataRequest): void {
  if (services.config.NODE_ENV !== 'test') throw new Error('The open data seam is for tests only.');
  overrides.set(services, request);
}

/** One GET to an open service, Whombat named in its User-Agent. Throws `OutboundError` when it can't be sent. */
export function openDataGet(
  services: Services,
  url: string,
  headers: Record<string, string> = {},
): Promise<OpenDataAnswer> {
  // Tests never reach the network: one that didn't answer these itself gets a failed read.
  const request =
    overrides.get(services) ?? (services.config.NODE_ENV === 'test' ? refusedInTests : systemRequest);
  return request(url, { ...headers, 'user-agent': whombatUserAgent() });
}

/** A header's first value, or undefined. */
export function headerOf(answer: Pick<OpenDataAnswer, 'headers'>, name: string): string | undefined {
  const v = answer.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
