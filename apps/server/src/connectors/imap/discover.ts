/**
 * Finding an address's mail servers (docs/decisions/connections-more.md CM-20, connections-more-mail.md CM-M08), in
 * Thunderbird's order: the ISPDB (`autoconfig.thunderbird.net/v1.1/<domain>`), the domain's own autoconfig
 * (`autoconfig.<domain>/mail/config-v1.1.xml`, `<domain>/.well-known/autoconfig/mail/config-v1.1.xml`), the ISPDB for
 * the registrable domain of its MX host (a domain at Fastmail or Google Workspace), then SRV records (RFC 6186 and 8314:
 * `_imaps._tcp`, `_imap._tcp`, `_submissions._tcp`, `_submission._tcp`). Nothing found: core's guess, `imap.<domain>`
 * on 993 with TLS and `smtp.<domain>` on 587 with STARTTLS (source `guess`, CM-D02), for the person to check.
 *
 * Only the domain is sent anywhere, never the address. Plain-text servers are left out (CM-22); a server that only takes
 * OAuth comes after one that takes a password. The fetches and lookups come from `deps` (`net.ts`: https only, public
 * addresses, DNS checked and pinned, a few seconds each).
 */
import {
  type ImapServerSettings,
  type ImapSettingsSource,
  imapGuessSettings,
  type MailServer,
} from '@whombat/core';
import { getDomain } from 'tldts';

/** What a source says: the servers, and who signs in when it isn't the address (`%EMAILLOCALPART%`). */
export type DiscoveredSettings = ImapServerSettings;

export interface Discovery {
  settings: DiscoveredSettings | null;
  source: ImapSettingsSource | null;
  /** The domain's MX hosts (for the provider hints, CM-21), best first. */
  mx: string[];
}

export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

export interface DiscoverDeps {
  /** An https document's text, or null (not found, not allowed, too slow, too large). */
  fetchText(url: string): Promise<string | null>;
  mx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  srv(name: string): Promise<SrvRecord[]>;
}

export const ISPDB_URL = 'https://autoconfig.thunderbird.net/v1.1/';

/** The domain of an address as a host name (an international one in punycode), or null. */
export function mailDomainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  try {
    const host = new URL(`https://${email.slice(at + 1).trim()}`).hostname.toLowerCase();
    return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/* Autoconfig XML -------------------------------------------------------------------------------- */

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlText = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITY[e] ?? '');

