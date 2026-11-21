/**
 * Pi-hole v6's declared settings: read from `/api/config/dns`, `/api/config/database` and `/api/config/misc`, written
 * via `PATCH /api/config`. Never touches `/api/config/webserver`, upstream DNS, or DHCP so nothing here can cut off
 * access or the network.
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
  rateLimitCount: number | null;
  rateLimitInterval: number | null;
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
  const rl = dns ? rec(dns.rateLimit) : null;
  const mode = dns ? str(rec(dns.blocking).mode) : null;
  return {
    blockingMode: mode ? mode.toUpperCase() : null,
    dnssec: dns && typeof dns.dnssec === 'boolean' ? dns.dnssec : null,
    queryLogging: dns && typeof dns.queryLogging === 'boolean' ? dns.queryLogging : null,
    rateLimitCount: rl ? num(rl.count) : null,
    rateLimitInterval: rl ? num(rl.interval) : null,
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

const patchConfig = (config: Record<string, unknown>) => ({
  method: 'PATCH' as const,
  path: '/api/config',
  body: { config },
});

const BLOCKING_MODES: SettingChoice[] = [
  { value: 'NULL', label: 'Empty address (0.0.0.0)', note: 'default and fastest' },
  { value: 'NXDOMAIN', label: 'Domain not found', note: 'NXDOMAIN' },
  { value: 'NODATA', label: 'No records', note: 'NODATA' },
  { value: 'ZERO', label: 'Empty address (IPv4 only)' },
];

const BLOCKING_SHORT: Record<string, string> = {
  NULL: '0.0.0.0',
  NXDOMAIN: 'NXDOMAIN',
  NODATA: 'NODATA',
  ZERO: 'IPv4 0.0.0.0',
};

const RATE_LIMITS: SettingChoice[] = [
  { value: 0, label: 'Off' },
  { value: 500, label: '500 lookups / min' },
  { value: 1000, label: '1,000 lookups / min', note: 'default' },
  { value: 2000, label: '2,000 lookups / min' },
  { value: 5000, label: '5,000 lookups / min' },
];

function rateLimitWords(v: SettingValue): string {
  const n = Number(v);
  if (n === 0) return 'Off';
  return RATE_LIMITS.find((c) => c.value === n)?.label ?? `${n.toLocaleString('en-GB')} lookups / min`;
}

const PRIVACY_LEVELS: SettingChoice[] = [
  { value: 0, label: 'Show everything', note: 'domains and devices' },
  { value: 1, label: 'Hide domains', note: 'counts and devices only' },
  { value: 2, label: 'Hide domains and devices', note: 'counts only' },
  { value: 3, label: 'Anonymous', note: 'no lookup history' },
];

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
    choices: (s) => withCurrent(BLOCKING_MODES, s.blockingMode ?? undefined, (v) => String(v)),
    short: (v) => BLOCKING_SHORT[String(v)] ?? String(v),
    write: (v) => patchConfig({ dns: { blocking: { mode: String(v) } } }),
    sentence: (v) => `Pi-hole now answers blocked domains with ${BLOCKING_SHORT[String(v)] ?? String(v)}.`,
  },
  {
    id: 'dnssec',
    group: 'blocking',
    label: 'Check DNS signatures (DNSSEC)',
    help: 'Verify that answers from upstream DNS haven’t been tampered with.',
    kind: 'switch',
    read: (s) => s.dnssec ?? undefined,
    write: (v) => patchConfig({ dns: { dnssec: asBool(v) === true } }),
    sentence: (v) => (asBool(v) ? 'DNSSEC is now on in Pi-hole.' : 'DNSSEC is now off in Pi-hole.'),
  },
  {
    id: 'rate_limit',
    group: 'blocking',
    label: 'Rate limit per device',
    help: 'Pause a device briefly if it floods Pi-hole with lookups in a minute.',
    kind: 'choice',
    read: (s) => s.rateLimitCount ?? undefined,
    choices: (s) => withCurrent(RATE_LIMITS, s.rateLimitCount ?? undefined, rateLimitWords),
    words: rateLimitWords,
    write: (v, s) => {
      const count = Number(v);
      const interval =
        count === 0 ? 0 : s.rateLimitInterval && s.rateLimitInterval > 0 ? s.rateLimitInterval : 60;
      return patchConfig({ dns: { rateLimit: { count, interval } } });
    },
    sentence: (v) =>
      Number(v) === 0
        ? 'Pi-hole’s per-device rate limit is now off.'
        : `Pi-hole now limits each device to ${rateLimitWords(v)}.`,
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
    help: 'Record DNS lookups so you can see what was allowed or blocked.',
    kind: 'switch',
    read: (s) => s.queryLogging ?? undefined,
    write: (v) => patchConfig({ dns: { queryLogging: asBool(v) === true } }),
    sentence: (v) =>
      asBool(v) ? 'Pi-hole is now recording DNS lookups.' : 'Pi-hole’s query log is now off.',
  },
  {
    id: 'privacy_level',
    group: 'logs',
    label: 'Privacy level',
    help: 'How much detail Pi-hole keeps about lookups and devices.',
    kind: 'choice',
    read: (s) => s.privacyLevel ?? undefined,
    choices: (s) => withCurrent(PRIVACY_LEVELS, s.privacyLevel ?? undefined, (v) => `Level ${String(v)}`),
    write: (v) => patchConfig({ misc: { privacylevel: Number(v) } }),
    sentence: (v) => {
      const label = PRIVACY_LEVELS.find((c) => c.value === Number(v))?.label ?? `level ${String(v)}`;
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
