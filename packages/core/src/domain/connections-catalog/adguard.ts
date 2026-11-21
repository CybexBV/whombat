import {
  type CatalogEntryInput,
  certificateField,
  DELETES_ASK,
  REQUEST_TOOL_NAME,
  urlField,
} from './shared.js';

export const entry = {
  id: 'adguard',
  name: 'AdGuard Home',
  category: 'home',
  description: 'Blocked ads and trackers, the query log, filters, clients and DNS rewrites in AdGuard Home.',
  tagline: 'Ad blocking and safe browsing',
  signIn: [
    {
      kind: 'token',
      label: 'Username and password',
      auth: { type: 'basic', usernameField: 'username' },
      secretLabel: 'Password',
      secretHelp:
        'AdGuard Home has no API keys: Whombat signs in with the username and password of its web page, on every request.',
      steps: [
        { text: 'Enter the username and password you sign in to AdGuard Home’s web page with.' },
        {
          text: 'AdGuard Home’s users can do everything. Choose Look only below if the agent should only look.',
        },
      ],
    },
  ],
  fields: [
    urlField(
      'http://192.168.1.2',
      'AdGuard Home’s web address, with its port when it isn’t 80 (3000 while it is being set up).',
    ),
    {
      id: 'username',
      label: 'Username',
      placeholder: 'admin',
      kind: 'text',
      required: true,
      help: 'The name you sign in to AdGuard Home with.',
    },
    certificateField('your browser shows it under the padlock → certificate'),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/control/status' },
  tools: [],
  request: {
    prefixes: ['/control/'],
    readPaths: [
      { method: 'POST', path: '^/control/(version\\.json|test_upstream_dns|tls/validate|clients/search)$' },
    ],
  },
  guide:
    'AdGuard Home’s API under /control/ (JSON in, many changes answer the text OK; errors are plain text). GET /control/status (version, protection_enabled, dns_addresses), /control/stats (num_dns_queries, num_blocked_filtering, top_queried_domains, top_blocked_domains, top_clients). Query log: GET /control/querylog?limit=100&search=<domain or client IP>&reason=… answers {oldest, data}: pass oldest as older_than for the next page. Filtering: GET /control/filtering/status; POST /control/filtering/add_url {"name", "url", "whitelist": false}, /filtering/refresh {"whitelist": false}; POST /control/filtering/set_rules {"rules": […]} replaces all custom rules: send user_rules back with yours (“@@||example.com^” allows, “||ads.example^” blocks). GET /control/filtering/check_host?name=example.com says why a name is blocked. Clients: GET /control/clients; POST /control/clients/add, /clients/update {"name", "data"}. Rewrites: GET /control/rewrite/list; POST /control/rewrite/add {"domain", "answer"}. Blocked services: GET /control/blocked_services/get, PUT /control/blocked_services/update {"ids": […]}. Protection: POST /control/protection {"enabled": false, "duration": 300000} pauses it (milliseconds). DHCP: GET /control/dhcp/status. Updates: POST /control/version.json {"recheck_now": false} only checks. Turning protection, safe browsing or parental control off, deleting, clearing statistics or the log, access and TLS settings, DHCP resets and updating always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/control/(filtering/remove_url|clients/delete|rewrite/delete|dhcp/remove_static_lease)$',
      reason: 'Deletes something',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/control/protection$',
      body: { path: 'enabled', equals: false },
      reason: 'Turns protection off: ads and trackers get through',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/control/dns_config$',
      body: { path: 'protection_enabled', equals: false },
      reason: 'Turns protection off: ads and trackers get through',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/control/(safebrowsing|parental)/disable$',
      reason: 'Turns off safe browsing or parental control',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/control/(stats_reset|querylog_clear|dhcp/reset|dhcp/reset_leases)$',
      reason: 'Clears statistics, the query log or DHCP',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/control/(access/set|tls/configure)$',
      reason: 'Changes who may use AdGuard Home, or its certificate',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/control/update$',
      reason: 'Updates AdGuard Home, which restarts it',
    },
  ],
  docsUrl: 'https://github.com/AdguardTeam/AdGuardHome/tree/master/openapi',
  tokenUrl: null,
  handle: 'adguard',
  access: {
    read: 'The agent can see statistics, the query log, filters and clients, and change nothing.',
    manage:
      'The agent can also add filters, rules, rewrites and clients. Turning protection off and clearing logs ask you first.',
  },
  discovery: {
    targets: [
      { port: 80, scheme: 'http' },
      { port: 3000, scheme: 'http' },
    ],
    probes: [
      { path: '/login.html', status: [200], bodyPattern: '#67B279' },
      { path: '/control/status', status: [401] },
    ],
  },
} satisfies CatalogEntryInput;
