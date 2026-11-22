import { type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'plex',
  name: 'Plex',
  category: 'home',
  description: 'Your Plex Media Server’s libraries, what’s playing and what was watched.',
  tagline: 'Films, series and music',
  signIn: [
    {
      // SG-04 (0.111, CT-739): Plex's PIN page, as every maintained Plex client signs in. It handles two-step codes,
      // Google, Apple and Facebook accounts and passkeys; the account's token is stored as the Plex token below.
      kind: 'service_login',
      label: 'Sign in with Plex',
      note: 'Sign in to Plex in a new tab and allow Whombat.',
      tokenMethod: 0,
    },
    {
      kind: 'token',
      label: 'Plex token',
      auth: { type: 'header', name: 'X-Plex-Token', template: '{secret}' },
      secretLabel: 'Plex token',
      secretHelp:
        'In Plex Web, open any movie or episode → ⋯ → Get Info → View XML: the token is the X-Plex-Token at the end of that page’s address.',
      steps: [
        { text: 'In Plex Web, signed in as the server’s owner, open any movie or episode.' },
        { text: 'Click ⋯ → Get Info → View XML. A page with the item’s details opens.' },
        { text: 'Copy that page’s address (it ends in X-Plex-Token=…) and paste it here.' },
      ],
      paste: [
        { target: 'secret', pattern: 'X-Plex-Token=([A-Za-z0-9_-]{20}|eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+)' },
      ],
    },
  ],
  fields: [urlField('http://192.168.1.20:32400', 'Your Plex Media Server’s address, usually port 32400.')],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: {
    kind: 'request',
    method: 'GET',
    path: '/library/sections',
    headers: { Accept: 'application/json' },
  },
  tools: [],
  request: {
    prefixes: [
      '/library/',
      '/status/',
      '/hubs/',
      '/playlists',
      '/:/',
      '/butler',
      '/activities',
      '/updater/',
      '/identity',
      // Posters through Plex's own resizer (0.121, CT-1009; Whombat SD-20): a GET, so a read.
      '/photo/:/transcode',
    ],
    headers: { Accept: 'application/json' },
    allowedHeaders: ['X-Plex-Container-Start', 'X-Plex-Container-Size'],
  },
  guide:
    'Plex Media Server’s API (JSON, Whombat asks for it; answers are {MediaContainer: …}). Libraries: GET /library/sections (each has a key, its id); GET /library/sections/<id>/all (?type=1 movies, 2 shows, 4 episodes; ?unwatched=1; sort=addedAt:desc) pages with X-Plex-Container-Start and X-Plex-Container-Size (as query parameters too; the answer has totalSize). Items: GET /library/metadata/<ratingKey> and …/children (seasons, episodes); GET /library/recentlyAdded, /library/onDeck; a poster smaller: GET /photo/:/transcode?url=<its thumb>&width=240&height=360. Search: GET /hubs/search?query=<words>&limit=10. Playing now: GET /status/sessions; history: GET /status/sessions/history/all?sort=viewedAt:desc. Scan a library: POST /library/sections/<id>/refresh. Watched: PUT /:/scrobble?identifier=com.plexapp.plugins.library&key=<ratingKey> (/:/unscrobble undoes it). Stop someone’s stream: POST /status/sessions/terminate?sessionId=<id>&reason=… Also /playlists, /activities, /butler and /updater/status. Deleting media deletes its files; that, emptying a library’s trash, reading or changing the server’s settings (/:/prefs) and installing an update always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['PUT'],
      path: '^/library/sections/[^/]+/emptyTrash/?$',
      reason: 'Deletes a library’s removed items for good',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      path: '^/:/prefs(/|$)',
      reason: 'Reads or changes Plex’s server settings, which may contain certificate passwords or tokens',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['PUT', 'POST'],
      path: '^/updater/apply/?$',
      reason: 'Installs a Plex update, which restarts the server',
    },
  ],
  docsUrl: 'https://developer.plex.tv/pms/',
  tokenUrl: null,
  handle: 'plex',
  access: {
    read: 'The agent can see your libraries, what’s playing and what was watched, and change nothing.',
    manage:
      'The agent can also scan libraries, mark things watched and stop streams. Deleting media and settings ask you first.',
  },
  discovery: {
    targets: [{ port: 32400, scheme: 'http' }],
    probes: [
      {
        path: '/identity',
        status: [200],
        header: { name: 'X-Plex-Protocol', pattern: '^1\\.' },
        bodyPattern: 'machineIdentifier',
        // The answer starts with `<?xml version="1.0" …?>`: the server's version is the MediaContainer's.
        version: { pattern: '<MediaContainer[^>]*\\sversion="([0-9][^"]*)"' },
      },
    ],
  },
} satisfies CatalogEntryInput;
