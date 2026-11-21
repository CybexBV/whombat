/**
 * Real answers of Pi-hole v6 (core v6.5, FTL v6.8, docker 2026.10.0) in a throwaway container, 2026-10-21: 32 test
 * queries from the container itself, the default StevenBlack list; `history` cut to its last 18 ten-minute buckets.
 * `blockingPaused` after `POST /api/dns/blocking {blocking:false,timer:300}`, `blockingOff` after `{blocking:false}`.
 */
export const PIHOLE_summary = {
  queries: {
    total: 32,
    blocked: 15,
    percent_blocked: 46.875,
    unique_domains: 12,
    forwarded: 6,
    cached: 11,
    frequency: 1.0666666666666667,
    types: {
      A: 30,
      AAAA: 0,
      ANY: 0,
      SRV: 0,
      SOA: 0,
      PTR: 2,
      TXT: 0,
      NAPTR: 0,
      MX: 0,
      DS: 0,
      RRSIG: 0,
      DNSKEY: 0,
      NS: 0,
      SVCB: 0,
      HTTPS: 0,
      OTHER: 0,
    },
    status: {
      UNKNOWN: 0,
      GRAVITY: 15,
      FORWARDED: 6,
      CACHE: 11,
      REGEX: 0,
      DENYLIST: 0,
      EXTERNAL_BLOCKED_IP: 0,
      EXTERNAL_BLOCKED_NULL: 0,
      EXTERNAL_BLOCKED_NXRA: 0,
      GRAVITY_CNAME: 0,
      REGEX_CNAME: 0,
      DENYLIST_CNAME: 0,
      RETRIED: 0,
      RETRIED_DNSSEC: 0,
      IN_PROGRESS: 0,
      DBBUSY: 0,
      SPECIAL_DOMAIN: 0,
      CACHE_STALE: 0,
      EXTERNAL_BLOCKED_EDE15: 0,
    },
    replies: {
      UNKNOWN: 0,
      NODATA: 0,
      NXDOMAIN: 0,
      CNAME: 0,
      IP: 30,
      DOMAIN: 2,
      RRNAME: 0,
      SERVFAIL: 0,
      REFUSED: 0,
      NOTIMP: 0,
      OTHER: 0,
      DNSSEC: 0,
      NONE: 0,
      BLOB: 0,
    },
  },
  clients: { active: 1, total: 1 },
  gravity: { domains_being_blocked: 71493, last_update: 1792611580 },
  took: 0.0003154277801513672,
};

export const PIHOLE_topBlocked = {
  domains: [
    { domain: 'doubleclick.net', count: 3 },
    { domain: 'ads.google.com', count: 3 },
    { domain: 'googleadservices.com', count: 3 },
    { domain: 'www.googletagmanager.com', count: 3 },
    { domain: 'analytics.google.com', count: 3 },
  ],
  total_queries: 32,
  blocked_queries: 15,
  took: 0.00018358230590820312,
};

export const PIHOLE_topClients = {
  clients: [{ name: 'localhost', ip: '127.0.0.1', count: 32 }],
  total_queries: 32,
  blocked_queries: 15,
  took: 2.7418136596679688e-5,
};

export const PIHOLE_history = {
  history: [
    { timestamp: 1792601100, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792601700, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792602300, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792602900, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792603500, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792604100, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792604700, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792605300, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792605900, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792606500, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792607100, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792607700, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792608300, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792608900, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792609500, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792610100, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792610700, total: 0, cached: 0, blocked: 0, forwarded: 0 },
    { timestamp: 1792611300, total: 32, cached: 11, blocked: 15, forwarded: 6 },
  ],
  took: 7.081031799316406e-5,
};

export const PIHOLE_messages = { messages: [], took: 0.0005478858947753906 };

export const PIHOLE_version = {
  version: {
    core: {
      local: { version: 'v6.5', branch: 'master', hash: 'f503a65d' },
      remote: { version: 'v6.5', hash: 'f503a65d' },
    },
    web: {
      local: { version: 'v6.6.1', branch: 'master', hash: 'fb699c4e' },
      remote: { version: 'v6.6.1', hash: 'fb699c4e' },
    },
    ftl: {
      local: { hash: '29c8b13f', branch: 'master', version: 'v6.8', date: '2026-10-17 13:08:09 +0200' },
      remote: { version: 'v6.8', hash: '29c8b13f' },
    },
    docker: { local: '2026.10.0', remote: '2026.10.0' },
  },
  took: 0.00013136863708496094,
};

export const PIHOLE_lists = {
  lists: [
    {
      address: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
      comment: 'Migrated from /etc/pihole/adlists.list',
      groups: [0],
      enabled: true,
      id: 1,
      date_added: 1792611580,
      date_modified: 1792611580,
      type: 'block',
      date_updated: 1792611580,
      number: 71493,
      invalid_domains: 1,
      abp_entries: 0,
      status: 1,
    },
  ],
  took: 0.0006182193756103516,
};

export const PIHOLE_blocking = { blocking: 'enabled', timer: null, took: 2.86102294921875e-5 };

export const PIHOLE_blockingPaused = { blocking: 'disabled', timer: 300, took: 4.220008850097656e-5 };

export const PIHOLE_blockingOff = { blocking: 'disabled', timer: null, took: 1.52587890625e-5 };
