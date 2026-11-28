/**
 * What each place's settings say is open to the internet (docs/decisions/internet-exposure.md): pure readers of the
 * answers Whombat already gets, or gets with the same sign-in. Every opening is a `RawOpening`; `openings.ts` gives it
 * its words, what it leads to and what is worth a look.
 */
import { type ExposureGuard, type ExposureHow, isInsideIPv4, isPublicName } from '@whombat/core';
import type { NpmSite, NpmSnapshot, NpmStream } from '../things/kinds/infra/nginx-proxy-manager';
import { clip, list, rec, str } from '../things/words';

export interface RawOpening {
  how: ExposureHow;
  /** The public side: a name (“photos.example.com”) or a port (“32400”). */
  address: string;
  /** How many more public names the same host answers on (“and 2 more”). */
  moreNames?: number;
  /** The public port of a port forward or stream; null for a name. */
  port?: number | null;
  /** “TCP”, “UDP”, “TCP and UDP”; absent for a website. */
  protocol?: string | null;
  /** What it leads to as the source says it. */
  target: string | null;
  targetHost: string | null;
  targetPort: number | null;
  https: 'yes' | 'no' | 'unknown';
  guard: ExposureGuard;
  /** The access list's name, the addresses a port forward allows. */
  guardName?: string;
  /** A proxy host's certificate end. */
  certificateExpires?: Date | null;
  /** The tunnel or rule it belongs to, as the source names it. */
  label?: string;
}

/** What one source's read found. */
export interface SourceOpenings {
  openings: RawOpening[];
  /**
   * Every list of openings was read: the first full read becomes the silent first list. A partly read source keeps
   * adding to it silently until a full read comes.
   */
  complete: boolean;
  /** What Whombat couldn't see there, as codes `openings.ts` says in words. */
  blind: Blind[];
}

/**
 * What a source couldn't show: its streams or a tunnel's settings unread, tunnels set up on their own server, Access
 * unreadable, UPnP switched on (its openings can't be read), UPnP unknown, Funnel allowed (what it shares can't be read).
 */
export type Blind =
  | { code: 'streams_unread' }
  | { code: 'tunnels_unread' }
  | { code: 'tunnel_local'; name: string }
  | { code: 'tunnel_config_unread'; name: string }
  | { code: 'access_unread' }
  | { code: 'upnp_on' }
  | { code: 'upnp_unknown' }
  | { code: 'funnel_allowed'; who: string }
  | { code: 'policy_unread' };

/** Host and port of a URL or `host:port` (“http://192.168.1.20:2283” → 192.168.1.20, 2283). */
export function hostPort(target: string): { host: string | null; port: number | null } {
  const t = target.trim();
  if (!t) return { host: null, port: null };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `tcp://${t}`;
  try {
    const u = new URL(withScheme);
    const host = u.hostname.replace(/^\[|\]$/g, '') || null;
    const scheme = u.protocol.replace(/:$/, '');
    const port = u.port ? Number(u.port) : scheme === 'https' ? 443 : scheme === 'http' ? 80 : null;
    return { host: host?.toLowerCase() ?? null, port };
  } catch {
    return { host: null, port: null };
  }
}

const protocolWords = (tcp: boolean, udp: boolean) => (tcp && udp ? 'TCP and UDP' : udp ? 'UDP' : 'TCP');

/* Nginx Proxy Manager ---------------------------------------------------------------------------------------------- */

function npmSiteOpening(site: NpmSite): RawOpening | null {
  // A redirection sends people elsewhere: it leads to nothing in the house. A switched-off host answers nobody.
  if (site.kind !== 'proxy' || !site.enabled) return null;
  const names = site.domains.filter(isPublicName);
  const first = names[0];
  if (!first) return null;
  const at = hostPort(site.target);
  return {
    how: 'proxy',
    address: clip(first, 200),
    ...(names.length > 1 ? { moreNames: names.length - 1 } : {}),
    target: site.target,
    targetHost: at.host,
    targetPort: at.port,
    https: site.certificate ? 'yes' : 'no',
    guard: site.access ? 'access_list' : 'none',
    ...(site.access ? { guardName: site.access.name } : {}),
    certificateExpires: site.certificate?.expires ?? null,
  };
}

function npmStreamOpening(x: NpmStream): RawOpening | null {
  if (!x.enabled) return null;
  const at = hostPort(x.target);
  return {
    how: 'stream',
    address: String(x.incomingPort),
    port: x.incomingPort,
    protocol: protocolWords(x.tcp, x.udp),
    target: x.target,
    targetHost: at.host,
    targetPort: at.port,
    https: 'unknown',
    guard: 'none',
  };
}

/** Nginx Proxy Manager's proxy hosts with a public name, and its streams. */
export function npmOpenings(s: NpmSnapshot): SourceOpenings {
  const openings = [...s.sites.map(npmSiteOpening), ...(s.streamList ?? []).map(npmStreamOpening)].filter(
    (o): o is RawOpening => o !== null,
  );
  return {
    openings,
    complete: s.streamList !== undefined,
    blind: s.streamList === undefined ? [{ code: 'streams_unread' }] : [],
  };
}

