/**
 * Pi-hole's settings copy: its Teleporter file (`GET /api/teleporter`, a zip of its settings, lists and groups, the file
 * Pi-hole's own Teleporter takes back), compared from what its API says of the same: its DNS and DHCP settings, local
 * DNS records, block lists, allowed and blocked sites, groups and devices, and the rest of its settings. Secrets (its
 * password hashes, two-factor seed) are left out of the items, and so are dates and counts that change by themselves.
 * Whether two copies are the same also reads the file's own entries (its settings file, the system's hosts file…), so
 * a change Pi-hole's API doesn't show still keeps a new copy.
 */
import { createHash } from 'node:crypto';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import { getJson } from '../../things/kinds/read';
import { list, rec, str } from '../../things/words';
import {
  type CopyHasher,
  cleaned,
  copyHasher,
  SECRET_FIELD,
  type SettingsSummary,
  SummaryBuilder,
} from './summary';
import { CopyFailed, type CopyService, getBytes } from './types';
import { zipFiles } from './zip';

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

/** What Pi-hole's API said of its settings, and what the Teleporter file holds (`teleporterFiles`). */
export interface PiholeRead {
  config: unknown;
  lists: unknown;
  domains: unknown;
  groups: unknown;
  clients: unknown;
  /** The file's entries, each by a hash of what it holds; null when the file couldn't be read. */
  files: Record<string, string> | null;
}

/**
 * Entries that change by themselves or are compared through the API instead: the DHCP leases, and the lists' database
 * (its lists, sites, groups and devices are read from the API without their dates and counts).
 */
const SELF_CHANGING = /(^|\/)dhcp\.leases$|(^|\/)gravity[^/]*(\/|$)/i;

/**
 * What the Teleporter file holds, entry by entry, each by a hash of its bytes; in a text file its comment lines are left
 * out, as a settings file's own header says when it was written. Null when the file can't be read.
 */
export function teleporterFiles(bytes: Buffer): Record<string, string> | null {
  const files = zipFiles(bytes, (name) => SELF_CHANGING.test(name));
  if (!files) return null;
  const out: Record<string, string> = {};
  for (const [name, data] of files) {
    const text = data.subarray(0, 8192).includes(0)
      ? data
      : data
          .toString('utf8')
          .split(/\r?\n/)
          .filter((line) => line.trim() && !line.trim().startsWith('#'))
          .join('\n');
    out[name] = createHash('sha256').update(text).digest('hex');
  }
  return out;
}

export function piholeSummary(read: PiholeRead, hasher?: CopyHasher): SettingsSummary {
  const out = new SummaryBuilder(hasher);
  const config = rec(rec(read.config).config);
  for (const section of SECTIONS) {
    const values = rec(config[section]);
    for (const [key, value] of Object.entries(values)) {
      // A setting that is a secret itself (a password), not only a holder of one: never an item.
      if (SECRET_FIELD.test(key)) continue;
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
  // All of it, secrets and the file's own entries in: a password changed is another copy, though no item changed. A file
  // that couldn't be read is never said to be the same as another.
  if (read.files)
    out.content({
      api: cleaned(
        {
          config: Object.fromEntries(SECTIONS.map((s) => [s, config[s] ?? null])),
          lists: read.lists,
          domains: read.domains,
          groups: read.groups,
          clients: read.clients,
        },
        VOLATILE,
        'keep',
      ),
      files: read.files,
    });
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
    const files = teleporterFiles(bytes);
    const summary = await Promise.all([
      get('/api/config'),
      get('/api/lists'),
      get('/api/domains'),
      get('/api/groups'),
      get('/api/clients'),
    ]).then(
      ([config, lists, domains, groups, clients]) =>
        piholeSummary({ config, lists, domains, groups, clients, files }, copyHasher(services)),
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
