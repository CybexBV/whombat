/**
 * Real answers of AdGuard Home v0.107.79 in a throwaway container, 2026-10-21: 55 test queries from the container
 * itself, the AdGuard DNS filter. `statusPaused` after `POST /control/protection {enabled:false,duration:300000}`,
 * `statusOff` after `{enabled:false}`; `version` as the Docker build answers `POST /control/version.json` (updates off).
 */
export const ADGUARD_stats = {
  time_units: 'hours',
  top_queried_domains: [
    { 'www.googletagmanager.com': 6 },
    { 'example.com': 6 },
    { 'ads.google.com': 6 },
    { 'wikipedia.org': 4 },
    { 'google.com': 4 },
    { 'github.com': 4 },
    { 'facebook.com': 4 },
  ],
  top_clients: [{ '127.0.0.1': 50 }],
  top_blocked_domains: [
    { 'doubleclick.net': 6 },
    { 'googleadservices.com': 6 },
    { 'analytics.google.com': 4 },
  ],
  top_upstreams_responses: [{ 'https://dns10.quad9.net:443/dns-query': 14 }],
  top_upstreams_avg_time: [{ 'https://dns10.quad9.net:443/dns-query': 0.015310142857142855 }],
  dns_queries: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50],
  blocked_filtering: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16],
  replaced_safebrowsing: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  replaced_parental: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  num_dns_queries: 50,
  num_blocked_filtering: 16,
  num_replaced_safebrowsing: 0,
  num_replaced_safesearch: 0,
  num_replaced_parental: 0,
  avg_processing_time: 0.006986999999999999,
};

export const ADGUARD_status = {
  version: 'v0.107.79',
  language: '',
  dns_addresses: ['127.0.0.1', '::1', '172.21.0.3'],
  dns_port: 53,
  http_port: 3000,
  protection_disabled_duration: 0,
  start_time: 1792611582636.2305,
  protection_enabled: true,
  dhcp_available: true,
  running: true,
};

export const ADGUARD_statusPaused = {
  version: 'v0.107.79',
  language: '',
  dns_addresses: ['127.0.0.1', '::1', '172.21.0.3'],
  dns_port: 53,
  http_port: 3000,
  protection_disabled_duration: 299953,
  start_time: 1792611582636.2305,
  protection_enabled: false,
  dhcp_available: true,
  running: true,
};

export const ADGUARD_statusOff = {
  version: 'v0.107.79',
  language: '',
  dns_addresses: ['127.0.0.1', '::1', '172.21.0.3'],
  dns_port: 53,
  http_port: 3000,
  protection_disabled_duration: 0,
  start_time: 1792611582636.2305,
  protection_enabled: false,
  dhcp_available: true,
  running: true,
};

export const ADGUARD_filtering = {
  filters: [
    {
      url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt',
      name: 'AdGuard DNS filter',
      last_updated: '2026-10-21T19:41:22Z',
      id: 1,
      rules_count: 190469,
      enabled: true,
    },
    {
      url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_2.txt',
      name: 'AdAway Default Blocklist',
      id: 2,
      rules_count: 0,
      enabled: false,
    },
  ],
  whitelist_filters: null,
  user_rules: null,
  interval: 24,
  enabled: true,
};

export const ADGUARD_version = { disabled: true };

/**
 * `/control/clients` of AdGuard Home v0.107 in a throwaway container, 2026-11-04: one client a person named, and what it
 * found in its hosts file (filtering settings and the rest of the hosts lines left out).
 */
export const ADGUARD_clients = {
  clients: [
    {
      name: 'Annas iPhone',
      ids: ['127.0.0.1'],
      tags: null,
      use_global_settings: true,
      use_global_blocked_services: true,
    },
  ],
  auto_clients: [
    { whois_info: {}, ip: '172.20.0.3', name: '53eac543bf1a', source: 'etc/hosts' },
    { whois_info: {}, ip: '127.0.0.1', name: 'localhost', source: 'etc/hosts' },
  ],
  supported_tags: ['device_phone', 'device_tv'],
};
