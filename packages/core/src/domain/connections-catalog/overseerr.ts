import { type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'overseerr',
  // Shown as Seerr since 0.121 (CT-1009; Whombat service-dashboards.md SD-21): Seerr took Overseerr and Jellyseerr
  // over with the same API. The id stays, so existing connections keep working.
  name: 'Seerr',
  category: 'home',
  description: 'Movie and TV requests in Seerr, Overseerr or Jellyseerr.',
  tagline: 'Requests for films and series',
  signIn: [
    {
      kind: 'token',
      label: 'API key',
      auth: { type: 'header', name: 'X-Api-Key', template: '{secret}' },
      secretLabel: 'API key',
      // SG-21 (0.111, CT-749): Overseerr is archived; Seerr took it over and migrates it, with the same API.
      secretHelp:
        'In Seerr (or Overseerr or Jellyseerr), open Settings → General and copy the API Key. It acts as the first admin.',
      steps: [
        { text: 'In Seerr (or Overseerr or Jellyseerr), open Settings → General.' },
        { text: 'Copy the API Key and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '([A-Za-z0-9+/]{66}==)' }],
    },
  ],
  fields: [
    urlField(
      'http://192.168.1.20:5055',
      'Your Seerr’s address (or Overseerr’s or Jellyseerr’s), usually port 5055.',
    ),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/api/v1/auth/me' },
  tools: [],
  request: { prefixes: ['/api/v1/'], allowedHeaders: ['X-Api-User'] },
  guide:
    'Seerr’s API under /api/v1/ (Overseerr and Jellyseerr answer the same); the key acts as the first admin, and an X-Api-User: <user id> header acts as that user instead. Search: GET /api/v1/search?query=<words, %20 for spaces>&page=1 (results with mediaType and id, the TMDB id). Details: GET /api/v1/movie/<tmdbId>, /api/v1/tv/<tmdbId> (mediaInfo.status: 2 pending, 3 processing, 4 partly available, 5 available). Requests: GET /api/v1/request?take=20&skip=0&filter=pending|approved|processing|available|failed|all&sort=added; POST /api/v1/request {"mediaType": "movie", "mediaId": <tmdbId>} or {"mediaType": "tv", "mediaId": <tmdbId>, "seasons": [1, 2]} (or "all"); POST /api/v1/request/<id>/approve or …/decline; GET /api/v1/request/count. Issues: GET and POST /api/v1/issue. Users: GET /api/v1/user. Discover: GET /api/v1/discover/trending, /discover/movies, /discover/tv. Lists answer {pageInfo: {pages, pageSize, results, page}, results}. Errors are {"status", "error"} or {"message"}; a 403 “invalid csrf token” on a change means CSRF protection is on (Seerr: Settings → Network; Overseerr: Settings → General), which leaves the API read-only. Deleting requests, media, issues or users, adding users or changing their permissions, and changing settings always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT', 'PATCH'],
      path: '^/api/v1/settings/',
      reason: 'Changes Seerr’s settings, or makes a new API key',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT'],
      path: '^/api/v1/user(/import-from-[a-z]+)?/?$|^/api/v1/user/[^/]+/settings/permissions/?$',
      reason: 'Adds users or changes what they may do',
    },
  ],
  docsUrl: 'https://docs.seerr.dev/',
  tokenUrl: '{url}/settings/main',
  handle: 'overseerr',
  access: {
    read: 'The agent can see requests, issues and what’s available, and change nothing.',
    manage:
      'The agent can also request, approve and decline movies and shows. Deleting, users and settings ask you first.',
  },
  discovery: {
    targets: [{ port: 5055, scheme: 'http' }],
    probes: [
      { path: '/api/v1/status', status: [200], bodyPattern: '"commitTag"', version: { json: 'version' } },
    ],
  },
} satisfies CatalogEntryInput;
