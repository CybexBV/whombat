/**
 * An opening in Whombat's words (docs/decisions/internet-exposure.md): its stable id, what it leads to when Whombat
 * knows the thing by its address, what guards it, and what is worth a look — few and certain. Pure: the reads and the
 * kept first list come in.
 */
import { createHash } from 'node:crypto';
import {
  ADMIN_KINDS,
  adminPortName,
  EXPOSURE_NEW_CHECK,
  type ExposureOpening,
  type ExposureProtection,
  type ExposureRisk,
  type ExposureSourceKind,
} from '@whombat/core';
import { type ServerMessageKey, tpServer, tServer } from '../i18n/catalog';
import { clip } from '../things/words';
import type { RawOpening } from './parse';

/** What an opening leads to, when Whombat knows it: a connection (with what it runs on) or a server or guest. */
export interface LinkTarget {
  thing: string;
  name: string;
  href: string;
  /** A connection's catalog id (`proxmox`), for whether it is a management page. */
  kind?: string;
  /** The machine a connection runs on (“nas-01”). */
  machine?: string;
}

/** Connections by `host:port`, and servers and guests by address. */
export interface Links {
  connections: Map<string, LinkTarget>;
  machines: Map<string, LinkTarget>;
}

export const NO_LINKS: Links = { connections: new Map(), machines: new Map() };

/** What a target host and port lead to: the connection on that address and port first, else the machine. */
export function linkOf(links: Links, host: string | null, port: number | null): LinkTarget | null {
  if (!host) return null;
  const h = host.toLowerCase();
  return (port !== null ? links.connections.get(`${h}:${port}`) : undefined) ?? links.machines.get(h) ?? null;
}

/**
 * The opening's id: the same while its source, public side and target stay the same. A changed target is another
 * opening (something else is reachable now).
 */
