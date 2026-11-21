import { type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'qbittorrent',
  name: 'qBittorrent',
  category: 'home',
  description: 'Your qBittorrent downloads, upload ratio, speed limits and disk space.',
  tagline: 'Torrent downloads',
  signIn: [
    {
      kind: 'token',
      label: 'Web UI username and password',
      auth: {
        type: 'session',
        login: {
          method: 'POST',
          path: '/api/v2/auth/login',
          encoding: 'form',
          body: { username: '{username}', password: '{secret}' },
        },
        tokenCookie: 'SID',
        ttlSeconds: 3600,
        apply: { type: 'cookie', name: 'SID' },
        logout: { method: 'POST', path: '/api/v2/auth/logout' },
        failures: [
          {
            status: [200],
            bodyPattern: '^\\s*Fails\\.?\\s*$',
            reason: 'refused',
            text: 'qBittorrent refused the username or password. Check them in Options → Web UI and try again.',
          },
          {
            status: [403],
            bodyPattern: 'banned',
            reason: 'locked',
            text: 'qBittorrent banned Whombat’s address after too many failed sign-ins. Wait a while or restart qBittorrent, then try again.',
          },
        ],
      },
      secretLabel: 'Password',
      secretHelp: 'The Web UI password set in qBittorrent under Options → Web UI → Authentication.',
      steps: [
        { text: 'In qBittorrent, open Tools → Options → Web UI.' },
        { text: 'Turn on Web User Interface (Remote control) and check your username and password.' },
        { text: 'Enter that username and password here.' },
      ],
    },
    {
      kind: 'none',
      label: 'No sign-in (local network bypass)',
    },
  ],
  fields: [
    urlField('http://192.168.1.20:8080', 'Your qBittorrent Web UI’s address, usually port 8080.'),
    {
      id: 'username',
      label: 'Username',
      placeholder: 'admin',
      help: 'Your Web UI username in qBittorrent (usually admin).',
      kind: 'text',
      required: true,
      default: 'admin',
      methods: ['token'],
    },
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: {
    kind: 'request',
    method: 'GET',
    path: '/api/v2/app/version',
  },
  tools: [],
  request: {
    prefixes: ['/api/v2/'],
    methods: ['GET', 'POST'],
    readMethods: ['GET', 'HEAD'],
  },
  guide:
    'qBittorrent’s WebUI API v2 under /api/v2/; Whombat keeps the SID session cookie. Reads: GET /api/v2/sync/maindata (server_state speeds, alltime_dl/ul, free_space_on_disk, connection_status, use_alt_speed_limits, and torrents map), GET /api/v2/torrents/info (?filter=downloading|seeding|stalled|errored&category=…&sort=…), GET /api/v2/transfer/info, GET /api/v2/torrents/categories, GET /api/v2/app/version. Actions (form-encoded POST with hashes=<hash|hash|all>): POST /api/v2/torrents/stop or /start (v5; /pause or /resume on v4), POST /api/v2/transfer/toggleSpeedLimitsMode, POST /api/v2/torrents/reannounce, POST /api/v2/torrents/add (urls=<magnet or URL>&category=…). Deleting torrents or their files (POST /api/v2/torrents/delete), changing preferences (POST /api/v2/app/setPreferences) and shutting qBittorrent down (POST /api/v2/app/shutdown) always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/v2/torrents/delete/?$',
      reason: 'Removes torrents and may delete their downloaded files',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/v2/app/setPreferences/?$',
      reason: 'Changes qBittorrent’s settings',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/v2/app/shutdown/?$',
      reason: 'Shuts qBittorrent down',
    },
  ],
  docsUrl: 'https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1)',
  tokenUrl: null,
  handle: 'qbittorrent',
  access: {
    read: 'The agent can see your torrents, speeds, categories and disk space, and change nothing.',
    manage:
      'The agent can also pause, resume, add torrents and toggle speed limits. Deleting torrents, settings and shutting down ask you first.',
  },
  discovery: {
    targets: [{ port: 8080, scheme: 'http' }],
    probes: [
      { path: '/', status: [200], bodyPattern: 'qBittorrent' },
      { path: '/api/v2/app/version', status: [200, 403] },
    ],
  },
} satisfies CatalogEntryInput;
