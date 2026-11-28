/**
 * Reading each place's openings (docs/decisions/internet-exposure.md) with the connection's own sign-in, GETs only,
 * kept 10 minutes (settings change seldom; the health pass asks every 5). Nginx Proxy Manager, Cloudflare's tunnels
 * and OPNsense's services come from their pages' own reads; the rest are reads of their own: a tunnel's settings and
 * Cloudflare Access, OPNsense's port forwards, UniFi's port forwards and UPnP switch (its older API: the official one
 * has no port forwards), Tailscale's policy. Endpoints that answer private keys are never asked.
 */
import { EXPOSURE_SOURCE_KINDS, type ExposureSourceKind } from '@whombat/core';
import type { CatalogConnectionRow } from '../connections/types';
import type { Services } from '../services';
import { cloudflareReader } from '../things/kinds/infra/cloudflare';
import { npmReader } from '../things/kinds/infra/nginx-proxy-manager';
import { opnsenseReader } from '../things/kinds/infra/opnsense';
import { optional, serviceUrl } from '../things/kinds/infra/shared';
import { cachedRead, getJson, latestRead } from '../things/kinds/read';
import { list, rec, str } from '../things/words';
import {
  type Blind,
  DNAT_RULES_MAX,
  funnelAllowed,
  npmOpenings,
  opnsenseUpnp,
  parseAccessDomains,
  parseDnat,
  parseTunnelConfig,
  parseUnifiForwards,
  type RawOpening,
  type SourceOpenings,
  tunnelOpenings,
  unifiSiteName,
  unifiUpnp,
} from './parse';

/** How long one place's openings are kept. */
export const EXPOSURE_KEEP_MS = 10 * 60_000;
/** Tunnels whose settings one read asks for. */
const TUNNELS_MAX = 20;

/** Whether a connection's settings can open something to the internet. */
export function isExposureSource(catalogId: string): catalogId is ExposureSourceKind {
  return (EXPOSURE_SOURCE_KINDS as readonly string[]).includes(catalogId);
}

/** `page` serves the last read while a new one comes (page-speed.md); `pass` reads when it is older than 10 minutes. */
export type ReadMode = 'page' | 'pass';

async function kept<T>(
  services: Services,
  row: CatalogConnectionRow,
  key: string,
  load: () => Promise<T>,
  mode: ReadMode,
): Promise<T> {
  if (mode === 'pass') return cachedRead(services, key, row, load, EXPOSURE_KEEP_MS);
  const r = await latestRead(services, key, row, load, { ttlMs: EXPOSURE_KEEP_MS });
  if (!r.ok) throw r.error;
  return r.value;
}

/* Each place --------------------------------------------------------------------------------------------------------- */

async function npm(services: Services, row: CatalogConnectionRow, mode: ReadMode): Promise<SourceOpenings> {
  const now = services.clock();
  if (mode === 'pass') return npmOpenings(await npmReader.cached(services, row, now));
  const r = await npmReader.latest(services, row, now);
  if (!r.ok) throw r.error;
  return npmOpenings(r.value);
}

async function cloudflare(
  services: Services,
  row: CatalogConnectionRow,
  mode: ReadMode,
): Promise<SourceOpenings> {
  const now = services.clock();
  const snapshot =
    mode === 'pass'
      ? await cloudflareReader.cached(services, row, now)
      : await cloudflareReader.latest(services, row, now).then((r) => {
          if (!r.ok) throw r.error;
          return r.value;
        });
  if (!snapshot.tunnels) return { openings: [], complete: false, blind: [{ code: 'tunnels_unread' }] };
  const tunnels = snapshot.tunnels.slice(0, TUNNELS_MAX);
  const accounts = [...new Set(tunnels.map((x) => x.account))];
  const access = await Promise.all(
    accounts.map((a) =>
      optional(
        kept(
          services,
          row,
          `exposure-cf-access:${row.id}:${a}`,
          async () =>
            parseAccessDomains(
              await getJson(
                services,
                row,
                'Cloudflare',
                `/client/v4/accounts/${encodeURIComponent(a)}/access/apps`,
                {
                  per_page: '100',
                },
              ),
            ),
          mode,
        ),
      ),
    ),
  );
  const domains = access.every((d) => d === null) && accounts.length ? null : access.flatMap((d) => d ?? []);
  const blind: Blind[] = [];
  if (accounts.length && access.some((d) => d === null)) blind.push({ code: 'access_unread' });
  const openings: RawOpening[] = [];
  let complete = !snapshot.tunnelsPartial && snapshot.tunnels.length <= TUNNELS_MAX;
  if (snapshot.tunnelsPartial) blind.push({ code: 'tunnels_unread' });
  await Promise.all(
    tunnels.map(async (tunnel) => {
      // `routes` null: the tunnel is set up on its own server, and its public names aren't in Cloudflare's settings.
      const read = await optional(
        kept(
          services,
          row,
          `exposure-cf-tunnel:${row.id}:${tunnel.id}`,
          async () => ({
            routes: parseTunnelConfig(
              await getJson(
                services,
                row,
                'Cloudflare',
                `/client/v4/accounts/${encodeURIComponent(tunnel.account)}/cfd_tunnel/${encodeURIComponent(tunnel.id)}/configurations`,
              ),
            ),
          }),
          mode,
        ),
      );
      if (!read) {
        complete = false;
        blind.push({ code: 'tunnel_config_unread', name: tunnel.name });
      } else if (!read.routes) blind.push({ code: 'tunnel_local', name: tunnel.name });
      else openings.push(...tunnelOpenings(tunnel.name, read.routes, domains));
    }),
  );
  return { openings, complete, blind };
}