function tag(block: string, name: string): string[] {
  return [...block.matchAll(new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`, 'gi'))].map((m) =>
    xmlText(m[1] ?? '').trim(),
  );
}

interface ServerEntry {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  /** Who signs in when it isn't the address; null: the address, or not said. */
  username: string | null;
  /** The document names the full address as the user name (`%EMAILADDRESS%`). */
  fullAddress: boolean;
  password: boolean;
}

/** `%EMAILADDRESS%`, `%EMAILLOCALPART%`, `%EMAILDOMAIN%` filled in. */
function fill(template: string, email: string): string {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return template
    .replace(/%EMAILADDRESS%/g, email)
    .replace(/%EMAILLOCALPART%/g, local)
    .replace(/%EMAILDOMAIN%/g, domain.toLowerCase());
}

function serverEntries(
  xml: string,
  element: 'incomingServer' | 'outgoingServer',
  type: string,
  email: string,
) {
  const out: ServerEntry[] = [];
  const re = new RegExp(`<${element}\\b([^>]*)>([\\s\\S]*?)</${element}>`, 'gi');
  for (const m of xml.matchAll(re)) {
    const attrs = m[1] ?? '';
    if (!new RegExp(`type\\s*=\\s*["']${type}["']`, 'i').test(attrs)) continue;
    const body = m[2] ?? '';
    const host = fill(tag(body, 'hostname')[0] ?? '', email)
      .toLowerCase()
      .replace(/\.$/, '');
    const port = Number(tag(body, 'port')[0]);
    const socket = (tag(body, 'socketType')[0] ?? '').toUpperCase();
    const security = socket === 'SSL' || socket === 'TLS' ? 'tls' : socket === 'STARTTLS' ? 'starttls' : null;
    if (!HOST.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !security) continue;
    const auth = tag(body, 'authentication').map((a) => a.toLowerCase());
    const user = tag(body, 'username')[0];
    const username = user ? fill(user, email) : null;
    const fullAddress = !!username && username.toLowerCase() === email.toLowerCase();
    out.push({
      host,
      port,
      security,
      username: username && !fullAddress ? username.slice(0, 320) : null,
      fullAddress,
      password: auth.length === 0 || auth.some((a) => a.startsWith('password')),
    });
  }
  return out;
}

/** The best entry: one that takes a password before one that doesn't, then implicit TLS, then document order. */
function best(entries: ServerEntry[]): ServerEntry | null {
  const rank = (e: ServerEntry) => (e.password ? 0 : 2) + (e.security === 'tls' ? 0 : 1);
  return [...entries].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** An autoconfig document (`clientConfig` 1.1) as settings for `email`, or null without an IMAP and an SMTP server. */
export function parseAutoconfig(xml: string, email: string): DiscoveredSettings | null {
  const text = xml.replace(/<!--[\s\S]*?-->/g, '');
  if (!/<clientConfig\b/i.test(text)) return null;
  const imap = best(serverEntries(text, 'incomingServer', 'imap', email));
  const smtp = best(serverEntries(text, 'outgoingServer', 'smtp', email));
  if (!imap || !smtp) return null;
  // One user name signs in to both sides. Where they differ and one side names the full address, both use it: iCloud's
  // IMAP takes the part before the @ or the address, its SMTP only the address (connection-signin.md SG-18a).
  const either = imap.fullAddress || smtp.fullAddress;
  return {
    imap: { host: imap.host, port: imap.port, security: imap.security },
    smtp: { host: smtp.host, port: smtp.port, security: smtp.security },
    username: imap.username !== smtp.username && either ? null : imap.username,
  };
}

/* SRV ------------------------------------------------------------------------------------------- */

const ordered = (records: SrvRecord[]) =>
  records
    .map((r) => ({ ...r, name: r.name.toLowerCase().replace(/\.$/, '') }))
    // An empty target (`.`) says the service isn't offered there (RFC 6186 §3.4).
    .filter((r) => r.name && HOST.test(r.name) && r.port > 0 && r.port <= 65535)
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight);

/** Settings from the four SRV answers (implicit TLS first), or null without both sides. */
export function settingsFromSrv(answers: {
  imaps: SrvRecord[];
  imap: SrvRecord[];
  submissions: SrvRecord[];
  submission: SrvRecord[];
}): DiscoveredSettings | null {
  const pick = (tls: SrvRecord[], starttls: SrvRecord[]): MailServer | null => {
    const a = ordered(tls)[0];
    if (a) return { host: a.name, port: a.port, security: 'tls' };
    const b = ordered(starttls)[0];
    return b ? { host: b.name, port: b.port, security: 'starttls' } : null;
  };
  const imap = pick(answers.imaps, answers.imap);
  const smtp = pick(answers.submissions, answers.submission);
  return imap && smtp ? { imap, smtp, username: null } : null;
}

/* Discovery ------------------------------------------------------------------------------------- */

/** The servers of `email`, from the first source that has both sides (CM-20). */
export async function discoverMail(email: string, deps: DiscoverDeps): Promise<Discovery> {
  const domain = mailDomainOf(email);
  if (!domain) return { settings: null, source: null, mx: [] };
  const config = async (url: string) => {
    const xml = await deps.fetchText(url).catch(() => null);
    return xml ? parseAutoconfig(xml, email) : null;
  };
  const [ispdb, own, wellKnown, mxRecords] = await Promise.all([
    config(`${ISPDB_URL}${domain}`),
    config(`https://autoconfig.${domain}/mail/config-v1.1.xml`),
    config(`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`),
    deps.mx(domain).catch(() => []),
  ]);
  const mx = [...mxRecords]
    .sort((a, b) => a.priority - b.priority)
    .map((r) => r.exchange.toLowerCase().replace(/\.$/, ''))
    .filter((h) => HOST.test(h))
    .slice(0, 10);
  if (ispdb) return { settings: ispdb, source: 'ispdb', mx };
  const auto = own ?? wellKnown;
  if (auto) return { settings: auto, source: 'autoconfig', mx };
  const mxDomain = mx[0] ? getDomain(mx[0]) : null;
  if (mxDomain && mxDomain !== domain) {
    const viaMx = await config(`${ISPDB_URL}${mxDomain}`);
    if (viaMx) return { settings: viaMx, source: 'mx', mx };
  }
  const srv = (service: string) => deps.srv(`_${service}._tcp.${domain}`).catch(() => [] as SrvRecord[]);
  const [imaps, imap, submissions, submission] = await Promise.all([
    srv('imaps'),
    srv('imap'),
    srv('submissions'),
    srv('submission'),
  ]);
  const fromSrv = settingsFromSrv({ imaps, imap, submissions, submission });
  if (fromSrv) return { settings: fromSrv, source: 'srv', mx };
  return { settings: imapGuessSettings(email), source: 'guess', mx };
}