/* Cloudflare ------------------------------------------------------------------------------------------------------- */

export interface TunnelRoute {
  hostname: string;
  /** “http://192.168.1.20:8123”, “ssh://nas:22”. */
  service: string;
  path: string | null;
}

/**
 * `/accounts/{a}/cfd_tunnel/{t}/configurations`: a tunnel set up in the dashboard has its public hostnames here; one
 * set up on its own server (`source: local`) has none, and null says Whombat can't see them.
 */
export function parseTunnelConfig(body: unknown): TunnelRoute[] | null {
  const result = rec(rec(body).result);
  const config = rec(result.config);
  if (str(result.source) === 'local' && !Array.isArray(config.ingress)) return null;
  if (!Array.isArray(config.ingress)) return str(result.source) === 'cloudflare' ? [] : null;
  return list(config.ingress)
    .slice(0, 200)
    .map((raw): TunnelRoute | null => {
      const r = rec(raw);
      const hostname = str(r.hostname);
      const service = str(r.service);
      // The last rule catches everything else, usually with a 404: it opens nothing by name.
      if (!hostname || !service || service.startsWith('http_status:')) return null;
      return { hostname: clip(hostname.toLowerCase(), 200), service: clip(service, 200), path: str(r.path) };
    })
    .filter((r): r is TunnelRoute => r !== null);
}

/** `/accounts/{a}/access/apps`: the names Cloudflare Access guards (an app's domain, its other domains, destinations). */
export function parseAccessDomains(body: unknown): string[] {
  const out: string[] = [];
  for (const raw of list(rec(body).result).slice(0, 500)) {
    const a = rec(raw);
    const type = str(a.type) ?? 'self_hosted';
    if (type !== 'self_hosted' && type !== 'saas' && type !== 'ssh' && type !== 'vnc' && type !== 'rdp')
      continue;
    const domain = str(a.domain);
    if (domain) out.push(domain);
    for (const d of list(a.self_hosted_domains)) if (typeof d === 'string' && d) out.push(d);
    for (const d of list(a.destinations)) {
      const uri = str(rec(d).uri);
      if (uri && (str(rec(d).type) ?? 'public') === 'public') out.push(uri);
    }
  }
  return out.map((d) => d.toLowerCase());
}

/** Whether an Access app guards this name: the same host, any path of it, or a wildcard over it. */
export function accessGuards(domains: readonly string[], hostname: string): boolean {
  const host = hostname.toLowerCase();
  return domains.some((d) => {
    const appHost = d.split('/')[0] ?? '';
    // An app on one path guards only that path: it doesn't guard the name.
    if (d.includes('/') && d.split('/').slice(1).join('/').length > 0) return false;
    if (appHost === host) return true;
    if (appHost.startsWith('*.')) return host.endsWith(appHost.slice(1)) && host !== appHost.slice(2);
    return false;
  });
}

/** A tunnel's public hostnames as openings. */
export function tunnelOpenings(
  tunnel: string,
  routes: readonly TunnelRoute[],
  access: readonly string[] | null,
): RawOpening[] {
  return routes
    .filter((r) => isPublicName(r.hostname))
    .map((r) => {
      const at = hostPort(r.service);
      const guarded = access ? accessGuards(access, r.hostname) : null;
      return {
        how: 'tunnel' as const,
        address: r.path ? clip(`${r.hostname}/${r.path.replace(/^\^?\/?/, '')}`, 200) : r.hostname,
        target: r.service,
        targetHost: at.host,
        targetPort: at.port,
        // Cloudflare answers the name over HTTPS at its edge.
        https: 'yes' as const,
        guard:
          guarded === null
            ? ('unknown' as const)
            : guarded
              ? ('cloudflare_access' as const)
              : ('none' as const),
        label: tunnel,
      };
    });
}

/* Routers: OPNsense and UniFi -------------------------------------------------------------------------------------- */

