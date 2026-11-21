import { arrSensitive, type CatalogEntryInput, urlField } from './shared.js';

export const entry = {
  id: 'sonarr',
  name: 'Sonarr',
  category: 'home',
  description: 'Your TV series in Sonarr: what’s coming, the download queue and what’s missing.',
  tagline: 'TV series, found and downloaded',
  signIn: [
    {
      kind: 'token',
      label: 'API key',
      auth: { type: 'header', name: 'X-Api-Key', template: '{secret}' },
      secretLabel: 'API key',
      secretPlaceholder: '32 letters and digits',
      secretHelp: 'In Sonarr, open Settings → General and copy the API Key under Security.',
      steps: [
        { text: 'In Sonarr, open Settings → General.' },
        { text: 'Under Security, copy the API Key and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b([0-9a-f]{32})\\b' }],
    },
  ],
  fields: [
    urlField(
      'http://192.168.1.20:8989',
      'Your Sonarr’s address, usually port 8989, with its URL Base when it has one (http://192.168.1.20:8989/sonarr).',
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
    'Sonarr’s API under /api/v3/ (JSON). Series: GET /api/v3/series (each with statistics: episodeFileCount, episodeCount, sizeOnDisk), /api/v3/series/<id>; add one: GET /api/v3/series/lookup?term=<words>, then POST /api/v3/series with that result, qualityProfileId, rootFolderPath, monitored and addOptions {"searchForMissingEpisodes": true}. Episodes: GET /api/v3/episode?seriesId=<id>. Calendar: GET /api/v3/calendar?start=<ISO>&end=<ISO>&includeSeries=true. Queue: GET /api/v3/queue?page=1&pageSize=20&includeSeries=true (status, trackedDownloadState, timeleft, sizeleft, downloadClient). Wanted: GET /api/v3/wanted/missing?page=1&pageSize=20&sortKey=airDateUtc&sortDirection=descending&monitored=true, and /api/v3/wanted/cutoff. History: GET /api/v3/history?page=1&pageSize=20. Commands: POST /api/v3/command {"name": "MissingEpisodeSearch"} (or SeriesSearch with seriesId, EpisodeSearch with episodeIds, RefreshSeries, RssSync); GET /api/v3/command/<id> says how it went. Health: GET /api/v3/health; disk: /api/v3/diskspace and /api/v3/rootfolder; version: /api/v3/system/status. Posters: GET /api/v3/mediacover/<seriesId>/poster-500.jpg (with the key; /MediaCover/ answers a sign-in page when Sonarr asks for one). Paged lists answer {page, pageSize, totalRecords, records}. Deleting series, episodes or files, changing settings, reading the security settings, a new API key, updates and restarts always ask a person.',
  sensitive: arrSensitive('Sonarr'),
  docsUrl: 'https://sonarr.tv/docs/api/',
  tokenUrl: '{url}/settings/general',
  handle: 'sonarr',
  access: {
    read: 'The agent can see your series, what’s coming, the queue and what’s missing, and change nothing.',
    manage:
      'The agent can also add series and search for episodes. Deleting, settings and updates ask you first.',
  },
  discovery: {
    targets: [{ port: 8989, scheme: 'http' }],
    // The sign-in page answers without a key on a fresh install and with Forms sign-in; it names the app.
    probes: [{ path: '/login', status: [200], bodyPattern: '<meta name="description" content="Sonarr"' }],
  },
} satisfies CatalogEntryInput;
