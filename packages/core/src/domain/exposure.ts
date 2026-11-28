/**
 * What the internet can reach (Whombat internet-exposure.md): every opening Whombat finds in the settings of what it is
 * already connected to — a proxy host with a public name, a Cloudflare tunnel's public hostname, a port forward on the
 * router, Tailscale Funnel — what each leads to, whether something guards it, and what is worth a look. Whombat never
 * checks from outside the house: the page says which places it read and which it can't see, so it never looks
 * complete when it isn't. Its words are the server's, in the person's language.
 */
import { z } from 'zod';
import { Timestamp } from './common.js';
import { HomeHref } from './home.js';
import { NoticeCheck, NoticeSubject } from './quiet.js';

/**
 * The check that says something new is open to the internet: one line per new opening, on the connection whose
 * settings opened it. It starts on: a security opening, and Whombat says what it leads to.
 */
export const EXPOSURE_NEW_CHECK = 'exposure.new';

/** Where Whombat reads openings from: the connections' catalog ids. */
export const EXPOSURE_SOURCE_KINDS = [
  'nginx_proxy_manager',
  'cloudflare',
  'opnsense',
  'unifi_network',
  'tailscale',
] as const;
export const ExposureSourceKind = z.enum(EXPOSURE_SOURCE_KINDS);
export type ExposureSourceKind = z.infer<typeof ExposureSourceKind>;

/**
 * How it opens: a proxy host (`proxy`), a redirection (`redirect`), a forwarded stream on the proxy (`stream`), a
 * tunnel's public hostname (`tunnel`), a port forward on the router (`port_forward`), Tailscale Funnel (`funnel`).
 */
export const ExposureHow = z.enum(['proxy', 'redirect', 'stream', 'tunnel', 'port_forward', 'funnel']);
export type ExposureHow = z.infer<typeof ExposureHow>;

/**
 * Whether it is served over HTTPS (`unknown` for a port Whombat can't tell), and what guards it besides the thing's own
 * sign-in: an access list on the proxy, Cloudflare Access, only some addresses on the router, or nothing.
 */
export const ExposureGuard = z.enum([
  'access_list',
  'cloudflare_access',
  'some_addresses',
  'none',
  'unknown',
]);
export type ExposureGuard = z.infer<typeof ExposureGuard>;

export const ExposureProtection = z.object({
  https: z.enum(['yes', 'no', 'unknown']),
  guard: ExposureGuard,
  /** In words: “HTTPS · access list ‘Family’”, “No HTTPS · nothing in front of it”. */
  words: z.string().min(1).max(200),
});
export type ExposureProtection = z.infer<typeof ExposureProtection>;

/**
 * Worth a look, few and certain: a management page or a remote desktop reachable with nothing in front of it
 * (`admin_open`), a website without HTTPS (`no_https`), a site whose certificate has ended (`certificate_expired`).
 */
export const ExposureRiskKind = z.enum(['admin_open', 'no_https', 'certificate_expired']);
export type ExposureRiskKind = z.infer<typeof ExposureRiskKind>;

export const ExposureRisk = z.object({
  kind: ExposureRiskKind,
  words: z.string().min(1).max(200),
});
export type ExposureRisk = z.infer<typeof ExposureRisk>;

/** One opening, in the server's words. */
export const ExposureOpening = z.object({
  /** Stable while the opening stays the same (its public side and what it leads to): `op_<hash>`. */
  id: z.string().min(1).max(64),
  source: ExposureSourceKind,
  /** The connection whose settings open it (`connection:con_…`). */
  sourceThing: z.string().min(3).max(220),
  /** That connection's name (“Nginx Proxy Manager”, “UniFi”). */
  sourceName: z.string().min(1).max(120),
  how: ExposureHow,
  /** The public side as people know it: “photos.example.com”, “Port 32400”. */
  address: z.string().min(1).max(200),
  /** The row's line: “photos.example.com → Immich on nas-01”. */
  title: z.string().min(1).max(240),
  /** Where it comes from: “Through Nginx Proxy Manager”, “Port forward on UniFi”. */
  via: z.string().min(1).max(160),
  /** What it leads to as the source says it (“192.168.1.20:2283”, “http://homeassistant:8123”). */
  target: z.string().max(200).optional(),
  /** The server, guest or connection it leads to, when Whombat knows it by its address. */
  leadsTo: z
    .object({ thing: z.string().min(3).max(220), name: z.string().min(1).max(120), href: HomeHref })
    .optional(),
  protection: ExposureProtection,
  /** Worth a look; absent when nothing is, and when the person said it's meant. */
  risk: ExposureRisk.optional(),
  /** The person said it's meant (This is meant): no highlight, no line. */
  meant: z.boolean(),
  /** Opened since Whombat made its first list for that source, and nobody said it's meant yet. */
  isNew: z.boolean(),
  /** When Whombat first saw it; absent before the first list for its source is kept. */
  firstSeen: Timestamp.optional(),
  /** Where it is changed: the source's own page. */
  manage: z.object({ label: z.string().min(1).max(60), url: z.string().url().max(500) }).optional(),
  /** The question “Ask Dusty” starts with. */
  ask: z.string().min(1).max(300),
  /** What This is meant switches off (`things.setWatch` on the source with this item, `watched: false`). */
  watch: z.object({ thing: z.string().min(3).max(220), check: NoticeCheck, subject: NoticeSubject }),
});
export type ExposureOpening = z.infer<typeof ExposureOpening>;

