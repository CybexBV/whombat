import { type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'immich',
  name: 'Immich',
  category: 'files',
  description: 'Your photo and video library, searched and organised.',
  tagline: 'Your photos and videos',
  signIn: [
    {
      kind: 'password',
      label: 'Sign in once',
      account: {
        label: 'Email',
        placeholder: 'mara@example.com',
        help: 'The email you sign in to Immich with.',
      },
      secondFactor: 'never',
      creates: 'An API key named Whombat, with read permissions to look or all permissions to manage.',
      serviceLimits: true,
    },
    {
      kind: 'token',
      label: 'API key',
      auth: { type: 'header', name: 'x-api-key', template: '{secret}' },
      secretLabel: 'API key',
      secretHelp: 'Create one in Immich → Account settings → API keys → New API key.',
      steps: [
        {
          text: 'In Immich, open Account settings → API keys → New API key.',
          values: [{ label: 'Name', value: 'Whombat' }],
        },
        {
          text: 'Pick the permissions (all of them to manage), create it, copy the key and paste it here.',
        },
      ],
    },
  ],
  fields: [urlField('http://immich.local:2283', 'Your Immich’s address.')],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  // SG-16 (0.111, CT-742): any key, whatever its permissions, on 1.113 and later (/api/api-keys/me came with 1.139).
  check: {
    kind: 'request',
    method: 'POST',
    path: '/api/auth/validateToken',
    okAnswer: { json: 'authStatus', values: ['true'] },
  },
  tools: [],
  request: {
    prefixes: ['/api/'],
    readPaths: [{ method: 'POST', path: '^/api/search/(metadata|smart|random|statistics|large-assets)$' }],
  },
  guide:
    'Immich’s API under /api/. POST /api/search/smart {"query": "dog on the beach"} searches by meaning, POST /api/search/metadata {originalFileName, takenAfter, takenBefore, city, …} by details (both are reads). GET /api/albums lists albums and GET /api/albums/<id> one with its assets; POST /api/albums makes one, PUT /api/albums/<id>/assets {ids} adds assets. GET /api/assets/<id> reads an asset’s details; /api/assets/<id>/original downloads it (binary: answered as a note). GET /api/people lists recognised people, GET /api/timeline/buckets the timeline. The key may be limited to some permissions: a 403 means it lacks one. Reading or changing server settings, database backups, API keys and deleting always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      path: '^/api/(system-config|admin/config)(/|$)',
      reason: 'Reads or changes Immich’s server settings, which may contain OAuth or SMTP passwords',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      path: '^/api/admin/database-backups/[^/]+(/|$)',
      reason: 'Downloads, uploads or restores an Immich database backup',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/api-keys/?$',
      reason: 'Creates a new Immich API key',
    },
  ],
  docsUrl: 'https://immich.app/docs/api/',
  tokenUrl: '{url}/user-settings?isOpen=api-keys',
  handle: 'immich',
  access: {
    read: 'The agent can search and look at your photos, albums and people, and change nothing.',
    manage: 'The agent can also make albums and add photos to them. Deleting asks you first.',
  },
  discovery: {
    targets: [{ port: 2283, scheme: 'http' }],
    probes: [{ path: '/api/server/ping', status: [200], bodyPattern: '"res"\\s*:\\s*"pong"' }],
  },
} satisfies CatalogEntryInput;
