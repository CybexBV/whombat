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
  /**
   * Every public name of a proxy host, lowercase and sorted, when it has more than one: the opening is all of them, so
   * a name added is a new opening and the order they are listed in changes nothing.
   */
  names?: string[];
  /** The list it was read from (`ReadPart.key`): what is new is told per list. */
  part: string;
}

/**
 * One list a read covered: a proxy's hosts or streams, a router's port forwards, the list of tunnels and each tunnel's
 * routes. `whole` when all of it was read; a list missing from a read wasn't read at all. A list `within` another (a
 * tunnel's routes within the list of tunnels) that came after that list was kept is new from the start.
 */
export interface ReadPart {
  key: string;
  whole: boolean;
  within?: string;
}

/** What one source's read found. */
export interface SourceOpenings {
  openings: RawOpening[];
  /**
   * Every list of openings was read: the first full read becomes the silent first list. A partly read source keeps
   * adding to it silently until a full read comes.
   */
  complete: boolean;
  /** The lists this read covered: the first list is kept per list, so one that can't be read doesn't hold back the rest. */
  parts: ReadPart[];
  /** What Whombat couldn't see there, as codes `openings.ts` says in words. */
  blind: Blind[];
}

/**
 * What a source couldn't show: its streams or a tunnel's settings unread, tunnels set up on their own server, Access
 * unreadable, UPnP switched on (its openings can't be read), UPnP unknown, Funnel allowed (what it shares can't be read),
 * more port forwards than one read takes, port forwards whose port or target is an alias Whombat can't read.
 */
export type Blind =
  | { code: 'streams_unread' }
  | { code: 'forwards_partial' }
  | { code: 'forwards_unread'; count: number; names: string }
  | { code: 'tunnels_unread' }
  | { code: 'tunnel_local'; name: string }
  | { code: 'tunnel_config_unread'; name: string }
  | { code: 'access_unread' }
  | { code: 'upnp_on' }
  | { code: 'upnp_unknown' }
  | { code: 'funnel_allowed'; who: string }
  | { code: 'policy_unread' };

/** Host and port of a URL or `host:port` (“http://10.100.0.20:2283” → 10.100.0.20, 2283). */
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
  const all = [...new Set(names.map((n) => n.trim().toLowerCase()))].sort();
  return {
    how: 'proxy',
    part: 'proxy',
    address: clip(first, 200),
    ...(names.length > 1 ? { moreNames: names.length - 1 } : {}),
    ...(all.length > 1 ? { names: all } : {}),
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
    part: 'stream',
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
    parts: [{ key: 'proxy', whole: true }, ...(s.streamList ? [{ key: 'stream', whole: true }] : [])],
    blind: s.streamList === undefined ? [{ code: 'streams_unread' }] : [],
  };
}

/* Cloudflare ------------------------------------------------------------------------------------------------------- */