/**
 * A place Whombat looked, or couldn't: `read` (everything it can see there), `partly` (some of it: the words say what
 * is missing), `unread` (it couldn't read it now), `missing` (nothing connected that would show it: a router).
 */
export const ExposureSourceState = z.enum(['read', 'partly', 'unread', 'missing']);
export type ExposureSourceState = z.infer<typeof ExposureSourceState>;

export const ExposureSource = z.object({
  /** The connection (`connection:con_…`); absent for a place that isn't connected. */
  thing: z.string().min(3).max(220).optional(),
  name: z.string().min(1).max(120),
  state: ExposureSourceState,
  /** “3 openings”, “Whombat can’t see your router’s port forwards. Connect it to include them.” */
  words: z.string().min(1).max(300),
  /** Where to go about it: the connection's page, or Add a connection. */
  href: HomeHref.optional(),
});
export type ExposureSource = z.infer<typeof ExposureSource>;

/** `things.exposure`: the page Open to the internet (session minor 22). */
export const ExposureView = z.object({
  /** Worth a look and new first, then the rest by address. */
  openings: z.array(ExposureOpening).max(500),
  sources: z.array(ExposureSource).max(40),
  /** “6 openings · 1 worth a look”, “Nothing Whombat can see is open to the internet.” */
  summary: z.string().min(1).max(200),
  /** What the page can't promise, in one sentence: Whombat only reads settings and never checks from outside. */
  note: z.string().min(1).max(300),
  readAt: Timestamp,
});
export type ExposureView = z.infer<typeof ExposureView>;

/* Pure helpers both sides use ------------------------------------------------------------------------------------- */

/** Names that only answer inside a house or a tailnet: never an opening by themselves. */
const INSIDE_SUFFIXES = [
  '.local',
  '.lan',
  '.home',
  '.home.arpa',
  '.internal',
  '.localdomain',
  '.localhost',
  '.ts.net',
];

/** An IPv4 address that the internet can't reach directly (private, shared, loopback, link-local). */
export function isInsideIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Whether a name people would type on the internet: a domain with a dot that isn't a house-only name or an inside
 * address. Wildcards count (“*.example.com” opens every name under it).
 */
export function isPublicName(name: string): boolean {
  const host = name.trim().toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host === 'localhost') return false;
  if (isInsideIPv4(host)) return false;
  if (host.includes(':')) return false;
  return !INSIDE_SUFFIXES.some((s) => host.endsWith(s));
}

/**
 * Ports whose service is for managing a computer, certain enough to be worth a look when nothing guards them: Telnet,
 * Windows file sharing, Remote Desktop, VNC, Proxmox, Proxmox Backup Server, Portainer and Webmin. Ports that many
 * things use (8080, 8443, 5000) aren't on it: a guess would make the highlight noise.
 */
export const ADMIN_PORTS: Readonly<Record<number, string>> = {
  23: 'Telnet',
  445: 'Windows file sharing',
  3389: 'Remote Desktop',
  5900: 'VNC',
  8006: 'Proxmox',
  8007: 'Proxmox Backup Server',
  9443: 'Portainer',
  10000: 'Webmin',
};

/**
 * The connections' kinds whose page manages a computer, a network or its storage: a hypervisor, a NAS, a container
 * manager, a router or firewall, the proxy's own admin page. Home Assistant and media servers have their own sign-in
 * and are meant to be reached from outside often; they aren't on this list.
 */
export const ADMIN_KINDS: ReadonlySet<string> = new Set([
  'proxmox',
  'proxmox_backup',
  'truenas',
  'synology',
  'qnap',
  'unraid',
  'portainer',
  'opnsense',
  'unifi_network',
  'unifi_protect',
  'unifi_access',
  'nginx_proxy_manager',
  'pihole',
  'adguard',
  'pterodactyl',
]);

/** The name of what an admin port serves (“Remote Desktop”), or null when the port isn't one of them. */
export function adminPortName(port: number | null | undefined): string | null {
  if (port === null || port === undefined) return null;
  return ADMIN_PORTS[port] ?? null;
}
