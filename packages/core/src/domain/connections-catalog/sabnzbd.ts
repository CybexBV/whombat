import { type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'sabnzbd',
  name: 'SABnzbd',
  category: 'home',
  description: 'The download queue, history and speed of your SABnzbd.',
  tagline: 'Downloads from Usenet',
  signIn: [
    {
      kind: 'token',
      label: 'API key',
      auth: { type: 'query', name: 'apikey' },
      secretLabel: 'API key',
      secretPlaceholder: '32 letters and digits',
      secretHelp: 'In SABnzbd, open Config → General → Security and copy the API Key (not the NZB Key).',
      steps: [
        { text: 'In SABnzbd, open Config (the gear) → General.' },
        { text: 'Under Security, copy the API Key (not the NZB Key) and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b([0-9a-f]{32})\\b' }],
    },
  ],
  fields: [
    urlField(
      'http://192.168.1.20:8080',
      'Your SABnzbd’s address, usually port 8080. Use its IP address, or add the name you use to Config → Special → host_whitelist.',
    ),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  // Every refusal is a plain-text 403 (SABnzbd 3.3 and later; empty with api_warnings off), whatever it refuses: the
  // key, the name in the address or the network (SG-11, CT-735). A working key answers the queue (CT-313's okJsonPath).
  check: {
    kind: 'request',
    method: 'GET',
    path: '/api?mode=queue&limit=1&output=json',
    okJsonPath: 'queue',
    failures: [
      {
        status: [403],
        bodyPattern: '^\\s*Access denied - Hostname verification failed',
        refused: false,
        text: 'SABnzbd doesn’t accept the name in this address. Use its IP address, or add the name to host_whitelist in its settings.',
      },
      {
        status: [403],
        bodyPattern: '^\\s*External internet access denied',
        refused: false,
        text: 'SABnzbd only answers devices on its own network.',
      },
      {
        status: [403],
        bodyPattern: '^\\s*API Key (Incorrect|Required)',
        refused: true,
        text: 'SABnzbd refused the key. Copy the API Key (not the NZB Key) from Config → General.',
      },
    ],
  },
  tools: [],
  // Everything is GET /api?mode=…: the mode decides (0.97, CT-473; CM-18).
  request: {
    prefixes: ['/api'],
    methods: ['GET', 'POST'],
    queryReads: [
      {
        name: 'mode',
        values: [
          'queue',
          'history',
          'version',
          'fullstatus',
          'status',
          'server_stats',
          'warnings',
          'get_cats',
          'get_scripts',
          'get_files',
          'translate',
          'auth',
        ],
        writes: [
          {
            name: 'name',
            values: [
              'delete',
              'delete_nzf',
              'purge',
              'rename',
              'pause',
              'resume',
              'priority',
              'sort',
              'change_complete_action',
              'mark_as_completed',
              'unblock_server',
              'delete_orphan',
              'delete_all_orphan',
              'add_orphan',
              'add_all_orphan',
              'clear',
            ],
          },
        ],
      },
    ],
  },
  guide:
    'SABnzbd’s API is GET /api?mode=…&output=json; Whombat adds the key. Reads: mode=queue (start, limit, search; queue.slots with nzo_id, filename, status, percentage, timeleft), mode=history (start, limit, search, failed_only=1; history.slots), mode=fullstatus, mode=server_stats, mode=warnings, mode=get_cats, mode=get_scripts, mode=version. Actions: mode=addurl&name=<NZB link>&nzbname=…&cat=… adds a download; mode=pause and mode=resume pause everything, mode=queue&name=pause|resume&value=<nzo_id> one item; mode=config&name=speedlimit&value=50 limits the speed (a percentage, or 5M); mode=queue&name=priority&value=<nzo_id>&value2=2 (-1 low, 0 normal, 1 high, 2 force); mode=change_cat&value=<nzo_id>&value2=<category>; mode=retry&value=<nzo_id> tries a failed one again. Errors come back 200 as {"status": false, "error": …}. When SABnzbd refuses with “Hostname verification failed”, the connection’s address must be an IP address or a name in Config → Special → host_whitelist. Deleting from the queue or history (mode=queue|history&name=delete&value=<nzo_id>), shutting it down or restarting it, and reading or changing its settings (mode=get_config shows its keys) always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      arg: 'query',
      argValue: '^(delete|delete_nzf|purge|delete_orphan|delete_all_orphan)$',
      reason: 'Deletes downloads from the queue or the history',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      arg: 'query',
      argValue: '^(shutdown|restart|restart_repair)$',
      reason: 'Shuts SABnzbd down or restarts it',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      arg: 'query',
      argValue: '^(get_config|set_config|set_config_default|del_config|set_apikey|set_nzbkey)$',
      reason: 'Reads or changes SABnzbd’s settings, which hold its keys and news servers',
    },
  ],
  docsUrl: 'https://sabnzbd.org/wiki/configuration/5.1/api',
  tokenUrl: '{url}/config/general/',
  handle: 'sabnzbd',
  access: {
    read: 'The agent can see the queue, the history and how downloads are going, and change nothing.',
    manage:
      'The agent can also add, pause and reorder downloads and set the speed. Deleting, restarts and settings ask you first.',
  },
  discovery: {
    targets: [{ port: 8080, scheme: 'http' }],
    probes: [
      {
        path: '/api?mode=version&output=json',
        status: [200],
        header: { name: 'Server', pattern: 'CherryPy' },
        bodyPattern: '"version"\\s*:',
        version: { json: 'version' },
      },
    ],
  },
} satisfies CatalogEntryInput;
