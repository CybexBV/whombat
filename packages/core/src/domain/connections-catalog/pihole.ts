import {
  type CatalogEntryInput,
  certificateField,
  DELETES_ASK,
  REQUEST_TOOL_NAME,
  urlField,
} from './shared.js';

export const entry = {
  id: 'pihole',
  name: 'Pi-hole',
  category: 'home',
  description: 'Blocked ads and trackers, DNS queries, lists, groups and clients on your Pi-hole.',
  tagline: 'Ad blocking for the house',
  signIn: [
    {
      kind: 'token',
      label: 'App password',
      // A session (0.97, CT-470; CM-08): the app password signs in for a session id, sent as X-FTL-SID.
      auth: {
        type: 'session',
        login: { method: 'POST', path: '/api/auth', body: { password: '{secret}' } },
        tokenJsonPath: 'session.sid',
        expiresJsonPath: 'session.validity',
        ttlSeconds: 1800,
        apply: { type: 'header', name: 'X-FTL-SID', template: '{token}' },
        logout: { method: 'DELETE', path: '/api/auth' },
        missing: 'This Pi-hole is older than version 6: update it, then connect it.',
        // SG-10 (0.111, CT-734, CT-743): the main password with two-step on (400 or 401 with an `error` object; an app
        // password never asks), every sign-in seat taken (429), and a Pi-hole without a password (200, no session).
        failures: [
          {
            json: 'error.message',
            values: ['No 2FA token found in JSON payload', 'Invalid 2FA token', 'Reused 2FA token'],
            reason: 'two_step',
            text: 'Pi-hole asks for a two-step code with that password. Make an app password in Pi-hole (Settings → Web interface / API → Expert → Configure app password) and use that instead.',
          },
          {
            json: 'error.key',
            values: ['api_seats_exceeded'],
            reason: 'locked',
            text: 'Pi-hole has no free sign-in seats: other apps are signed in. Wait half an hour, or raise webserver.api.max_sessions in Pi-hole.',
          },
          {
            status: [200],
            json: 'session.validity',
            values: ['-1'],
            reason: 'denied',
            text: 'This Pi-hole has no password, so Whombat can’t sign in. Set one in Pi-hole (sudo pihole setpassword), then make an app password.',
          },
        ],
      },
      secretLabel: 'App password',
      secretHelp:
        'Make one in Pi-hole → Settings → Web interface / API (switch to Expert) → Configure app password. It also works with two-step sign-in on.',
      steps: [
        {
          text: 'In Pi-hole, open Settings → Web interface / API and switch Basic to Expert at the top right.',
        },
        { text: 'Under Advanced Settings, click Configure app password, then Enable new app password.' },
        { text: 'Copy the app password it shows (only once) and paste it here.' },
        {
          text: 'To let the agent change Pi-hole’s settings too, tick webserver.api.app_sudo under Settings → All settings → HTTP/API.',
        },
      ],
    },
  ],
  fields: [
    urlField(
      'http://192.168.1.2',
      'Your Pi-hole’s address, like http://192.168.1.2 (Pi-hole 6 or later; https:// works with its own certificate).',
    ),
    certificateField('your browser shows it under the padlock → certificate'),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/api/info/version' },
  tools: [],
  request: { prefixes: ['/api/'] },
  guide:
    'Pi-hole 6’s API under /api/ (JSON); Whombat signs in with the app password and sends the session itself. GET /api/stats/summary (queries, blocked, percent_blocked, clients, gravity), /api/stats/top_domains?blocked=true&count=10, /api/stats/top_clients, /api/history. Queries: GET /api/queries?length=100&domain=…&client_ip=…&status=… (from and until in Unix time; pass the answer’s cursor to page on). Blocking: GET /api/dns/blocking; POST /api/dns/blocking {"blocking": true}, or {"blocking": false, "timer": 300} to pause it for 5 minutes. Allow and deny lists: GET or POST /api/domains/{allow|deny}/{exact|regex} {"domain", "comment", "groups"}; PUT or DELETE /api/domains/{type}/{kind}/{domain}. Blocklists: /api/lists (?type=block|allow; POST {"address", "comment"}); POST /api/action/gravity updates them (plain text, takes minutes). Also /api/groups, /api/clients, /api/dhcp/leases, /api/network/devices, /api/info/version, /api/info/system, /api/logs/dnsmasq and GET /api/search/{domain}. Settings: GET /api/config/{element} (dns/upstreams); PATCH /api/config {"config": {…}} changes them, which an app password may only do with webserver.api.app_sudo on (403 “read-only” otherwise). Errors are {"error": {"key", "message", "hint"}}. Turning blocking off, exporting or restoring a Teleporter backup, emptying logs, passwords and API settings, and deleting always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: ':batchDelete$',
      reason: 'Deletes something',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/dns/blocking/?$',
      body: { path: 'blocking', equals: false },
      reason: 'Turns blocking off: ads and trackers get through',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      path: '^/api/teleporter(/|$)',
      reason: 'Exports or restores a Pi-hole backup, which holds password hashes and the two-step secret',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['GET', 'HEAD'],
      path: '^/api/config/?$',
      reason: 'Reads all of Pi-hole’s settings, including its webserver password hashes',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['PATCH'],
      path: '^/api/config/?$',
      body: { path: 'config.webserver' },
      reason: 'Changes Pi-hole’s passwords, its web server or who may use its API',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      path: '^/api/config/webserver(/|$)',
      reason: 'Reads or changes Pi-hole’s passwords, its web server or who may use its API',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      path: '^/api/auth/(app|totp)(/|$)',
      reason: 'Generates a new Pi-hole app password or two-step secret',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/action/flush/',
      reason: 'Empties the query log or the network table',
    },
  ],
  cutsOff: [
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['PUT', 'PATCH', 'POST'],
      path: '^/api/config(/|$)',
      reason: 'Changes Pi-hole’s settings, such as its DNS servers or DHCP',
    },
  ],
  docsUrl: 'https://docs.pi-hole.net/api/',
  tokenUrl: '{url}/admin/settings/api',
  handle: 'pihole',
  access: {
    read: 'The agent can see queries, statistics, lists and clients, and change nothing.',
    manage:
      'The agent can also allow and block domains, change lists and update them. Turning blocking off, backups and passwords ask you first.',
  },
  discovery: {
    targets: [{ port: 80, scheme: 'http' }],
    probes: [{ path: '/api/auth', status: [200, 401], bodyPattern: '"session"\\s*:\\s*\\{\\s*"valid"' }],
  },
} satisfies CatalogEntryInput;
