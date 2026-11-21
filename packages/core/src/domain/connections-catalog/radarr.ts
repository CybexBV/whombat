import { arrSensitive, type CatalogEntryInput, urlField } from './shared.js';

export const entry = {
  id: 'radarr',
  name: 'Radarr',
  category: 'home',
  description: 'Your movies in Radarr: what’s coming, the download queue and what’s missing.',
  tagline: 'Movies, found and downloaded',
  signIn: [
    {
      kind: 'token',
      label: 'API key',
      auth: { type: 'header', name: 'X-Api-Key', template: '{secret}' },
      secretLabel: 'API key',
      secretPlaceholder: '32 letters and digits',
      secretHelp: 'In Radarr, open Settings → General and copy the API Key under Security.',
      steps: [
        { text: 'In Radarr, open Settings → General.' },
        { text: 'Under Security, copy the API Key and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b([0-9a-f]{32})\\b' }],
    },
  ],
  fields: [
    urlField(
      'http://192.168.1.20:7878',
      'Your Radarr’s address, usually port 7878, with its URL Base when it has one (http://192.168.1.20:7878/radarr).',
    ),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  // Without a key, or with a wrong one, every /api/ path answers an empty 401.
  check: { kind: 'request', method: 'GET', path: '/api/v3/system/status', okJsonPath: 'version' },
  tools: [],
  request: { prefixes: ['/api/v3/', '/MediaCover/'] },
  guide:
    'Radarr’s API under /api/v3/ (JSON). Movies: GET /api/v3/movie (each with hasFile, monitored, sizeOnDisk, status), /api/v3/movie/<id>; add one: GET /api/v3/movie/lookup?term=<words>, then POST /api/v3/movie with that result, qualityProfileId, rootFolderPath, monitored, minimumAvailability and addOptions {"searchForMovie": true}. Calendar: GET /api/v3/calendar?start=<ISO>&end=<ISO> (inCinemas, digitalRelease, physicalRelease). Queue: GET /api/v3/queue?page=1&pageSize=20&includeMovie=true (status, trackedDownloadState, timeleft, sizeleft, downloadClient). Wanted: GET /api/v3/wanted/missing?page=1&pageSize=20&monitored=true and /api/v3/wanted/cutoff (Radarr 5 and later; before, the monitored movies without hasFile). History: GET /api/v3/history?page=1&pageSize=20. Commands: POST /api/v3/command {"name": "MissingMoviesSearch"} (or MoviesSearch with movieIds, RefreshMovie, RssSync); GET /api/v3/command/<id> says how it went. Health: GET /api/v3/health; disk: /api/v3/diskspace and /api/v3/rootfolder; version: /api/v3/system/status. Posters: GET /api/v3/mediacover/<movieId>/poster-500.jpg (with the key; /MediaCover/ answers a sign-in page when Radarr asks for one). Paged lists answer {page, pageSize, totalRecords, records}. Deleting movies or files, changing settings, reading the security settings, a new API key, updates and restarts always ask a person.',
  sensitive: arrSensitive('Radarr'),
  docsUrl: 'https://radarr.video/docs/api/',
  tokenUrl: '{url}/settings/general',
  handle: 'radarr',
  access: {
    read: 'The agent can see your movies, what’s coming, the queue and what’s missing, and change nothing.',
    manage:
      'The agent can also add movies and search for them. Deleting, settings and updates ask you first.',
  },
  discovery: {
    targets: [{ port: 7878, scheme: 'http' }],
    // As Sonarr's; Radarr's sign-in page says “Radarr (Preview)”, its other pages “Radarr”.
    probes: [{ path: '/login', status: [200], bodyPattern: '<meta name="description" content="Radarr' }],
  },
} satisfies CatalogEntryInput;
