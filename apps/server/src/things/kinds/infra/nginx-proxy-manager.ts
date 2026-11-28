/**
 * Nginx Proxy Manager's page (service-dashboards.md SD-41, SD-S11, SD-S16): its sites, where each forwards to, how long
 * its certificate lasts and whether it answers — Whombat asks each site itself, since Nginx Proxy Manager only knows
 * whether its config is valid; one button, **Renew**✱, on a Let’s Encrypt certificate ending within 30 days. Read as the
 * user Whombat signs in as: `/api/` (version), proxy and redirection hosts with their certificate expanded, streams'
 * and 404 hosts' counts. Never reads `/api/nginx/certificates` (it answers custom certificates' private keys), never
 * changes or deletes a host. Its page is in slots (docs/decisions/service-slots.md): its sites now beside how many hosts
 * and certificates it holds, with the hosts added this week from their `created_on`; every site's details in a tab.
 */
import type {
  ThingLine,
  ThingPageBar,
  ThingPageCell,
  ThingPageItem,
  ThingPageKpi,
  ThingPageRow,
  ThingPageTab,
} from '@whombat/core';
import type { TrackedFacts } from '../../../changes/diff';
import { externalEffect } from '../../../commit/scope';
import { connectionPolicy } from '../../../connections/destination';
import type { CatalogConnectionRow } from '../../../connections/types';
import { EXPOSURE_NEW } from '../../../exposure/check';
import { OutboundError, outboundRequest } from '../../../lib/outbound';
import type { Services } from '../../../services';
import { shortHash } from '../../quiet/items';
import type { KindCheck, KindNotice } from '../../quiet/types';
import { clip, dayMonth, line, list, num, plural, rec, str, thousands } from '../../words';
import { actAs } from '../act';
import { type PageButton, pageButton } from '../buttons';
import { cachedRead, getJson, latestRead } from '../read';
import type { KindAction, KindModule } from '../registry';
import { addedNote, countLine, inventory, liveList, slotPanels } from '../slots';
import type { KindCtx, KindView } from '../types';
import {
  type ButtonCtx,
  badgeOf,
  cardOf,
  daysUntil,
  idOf,
  inTime,
  itemLines,
  linesSeen,
  notOffered,
  okStatus,
  optional,
  serviceUrl,
  snapshotReader,
  uniqueById,
  unreadView,
} from './shared';

const NAME = 'Nginx Proxy Manager';
/** SD-S11: at most this many sites asked a pass, each within 5 seconds, the answers kept 5 minutes. */
export const ANSWER_MAX = 30;
const ANSWER_DEADLINE_MS = 5_000;
const ANSWER_KEEP_MS = 5 * 60_000;
/** A certificate within this many days may be renewed; within 14 it is worth a look. */
const RENEW_DAYS = 30;
const WARN_DAYS = 14;
const USER_AGENT = 'Whombat/1.0 (site check)';
/** Sites in Sites now; the Sites tab has them all. */
export const LIVE_SITES = 8;
const WEEK = 7 * 86_400_000;

export interface NpmCertificate {
  id: number;
  name: string;
  provider: string;
  expires: Date | null;
}

export interface NpmSite {
  /** `p<id>` for a proxy host, `r<id>` for a redirection host. */
  id: string;
  kind: 'proxy' | 'redirect';
  domains: string[];
  /** “http://192.168.1.20:8080”, or the redirect's target. */
  target: string;
  enabled: boolean;
  /** Nginx Proxy Manager's own word that its config loaded. */
  online: boolean;
  /** Nginx's complaint, without its file paths. */
  error: string | null;
  certificate: NpmCertificate | null;
  /** When it was added (`created_on`; editing it doesn't change it). */
  created?: Date | null;
  /** The access list in front of it (users or allowed addresses), for Open to the internet; null when none. */
  access?: { id: number; name: string } | null;
  /** HTTP is sent on to HTTPS (`ssl_forced`). */
  sslForced?: boolean;
}

/** A stream: a TCP or UDP port Nginx Proxy Manager forwards (`/api/nginx/streams`), for Open to the internet. */
export interface NpmStream {
  id: number;
  incomingPort: number;
  /** “192.168.1.30:25565”. */
  target: string;
  tcp: boolean;
  udp: boolean;
  enabled: boolean;
}

export interface NpmSnapshot {
  readAt: Date;
  version: string | null;
  sites: NpmSite[];
  streams: number | null;
  dead: number | null;
  /** When each stream and 404 host was added, for what came in this week. */
  created?: { streams: (Date | null)[]; dead: (Date | null)[] };
  /** Its redirection hosts couldn't be read: their lines don't look fixed (QN-11). */
  redirectsUnread?: boolean;
  /** Its streams, for Open to the internet; absent when they couldn't be read. */
  streamList?: NpmStream[];
}

