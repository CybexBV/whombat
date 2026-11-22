/**
 * AdGuard Home settings fixtures built from AdGuard Home's OpenAPI specification (`openapi/openapi.yaml`):
 * `/control/filtering/status`, `/control/safebrowsing/status`, `/control/parental/status`,
 * `/control/safesearch/status`, `/control/querylog/config`, and `/control/stats/config`.
 */

export const ADGUARD_filteringConfig = {
  enabled: true,
  interval: 24,
  filters: [
    {
      enabled: true,
      id: 1,
      last_updated: '2026-10-21T12:00:00Z',
      name: 'AdGuard DNS filter',
      rules_count: 190469,
      url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt',
    },
  ],
  whitelist_filters: [],
  user_rules: [],
};

export const ADGUARD_safebrowsingStatus = {
  enabled: true,
};

export const ADGUARD_parentalStatus = {
  enabled: false,
};

export const ADGUARD_safesearchStatus = {
  enabled: false,
  bing: false,
  duckduckgo: false,
  google: false,
  pixabay: false,
  yandex: false,
  youtube: false,
};

export const ADGUARD_querylogConfig = {
  enabled: true,
  interval: 604_800_000,
  anonymize_client_ip: false,
  ignored: ['example.com'],
  ignored_enabled: true,
};

export const ADGUARD_statsConfig = {
  enabled: true,
  interval: 86_400_000,
  ignored: ['metrics.example.com'],
  ignored_enabled: true,
};
