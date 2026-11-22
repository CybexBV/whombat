/**
 * AdGuard Home's declared settings: read from `/control/filtering/status`, `/control/safebrowsing/status`,
 * `/control/parental/status`, `/control/safesearch/status`, `/control/querylog/config` and `/control/stats/config`.
 * DNS filtering switches (block lists, safe browsing, parental control), log and statistics collection switches,
 * retention, upstream DNS, encryption and access stay in AdGuard Home so nothing here can block lookups, cut off
 * access or stop keeping logs and statistics.
 */
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { num, rec } from '../../words';
import { getJson, ReadProblem } from '../read';
import {
  asBool,
  type DeclaredSettings,
  type SettingChoice,
  type SettingSpec,
  type SettingValue,
  withCurrent,
} from '../settings';

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

const FILTER_INTERVALS: SettingChoice[] = [
  { value: 0, label: 'Never automatically' },
  { value: 1, label: 'Every hour' },
  { value: 12, label: 'Every 12 hours' },
  { value: 24, label: 'Every day' },
  { value: 72, label: 'Every 3 days' },
  { value: 168, label: 'Every week' },
];

function filterIntervalWords(v: SettingValue): string {
  const h = Number(v);
  const known = FILTER_INTERVALS.find((c) => c.value === h);
  if (known) return known.label;
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
    help: 'How often AdGuard Home checks your block lists for updates.',
    kind: 'choice',
    read: (s) => s.filtering?.interval,
    choices: (s) => withCurrent(FILTER_INTERVALS, s.filtering?.interval, filterIntervalWords),
    words: filterIntervalWords,
    short: (v) => filterIntervalWords(v).toLowerCase(),
    write: (v, s) => ({
      method: 'POST',
      path: '/control/filtering/config',
      body: { enabled: s.filtering?.enabled === true, interval: Number(v) },
    }),
    sentence: (v) =>
      Number(v) === 0
        ? 'AdGuard Home no longer updates its block lists automatically.'
        : `AdGuard Home now updates its block lists ${filterIntervalWords(v).toLowerCase()}.`,
  },
  {
    id: 'safebrowsing',
    group: 'protection',
    label: 'Safe browsing',
    help: 'Block known phishing and malware websites. Because DNS filtering can block addresses you rely on, it stays in AdGuard Home.',
    kind: 'elsewhere',
    read: (s) => s.safebrowsing ?? undefined,
    words: (v) => (asBool(v) ? 'On' : 'Off'),
    elsewhere: (base) => `${base}/#settings`,
  },
  {
    id: 'parental',
    group: 'protection',
    label: 'Parental control',
    help: 'Block adult websites across devices that use AdGuard Home. Because DNS filtering can block addresses you rely on, it stays in AdGuard Home.',
    kind: 'elsewhere',
    read: (s) => s.parental ?? undefined,
    words: (v) => (asBool(v) ? 'On' : 'Off'),
    elsewhere: (base) => `${base}/#settings`,
  },
  {
    id: 'safesearch',
    group: 'protection',
    label: 'Safe search',
    help: 'Keep explicit results out of Google, YouTube and other search engines. Engine choices stay in AdGuard Home.',
    kind: 'elsewhere',
    read: (s) => s.safesearch ?? undefined,
    words: (v) => (asBool(v) ? 'On' : 'Off'),
  },
  {
    id: 'querylog_enabled',
    group: 'logs',
    label: 'Query log',
    help: 'Record DNS lookups so you can see what was allowed or blocked. Turning it off stops keeping lookup logs, so it stays in AdGuard Home.',
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
    help: 'Leave client IP addresses out of the query log. Turning it on stops keeping device addresses in new logs, so it stays in AdGuard Home.',
    kind: 'elsewhere',
    read: (s) => s.querylog?.anonymizeIp,
    words: (v) => (asBool(v) ? 'On' : 'Off'),
    elsewhere: (base) => `${base}/#settings`,
  },
  {
    id: 'stats_enabled',
    group: 'logs',
    label: 'Statistics',
    help: 'Keep counts of lookups, blocked domains and busiest devices. Turning it off stops keeping statistics, so it stays in AdGuard Home.',
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