/** Nginx Proxy Manager's dates (“2026-11-10 19:46:00”, UTC, or ISO). */
export function npmDate(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Nginx's complaint in a line: the first line, without `in /data/…conf:37`. */
export function nginxError(v: unknown): string | null {
  const first = str(v)?.split('\n')[0];
  if (!first) return null;
  return clip(first.replace(/^nginx:\s*/, '').replace(/\s+in\s+\/\S+$/, ''), 160);
}

function certificateOf(raw: unknown): NpmCertificate | null {
  const c = rec(raw);
  const id = num(c.id);
  if (id === null || c.is_deleted === true) return null;
  return {
    id,
    name: clip(
      str(c.nice_name) ??
        list(c.domain_names)
          .filter((d) => typeof d === 'string')
          .join(', '),
      120,
    ),
    provider: str(c.provider) ?? 'other',
    expires: npmDate(c.expires_on),
  };
}

const domainsOf = (v: unknown) =>
  list(v)
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .slice(0, 20);

/** `/api/nginx/proxy-hosts?expand=certificate`. */
export function parseProxyHosts(body: unknown): NpmSite[] {
  return list(body)
    .slice(0, 500)
    .map((raw): NpmSite | null => {
      const h = rec(raw);
      const id = num(h.id);
      if (id === null) return null;
      const port = num(h.forward_port);
      const meta = rec(h.meta);
      return {
        id: `p${id}`,
        kind: 'proxy',
        domains: domainsOf(h.domain_names),
        target: clip(
          `${str(h.forward_scheme) ?? 'http'}://${str(h.forward_host) ?? ''}${port ? `:${port}` : ''}`,
          200,
        ),
        enabled: h.enabled !== false && h.enabled !== 0,
        online: meta.nginx_online !== false,
        error: nginxError(meta.nginx_err),
        certificate: certificateOf(h.certificate),
        created: npmDate(h.created_on),
        access: accessOf(h),
        sslForced: h.ssl_forced === true || h.ssl_forced === 1,
      };
    })
    .filter((s): s is NpmSite => s !== null);
}

/** The access list a host uses (`access_list_id`, expanded `access_list`); null when it has none. */
function accessOf(h: Record<string, unknown>): NpmSite['access'] {
  const id = num(h.access_list_id) ?? num(rec(h.access_list).id);
  if (!id) return null;
  return { id, name: clip(str(rec(h.access_list).name) ?? `#${id}`, 80) };
}

/** `/api/nginx/streams`: the switched-on and switched-off TCP and UDP forwards. */
export function parseStreams(body: unknown): NpmStream[] {
  return list(body)
    .slice(0, 200)
    .map((raw): NpmStream | null => {
      const x = rec(raw);
      const id = num(x.id);
      const incomingPort = num(x.incoming_port);
      if (id === null || incomingPort === null) return null;
      const host = str(x.forwarding_host) ?? '';
      const port = num(x.forwarding_port);
      return {
        id,
        incomingPort,
        target: clip(`${host}${port ? `:${port}` : ''}`, 200),
        tcp: x.tcp_forwarding !== false && x.tcp_forwarding !== 0,
        udp: x.udp_forwarding === true || x.udp_forwarding === 1,
        enabled: x.enabled !== false && x.enabled !== 0,
      };
    })
    .filter((x): x is NpmStream => x !== null);
}

/** `/api/nginx/redirection-hosts?expand=certificate`. */
export function parseRedirects(body: unknown): NpmSite[] {
  return list(body)
    .slice(0, 500)
    .map((raw): NpmSite | null => {
      const h = rec(raw);
      const id = num(h.id);
      if (id === null) return null;
      const meta = rec(h.meta);
      return {
        id: `r${id}`,
        kind: 'redirect',
        domains: domainsOf(h.domain_names),
        target: clip(`${str(h.forward_scheme) ?? 'https'}://${str(h.forward_domain_name) ?? ''}`, 200),
        enabled: h.enabled !== false && h.enabled !== 0,
        online: meta.nginx_online !== false,
        error: nginxError(meta.nginx_err),
        certificate: certificateOf(h.certificate),
        created: npmDate(h.created_on),
      };
    })
    .filter((s): s is NpmSite => s !== null);
}

/** `/api/` → “2.16.0”. */
export function npmVersion(body: unknown): string | null {
  const v = rec(rec(body).version);
  const major = num(v.major);
  return major === null ? null : `${major}.${num(v.minor) ?? 0}.${num(v.revision) ?? 0}`;
}

export const npmReader = snapshotReader<NpmSnapshot>(NAME, 'npm', async (services, row, now) => {
  const get = (path: string, query?: Record<string, string>) => getJson(services, row, NAME, path, query);
  const [root, proxies, redirects, streams, dead] = await Promise.all([
    optional(get('/api/')),
    get('/api/nginx/proxy-hosts', { expand: 'certificate,access_list' }),
    optional(get('/api/nginx/redirection-hosts', { expand: 'certificate' })),
    optional(get('/api/nginx/streams')),
    optional(get('/api/nginx/dead-hosts')),
  ]);
  return {
    readAt: now,
    version: root ? npmVersion(root) : null,
    sites: [...parseProxyHosts(proxies), ...(redirects ? parseRedirects(redirects) : [])],
    streams: streams ? list(streams).length : null,
    dead: dead ? list(dead).length : null,
    created: {
      streams: streams ? list(streams).map((x) => npmDate(rec(x).created_on)) : [],
      dead: dead ? list(dead).map((x) => npmDate(rec(x).created_on)) : [],
    },
    ...(redirects ? {} : { redirectsUnread: true }),
    ...(streams ? { streamList: parseStreams(streams) } : {}),
  };
});

/* Answering (SD-S11) ---------------------------------------------------------------------------------------------- */

export type SiteAnswer =
  | { state: 'ok'; status: number }
  | { state: 'error'; status: number }
  | { state: 'down'; why: 'timeout' | 'network' | 'certificate' }
  | { state: 'unchecked' };

/** What one ask said: any answer below 500 is answering (a login page, a redirect, 404 too). */
export function answerOf(outcome: { status: number } | { error: unknown }): SiteAnswer {
  if ('status' in outcome)
    return outcome.status < 500
      ? { state: 'ok', status: outcome.status }
      : { state: 'error', status: outcome.status };
  const err = outcome.error;
  if (err instanceof OutboundError) {
    if (err.refused) return { state: 'unchecked' };
    if (err.reason === 'timeout') return { state: 'down', why: 'timeout' };
    if (err.reason === 'certificate' || err.reason === 'untrusted_certificate')
      return { state: 'down', why: 'certificate' };
  }
  return { state: 'down', why: 'network' };
}

/** The first plain domain of a site Whombat asks (wildcards and switched-off sites aren't asked). */
export function askedDomain(site: NpmSite): string | null {
  if (!site.enabled || !site.online) return null;
  return site.domains.find((d) => !d.includes('*') && /^[a-z0-9.-]+$/i.test(d)) ?? null;
}

/** HEAD, then GET when HEAD isn't allowed, from the box under the connection's address rule; no credentials. */
async function ask(services: Services, url: string): Promise<SiteAnswer> {
  const once = async (method: 'HEAD' | 'GET') => {
    const policy = await connectionPolicy(services, url, {
      deadlineMs: ANSWER_DEADLINE_MS,
      truncateAt: 2048,
    });
    return externalEffect(
      'things.read',
      () => outboundRequest(url, { method, headers: { 'user-agent': USER_AGENT, accept: '*/*' } }, policy),
      { idempotent: true },
    );
  };
  try {
    let res = await once('HEAD');
    if (res.status === 405 || res.status === 501) res = await once('GET');
    return answerOf({ status: res.status });
  } catch (error) {
    return answerOf({ error });
  }
}

/** The answers of the first 30 sites by domain; asked again after 5 minutes. */
export function npmAnswers(
  services: Services,
  row: CatalogConnectionRow,
  sites: readonly NpmSite[],
  mode: 'page' | 'pass',
): Promise<Map<string, SiteAnswer> | null> {
  const load = async () => {
    const asked = sites
      .map((s) => ({ s, domain: askedDomain(s) }))
      .filter((x): x is { s: NpmSite; domain: string } => x.domain !== null)
      .slice(0, ANSWER_MAX);
    const answers = await Promise.all(
      asked.map(async ({ s, domain }) => {
        const scheme = s.certificate ? 'https' : 'http';
        return [domain, await ask(services, `${scheme}://${domain}/`)] as const;
      }),
    );
    return new Map(answers);
  };
  const key = `npm-answers:${row.id}`;
  if (mode === 'pass') return cachedRead(services, key, row, load, ANSWER_KEEP_MS).catch(() => null);
  return latestRead(services, key, row, load, { ttlMs: ANSWER_KEEP_MS }).then((r) => (r.ok ? r.value : null));
}

/* What it means ------------------------------------------------------------------------------------------------------- */

const live = (s: NpmSnapshot) => s.sites.filter((x) => x.enabled);
const answerFor = (site: NpmSite, answers: ReadonlyMap<string, SiteAnswer> | null): SiteAnswer => {
  const d = askedDomain(site);
  return (d && answers?.get(d)) || { state: 'unchecked' };
};
const notAnswering = (s: NpmSnapshot, answers: ReadonlyMap<string, SiteAnswer> | null) =>
  live(s).filter((x) => {
    const a = answerFor(x, answers);
    return a.state === 'down' || a.state === 'error';
  });

/** The certificates the live sites use, each once. */
export function certificatesOf(s: NpmSnapshot): NpmCertificate[] {
  const byId = new Map<number, NpmCertificate>();
  for (const x of live(s)) if (x.certificate) byId.set(x.certificate.id, x.certificate);
  return [...byId.values()].sort(
    (a, b) => (a.expires?.getTime() ?? Infinity) - (b.expires?.getTime() ?? Infinity),
  );
}

const siteName = (x: NpmSite) => x.domains[0] ?? x.id;
const domainsOfCert = (s: NpmSnapshot, c: NpmCertificate) =>
  live(s)
    .filter((x) => x.certificate?.id === c.id)
    .map(siteName);

export function npmKpis(
  s: NpmSnapshot,
  answers: ReadonlyMap<string, SiteAnswer> | null,
  now: Date,
): ThingPageKpi[] {
  const sites = live(s);
  const off = s.sites.length - sites.length;
  const certs = certificatesOf(s);
  const valid = certs.filter((c) => !c.expires || c.expires > now).length;
  const expired = certs.length - valid;
  const soon = certs.filter((c) => c.expires && daysUntil(c.expires, now) < RENEW_DAYS);
  const first = soon[0];
  const out: ThingPageKpi[] = [
    {
      key: 'sites',
      label: 'Sites',
      value: String(sites.length),
      sub: off ? `${off} switched off` : sites.length ? 'all switched on' : 'none yet',
    },
    {
      key: 'certificates',
      label: 'Certificates',
      value: String(valid),
      rest: 'valid',
      sub: expired ? `${expired} expired` : certs.length ? 'all valid' : 'none',
      ...(expired ? { tone: 'bad' as const } : {}),
    },
    {
      key: 'ending',
      label: 'Ending soon',
      value: String(soon.length),
      rest: 'in 30 days',
      sub: first?.expires
        ? clip(`${domainsOfCert(s, first)[0] ?? first.name} ${inTime(first.expires, now)}`, 80)
        : 'none',
      ...(first?.expires && first.expires <= now
        ? { tone: 'bad' as const }
        : first?.expires && daysUntil(first.expires, now) < WARN_DAYS
          ? { tone: 'warn' as const }
          : {}),
    },
  ];
  if (answers) {
    const down = notAnswering(s, answers).length;
    const asked = sites.filter((x) => answerFor(x, answers).state !== 'unchecked').length;
    out.push({
      key: 'answering',
      label: 'Not answering',
      value: String(down),
      sub: asked ? `of ${plural(asked, 'site')} asked` : 'none asked',
      ...(down ? { tone: 'warn' as const } : {}),
    });
  }
  return out;
}

/** Every check Nginx Proxy Manager's page can raise (QN-15). */
export const NPM_CHECKS: readonly KindCheck[] = [
  {
    check: 'nginx_proxy_manager.cert',
    name: 'Certificates ending',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'nginx_proxy_manager.site',
    name: 'Sites not answering',
    nature: 'problem',
    perItem: true,
    startsOn: true,
  },
  {
    check: 'nginx_proxy_manager.config',
    name: 'Config errors',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'nginx_proxy_manager.switched_off',
    name: 'Switched-off sites',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
  // Something new is open to the internet: a new opening in its settings (internet-exposure.md).
  EXPOSURE_NEW,
];

/** What this read couldn't see (QN-11): its redirections, answers not asked (past the first 30, or none). */
export function npmSkipped(s: NpmSnapshot, answers: ReadonlyMap<string, SiteAnswer> | null): string[] {
  const out: string[] = [];
  if (s.redirectsUnread)
    out.push(
      'nginx_proxy_manager.cert',
      'nginx_proxy_manager.site',
      'nginx_proxy_manager.config',
      'nginx_proxy_manager.switched_off',
    );
  if (!answers || s.sites.filter((x) => askedDomain(x) !== null).length > ANSWER_MAX)
    out.push('nginx_proxy_manager.site');
  return out;
}

const siteSubject = (x: NpmSite) => ({ id: `site:${x.id}`, name: clip(siteName(x), 80) });

/** Worth a look (SD-41; quiet-notices.md QN-01…QN-04): one line per certificate and site. */
export function npmNotices(
  s: NpmSnapshot,
  answers: ReadonlyMap<string, SiteAnswer> | null,
  now: Date,
  url: string,
  ctx?: ButtonCtx,
): KindNotice[] {
  const out: KindNotice[] = [];
  const open = { kind: 'url' as const, label: 'Open it', url };
  const renew = (c: NpmCertificate) => {
    const b = ctx ? renewButton(ctx, c, now, domainsOfCert(s, c)[0] ?? c.name) : null;
    return b ? { action: b } : {};
  };
  const certs = certificatesOf(s)
    .filter((x) => x.expires && daysUntil(x.expires, now) < WARN_DAYS)
    .map((c): KindNotice => {
      const site = domainsOfCert(s, c)[0] ?? c.name;
      const expired = (c.expires as Date) <= now;
      // Let’s Encrypt renews by itself, so a failing renewal is something to look into; an own certificate is a
      // person's to replace.
      const own = c.provider !== 'letsencrypt';
      return {
        id: `cert-${expired ? 'expired' : 'ending'}-${c.id}`,
        tone: expired ? 'bad' : 'warn',
        icon: 'certificate',
        title: clip(
          expired
            ? `The certificate for ${site} has expired`
            : `The certificate for ${site} ends ${inTime(c.expires as Date, now)}`,
          120,
        ),
        detail: expired
          ? 'Browsers warn people away from the site until it’s renewed.'
          : own
            ? 'It’s a certificate of your own: upload a new one in Nginx Proxy Manager.'
            : 'Nginx Proxy Manager usually renews it by now, so its renewal may be failing.',
        link: own
          ? open
          : {
              kind: 'ask',
              label: 'Look into it',
              question: clip(`Why isn’t Nginx Proxy Manager renewing the certificate for ${site}?`, 300),
            },
        ...renew(c),
        nature: own ? 'you' : 'problem',
        check: 'nginx_proxy_manager.cert',
        subject: { id: `cert:${c.id}`, name: clip(site, 80) },
        // A renewed certificate ends later: that's a new one.
        episode: (c.expires as Date).toISOString(),
        ignore: { lifts: 'newer', words: 'Until it’s renewed.' },
        badge: badgeOf(expired ? `Certificate expired: ${site}` : `Certificate ending: ${site}`),
      };
    });
  out.push(
    ...itemLines(
      certs.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'bad' ? -1 : 1)),
      (rest) => ({
        id: 'cert-more',
        title: `${plural(rest.length, 'more certificate ends', 'more certificates end')} soon`,
        detail: clip(rest.map((n) => n.subject?.name ?? n.title).join(' · '), 200),
        link: open,
      }),
    ),
  );
  const down = notAnswering(s, answers).map(
    (x): KindNotice => ({
      id: idOf('not-answering', x.id),
      tone: 'warn',
      icon: 'network',
      title: clip(`${siteName(x)} isn’t answering`, 120),
      detail: clip(answerWords(answerFor(x, answers)).text, 200),
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: clip(`Why isn’t ${siteName(x)} answering behind Nginx Proxy Manager?`, 300),
      },
      nature: 'problem',
      check: 'nginx_proxy_manager.site',
      subject: siteSubject(x),
      // Asked once from the box with a short deadline: it counts after two passes (QN-04).
      confirm: 2,
      ignore: { lifts: 'fixed', words: 'Until it answers again.' },
      badge: badgeOf(`${siteName(x)} not answering`),
    }),
  );
  out.push(
    ...itemLines(down, (rest) => ({
      id: 'not-answering-more',
      title: `${plural(rest.length, 'more site isn’t', 'more sites aren’t')} answering`,
      detail: clip(rest.map((n) => n.subject?.name ?? n.title).join(' · '), 200),
      link: {
        kind: 'ask',
        label: 'Look into it',
        question: 'Why are several sites behind Nginx Proxy Manager not answering?',
      },
    })),
  );
  const broken = live(s)
    .filter((v) => !v.online)
    .map(
      (x): KindNotice => ({
        id: idOf('config', x.id),
        tone: 'warn',
        icon: 'warn',
        title: clip(`${siteName(x)} has a config error`, 120),
        ...(x.error ? { detail: x.error } : {}),
        link: {
          kind: 'ask',
          label: 'Look into it',
          question: clip(`What’s wrong with the config of ${siteName(x)} in Nginx Proxy Manager?`, 300),
        },
        nature: 'problem',
        check: 'nginx_proxy_manager.config',
        subject: siteSubject(x),
        ignore: { lifts: 'fixed', words: 'Until its config loads.' },
        badge: badgeOf(`${siteName(x)} config error`),
      }),
    );
  out.push(
    ...itemLines(broken, (rest) => ({
      id: 'config-more',
      title: `${plural(rest.length, 'more site has', 'more sites have')} a config error`,
      detail: clip(rest.map((n) => n.subject?.name ?? n.title).join(' · '), 200),
      link: open,
    })),
  );
  const off = s.sites.filter((x) => !x.enabled);
  if (off.length)
    out.push({
      id: 'switched-off',
      tone: 'info',
      icon: 'power',
      title:
        off.length === 1
          ? `${siteName(off[0] as NpmSite)} is switched off`
          : `${off.length} sites are switched off`,
      ...(off.length > 1 ? { detail: clip(off.map(siteName).join(' · '), 200) } : {}),
      nature: 'fyi',
      check: 'nginx_proxy_manager.switched_off',
      episode: shortHash(off.map((x) => x.id)),
      ignore: { lifts: 'newer', words: 'Until another site is switched off.' },
    });
  return uniqueById(out);
}

