/**
 * AdGuard Home's declared settings: read from `/control/filtering/status`, `/control/safebrowsing/status`,
 * `/control/parental/status`, `/control/safesearch/status`, `/control/querylog/config` and `/control/stats/config`.
 *
 * Only Safe browsing and Parental control are writable here:
 * - Single-field writes: in AdGuard Home (`internal/filtering/http.go`), `POST /control/safebrowsing/{enable,disable}`
 *   only toggles `SafeBrowsingEnabled` and `POST /control/parental/{enable,disable}` only toggles `ParentalEnabled`,
 *   with no request body and no sibling fields sent.
 * - Non-destructive: neither deletes or replaces any stored data.
 * - Cannot cut the person off: in AdGuard Home (`internal/filtering/filtering.go`, `internal/filtering/hashprefix/`,
 *   `internal/dnsforward/process.go`), both check SHA-256 hash prefixes against AdGuard's phishing/malware or
 *   adult-domain feeds only, are disabled for private reverse DNS, and stay separate from user block lists and custom
 *   rules.
 *
 * Every other row stays in AdGuard Home: `/control/filtering/config`, `/control/safesearch/settings`,
 * `/control/querylog/config/update` and `/control/stats/config/update` all take whole-section payloads (and block
 * lists, retention intervals, upstream DNS, encryption and access also carry cut-off or deletion risk).
 */
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { num, rec } from '../../words';
import { getJson, ReadProblem } from '../read';
import { asBool, type DeclaredSettings, type SettingSpec, type SettingValue } from '../settings';

const NAME = 'AdGuard Home';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface AdGuardSettingsState {
  filtering: { enabled: boolean; interval: number } | null;
  safebrowsing: boolean | null;
  parental: boolean | null;
  safesearch: boolean | null;
  querylog: { enabled: boolean; interval: number; anonymizeIp: boolean; raw: Record<string, unknown> } | null;
  stats: { enabled: boolean; interval: number; raw: Record<string, unknown> } | null;
}

const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** Parses AdGuard Home's settings endpoints; any endpoint that didn't answer is null and left out. */
export function parseAdGuardSettings(parts: {
  filtering: unknown;
  safebrowsing: unknown;
  parental: unknown;
  safesearch: unknown;
  querylog: unknown;
  stats: unknown;
}): AdGuardSettingsState {
  const f = parts.filtering !== null ? rec(parts.filtering) : null;
  const sb = parts.safebrowsing !== null ? rec(parts.safebrowsing) : null;
  const par = parts.parental !== null ? rec(parts.parental) : null;
  const ss = parts.safesearch !== null ? rec(parts.safesearch) : null;
  const ql = parts.querylog !== null ? rec(parts.querylog) : null;
  const st = parts.stats !== null ? rec(parts.stats) : null;
  const fInterval = num(f?.interval);
  const qlInterval = num(ql?.interval);
  const stInterval = num(st?.interval);
  return {
    filtering:
      f && typeof f.enabled === 'boolean' && fInterval !== null
        ? { enabled: f.enabled, interval: fInterval }
        : null,
    safebrowsing: sb && typeof sb.enabled === 'boolean' ? sb.enabled : null,
    parental: par && typeof par.enabled === 'boolean' ? par.enabled : null,
    safesearch: ss && typeof ss.enabled === 'boolean' ? ss.enabled : null,
    querylog:
      ql && typeof ql.enabled === 'boolean' && qlInterval !== null
        ? {
            enabled: ql.enabled,
            interval: qlInterval,
            anonymizeIp: ql.anonymize_client_ip === true,
            raw: { ...ql },
          }
        : null,
    stats:
      st && typeof st.enabled === 'boolean' && stInterval !== null
        ? { enabled: st.enabled, interval: stInterval, raw: { ...st } }
        : null,
  };
}