export function openingId(sourceId: string, o: Pick<RawOpening, 'how' | 'address' | 'target'>): string {
  const key = [sourceId, o.how, o.address.toLowerCase(), (o.target ?? '').toLowerCase()].join('\n');
  return `op_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
}

/** The item an opening is in What Whombat watches: `open:<id>`. */
export const openingSubject = (id: string) => `open:${id}`;

/** The source a row comes from. */
export interface OpeningSource {
  kind: ExposureSourceKind;
  /** The connection's id (`con_…`). */
  id: string;
  /** Its name as the person calls it. */
  name: string;
  /** The service's own page, where openings are changed. */
  manageUrl: string | null;
}

/** What Whombat kept of an opening (the first list, when it was first seen). */
export interface KeptOpening {
  firstSeen: Date;
  baseline: boolean;
}

/** How long an opening that came after the first list is new: after two weeks of its line it is known. */
export const NEW_FOR_MS = 14 * 86_400_000;

/** Whether a kept opening is new now: not in the first list, and first seen less than `NEW_FOR_MS` ago. */
export function isNewOpening(k: Pick<KeptOpening, 'firstSeen' | 'baseline'> | undefined, now: Date): boolean {
  return !!k && !k.baseline && now.getTime() - k.firstSeen.getTime() < NEW_FOR_MS;
}

export interface OpeningCtx {
  locale: string;
  now: Date;
  timeZone: string;
  source: OpeningSource;
  links: Links;
  /** Items the person said are meant (`open:<id>` switched off for `exposure.new`). */
  meant: ReadonlySet<string>;
  kept: ReadonlyMap<string, KeptOpening>;
}

const t = (locale: string, key: ServerMessageKey, vars?: Record<string, string | number>) =>
  tServer(locale, key, vars);

const upperFirst = (s: string) => (s ? `${s[0]?.toUpperCase()}${s.slice(1)}` : s);

/** The public side in words: the name (“photos.example.com and 2 more”), or “Port 32400”. */
export function addressWords(o: RawOpening, locale: string): string {
  if (o.how === 'port_forward' || o.how === 'stream') return t(locale, 'exposure.port', { port: o.address });
  return o.moreNames
    ? tpServer(locale, 'exposure.moreNames', o.moreNames, { address: o.address })
    : o.address;
}

/** What it leads to in words: “Immich on nas-01”, “nas-01”, or the target as the source says it. */
export function whatWords(o: RawOpening, link: LinkTarget | null, locale: string): string {
  if (link?.machine) return t(locale, 'exposure.on', { name: link.name, machine: link.machine });
  return link?.name ?? o.target ?? o.address;
}

function protocolWords(p: string | null | undefined, locale: string): string {
  if (p === 'UDP') return t(locale, 'exposure.protocol.udp');
  if (p === 'TCP and UDP') return t(locale, 'exposure.protocol.both');
  return t(locale, 'exposure.protocol.tcp');
}

/** Where it comes from: “Through Nginx Proxy Manager”, “Port forward on UniFi · TCP”. */
export function viaWords(o: RawOpening, source: OpeningSource, locale: string): string {
  switch (o.how) {
    case 'proxy':
    case 'redirect':
      return t(locale, 'exposure.via.proxy', { source: source.name });
    case 'stream':
      return t(locale, 'exposure.via.stream', {
        source: source.name,
        protocol: protocolWords(o.protocol, locale),
      });
    case 'tunnel':
      return t(locale, 'exposure.via.tunnel', { tunnel: o.label ?? source.name });
    case 'port_forward':
      return o.label
        ? t(locale, 'exposure.via.portForwardNamed', {
            label: o.label,
            source: source.name,
            protocol: protocolWords(o.protocol, locale),
          })
        : t(locale, 'exposure.via.portForward', {
            source: source.name,
            protocol: protocolWords(o.protocol, locale),
          });
    default:
      return t(locale, 'exposure.via.proxy', { source: source.name });
  }
}

/** HTTPS and what stands in front of it, in words. */
export function protectionOf(o: RawOpening, locale: string): ExposureProtection {
  const guard =
    o.guard === 'access_list'
      ? t(locale, 'exposure.guard.accessList', { name: o.guardName ?? '' })
      : o.guard === 'cloudflare_access'
        ? t(locale, 'exposure.guard.cloudflareAccess')
        : o.guard === 'some_addresses'
          ? t(locale, 'exposure.guard.someAddresses', { addresses: o.guardName ?? '' })
          : o.guard === 'none'
            ? t(locale, 'exposure.guard.none')
            : t(locale, 'exposure.guard.unknown');
  const https =
    o.https === 'yes'
      ? t(locale, 'exposure.https.yes')
      : o.https === 'no'
        ? t(locale, 'exposure.https.no')
        : null;
  return {
    https: o.https,
    guard: o.guard,
    words: clip(https ? `${https} · ${guard}` : upperFirst(guard), 200),
  };
}

/** What makes it a management page: the connection's kind, else a port only management uses. */
export function adminName(o: RawOpening, link: LinkTarget | null): string | null {
  if (link?.kind && ADMIN_KINDS.has(link.kind)) return link.name;
  const port = adminPortName(o.targetPort) ?? (o.how === 'port_forward' ? adminPortName(o.port) : null);
  return port;
}

/**
 * Worth a look, few and certain: a management page with nothing in front of it, a proxy host whose certificate has
 * ended, a proxy host without HTTPS. Only one, the most serious; nothing when the person said it's meant.
 */
export function riskOf(
  o: RawOpening,
  link: LinkTarget | null,
  ctx: Pick<OpeningCtx, 'locale' | 'now' | 'timeZone'>,
): ExposureRisk | null {
  const admin = adminName(o, link);
  if (admin && o.guard === 'none')
    return { kind: 'admin_open', words: t(ctx.locale, 'exposure.risk.adminOpen', { what: admin }) };
  if (o.how === 'proxy' && o.certificateExpires && o.certificateExpires <= ctx.now)
    return {
      kind: 'certificate_expired',
      words: t(ctx.locale, 'exposure.risk.certificateExpired', {
        when: new Intl.DateTimeFormat(ctx.locale, {
          timeZone: ctx.timeZone,
          day: 'numeric',
          month: 'short',
        }).format(o.certificateExpires),
      }),
    };
  if (o.how === 'proxy' && o.https === 'no')
    return { kind: 'no_https', words: t(ctx.locale, 'exposure.risk.noHttps') };
  return null;
}

/** One opening for the page and the assistant. */
export function buildOpening(o: RawOpening, ctx: OpeningCtx): ExposureOpening {
  const { locale, source } = ctx;
  const id = openingId(source.id, o);
  const subject = openingSubject(id);
  const link = linkOf(ctx.links, o.targetHost, o.targetPort);
  const address = addressWords(o, locale);
  const what = whatWords(o, link, locale);
  const via = viaWords(o, source, locale);
  const meant = ctx.meant.has(subject);
  const kept = ctx.kept.get(id);
  const risk = meant ? null : riskOf(o, link, ctx);
  return {
    id,
    source: source.kind,
    sourceThing: `connection:${source.id}`,
    sourceName: clip(source.name, 120),
    how: o.how,
    address: clip(address, 200),
    title: clip(t(locale, 'exposure.leadsTo', { address, what }), 240),
    via: clip(via, 160),
    ...(o.target ? { target: clip(o.target, 200) } : {}),
    ...(link ? { leadsTo: { thing: link.thing, name: clip(link.name, 120), href: link.href } } : {}),
    protection: protectionOf(o, locale),
    ...(risk ? { risk } : {}),
    meant,
    isNew: isNewOpening(kept, ctx.now) && !meant,
    ...(kept ? { firstSeen: kept.firstSeen.toISOString() } : {}),
    ...(source.manageUrl
      ? {
          manage: {
            label: clip(t(locale, 'exposure.manage', { source: source.name }), 60),
            url: source.manageUrl,
          },
        }
      : {}),
    ask: clip(t(locale, 'exposure.ask', { address, via }), 300),
    watch: {
      thing: `connection:${source.id}`,
      check: EXPOSURE_NEW_CHECK,
      subject: { id: subject, name: clip(o.address, 80) },
    },
  };
}

/** Worth a look and new first, then the rest by address. */
export function sortOpenings(list: ExposureOpening[]): ExposureOpening[] {
  const rank = (o: ExposureOpening) => (o.risk ? 0 : o.isNew ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address));
}
