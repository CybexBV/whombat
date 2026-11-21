/**
 * Cloudflare API v4 answers as its OpenAPI schema and GraphQL docs write them (cloudflare/api-schemas, 2026-10-21;
 * no account to ask), trimmed to the fields read; ids and names made up.
 */

/** `GET /client/v4/zones?per_page=50`. */
export const CF_ZONES = {
  success: true,
  errors: [],
  messages: [],
  result: [
    {
      id: '023e105f4ecef8ad9ca31a8372d0c353',
      name: 'example.com',
      status: 'active',
      paused: false,
      type: 'full',
      account: { id: '01a7362d577a6c3019a474fd6f485823', name: 'Home' },
      plan: { id: '0feeeeeeeeeeeeeeeeeeeeeeeeeeeeee', name: 'Free Website', legacy_id: 'free' },
    },
    {
      id: '9a7806061c88ada191ed06f989cc3dac',
      name: 'example.org',
      status: 'pending',
      paused: false,
      type: 'full',
      account: { id: '01a7362d577a6c3019a474fd6f485823', name: 'Home' },
      plan: { id: '0feeeeeeeeeeeeeeeeeeeeeeeeeeeeee', name: 'Free Website', legacy_id: 'free' },
    },
  ],
  result_info: { page: 1, per_page: 50, count: 2, total_count: 2, total_pages: 1 },
};

/** `GET /client/v4/accounts/{id}/cfd_tunnel?is_deleted=false`. */
export const CF_TUNNELS = {
  success: true,
  errors: [],
  messages: [],
  result: [
    {
      id: 'f70ff985-a4ef-4643-bbbc-4a0ed4fc8415',
      name: 'home',
      account_tag: '01a7362d577a6c3019a474fd6f485823',
      status: 'healthy',
      tun_type: 'cfd_tunnel',
      config_src: 'cloudflare',
      created_at: '2026-01-10T09:00:00Z',
      deleted_at: null,
      conns_active_at: '2026-10-20T08:00:00Z',
      conns_inactive_at: null,
    },
    {
      id: '4f1b7c2e-0d43-4d0e-9b55-1c9a7f3e2b10',
      name: 'office',
      account_tag: '01a7362d577a6c3019a474fd6f485823',
      status: 'down',
      tun_type: 'cfd_tunnel',
      created_at: '2026-02-01T09:00:00Z',
      deleted_at: null,
      conns_active_at: null,
      conns_inactive_at: '2026-10-21T06:12:00Z',
    },
    {
      id: '8c2d4e6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f',
      name: 'test',
      account_tag: '01a7362d577a6c3019a474fd6f485823',
      status: 'inactive',
      tun_type: 'cfd_tunnel',
      created_at: '2026-03-01T09:00:00Z',
      deleted_at: null,
      conns_active_at: null,
      conns_inactive_at: null,
    },
  ],
  result_info: { count: 3, page: 1, per_page: 100, total_count: 3 },
};

/** `GET /client/v4/accounts/{id}/cfd_tunnel/{tunnel}/connections`. */
export const CF_CONNECTIONS = {
  success: true,
  errors: [],
  messages: [],
  result: [
    {
      id: '1bedc50d-42b3-473c-b108-ff3d10c0d925',
      arch: 'linux_amd64',
      version: '2026.9.1',
      run_at: '2026-10-20T08:00:00Z',
      conns: [
        {
          colo_name: 'ams01',
          id: 'a',
          client_id: '1',
          opened_at: '2026-10-20T08:00:00Z',
          origin_ip: '203.0.113.9',
          is_pending_reconnect: false,
        },
        {
          colo_name: 'fra08',
          id: 'b',
          client_id: '1',
          opened_at: '2026-10-20T08:00:00Z',
          origin_ip: '203.0.113.9',
          is_pending_reconnect: false,
        },
        {
          colo_name: 'ams08',
          id: 'c',
          client_id: '1',
          opened_at: '2026-10-20T08:00:00Z',
          origin_ip: '203.0.113.9',
          is_pending_reconnect: false,
        },
        {
          colo_name: 'fra10',
          id: 'd',
          client_id: '1',
          opened_at: '2026-10-20T08:00:00Z',
          origin_ip: '203.0.113.9',
          is_pending_reconnect: true,
        },
      ],
    },
  ],
};

/** `GET /client/v4/zones/{id}/ssl/certificate_packs?status=all`. */
export const CF_CERTIFICATE_PACKS = {
  success: true,
  errors: [],
  messages: [],
  result: [
    {
      id: '3822ff90-ea29-44df-9e55-21300bb9419b',
      type: 'universal',
      status: 'active',
      hosts: ['example.com', '*.example.com'],
      primary_certificate: '7e7b8deba8538af625850b7b2530034c',
      certificate_authority: 'google',
      validity_days: 90,
      certificates: [
        {
          id: '7e7b8deba8538af625850b7b2530034c',
          hosts: ['example.com', '*.example.com'],
          status: 'active',
          expires_on: '2026-10-30T00:00:00Z',
        },
      ],
    },
  ],
};

/** `POST /client/v4/graphql` with `httpRequests1hGroups` (two hours of example.com). */
export const CF_GRAPHQL_HOURLY = {
  data: {
    viewer: {
      zones: [
        {
          zoneTag: '023e105f4ecef8ad9ca31a8372d0c353',
          httpRequests1hGroups: [
            {
              dimensions: { datetime: '2026-10-21T10:00:00Z' },
              sum: { requests: 1200, cachedRequests: 900, threats: 3 },
            },
            {
              dimensions: { datetime: '2026-10-21T11:00:00Z' },
              sum: { requests: 800, cachedRequests: 500, threats: 1 },
            },
          ],
        },
      ],
    },
  },
  errors: null,
};

/** The same refused for the plan or the token: a 200 with errors only. */
export const CF_GRAPHQL_REFUSED = {
  data: null,
  errors: [
    {
      message: 'zone does not have access to the path',
      path: ['viewer', 'zones', '0', 'httpRequests1hGroups'],
    },
  ],
};

/** `httpRequestsAdaptiveGroups`: counts per hour and cache status, no threats. */
export const CF_GRAPHQL_ADAPTIVE = {
  data: {
    viewer: {
      zones: [
        {
          zoneTag: '023e105f4ecef8ad9ca31a8372d0c353',
          httpRequestsAdaptiveGroups: [
            { count: 600, dimensions: { datetimeHour: '2026-10-21T11:00:00Z', cacheStatus: 'hit' } },
            { count: 300, dimensions: { datetimeHour: '2026-10-21T11:00:00Z', cacheStatus: 'dynamic' } },
            { count: 100, dimensions: { datetimeHour: '2026-10-21T10:00:00Z', cacheStatus: 'miss' } },
          ],
        },
      ],
    },
  },
  errors: null,
};
