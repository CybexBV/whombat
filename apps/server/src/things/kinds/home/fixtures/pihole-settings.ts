/**
 * Pi-hole v6 settings fixtures built from Pi-hole's documented `/api/config/{dns,database,misc}` endpoints.
 */

export const PIHOLE_configDns = {
  config: {
    dns: {
      upstreams: ['9.9.9.9'],
      queryLogging: true,
      dnssec: false,
      blocking: {
        active: true,
        mode: 'NULL',
        edns: 'TEXT',
      },
      rateLimit: {
        count: 1000,
        interval: 60,
      },
    },
  },
};

export const PIHOLE_configDatabase = {
  config: {
    database: {
      DBimport: true,
      maxDBdays: 90,
      DBinterval: 60,
    },
  },
};

export const PIHOLE_configMisc = {
  config: {
    misc: {
      privacylevel: 0,
      delay_startup: 0,
    },
  },
};