/** The head when nothing is worth a look (QN-S30): how many sites; the lines say what's wrong. */
export function npmStatus(s: NpmSnapshot): NonNullable<KindView['status']> {
  return okStatus(plural(live(s).length, 'site'));
}

export function answerWords(a: SiteAnswer): { text: string; dot: NonNullable<ThingPageCell['dot']> } {
  switch (a.state) {
    case 'ok':
      return { text: 'Answering', dot: 'ok' };
    case 'error':
      return { text: `Answers ${a.status}`, dot: 'warn' };
    case 'down':
      return {
        text:
          a.why === 'certificate'
            ? 'Certificate refused'
            : a.why === 'timeout'
              ? 'No answer'
              : 'Not answering',
        dot: 'bad',
      };
    default:
      return { text: '—', dot: 'off' };
  }
}

function certificateCell(c: NpmCertificate | null, now: Date, timeZone: string): ThingPageCell {
  if (!c) return { text: 'None', tone: 'muted' };
  if (!c.expires) return { text: c.name };
  if (c.expires <= now) return { text: 'Expired', tone: 'bad', note: c.name };
  const days = daysUntil(c.expires, now);
  return {
    text: plural(days, 'day'),
    note: `until ${dayMonth(c.expires, timeZone)}`,
    ...(days < WARN_DAYS ? { tone: 'warn' as const } : {}),
  };
}

