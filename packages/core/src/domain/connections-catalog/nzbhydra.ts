import { type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'nzbhydra',
  name: 'NZBHydra2',
  category: 'home',
  description: 'Searches across your Usenet indexers, and NZBHydra2’s history and statistics.',
  tagline: 'Searches across Usenet indexers',
  signIn: [
    {
      kind: 'token',
      label: 'API key',
      auth: { type: 'query', name: 'apikey' },
      secretLabel: 'API key',
      secretHelp: 'In NZBHydra2, open Config → Main → Security and copy the API key.',
      steps: [
        { text: 'In NZBHydra2, open Config → Main and find Security.' },
        { text: 'Copy the API key (the one you give Sonarr and Radarr) and paste it here.' },
      ],
    },
  ],
  fields: [
    urlField(
      'http://192.168.1.20:5076',
      'Your NZBHydra2’s address, usually port 5076 (NZBHydra2 9 or later).',
    ),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  // The external API (NZBHydra2 9): a wrong key answers a bare 404, a right one {version, serverTime} (SG-11, CT-735).
  check: {
    kind: 'request',
    method: 'GET',
    path: '/externalapi/v1/ping',
    okJsonPath: 'version',
    failures: [
      {
        status: [404],
        bodyPattern: '^\\s*$',
        refused: true,
        text: 'NZBHydra2 didn’t accept that API key, or it’s older than version 9.',
      },
    ],
  },
  tools: [],
  request: {
    prefixes: ['/api', '/externalapi/v1/'],
    queryReads: [{ name: 't', values: ['caps', 'search', 'tvsearch', 'movie', 'book', 'details'] }],
  },
  guide:
    'NZBHydra2 searches all your indexers at once with the Newznab API: GET /api?t=search&q=<words>&o=json (also t=tvsearch with tvdbid or tvmazeid, season and ep; t=movie with imdbid or tmdbid; t=book with author and title; cat=2000 movies, 5000 TV, 7000 books; limit, offset, maxage in days). Results have a title, size, age and a link; t=get&id=<guid> downloads the NZB itself and counts against the indexers’ limits, so hand the link to SABnzbd (mode=addurl) instead. t=caps lists categories. Searches use up the indexers’ daily API hits. Its own API under /externalapi/v1/ reads: GET /externalapi/v1/stats (?after, ?before, ?section), /history/searches and /history/downloads (page, limit up to 500, query, indexer, status), /history/notifications, /backups (POST /backups makes one). Newznab errors come back 200 with an error code (100: wrong key); the external API answers a bare 404 to a wrong key. Reading the current log, which can hold your indexers’ keys, always asks a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      path: '^/externalapi/v1/log(/|$)',
      reason: 'Reads NZBHydra2’s log, which can hold your indexers’ keys',
    },
  ],
  docsUrl: 'https://github.com/theotherp/nzbhydra2/blob/master/docs/external-api.md',
  tokenUrl: '{url}/config/main',
  handle: 'nzbhydra',
  access: {
    read: 'The agent can search your indexers and see the history and statistics, and change nothing.',
    manage: 'The agent can also download NZBs and make backups. Reading the log asks you first.',
  },
  discovery: {
    targets: [{ port: 5076, scheme: 'http' }],
    probes: [{ path: '/', status: [200], bodyPattern: '<title>NZBHydra ?2</title>' }],
  },
} satisfies CatalogEntryInput;