export async function readAdGuardSettings(
  services: Services,
  row: CatalogConnectionRow,
): Promise<AdGuardSettingsState> {
  const get = (path: string) => getJson(services, row, NAME, path);
  const [filtering, safebrowsing, parental, safesearch, querylog, stats] = await Promise.all([
    optional(get('/control/filtering/status')),
    optional(get('/control/safebrowsing/status')),
    optional(get('/control/parental/status')),
    optional(get('/control/safesearch/status')),
    optional(get('/control/querylog/config')),
    optional(get('/control/stats/config')),
  ]);
  if (
    filtering === null &&
    safebrowsing === null &&
    parental === null &&
    safesearch === null &&
    querylog === null &&
    stats === null
  )
    throw new ReadProblem(`Whombat couldn’t read ${NAME}’s settings just now.`);
  return parseAdGuardSettings({ filtering, safebrowsing, parental, safesearch, querylog, stats });
}

async function readAdGuardSafeBrowsing(
  services: Services,
  row: CatalogConnectionRow,
): Promise<AdGuardSettingsState> {
  const safebrowsing = await getJson(services, row, NAME, '/control/safebrowsing/status');
  return parseAdGuardSettings({
    filtering: null,
    safebrowsing,
    parental: null,
    safesearch: null,
    querylog: null,
    stats: null,
  });
}

async function readAdGuardParental(
  services: Services,
  row: CatalogConnectionRow,
): Promise<AdGuardSettingsState> {
  const parental = await getJson(services, row, NAME, '/control/parental/status');
  return parseAdGuardSettings({
    filtering: null,
    safebrowsing: null,
    parental,
    safesearch: null,
    querylog: null,
    stats: null,
  });
}

const FILTER_INTERVAL_LABELS: Record<number, string> = {
  0: 'Never automatically',
  1: 'Every hour',
  12: 'Every 12 hours',
  24: 'Every day',
  72: 'Every 3 days',
  168: 'Every week',
};

function filterIntervalWords(v: SettingValue): string {
  const h = Number(v);
  const known = FILTER_INTERVAL_LABELS[h];
  if (known) return known;
  if (h === 0) return 'Never automatically';
  return h % 24 === 0 ? `Every ${h / 24} days` : `Every ${h} hours`;
}

function durationWords(v: SettingValue): string {
  const ms = Number(v);
  if (ms >= DAY_MS && ms % DAY_MS === 0) {
    const d = ms / DAY_MS;
    return d === 1 ? '24 hours' : `${d} days`;
  }
  const h = Math.max(1, Math.round(ms / HOUR_MS));
  return h === 1 ? '1 hour' : `${h} hours`;
}