/** Only Let’s Encrypt certificates renew (2.16 refuses others), and only within 30 days of their end. */
const renewable = (c: NpmCertificate, now: Date) =>
  c.provider === 'letsencrypt' && !!c.expires && daysUntil(c.expires, now) < RENEW_DAYS;

/** Renew✱ on a Let’s Encrypt certificate ending within 30 days (SD-41). */
export function renewButton(ctx: ButtonCtx, c: NpmCertificate, now: Date, site: string): PageButton | null {
  if (!renewable(c, now)) return null;
  return pageButton(ctx, {
    action: 'renew',
    target: String(c.id),
    label: 'Renew',
    icon: 'retry',
    confirm: {
      title: clip(`Renew the certificate for ${site}?`, 80),
      body: 'Nginx Proxy Manager asks Let’s Encrypt for a new one; it takes up to a minute.',
      button: 'Renew',
    },
  });
}

export function npmRows(
  s: NpmSnapshot,
  answers: ReadonlyMap<string, SiteAnswer> | null,
  now: Date,
  timeZone: string,
  ctx: ButtonCtx,
): ThingPageRow[] {
  const rank = (x: NpmSite) => {
    if (!x.enabled) return 5;
    if (!x.online) return 0;
    const a = answerFor(x, answers).state;
    if (a === 'down' || a === 'error') return 1;
    if (x.certificate?.expires && daysUntil(x.certificate.expires, now) < WARN_DAYS) return 2;
    return 3;
  };
  return [...s.sites]
    .sort((a, b) => rank(a) - rank(b) || siteName(a).localeCompare(siteName(b)))
    .slice(0, 300)
    .map((x) => ({
      id: x.id,
      cells: {
        site: {
          text: siteName(x),
          ...(x.domains.length > 1 ? { note: `+ ${plural(x.domains.length - 1, 'more name')}` } : {}),
          ...(askedDomain(x) ? { url: `${x.certificate ? 'https' : 'http'}://${askedDomain(x)}/` } : {}),
        },
        target: { text: x.target, mono: true, ...(x.kind === 'redirect' ? { note: 'redirect' } : {}) },
        certificate: certificateCell(x.certificate, now, timeZone),
        answering: !x.enabled
          ? { text: 'Switched off', dot: 'off' as const }
          : !x.online
            ? { text: 'Config error', dot: 'bad' as const }
            : answerWords(answerFor(x, answers)),
        ...renewCell(ctx, x, now),
      },
    }));
}

