import { type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'jellyfin',
  name: 'Jellyfin',
  category: 'home',
  description: 'Your Jellyfin server’s libraries, what’s playing and what was watched.',
  tagline: 'Films, series and music',
  signIn: [
    {
      kind: 'token',
      label: 'API key',
      auth: { type: 'header', name: 'X-Emby-Token', template: '{secret}' },
      secretLabel: 'API key',
      secretPlaceholder: '32 letters and digits',
      secretHelp: 'In Jellyfin, open Dashboard → API Keys, click +, name it Whombat and copy the key.',
      steps: [
        { text: 'In Jellyfin, signed in as an administrator, open Dashboard → API Keys.' },
        {
          text: 'Click + to create a key and name it Whombat.',
          values: [{ label: 'App name', value: 'Whombat' }],
        },
        { text: 'Copy the key from the list and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b([0-9a-f]{32})\\b' }],
    },
  ],
  fields: [urlField('http://192.168.1.20:8096', 'Your Jellyfin server’s address, usually port 8096.')],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: {
    kind: 'request',
    method: 'GET',
    path: '/System/Info',
    headers: { Accept: 'application/json' },
    okJsonPath: 'Version',
  },
  tools: [],
  request: {
    prefixes: [
      '/System/',
      '/Sessions',
      '/Library/',
      '/Items',
      '/Users',
      '/ScheduledTasks',
      '/ActivityLog/',
      '/Plugins',
      '/Shows/',
      '/Audio/',
    ],
    headers: { Accept: 'application/json' },
  },
  guide:
    'Jellyfin’s REST API (JSON; Whombat adds X-Emby-Token). Server info: GET /System/Info (ServerName, Version, HasPendingRestart). Libraries: GET /Library/VirtualFolders (ItemId, Name, CollectionType, RefreshStatus); counts: GET /Items/Counts. Browse items: GET /Items?Recursive=true&IncludeItemTypes=Movie,Series,Episode&SortBy=DateCreated&SortOrder=Descending&Limit=20&Fields=DateCreated,ProviderIds (filter by ParentId=<library ItemId> or SearchTerm=<words>); item images: GET /Items/<id>/Images/Primary?maxWidth=240&quality=90. Playing now: GET /Sessions (active streams have NowPlayingItem, UserName, DeviceName, PlayState and TranscodingInfo). Watch activity: GET /System/ActivityLog/Entries?MinDate=<ISO>&Limit=100 and GET /Users. Scheduled tasks: GET /ScheduledTasks. Scan all libraries: POST /Library/Refresh; scan one: POST /Items/<id>/Refresh?Recursive=true. Deleting media, changing server settings or user accounts, and restarting or shutting down Jellyfin always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/System/(Restart|Shutdown)/?$',
      reason: 'Restarts or shuts down Jellyfin',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT'],
      path: '^/System/Configuration(/|$)',
      reason: 'Changes Jellyfin’s server settings',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT'],
      path: '^/Users/(New|[^/]+/(Policy|Password|Configuration))/?$',
      reason: 'Creates or changes a Jellyfin user or their permissions',
    },
  ],
  docsUrl: 'https://api.jellyfin.org/',
  tokenUrl: '{url}/web/index.html#!/dashboard/keys',
  handle: 'jellyfin',
  access: {
    read: 'The agent can see your libraries, what’s playing and what was watched, and change nothing.',
    manage:
      'The agent can also scan libraries and control playback. Deleting media, users, settings and restarts ask you first.',
  },
  discovery: {
    targets: [{ port: 8096, scheme: 'http' }],
    probes: [
      {
        path: '/System/Info/Public',
        status: [200],
        bodyPattern: '"ProductName"\\s*:\\s*"Jellyfin Server"',
        version: { json: 'Version' },
      },
    ],
  },
} satisfies CatalogEntryInput;