/** OPNsense's rules per page of its search. */
export const DNAT_PAGE = 500;

/**
 * Every destination NAT rule, a page at a time (`current` 1, 2, …) until its `total` is read, or, from an answer
 * without one, until a page isn't full; `partial` when there were more than one read takes (`DNAT_RULES_MAX`).
 */
export async function dnatRules(
  page: (n: number) => Promise<unknown>,
): Promise<{ rows: unknown[]; partial: boolean }> {
  const rows: unknown[] = [];
  for (let n = 1; n <= DNAT_RULES_MAX / DNAT_PAGE; n++) {
    const body = rec(await page(n));
    const got = list(body.rows);
    rows.push(...got);
    const total = Number(body.total);
    const more = Number.isFinite(total) && total > 0 ? rows.length < total : got.length >= DNAT_PAGE;
    if (!got.length) return { rows, partial: more };
    if (!more) return { rows, partial: false };
  }
  return { rows, partial: true };
}

async function opnsense(
  services: Services,
  row: CatalogConnectionRow,
  mode: ReadMode,
): Promise<SourceOpenings> {
  const now = services.clock();
  const [forwards, snapshot] = await Promise.all([
    kept(
      services,
      row,
      `exposure-opnsense:${row.id}`,
      async () => {
        const read = await dnatRules((n) =>
          getJson(services, row, 'OPNsense', '/api/firewall/d_nat/search_rule', {
            current: String(n),
            rowCount: String(DNAT_PAGE),
          }),
        );
        return { ...parseDnat({ rows: read.rows }), partial: read.partial };
      },
      mode,
    ),
    optional(opnsenseReader.cached(services, row, now)),
  ]);
  const upnp = opnsenseUpnp(snapshot?.services ?? null);
  const blind: Blind[] = [...forwards.blind];
  // More rules than one read takes: what it found is listed, and the place never reads as complete.
  if (forwards.partial) blind.push({ code: 'forwards_partial' });
  if (upnp === true) blind.push({ code: 'upnp_on' });
  else if (upnp === null) blind.push({ code: 'upnp_unknown' });
  return { openings: forwards.openings, complete: !forwards.partial, blind };
}

/** The console's older API, beside the official one (`/proxy/network/api/…`). */
export function unifiLegacyBase(row: Pick<CatalogConnectionRow, 'baseUrl'>): string {
  return `${row.baseUrl.replace(/\/+$/, '').replace(/\/integration$/, '')}/api`;
}

async function unifi(services: Services, row: CatalogConnectionRow, mode: ReadMode): Promise<SourceOpenings> {
  const legacy = { ...row, baseUrl: unifiLegacyBase(row) };
  const read = await kept(
    services,
    row,
    `exposure-unifi:${row.id}`,
    async () => {
      const site = unifiSiteName(await getJson(services, row, 'UniFi', '/v1/sites')) ?? 'default';
      const S = `/s/${encodeURIComponent(site)}`;
      const [forwards, settings] = await Promise.all([
        getJson(services, legacy, 'UniFi', `${S}/rest/portforward`),
        optional(getJson(services, legacy, 'UniFi', `${S}/rest/setting`)),
      ]);
      return { forwards: parseUnifiForwards(forwards), upnp: settings ? unifiUpnp(settings) : null };
    },
    mode,
  );
  return {
    openings: read.forwards,
    complete: true,
    blind: read.upnp === true ? [{ code: 'upnp_on' }] : read.upnp === null ? [{ code: 'upnp_unknown' }] : [],
  };
}

async function tailscale(
  services: Services,
  row: CatalogConnectionRow,
  mode: ReadMode,
): Promise<SourceOpenings> {
  const who = await optional(
    kept(
      services,
      row,
      `exposure-tailscale:${row.id}`,
      async () => funnelAllowed(await getJson(services, row, 'Tailscale', '/api/v2/tailnet/-/acl')),
      mode,
    ),
  );
  // Funnel shares what a device chooses; the API says only who may. Nothing here is an opening of its own.
  if (who === null) return { openings: [], complete: true, blind: [{ code: 'policy_unread' }] };
  return {
    openings: [],
    complete: true,
    blind: who.length ? [{ code: 'funnel_allowed', who: who.join(', ') }] : [],
  };
}

const READERS: Record<
  ExposureSourceKind,
  (services: Services, row: CatalogConnectionRow, mode: ReadMode) => Promise<SourceOpenings>
> = {
  nginx_proxy_manager: npm,
  cloudflare,
  opnsense,
  unifi_network: unifi,
  tailscale,
};

/** One place's openings; throws when they couldn't be read. */
export function readOpenings(
  services: Services,
  row: CatalogConnectionRow,
  mode: ReadMode,
): Promise<SourceOpenings> {
  if (!isExposureSource(row.catalogId)) return Promise.resolve({ openings: [], complete: true, blind: [] });
  return READERS[row.catalogId](services, row, mode);
}

/** Where openings are changed: the service's own page (Cloudflare's tunnels in Zero Trust). */
export function manageUrlOf(row: CatalogConnectionRow): string | null {
  if (row.catalogId === 'cloudflare') return 'https://one.dash.cloudflare.com/';
  if (row.catalogId === 'tailscale') return 'https://login.tailscale.com/admin/acls';
  const url =
    row.catalogId === 'unifi_network'
      ? (str(row.fields.url) ?? row.baseUrl.replace(/\/proxy\/network\/integration$/, ''))
      : serviceUrl(row);
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}
