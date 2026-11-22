/**
 * Pi-hole v6's declared settings: read from `/api/config/dns`, `/api/config/database` and `/api/config/misc`, written
 * via field-only `PATCH /api/config`.
 *
 * Writable here:
 * - `blocking_mode` (`dns.blocking.mode`): field-only PATCH; changes only how already-blocked domains answer.
 * - `query_logging` (`dns.queryLogging`): field-only PATCH; in `pi-hole/FTL` (`src/config/config.c`), this only
 *   toggles writing future DNS queries and replies to `pihole.log` and deletes or replaces nothing already stored.
 * - `privacy_level` (`misc.privacylevel`): field-only PATCH; in `pi-hole/FTL` (`src/database/query-table.c`,
 *   `src/datastructure.c`), each query keeps the privacy level active when it arrived, so raising the level (even to
 *   Anonymous) only affects new queries and leaves already-stored rows in `pihole-FTL.db` intact.
 *
 * Stays in Pi-hole: `dnssec` (enabling it against a non-DNSSEC upstream breaks name lookups), `dns_and_dhcp`
 * (upstream DNS, DHCP and sign-in, never `/api/config/webserver`) and `max_db_days` (in `pi-hole/FTL`
 * `src/database/database-thread.c`, shortening it deletes stored queries older than `maxDBdays * 86400`).
 */
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { num, rec, str } from '../../words';
import { getJson, ReadProblem } from '../read';
import {
  asBool,
  type DeclaredSettings,
  type SettingChoice,
  type SettingSpec,
  type SettingValue,
  withCurrent,
} from '../settings';

const NAME = 'Pi-hole';

export interface PiholeSettingsState {
  blockingMode: string | null;
  dnssec: boolean | null;
  queryLogging: boolean | null;
  maxDbDays: number | null;
  privacyLevel: number | null;
}

const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** Parses Pi-hole v6 `/api/config/{dns,database,misc}` replies; missing sections are left out. */
export function parsePiholeSettings(parts: {
  dns: unknown;
  database: unknown;
  misc: unknown;
}): PiholeSettingsState {
  const dns = parts.dns !== null ? rec(rec(rec(parts.dns).config).dns) : null;
  const db = parts.database !== null ? rec(rec(rec(parts.database).config).database) : null;
  const misc = parts.misc !== null ? rec(rec(rec(parts.misc).config).misc) : null;
  const mode = dns ? str(rec(dns.blocking).mode) : null;
  return {
    blockingMode: mode ? mode.toUpperCase() : null,
    dnssec: dns && typeof dns.dnssec === 'boolean' ? dns.dnssec : null,
    queryLogging: dns && typeof dns.queryLogging === 'boolean' ? dns.queryLogging : null,
    maxDbDays: db ? num(db.maxDBdays) : null,
    privacyLevel: misc ? num(misc.privacylevel) : null,
  };
}

export async function readPiholeSettings(
  services: Services,
  row: CatalogConnectionRow,
): Promise<PiholeSettingsState> {
  const get = (path: string) => getJson(services, row, NAME, path);
  const [dns, database, misc] = await Promise.all([
    optional(get('/api/config/dns')),
    optional(get('/api/config/database')),
    optional(get('/api/config/misc')),
  ]);
  if (dns === null && database === null && misc === null)
    throw new ReadProblem(`Whombat couldn’t read ${NAME}’s settings just now.`);
  return parsePiholeSettings({ dns, database, misc });
}

async function readPiholeDns(services: Services, row: CatalogConnectionRow): Promise<PiholeSettingsState> {
  const dns = await getJson(services, row, NAME, '/api/config/dns');
  return parsePiholeSettings({ dns, database: null, misc: null });
}

async function readPiholeMisc(services: Services, row: CatalogConnectionRow): Promise<PiholeSettingsState> {
  const misc = await getJson(services, row, NAME, '/api/config/misc');
  return parsePiholeSettings({ dns: null, database: null, misc });
}

const patchConfig = (config: Record<string, unknown>) => ({
  method: 'PATCH' as const,
  path: '/api/config',
  body: { config },
});

const BLOCKING_MODES: SettingChoice[] = [
  { value: 'NULL', label: 'Empty address (0.0.0.0)', note: 'default and fastest' },
  { value: 'IP_NODATA_AAAA', label: 'Pi-hole’s IPv4 address', note: 'empty answer for IPv6' },
  { value: 'IP', label: 'Pi-hole’s address', note: 'IPv4 and IPv6' },
  { value: 'NXDOMAIN', label: 'Domain not found', note: 'NXDOMAIN' },
  { value: 'NODATA', label: 'No records', note: 'NODATA' },
];

const BLOCKING_SHORT: Record<string, string> = {
  NULL: '0.0.0.0',
  IP_NODATA_AAAA: 'Pi-hole’s IPv4 address',
  IP: 'Pi-hole’s address',
  NXDOMAIN: 'NXDOMAIN',
  NODATA: 'NODATA',
};