/** Renew✱ beside a live site whose Let’s Encrypt certificate ends within 30 days. */
function renewCell(ctx: ButtonCtx, x: NpmSite, now: Date): ThingPageRow['cells'] {
  const b = x.enabled && x.certificate ? renewButton(ctx, x.certificate, now, siteName(x)) : null;
  return b ? { renew: { text: b.label, action: b } } : {};
}

const COLUMNS = [
  { key: 'site', label: 'Site' },
  { key: 'target', label: 'Forwards to' },
  { key: 'certificate', label: 'Certificate' },
  { key: 'answering', label: 'Answering' },
];

export function npmFacts(s: NpmSnapshot): ThingLine[] {
  const facts: ThingLine[] = [];
  if (s.version) facts.push(line(`Nginx Proxy Manager **${s.version}**`));
  const proxies = s.sites.filter((x) => x.kind === 'proxy').length;
  const redirects = s.sites.length - proxies;
  const parts = [`**${plural(proxies, 'proxy host')}**`];
  if (redirects) parts.push(`**${plural(redirects, 'redirect')}**`);
  if (s.streams) parts.push(`**${plural(s.streams, 'stream')}**`);
  facts.push(line(parts.join(' · ')));
  return facts;
}

/** Where a site sends people, in a few words: “192.168.1.20:8080”, “Redirect to example.com”. */
function forwardWords(x: NpmSite): string {
  const to = x.target.replace(/^[a-z]+:\/\//i, '');
  return x.kind === 'redirect' ? `Redirect to ${to}` : to;
}

/** A site's certificate when it needs a word: ending within 30 days, or expired. */
function certificateWords(
  c: NpmCertificate | null,
  now: Date,
): { text: string; tone?: 'warn' | 'bad' } | null {
  if (!c?.expires) return null;
  if (c.expires <= now) return { text: 'certificate expired', tone: 'bad' };
  const days = daysUntil(c.expires, now);
  if (days >= RENEW_DAYS) return null;
  return {
    text: `certificate ends in ${plural(days, 'day')}`,
    ...(days < WARN_DAYS ? { tone: 'warn' as const } : {}),
  };
}

/** Sites now (Live): each site with whether it answers, problems first, Renew✱ where its certificate ends soon. */
export function npmLive(
  s: NpmSnapshot,
  answers: ReadonlyMap<string, SiteAnswer> | null,
  now: Date,
  ctx: ButtonCtx,
) {
  const rows = npmRows(s, answers, now, 'UTC', ctx);
  const byId = new Map(s.sites.map((x) => [x.id, x]));
  const items: ThingPageItem[] = rows.slice(0, LIVE_SITES).flatMap((r) => {
    const x = byId.get(r.id);
    if (!x) return [];
    const cert = x.enabled ? certificateWords(x.certificate, now) : null;
    const answer = r.cells.answering;
    const words = !x.enabled
      ? null
      : !x.online
        ? x.error
        : [forwardWords(x), cert?.text].filter(Boolean).join(' · ');
    const dot = answer?.dot;
    const tone = !x.enabled
      ? undefined
      : dot === 'bad'
        ? ('bad' as const)
        : dot === 'warn' || cert?.tone
          ? cert?.tone === 'bad'
            ? ('bad' as const)
            : ('warn' as const)
          : dot === 'ok'
            ? ('ok' as const)
            : undefined;
    const renew = r.cells.renew?.action;
    const url = askedDomain(x) ? `${x.certificate ? 'https' : 'http'}://${askedDomain(x)}/` : undefined;
    return [
      {
        id: x.id,
        title: clip(siteName(x), 160),
        ...(words ? { detail: clip(words, 300) } : {}),
        ...(tone ? { tone } : {}),
        icon: cert ? ('certificate' as const) : ('network' as const),
        ...(answer && answer.text !== '—' ? { right: clip(answer.text, 40) } : {}),
        ...(url ? { url } : {}),
        ...(renew ? { actions: [renew] } : {}),
      },
    ];
  });
  const asked = live(s).filter((x) => answerFor(x, answers).state !== 'unchecked').length;
  const down = notAnswering(s, answers).length;
  const meta = !answers
    ? plural(live(s).length, 'site')
    : down
      ? `${down} of ${asked} not answering`
      : asked === 1
        ? 'It answers · asked every 5 minutes'
        : asked
          ? `All ${asked} answer · asked every 5 minutes`
          : plural(live(s).length, 'site');
  return liveList({
    id: 'answering',
    title: 'Sites now',
    meta,
    ...(rows.length > LIVE_SITES
      ? { link: { kind: 'tab' as const, label: `All ${rows.length} sites`, tab: 'sites' } }
      : {}),
    items,
    empty: 'No sites in Nginx Proxy Manager yet.',
  });
}

/** “+1 this week” from when things were added; null when nothing was. */
function addedThisWeek(dates: readonly (Date | null | undefined)[], now: Date) {
  const n = dates.filter((d) => d && d <= now && now.getTime() - d.getTime() < WEEK).length;
  return n ? addedNote(n) : null;
}

/** In Nginx Proxy Manager (Inventory): its hosts by kind with what came in this week, and its certificates. */
export function npmInventory(s: NpmSnapshot, now: Date, url: string) {
  const proxies = s.sites.filter((x) => x.kind === 'proxy');
  const redirects = s.sites.filter((x) => x.kind === 'redirect');
  const off = proxies.filter((x) => !x.enabled).length;
  const lines: ThingPageItem[] = [
    countLine({
      id: 'proxy-hosts',
      title: 'Proxy hosts',
      icon: 'network',
      value: thousands(proxies.length),
      ...(off ? { detail: `${off} switched off` } : {}),
      ...addedThisWeek(
        proxies.map((x) => x.created),
        now,
      ),
      url: `${url}/nginx/proxy`,
    }),
  ];
  if (redirects.length)
    lines.push(
      countLine({
        id: 'redirects',
        title: 'Redirects',
        icon: 'network',
        value: thousands(redirects.length),
        ...addedThisWeek(
          redirects.map((x) => x.created),
          now,
        ),
        url: `${url}/nginx/redirection`,
      }),
    );
  if (s.streams)
    lines.push(
      countLine({
        id: 'streams',
        title: 'Streams',
        icon: 'network',
        value: thousands(s.streams),
        ...addedThisWeek(s.created?.streams ?? [], now),
        url: `${url}/nginx/stream`,
      }),
    );
  if (s.dead)
    lines.push(
      countLine({
        id: 'dead-hosts',
        title: '404 hosts',
        icon: 'network',
        value: thousands(s.dead),
        ...addedThisWeek(s.created?.dead ?? [], now),
        url: `${url}/nginx/404`,
      }),
    );
  const certs = certificatesOf(s);
  if (certs.length) {
    const expired = certs.filter((c) => c.expires && c.expires <= now).length;
    const soon = certs.filter(
      (c) => c.expires && c.expires > now && daysUntil(c.expires, now) < RENEW_DAYS,
    ).length;
    lines.push(
      countLine({
        id: 'certificates',
        title: 'Certificates',
        icon: 'certificate',
        value: thousands(certs.length),
        ...(expired
          ? { note: `${expired} expired`, noteTone: 'bad' as const }
          : soon
            ? { note: `${soon} ending soon`, noteTone: 'warn' as const }
            : { note: 'All valid', noteTone: 'ok' as const }),
        url: `${url}/nginx/certificates`,
      }),
    );
  }
  return inventory({ id: 'inventory', title: 'In the proxy', items: lines });
}

/** The 2.15.1 bug (#5943): nginx keeps the old certificate until it reloads. */
const RELOAD_BUG = '2.15.1';

/** Its own line in the machine card: its version (2.15.1 needs a restart after a renewal). */
export function npmMachineLines(s: NpmSnapshot): ThingPageBar[] {
  if (!s.version) return [];
  return [
    {
      id: 'npm-version',
      label: 'Nginx Proxy Manager',
      value: clip(s.version, 40),
      pct: null,
      ...(s.version === RELOAD_BUG ? { sub: 'Restart it after a renewal', subTone: 'warn' as const } : {}),
    },
  ];
}

/**
 * The Summary in slots (docs/decisions/service-slots.md): whether each site answers beside how many hosts and
 * certificates it holds; no Trend (it keeps no history of requests), no Shelf, no People (its users are its admins).
 * Every site with its columns is in the Sites tab.
 */
export function npmSlots(
  s: NpmSnapshot,
  answers: ReadonlyMap<string, SiteAnswer> | null,
  now: Date,
  url: string,
  ctx: ButtonCtx,
): Pick<KindView, 'panels' | 'slots'> {
  return slotPanels({
    live: npmLive(s, answers, now, ctx),
    inventory: npmInventory(s, now, url),
    machine: npmMachineLines(s),
  });
}

export interface NpmInput {
  snapshot: NpmSnapshot;
  answers: ReadonlyMap<string, SiteAnswer> | null;
  now: Date;
  timeZone: string;
  url: string;
  row: ButtonCtx['row'];
}

/** Every site with where it forwards, its certificate and whether it answers: the Sites tab. */
export function npmSitesTab(
  s: NpmSnapshot,
  answers: ReadonlyMap<string, SiteAnswer> | null,
  now: Date,
  timeZone: string,
  ctx: ButtonCtx,
): ThingPageTab {
  const rows = npmRows(s, answers, now, timeZone, ctx);
  const down = notAnswering(s, answers).length;
  return {
    key: 'sites',
    label: 'Sites',
    count: rows.length,
    panels: [
      {
        kind: 'table',
        id: 'sites',
        title: 'Sites',
        meta: answers
          ? down
            ? `${down} not answering`
            : 'asked every 5 minutes'
          : plural(live(s).length, 'site'),
        columns: rows.some((r) => r.cells.renew) ? [...COLUMNS, { key: 'renew', label: '' }] : COLUMNS,
        rows,
        empty: 'No sites in Nginx Proxy Manager yet.',
      },
    ],
  };
}

/** The page's Nginx Proxy Manager part (SD-41), in slots; pure. */
export function npmView({ snapshot: s, answers, now, timeZone, url, row }: NpmInput): KindView {
  return {
    // In slots its counts are in Sites now and In the proxy; the card keeps its figures (`npmKpis` in `seen`).
    kpis: [],
    machine: 'after',
    charts: [],
    notices: npmNotices(s, answers, now, url, { row }),
    ...npmSlots(s, answers, now, url, { row }),
    tabs: s.sites.length ? [npmSitesTab(s, answers, now, timeZone, { row })] : [],
    facts: npmFacts(s),
    status: npmStatus(s),
    open: { label: 'Open Nginx Proxy Manager', url },
    actions: [],
    readAt: s.readAt,
    suggestions: ['Certificates ending this month', 'Where a site forwards', 'Sites without HTTPS'],
  };
}

export async function npmPage(ctx: KindCtx): Promise<KindView> {
  const url = serviceUrl(ctx.row);
  const read = await npmReader.latest(ctx.services, ctx.row, ctx.now);
  if (!read.ok) return unreadView(read, NAME, { label: 'Open Nginx Proxy Manager', url }, []);
  const answers = await npmAnswers(ctx.services, ctx.row, read.value.sites, 'page').catch(() => null);
  return {
    ...npmView({
      snapshot: read.value,
      answers,
      now: ctx.now,
      timeZone: ctx.timeZone,
      url,
      row: ctx.row,
    }),
    refreshing: read.refreshing,
  };
}

/** Renew one Let’s Encrypt certificate a live site uses, within 30 days of its end (SD-41 ✱). */
const renew: KindAction = async ({ services, row, now, timeZone }, { target }) => {
  const s = await npmReader.cached(services, row, now);
  const c = certificatesOf(s).find((x) => String(x.id) === target);
  if (!c || !renewable(c, now)) throw notOffered('That certificate');
  const site = domainsOfCert(s, c)[0] ?? c.name;
  const answer = await actAs(services, row, NAME, {
    method: 'POST',
    path: `/api/nginx/certificates/${c.id}/renew`,
    deadlineMs: 90_000,
  });
  const until = npmDate(rec(answer.json).expires_on);
  const reload =
    s.version === RELOAD_BUG ? ' Nginx Proxy Manager may need a restart before it uses the new one.' : '';
  return {
    message: `Renewed the certificate for ${site}${until ? `, good until ${dayMonth(until, timeZone)}` : ''}.${reload}`,
    title: clip(`Renewed the certificate for ${site}`, 200),
  };
};

/**
 * What the change log compares (docs/decisions/outside-changes.md): the version, and each proxy host by its first
 * domain with where it goes (`off:` before it while it is switched off).
 */
export function npmTracked(s: NpmSnapshot): TrackedFacts {
  const map: Record<string, string> = {};
  for (const site of s.sites) {
    const host = site.domains[0];
    if (site.kind !== 'proxy' || !host) continue;
    map[host] = `${site.enabled ? '' : 'off:'}${site.target}`;
  }
  return { version: s.version ?? null, routes: { via: 'proxy', map } };
}

export const NPM_KIND: KindModule = {
  page: npmPage,
  seen: async (services, row, now, timeZone) => {
    const s = await npmReader.cached(services, row, now);
    const answers = await npmAnswers(services, row, s.sites, 'pass');
    const view = npmView({
      snapshot: s,
      answers,
      now,
      timeZone,
      url: serviceUrl(row),
      row,
    });
    return {
      // The page has no row of figures; the card keeps Sites and Ending soon.
      glance: cardOf(
        { kpis: npmKpis(s, answers, now), notices: view.notices },
        ['sites', 'ending'],
        plural(live(s).length, 'site'),
      ),
      points: {},
      tracked: npmTracked(s),
      ...linesSeen(view, npmSkipped(s, answers)),
    };
  },
  checks: NPM_CHECKS,
  actions: { renew },
};
