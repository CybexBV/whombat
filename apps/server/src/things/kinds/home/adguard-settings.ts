/**
 * AdGuard Home's declared settings: read from `/control/filtering/status`, `/control/safebrowsing/status`,
 * `/control/parental/status`, `/control/safesearch/status`, `/control/querylog/config` and `/control/stats/config`.
 * Upstream DNS, encryption and access stay in AdGuard Home so nothing here can cut off the network.
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
  safesearch: { enabled: boolean; raw: Record<string, unknown> } | null;
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
    safesearch: ss && typeof ss.enabled === 'boolean' ? { enabled: ss.enabled, raw: { ...ss } } : null,
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

const QUERYLOG_INTERVALS: SettingChoice[] = [
  { value: 6 * HOUR_MS, label: '6 hours' },
  { value: DAY_MS, label: '24 hours' },
  { value: 7 * DAY_MS, label: '7 days' },
  { value: 30 * DAY_MS, label: '30 days' },
  { value: 90 * DAY_MS, label: '90 days' },
];

const STATS_INTERVALS: SettingChoice[] = [
  { value: DAY_MS, label: '24 hours' },
  { value: 7 * DAY_MS, label: '7 days' },
  { value: 30 * DAY_MS, label: '30 days' },
  { value: 90 * DAY_MS, label: '90 days' },
];

function durationWords(v: SettingValue): string {
  const ms = Number(v);
  const known = QUERYLOG_INTERVALS.find((c) => c.value === ms);
  if (known) return known.label;
  if (ms >= DAY_MS && ms % DAY_MS === 0) {
    const d = ms / DAY_MS;
    return d === 1 ? '24 hours' : `${d} days`;
  }
  const h = Math.max(1, Math.round(ms / HOUR_MS));
  return h === 1 ? '1 hour' : `${h} hours`;
}

const SAFE_ENGINES = ['bing', 'duckduckgo', 'google', 'pixabay', 'yandex', 'youtube'] as const;

export const ADGUARD_SETTING_SPECS: readonly SettingSpec<AdGuardSettingsState>[] = [
  {
    id: 'filtering_enabled',
    group: 'protection',
    label: 'Block lists',
    help: 'Use your enabled block lists to filter ads and trackers.',
    kind: 'switch',
    read: (s) => s.filtering?.enabled,
    write: (v, s) => ({
      method: 'POST',
      path: '/control/filtering/config',
      body: { enabled: asBool(v) === true, interval: s.filtering?.interval ?? 24 },
    }),
    sentence: (v) =>
      asBool(v) ? 'AdGuard Home is now using its block lists.' : 'AdGuard Home’s block lists are now off.',
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
      body: { enabled: s.filtering?.enabled ?? true, interval: Number(v) },
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
    help: 'Block known phishing and malware websites.',
    kind: 'switch',
    read: (s) => s.safebrowsing ?? undefined,
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
    help: 'Keep explicit results out of Google, YouTube and other search engines.',
    kind: 'switch',
    read: (s) => s.safesearch?.enabled,
    write: (v, s) => {
      const enabled = asBool(v) === true;
      const raw = { ...(s.safesearch?.raw ?? {}) };
      const anyOn = SAFE_ENGINES.some((e) => raw[e] === true);
      if (enabled && !anyOn) for (const e of SAFE_ENGINES) raw[e] = true;
      return { method: 'PUT', path: '/control/safesearch/settings', body: { ...raw, enabled } };
    },
    sentence: (v) =>
      asBool(v) ? 'Safe search is now on in AdGuard Home.' : 'Safe search is now off in AdGuard Home.',
  },
  {
    id: 'querylog_enabled',
    group: 'logs',
    label: 'Query log',
    help: 'Record DNS lookups so you can see what was allowed or blocked.',
    kind: 'switch',
    read: (s) => s.querylog?.enabled,
    write: (v, s) => ({
      method: 'PUT',
      path: '/control/querylog/config/update',
      body: { ...(s.querylog?.raw ?? {}), enabled: asBool(v) === true },
    }),
    sentence: (v) =>
      asBool(v) ? 'AdGuard Home is now recording DNS lookups.' : 'AdGuard Home’s query log is now off.',
  },
  {
    id: 'querylog_interval',
    group: 'logs',
    label: 'Keep query log for',
    help: 'Older lookups are removed automatically.',
    kind: 'choice',
    read: (s) => s.querylog?.interval,
    choices: (s) => withCurrent(QUERYLOG_INTERVALS, s.querylog?.interval, durationWords),
    words: durationWords,
    write: (v, s) => ({
      method: 'PUT',
      path: '/control/querylog/config/update',
      body: { ...(s.querylog?.raw ?? {}), interval: Number(v) },
    }),
    sentence: (v) => `AdGuard Home now keeps its query log for ${durationWords(v)}.`,
  },
  {
    id: 'anonymize_ip',
    group: 'logs',
    label: 'Anonymise device addresses',
    help: 'Leave client IP addresses out of the query log.',
    kind: 'switch',
    read: (s) => s.querylog?.anonymizeIp,
    write: (v, s) => ({
      method: 'PUT',
      path: '/control/querylog/config/update',
      body: { ...(s.querylog?.raw ?? {}), anonymize_client_ip: asBool(v) === true },
    }),
    sentence: (v) =>
      asBool(v)
        ? 'AdGuard Home now leaves device addresses out of its query log.'
        : 'AdGuard Home now shows device addresses in its query log.',
  },
  {
    id: 'stats_enabled',
    group: 'logs',
    label: 'Statistics',
    help: 'Keep counts of lookups, blocked domains and busiest devices.',
    kind: 'switch',
    read: (s) => s.stats?.enabled,
    write: (v, s) => ({
      method: 'PUT',
      path: '/control/stats/config/update',
      body: { ...(s.stats?.raw ?? {}), enabled: asBool(v) === true },
    }),
    sentence: (v) =>
      asBool(v) ? 'Statistics are now on in AdGuard Home.' : 'Statistics are now off in AdGuard Home.',
  },
  {
    id: 'stats_interval',
    group: 'logs',
    label: 'Keep statistics for',
    help: 'How much history the charts and counts cover.',
    kind: 'choice',
    read: (s) => s.stats?.interval,
    choices: (s) => withCurrent(STATS_INTERVALS, s.stats?.interval, durationWords),
    words: durationWords,
    write: (v, s) => ({
      method: 'PUT',
      path: '/control/stats/config/update',
      body: { ...(s.stats?.raw ?? {}), interval: Number(v) },
    }),
    sentence: (v) => `AdGuard Home now keeps statistics for ${durationWords(v)}.`,
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