/** A field that may come flat (`destination.port`), nested or under an older name. */
function field(r: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    if (n in r && r[n] !== undefined && r[n] !== null && r[n] !== '') return r[n];
    const [a, b] = n.split('.');
    if (b && a) {
      const v = rec(r[a])[b];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return undefined;
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

/** The first port of “32400”, “8000-8010”, “8000:8010”; null for an alias or none. */
export function firstPort(v: unknown): number | null {
  const m = /^\s*(\d{1,5})/.exec(String(v ?? ''));
  const n = m ? Number(m[1]) : null;
  return n !== null && n > 0 && n < 65_536 ? n : null;
}

/** “any”, empty or an “any”-like value: from everywhere. */
function fromAnywhere(v: unknown): boolean {
  const s = (str(v) ?? 'any').toLowerCase();
  return s === 'any' || s === '' || s === '0.0.0.0/0' || s === '::/0';
}

/**
 * `/api/firewall/d_nat/search_rule` (OPNsense 25.7 and later): the port forwards on a WAN interface that are switched
 * on and redirect (`nordr` is “don't redirect”). A rule on another interface (a DNS redirect on the LAN) opens nothing
 * to the internet.
 */
export function parseDnat(body: unknown): RawOpening[] {
  return list(rec(body).rows)
    .slice(0, 500)
    .map((raw): RawOpening | null => {
      const r = rec(raw);
      if (truthy(field(r, 'disabled')) || truthy(field(r, 'nordr'))) return null;
      const iface = String(field(r, 'interface') ?? '').toLowerCase();
      if (!iface.split(',').some((i) => /wan/.test(i.trim()))) return null;
      const dst = field(r, 'destination.port', 'destination_port', 'dstport');
      const port = firstPort(dst);
      const targetHost = str(field(r, 'target'));
      if (port === null || !targetHost) return null;
      const local = firstPort(field(r, 'local-port', 'local_port', 'localport')) ?? port;
      const proto = (str(field(r, 'protocol')) ?? 'TCP').toUpperCase();
      const source = field(r, 'source.network', 'source_net', 'source.address');
      const anyone = fromAnywhere(source) || truthy(field(r, 'source.not'));
      const host = targetHost.toLowerCase();
      return {
        how: 'port_forward',
        address: clip(String(dst), 40),
        port,
        protocol: proto === 'TCP/UDP' ? 'TCP and UDP' : proto,
        target: `${host}:${local}`,
        targetHost: host,
        targetPort: local,
        https: 'unknown',
        guard: anyone ? 'none' : 'some_addresses',
        ...(anyone ? {} : { guardName: clip(String(source), 80) }),
        ...(str(field(r, 'descr', 'description'))
          ? { label: clip(str(field(r, 'descr', 'description')) ?? '', 80) }
          : {}),
      };
    })
    .filter((o): o is RawOpening => o !== null);
}

/** Whether OPNsense's UPnP service runs (`miniupnpd` in its services); null when its services weren't read. */
export function opnsenseUpnp(services: readonly { id: string; running: boolean }[] | null): boolean | null {
  if (!services) return null;
  return services.some((s) => s.id.startsWith('miniupnpd') && s.running);
}

/** UniFi's `rest/portforward` (`{data: [{name, enabled, dst_port, fwd, fwd_port, proto, src}]}`). */
export function parseUnifiForwards(body: unknown): RawOpening[] {
  return list(rec(body).data)
    .slice(0, 500)
    .map((raw): RawOpening | null => {
      const r = rec(raw);
      if (r.enabled === false) return null;
      const port = firstPort(r.dst_port);
      const host = str(r.fwd)?.toLowerCase();
      if (port === null || !host) return null;
      const local = firstPort(r.fwd_port) ?? port;
      const proto = (str(r.proto) ?? 'tcp_udp').toLowerCase();
      const src = r.src_limiting_enabled === true ? (str(r.src_limiting_cidr) ?? str(r.src)) : str(r.src);
      const anyone = fromAnywhere(src);
      return {
        how: 'port_forward',
        address: clip(String(r.dst_port), 40),
        port,
        protocol: proto === 'tcp' ? 'TCP' : proto === 'udp' ? 'UDP' : 'TCP and UDP',
        target: `${host}:${local}`,
        targetHost: host,
        targetPort: local,
        https: 'unknown',
        guard: anyone ? 'none' : 'some_addresses',
        ...(anyone ? {} : { guardName: clip(String(src), 80) }),
        ...(str(r.name) ? { label: clip(str(r.name) ?? '', 80) } : {}),
      };
    })
    .filter((o): o is RawOpening => o !== null);
}

/** UniFi's `rest/setting`: whether UPnP is on (the gateway's `usg` setting's `upnp_enabled`); null when not said. */
export function unifiUpnp(body: unknown): boolean | null {
  for (const raw of list(rec(body).data)) {
    const r = rec(raw);
    if (typeof r.upnp_enabled === 'boolean') return r.upnp_enabled;
  }
  return null;
}

/** The first site's name in the older API (“default”) from the official API's `/v1/sites`. */
export function unifiSiteName(body: unknown): string | null {
  const first = rec(list(rec(body).data)[0]);
  return str(first.internalReference) ?? (first.id ? 'default' : null);
}

/* Tailscale ---------------------------------------------------------------------------------------------------------- */

/**
 * Who the tailnet's policy lets use Funnel (`nodeAttrs` with the `funnel` attribute): “autogroup:member”, a tag, a
 * person. Empty: nobody may, so nothing is shared through it. What a device shares can't be read from the API.
 */
export function funnelAllowed(policy: unknown): string[] {
  const out = new Set<string>();
  for (const raw of list(rec(policy).nodeAttrs)) {
    const a = rec(raw);
    if (!list(a.attr).some((x) => x === 'funnel')) continue;
    for (const t of list(a.target)) if (typeof t === 'string' && t) out.add(t);
  }
  return [...out].slice(0, 20);
}

/** Whether a target is an address the internet can't reach by itself (a private one), for the words. */
export function insideTarget(host: string | null): boolean {
  return !!host && (isInsideIPv4(host) || !host.includes('.'));
}