const PRIVACY_LEVELS: SettingChoice[] = [
  { value: 0, label: 'Show everything', note: 'full domains and devices' },
  { value: 1, label: 'Hide domains', note: 'keeps device counts' },
  { value: 2, label: 'Hide domains and devices', note: 'totals only' },
  { value: 3, label: 'Anonymous', note: 'no new lookup history' },
];

const PRIVACY_WORDS: Record<string, string> = {
  '0': 'Show everything',
  '1': 'Hide domains',
  '2': 'Hide domains and devices',
  '3': 'Anonymous',
};

function daysWords(v: SettingValue): string {
  const d = Number(v);
  if (d === 365) return '1 year';
  return d === 1 ? '1 day' : `${d} days`;
}

export const PIHOLE_SETTING_SPECS: readonly SettingSpec<PiholeSettingsState>[] = [
  {
    id: 'blocking_mode',
    group: 'blocking',
    label: 'How blocked sites answer',
    help: 'What Pi-hole sends back when a domain is on a block list.',
    kind: 'choice',
    read: (s) => s.blockingMode ?? undefined,
    readFresh: readPiholeDns,
    choices: (s) => withCurrent(BLOCKING_MODES, s.blockingMode ?? undefined, (v) => String(v)),
    short: (v) => BLOCKING_SHORT[String(v)] ?? String(v),
    write: (v) => patchConfig({ dns: { blocking: { mode: String(v) } } }),
    sentence: (v) => `Pi-hole now answers blocked domains with ${BLOCKING_SHORT[String(v)] ?? String(v)}.`,
  },
  {
    id: 'dnssec',
    group: 'blocking',
    label: 'Check DNS signatures (DNSSEC)',
    help: 'Verify that answers from upstream DNS haven’t been tampered with. Turning it on with an upstream that doesn’t support DNSSEC breaks lookups, so it stays in Pi-hole.',
    kind: 'elsewhere',
    read: (s) => s.dnssec ?? undefined,
    words: (v) => (asBool(v) ? 'On' : 'Off'),
    elsewhere: (base) => `${base}/admin/settings/dns`,
  },
  {
    id: 'dns_and_dhcp',
    group: 'blocking',
    label: 'Upstream DNS and DHCP',
    help: 'Upstream resolvers, DHCP and sign-in stay in Pi-hole so nothing cuts off your network.',
    kind: 'elsewhere',
    read: () => 'Managed in Pi-hole',
    elsewhere: (base) => `${base}/admin/settings/dns`,
  },
  {
    id: 'query_logging',
    group: 'logs',
    label: 'Query log',
    help: 'Record new DNS lookups to Pi-hole’s log file. Existing history stays.',
    kind: 'switch',
    read: (s) => s.queryLogging ?? undefined,
    readFresh: readPiholeDns,
    write: (v) => patchConfig({ dns: { queryLogging: asBool(v) === true } }),
    sentence: (v) =>
      asBool(v) ? 'Pi-hole is now recording DNS lookups.' : 'Pi-hole’s query log is now off.',
  },
  {
    id: 'privacy_level',
    group: 'logs',
    label: 'Privacy level',
    help: 'How much detail Pi-hole keeps for new lookups and devices. Existing history stays.',
    kind: 'choice',
    read: (s) => s.privacyLevel ?? undefined,
    readFresh: readPiholeMisc,
    choices: (s) =>
      withCurrent(
        PRIVACY_LEVELS,
        s.privacyLevel ?? undefined,
        (v) => PRIVACY_WORDS[String(v)] ?? `Level ${String(v)}`,
      ),
    words: (v) => PRIVACY_WORDS[String(v)] ?? `Level ${String(v)}`,
    write: (v) => patchConfig({ misc: { privacylevel: Number(v) } }),
    sentence: (v) => {
      const label = PRIVACY_WORDS[String(v)] ?? `level ${String(v)}`;
      return `Pi-hole’s privacy level is now set to ${label.toLowerCase()}.`;
    },
  },
  {
    id: 'max_db_days',
    group: 'logs',
    label: 'Keep query history for',
    help: 'How many days of lookups Pi-hole keeps in its database. Shortening it deletes older history, so it stays in Pi-hole.',
    kind: 'elsewhere',
    read: (s) => s.maxDbDays ?? undefined,
    words: daysWords,
  },
];

export const PIHOLE_SETTINGS: DeclaredSettings<PiholeSettingsState> = {
  name: NAME,
  url: (base) => `${base}/admin/settings`,
  groups: [
    {
      id: 'blocking',
      title: 'Blocking and lookups',
      ask: ['Which blocking mode works best in Pi-hole?', 'Should I turn on DNSSEC in Pi-hole?'],
    },
    {
      id: 'logs',
      title: 'Logs and privacy',
      ask: ['What do Pi-hole’s privacy levels hide?', 'How much space does Pi-hole’s query database use?'],
    },
  ],
  specs: PIHOLE_SETTING_SPECS,
  read: readPiholeSettings,
};