export interface TunnelRoute {
  hostname: string;
  /** “http://10.100.0.20:8123”, “ssh://nas:22”. */
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

/**
 * What an Access application does for the names it covers, from its policies: `guarded` (everyone must sign in, or
 * nobody gets in), `open` (a Bypass for everyone: nothing in front of it), `unknown` (policies not in the answer, a
 * Bypass for some, or anyone who can sign in at all).
 */
export type AccessVerdict = 'guarded' | 'open' | 'unknown';

/** One name an Access application covers (its domain, other domains, destinations), with what its policies do. */
export interface AccessApp {
  domain: string;
  verdict: AccessVerdict;
}

/** What an application's `policies` let through. */
export function accessVerdict(app: Record<string, unknown>): AccessVerdict {
  if (!Array.isArray(app.policies)) return 'unknown';
  let verdict: AccessVerdict = 'guarded';
  for (const raw of app.policies) {
    const p = rec(raw);
    const decision = (str(p.decision) ?? '').toLowerCase();
    if (decision === 'deny') continue;
    const everyone = list(p.include).some((i) => 'everyone' in rec(i));
    if (decision === 'bypass' && everyone) return 'open';
    // A Bypass for some (an address range) lets them in without a sign-in; “everyone” lets anyone who can sign in.
    if (decision === 'bypass' || everyone) verdict = 'unknown';
  }
  return verdict;
}

/** `/accounts/{a}/access/apps`: the names Cloudflare Access covers and what each application's policies do. */
export function parseAccessDomains(body: unknown): AccessApp[] {
  const out: AccessApp[] = [];
  for (const raw of list(rec(body).result).slice(0, 500)) {
    const a = rec(raw);
    const type = str(a.type) ?? 'self_hosted';
    if (type !== 'self_hosted' && type !== 'saas' && type !== 'ssh' && type !== 'vnc' && type !== 'rdp')
      continue;
    const verdict = accessVerdict(a);
    const domains: string[] = [];
    const domain = str(a.domain);
    if (domain) domains.push(domain);
    for (const d of list(a.self_hosted_domains)) if (typeof d === 'string' && d) domains.push(d);
    for (const d of list(a.destinations)) {
      const uri = str(rec(d).uri);
      if (uri && (str(rec(d).type) ?? 'public') === 'public') domains.push(uri);
    }
    for (const d of domains) out.push({ domain: d.toLowerCase(), verdict });
  }
  return out;
}

const WORST: Readonly<Record<AccessVerdict, number>> = { guarded: 0, unknown: 1, open: 2 };

/**
 * What Access does for this name, null when no application covers it: the applications on the same host (any path of
 * it) first, as Cloudflare picks the most specific; else a wildcard over it. Of several, the least guarded.
 */
export function accessGuards(apps: readonly AccessApp[], hostname: string): AccessVerdict | null {
  const host = hostname.toLowerCase();
  const exact: AccessVerdict[] = [];
  const wild: AccessVerdict[] = [];
  for (const { domain, verdict } of apps) {
    const appHost = domain.split('/')[0] ?? '';
    // An app on one path guards only that path: it doesn't guard the name.
    if (domain.includes('/') && domain.split('/').slice(1).join('/').length > 0) continue;
    if (appHost === host) exact.push(verdict);
    else if (appHost.startsWith('*.') && host.endsWith(appHost.slice(1)) && host !== appHost.slice(2))
      wild.push(verdict);
  }
  const found = exact.length ? exact : wild;
  if (!found.length) return null;
  return found.reduce((a, b) => (WORST[b] > WORST[a] ? b : a));
}

/** How an opening behind a tunnel is guarded: Access read or not, and what it does for the name. */
function tunnelGuard(access: readonly AccessApp[] | null, hostname: string): ExposureGuard {
  if (!access) return 'unknown';
  const verdict = accessGuards(access, hostname);
  if (verdict === null || verdict === 'open') return 'none';
  return verdict === 'guarded' ? 'cloudflare_access' : 'unknown';
}

/** The list of one tunnel's routes, within the list of tunnels (`TUNNELS_PART`). */
export const tunnelPart = (id: string) => `tunnel:${id}`;
export const TUNNELS_PART = 'tunnels';

/** A tunnel's public hostnames as openings. */
export function tunnelOpenings(
  tunnel: { id: string; name: string },
  routes: readonly TunnelRoute[],
  access: readonly AccessApp[] | null,
): RawOpening[] {
  return routes
    .filter((r) => isPublicName(r.hostname))
    .map((r) => {
      const at = hostPort(r.service);
      return {
        how: 'tunnel' as const,
        part: tunnelPart(tunnel.id),
        address: r.path ? clip(`${r.hostname}/${r.path.replace(/^\^?\/?/, '')}`, 200) : r.hostname,
        target: r.service,
        targetHost: at.host,
        targetPort: at.port,
        // Cloudflare answers the name over HTTPS at its edge.
        https: 'yes' as const,
        guard: tunnelGuard(access, r.hostname),
        label: tunnel.name,
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

/** Ports a router names as the system's services list does (OPNsense keeps `http`, `https`, `ssh`…). */
const PORT_NAMES: Readonly<Record<string, number>> = {
  ftp: 21,
  ssh: 22,
  telnet: 23,
  smtp: 25,
  domain: 53,
  dns: 53,
  http: 80,
  www: 80,
  kerberos: 88,
  pop3: 110,
  ntp: 123,
  imap: 143,
  snmp: 161,
  ldap: 389,
  https: 443,
  'microsoft-ds': 445,
  smb: 445,
  smtps: 465,
  isakmp: 500,
  submission: 587,
  ldaps: 636,
  imaps: 993,
  pop3s: 995,
  openvpn: 1194,
  pptp: 1723,
  mysql: 3306,
  'ms-wbt-server': 3389,
  rdp: 3389,
  'ipsec-nat-t': 4500,
  sip: 5060,
  postgresql: 5432,
  rfb: 5900,
  vnc: 5900,
  'http-alt': 8080,
};

/** The first port of “32400”, “8000-8010”, “8000:8010” or a named one (“https”); null for an alias or none. */
export function firstPort(v: unknown): number | null {
  const text = String(v ?? '').trim();
  const named = PORT_NAMES[text.toLowerCase()];
  if (named !== undefined) return named;
  const m = /^(\d{1,5})/.exec(text);
  const n = m ? Number(m[1]) : null;
  return n !== null && n > 0 && n < 65_536 ? n : null;
}

/** “any”, empty or an “any”-like value: from everywhere. */
function fromAnywhere(v: unknown): boolean {
  const s = (str(v) ?? 'any').toLowerCase();
  return s === 'any' || s === '' || s === '0.0.0.0/0' || s === '::/0';
}

/** The most rules one read of OPNsense's destination NAT takes (its pages together). */
export const DNAT_RULES_MAX = 5000;

/** OPNsense's port forwards: those it could read, and what it couldn't. */
export interface DnatRead {
  openings: RawOpening[];
  blind: Blind[];
}

/**
 * `/api/firewall/d_nat/search_rule` (OPNsense 25.7 and later): the port forwards on a WAN interface that are switched
 * on and redirect (`nordr` is “don't redirect”). A rule on another interface (a DNS redirect on the LAN) opens nothing
 * to the internet. A WAN forward whose port or target is an alias Whombat can't read isn't dropped silently: it is a
 * blind spot of the place, by its description.
 */
export function parseDnat(body: unknown): DnatRead {
  const unread: string[] = [];
  const openings = list(rec(body).rows)
    .slice(0, DNAT_RULES_MAX)
    .map((raw): RawOpening | null => {
      const r = rec(raw);
      if (truthy(field(r, 'disabled')) || truthy(field(r, 'nordr'))) return null;
      const iface = String(field(r, 'interface') ?? '').toLowerCase();
      if (!iface.split(',').some((i) => /wan/.test(i.trim()))) return null;
      const dst = field(r, 'destination.port', 'destination_port', 'dstport');
      const port = firstPort(dst);
      const targetHost = str(field(r, 'target'));
      if (port === null || !targetHost) {
        unread.push(clip(str(field(r, 'descr', 'description')) ?? String(dst ?? targetHost ?? '?'), 40));
        return null;
      }
      const local = firstPort(field(r, 'local-port', 'local_port', 'localport')) ?? port;
      const proto = (str(field(r, 'protocol')) ?? 'TCP').toUpperCase();
      const source = field(r, 'source.network', 'source_net', 'source.address');
      const anyone = fromAnywhere(source) || truthy(field(r, 'source.not'));
      const host = targetHost.toLowerCase();
      return {
        how: 'port_forward',
        part: 'port_forward',
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
  const blind: Blind[] = unread.length
    ? [{ code: 'forwards_unread', count: unread.length, names: clip(unread.slice(0, 3).join(', '), 120) }]
    : [];
  return { openings, blind };
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
        part: 'port_forward',
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
