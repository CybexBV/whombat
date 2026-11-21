import { BEARER, type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'pterodactyl',
  name: 'Pterodactyl',
  category: 'infrastructure',
  description: 'Game servers on your Pterodactyl Panel: power, console, files, backups and schedules.',
  tagline: 'Your game servers',
  signIn: [
    {
      kind: 'token',
      label: 'Client API key',
      auth: BEARER,
      secretLabel: 'Client API key',
      secretPlaceholder: 'ptlc_… or pacc_…',
      secretHelp:
        'In Pterodactyl, open your account (top right) → API Credentials and create a key; on Pelican, your avatar → Profile → API Keys. An application key (ptla_ or papp_) doesn’t work here.',
      steps: [
        {
          text: 'In Pterodactyl, click your account icon at the top right and open API Credentials (on Pelican: your avatar → Profile → API Keys).',
        },
        {
          text: 'Under Create API Key, describe it and leave Allowed IPs empty (or add your Whombat’s address), then click Create.',
          values: [{ label: 'Description', value: 'Whombat' }],
        },
        { text: 'Copy the key (it’s shown once) and paste it here.' },
      ],
      // SG-21 (0.111, CT-749): Pelican's client keys are pacc_.
      paste: [{ target: 'secret', pattern: '\\b((?:ptlc|pacc)_[A-Za-z0-9]{43})\\b' }],
    },
  ],
  fields: [urlField('https://panel.example.com', 'Your Pterodactyl Panel’s address.')],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: {
    kind: 'request',
    method: 'GET',
    path: '/api/client/account',
    headers: { Accept: 'application/json' },
  },
  tools: [],
  request: { prefixes: ['/api/client'], headers: { Accept: 'application/json' } },
  guide:
    'Pterodactyl’s client API under /api/client (JSON). GET /api/client lists servers (per_page up to 100, page; meta.pagination); a server is its 8-character identifier. Per server, /api/client/servers/<id>: GET for details, /resources (current_state, memory_bytes, cpu_absolute, disk_bytes, uptime), /activity; POST /power {"signal": "start"|"stop"|"restart"|"kill"}; POST /command {"command": "say hello"} (the server must be running). Files: GET /files/list?directory=/, GET /files/contents?file=/server.properties (text), POST /files/write?file=… with the new content as the body, PUT /files/rename {"root": "/", "files": [{"from", "to"}]}, POST /files/compress, /files/decompress, /files/create-folder, /files/pull {"url", "directory"}. Backups: GET /backups, POST /backups {"name"}. Also /databases, /schedules (POST /schedules/<id>/execute runs one now), /network/allocations, /startup (PUT /startup/variable {"key", "value"}) and /users (sub-users). GET /api/client/account is the key’s user. Errors are {"errors": [{"code", "status", "detail"}]}; 403 means the key, its allowed IPs or its user can’t do that. Killing a server, reinstalling it, restoring a backup, deleting files, backups, databases or schedules, changing a database’s password, sub-users, and the account’s keys, email, password and two-step sign-in always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/client/servers/[^/]+/power/?$',
      body: { path: 'signal', equals: 'kill' },
      reason: 'Kills a server without letting it save',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/client/servers/[^/]+/settings/reinstall/?$',
      reason: 'Reinstalls a server; files may be deleted',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/client/servers/[^/]+/files/delete/?$',
      reason: 'Deletes files',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/client/servers/[^/]+/backups/[^/]+/restore/?$',
      reason: 'Restores a backup over a server’s files',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/client/servers/[^/]+/databases/[^/]+/rotate-password/?$',
      reason: 'Changes a database’s password',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT'],
      path: '^/api/client/servers/[^/]+/users(/|$)',
      reason: 'Adds a sub-user or changes what one may do',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['GET', 'POST', 'PUT'],
      path: '^/api/client/account/(api-keys|ssh-keys|email|password|two-factor)(/|$)',
      reason: 'Changes the account’s keys, email, password or two-step sign-in',
    },
  ],
  docsUrl: 'https://pterodactyl.io/',
  tokenUrl: '{url}/account/api',
  handle: 'pterodactyl',
  access: {
    read: 'The agent can see your servers, their state, files, backups and schedules, and change nothing.',
    manage:
      'The agent can also start, stop and restart servers, send commands, edit files and make backups. Killing, reinstalling, restores and deleting ask you first.',
  },
  discovery: {
    targets: [
      { port: 80, scheme: 'http' },
      { port: 443, scheme: 'https' },
    ],
    probes: [
      {
        path: '/api/client',
        headers: { Accept: 'application/json' },
        status: [401],
        bodyPattern: '"AuthenticationException"',
      },
      { path: '/auth/login', status: [200], bodyPattern: 'SiteConfiguration' },
    ],
  },
} satisfies CatalogEntryInput;
