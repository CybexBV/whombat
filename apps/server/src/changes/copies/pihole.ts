/**
 * Pi-hole's settings copy: its Teleporter file (`GET /api/teleporter`, a zip of its settings, lists and groups, the file
 * Pi-hole's own Teleporter takes back), compared from what its API says of the same: its DNS and DHCP settings, local
 * DNS records, block lists, allowed and blocked sites, groups and devices, and the rest of its settings. Secrets (its
 * password hashes, two-factor seed) are left out of the comparison, and so are dates and counts that change by
 * themselves.
 */
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import { getJson } from '../../things/kinds/read';
import { list, rec, str } from '../../things/words';
import { cleaned, type SettingsSummary, SummaryBuilder } from './summary';
import { CopyFailed, type CopyService, getBytes } from './types';

const NAME = 'Pi-hole';
/** Dates, ids and counts Pi-hole changes by itself. */
const VOLATILE = new Set([
  'id',
  'date_added',
  'date_modified',
  'date_updated',
  'number',
  'invalid_domains',
  'abp_entries',
  'status',
  'unicode',
]);
/** Settings sections compared; `files` (paths) and `debug` aren't settings people change. */
const SECTIONS = ['dns', 'dhcp', 'ntp', 'resolver', 'database', 'webserver', 'misc'] as const;

/** What Pi-hole's API said of its settings, as read for the summary. */
export interface PiholeRead {
  config: unknown;
  lists: unknown;
  domains: unknown;
  groups: unknown;
  clients: unknown;
}

export function piholeSummary(read: PiholeRead): SettingsSummary {
  const out = new SummaryBuilder();
  const config = rec(rec(read.config).config);
  for (const section of SECTIONS) {
    const values = rec(config[section]);
    for (const [key, value] of Object.entries(values)) {
      // Local DNS records and fixed DHCP addresses are items of their own.
      if (
        (section === 'dns' && (key === 'hosts' || key === 'cnameRecords')) ||
        (section === 'dhcp' && key === 'hosts')
      ) {
        for (const item of list(value)) {
          const line = String(item).trim();
          if (line) out.add(section === 'dns' ? 'records' : 'dhcp', line, line);
        }
        continue;
      }
      const part = section === 'dns' ? 'dns' : section === 'dhcp' ? 'dhcp' : 'system';
      out.add(part, `${section}.${key}`, cleaned(value, VOLATILE));
    }
  }
  for (const l of list(rec(read.lists).lists)) {
    const r = rec(l);
    out.add('lists', `${str(r.type) ?? 'block'}:${str(r.address) ?? ''}`, cleaned(r, VOLATILE));
  }
  for (const d of list(rec(read.domains).domains)) {
    const r = rec(d);
    out.add(
      'domains',
      `${str(r.type) ?? ''}/${str(r.kind) ?? ''}:${str(r.domain) ?? ''}`,
      cleaned(r, VOLATILE),
    );
  }
  for (const g of list(rec(read.groups).groups)) {
    const r = rec(g);
    out.add('groups', str(r.name) ?? '', cleaned(r, VOLATILE));
  }
  for (const c of list(rec(read.clients).clients)) {
    const r = rec(c);
    out.add('clients', str(r.client) ?? '', cleaned(r, VOLATILE));
  }
  return out.summary;
}

const fileDate = (d: Date) => d.toISOString().slice(0, 10);

export const PIHOLE_COPY: CopyService = {
  name: NAME,
  async take(services: Services, row: CatalogConnectionRow, now: Date) {
    const bytes = await getBytes(services, row, '/api/teleporter', 'application/zip, */*');
    // A zip starts with “PK”; anything else is an error page.
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new CopyFailed('unreadable');
    const get = (path: string) => getJson(services, row, NAME, path);
    const summary = await Promise.all([
      get('/api/config'),
      get('/api/lists'),
      get('/api/domains'),
      get('/api/groups'),
      get('/api/clients'),
    ]).then(
      ([config, lists, domains, groups, clients]) =>
        piholeSummary({ config, lists, domains, groups, clients }),
      () => null,
    );
    return {
      bytes,
      fileName: `pihole-teleporter-${fileDate(now)}.zip`,
      contentType: 'application/zip',
      summary,
    };
  },
};
