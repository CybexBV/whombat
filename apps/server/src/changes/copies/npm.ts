/**
 * Nginx Proxy Manager's settings copy: it has no export of its own, so the copy is its hosts as its API lists them
 * (proxy hosts, redirects, streams, 404 hosts and access lists, `GET /api/nginx/…`) in one JSON file, secrets left out:
 * enough to set each one up again by hand. Compared host by host; where a proxy host points is told by the change log's
 * routes already, so the comparison leaves it out.
 */
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import { getJson } from '../../things/kinds/read';
import { list, rec, str } from '../../things/words';
import { type CopyHasher, cleaned, copyHasher, type SettingsSummary, SummaryBuilder } from './summary';
import type { CopyService } from './types';

const NAME = 'Nginx Proxy Manager';
/** Ids, dates, owners and NPM's own state: never a change of the settings. */
const VOLATILE = new Set([
  'id',
  'created_on',
  'modified_on',
  'owner_user_id',
  'owner',
  'meta',
  'certificate',
  'access_list',
  'proxy_host_count',
]);
/** Told by the routes in the change log. */
const ROUTED = new Set(['forward_scheme', 'forward_host', 'forward_port', 'enabled']);

export interface NpmRead {
  proxyHosts: unknown;
  redirects: unknown;
  streams: unknown;
  deadHosts: unknown;
  accessLists: unknown;
}

const domains = (r: Record<string, unknown>) =>
  list(r.domain_names)
    .map((d) => String(d).trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');

export function npmSummary(read: NpmRead, hasher?: CopyHasher): SettingsSummary {
  const out = new SummaryBuilder(hasher);
  const routed = new Set([...VOLATILE, ...ROUTED]);
  for (const h of list(read.proxyHosts)) out.add('proxyHosts', domains(rec(h)), cleaned(h, routed));
  for (const h of list(read.redirects)) out.add('redirects', domains(rec(h)), cleaned(h, VOLATILE));
  for (const s of list(read.streams)) {
    const r = rec(s);
    out.add('streams', String(r.incoming_port ?? ''), cleaned(r, VOLATILE));
  }
  for (const h of list(read.deadHosts)) out.add('deadHosts', domains(rec(h)), cleaned(h, VOLATILE));
  for (const a of list(read.accessLists)) {
    const r = rec(a);
    out.add('accessLists', str(r.name) ?? '', cleaned(r, VOLATILE));
  }
  // What the file holds, where hosts point included (secrets are never in it): one pointed elsewhere is another copy.
  out.content(cleaned(read, VOLATILE));
  return out.summary;
}

const fileDate = (d: Date) => d.toISOString().slice(0, 10);

export const NPM_COPY: CopyService = {
  name: NAME,
  async take(services: Services, row: CatalogConnectionRow, now: Date) {
    const get = (path: string, query?: Record<string, string>) => getJson(services, row, NAME, path, query);
    const [proxyHosts, redirects, streams, deadHosts, accessLists] = await Promise.all([
      get('/api/nginx/proxy-hosts'),
      get('/api/nginx/redirection-hosts'),
      get('/api/nginx/streams'),
      get('/api/nginx/dead-hosts'),
      get('/api/nginx/access-lists', { expand: 'items,clients' }),
    ]);
    const read: NpmRead = { proxyHosts, redirects, streams, deadHosts, accessLists };
    // The file keeps what each host is (where it points too); only secrets stay out.
    const file = {
      exportedBy: 'Whombat',
      proxyHosts: cleaned(proxyHosts, new Set(['meta', 'owner'])),
      redirectionHosts: cleaned(redirects, new Set(['meta', 'owner'])),
      streams: cleaned(streams, new Set(['meta', 'owner'])),
      deadHosts: cleaned(deadHosts, new Set(['meta', 'owner'])),
      accessLists: cleaned(accessLists, new Set(['meta', 'owner'])),
    };
    return {
      bytes: Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8'),
      fileName: `nginx-proxy-manager-${fileDate(now)}.json`,
      contentType: 'application/json',
      summary: npmSummary(read, copyHasher(services)),
    };
  },
};