export const ADGUARD_SETTING_SPECS: readonly SettingSpec<AdGuardSettingsState>[] = [
  {
    id: 'filtering_enabled',
    group: 'protection',
    label: 'Block lists',
    help: 'Use your enabled block lists and custom rules to filter ads and trackers. Turning them on can block your own addresses, so it stays in AdGuard Home.',
    kind: 'elsewhere',
    read: (s) => s.filtering?.enabled,
    words: (v) => (asBool(v) ? 'On' : 'Off'),
    elsewhere: (base) => `${base}/#filters`,
  },
  {
    id: 'filter_update_interval',
    group: 'protection',
    label: 'Update block lists',
    help: 'How often AdGuard Home checks your block lists for updates. Saving it also sends the block-lists switch, so it stays in AdGuard Home.',
    kind: 'elsewhere',
    read: (s) => s.filtering?.interval,
    words: filterIntervalWords,
    elsewhere: (base) => `${base}/#filters`,
  },
  {
    id: 'safebrowsing',
    group: 'protection',
    label: 'Safe browsing',
    help: 'Block known phishing and malware websites.',
    kind: 'switch',
    read: (s) => s.safebrowsing ?? undefined,
    readFresh: readAdGuardSafeBrowsing,
    write: (v) => ({
      method: 'POST',
      path: asBool(v) ? '/control/safebrowsing/enable' : '/control/safebrowsing/disable',
    }),
    sentence: (v) =>
      asBool(v) ? 'Safe browsing is now on in AdGuard Home.' : 'Safe browsing is now off in AdGuard Home.',
  },
  {
    id: 'parental',
    group: 'protection',
    label: 'Parental control',
    help: 'Block adult websites across devices that use AdGuard Home.',
    kind: 'switch',
    read: (s) => s.parental ?? undefined,
    readFresh: readAdGuardParental,
    write: (v) => ({
      method: 'POST',
      path: asBool(v) ? '/control/parental/enable' : '/control/parental/disable',
    }),
    sentence: (v) =>
      asBool(v)
        ? 'Parental control is now on in AdGuard Home.'
        : 'Parental control is now off in AdGuard Home.',
  },
  {
    id: 'safesearch',
    group: 'protection',
    label: 'Safe search',
    help: 'Keep explicit results out of Google, YouTube and other search engines. Engine choices are saved together, so it stays in AdGuard Home.',
    kind: 'elsewhere',
    read: (s) => s.safesearch ?? undefined,
    words: (v) => (asBool(v) ? 'On' : 'Off'),
  },
  {
    id: 'querylog_enabled',
    group: 'logs',
    label: 'Query log',
    help: 'Record DNS lookups so you can see what was allowed or blocked. AdGuard Home saves all query-log settings together, so it stays in AdGuard Home.',
    kind: 'elsewhere',
    read: (s) => s.querylog?.enabled,
    words: (v) => (asBool(v) ? 'On' : 'Off'),
    elsewhere: (base) => `${base}/#settings`,
  },
  {
    id: 'querylog_interval',
    group: 'logs',
    label: 'Keep query log for',
    help: 'How long AdGuard Home keeps lookups before removing them. Shortening it deletes older history, so it stays in AdGuard Home.',
    kind: 'elsewhere',
    read: (s) => s.querylog?.interval,
    words: durationWords,
  },
  {
    id: 'anonymize_ip',
    group: 'logs',
    label: 'Anonymise device addresses',
    help: 'Leave client IP addresses out of the query log. AdGuard Home saves all query-log settings together, so it stays in AdGuard Home.',
    kind: 'elsewhere',
    read: (s) => s.querylog?.anonymizeIp,
    words: (v) => (asBool(v) ? 'On' : 'Off'),
    elsewhere: (base) => `${base}/#settings`,
  },
  {
    id: 'stats_enabled',
    group: 'logs',
    label: 'Statistics',
    help: 'Keep counts of lookups, blocked domains and busiest devices. AdGuard Home saves all statistics settings together, so it stays in AdGuard Home.',
    kind: 'elsewhere',
    read: (s) => s.stats?.enabled,
    words: (v) => (asBool(v) ? 'On' : 'Off'),
    elsewhere: (base) => `${base}/#settings`,
  },
  {
    id: 'stats_interval',
    group: 'logs',
    label: 'Keep statistics for',
    help: 'How long AdGuard Home keeps charts and counts. Shortening it deletes older history, so it stays in AdGuard Home.',
    kind: 'elsewhere',
    read: (s) => s.stats?.interval,
    words: durationWords,
  },
  {
    id: 'dns_and_access',
    group: 'logs',
    label: 'Upstream DNS and access',
    help: 'Upstream resolvers, encryption and sign-in stay in AdGuard Home so nothing cuts off your network.',
    kind: 'elsewhere',
    read: () => 'Managed in AdGuard Home',
    elsewhere: (base) => `${base}/#dns`,
  },
];

export const ADGUARD_SETTINGS: DeclaredSettings<AdGuardSettingsState> = {
  name: NAME,
  url: (base) => `${base}/#settings`,
  groups: [
    {
      id: 'protection',
      title: 'Protection and filtering',
      ask: [
        'What does Safe browsing block in AdGuard Home?',
        'How often should AdGuard Home update its block lists?',
      ],
    },
    {
      id: 'logs',
      title: 'Logs and history',
      ask: [
        'How long should AdGuard Home keep its query log?',
        'Does anonymising addresses affect device names?',
      ],
    },
  ],
  specs: ADGUARD_SETTING_SPECS,
  read: readAdGuardSettings,
};
