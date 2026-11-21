import { type CatalogEntryInput, DELETES_ASK, urlField } from './shared.js';

export const entry = {
  id: 'paperless',
  name: 'Paperless-ngx',
  category: 'files',
  description: 'Your scanned documents, searched, tagged and filed.',
  tagline: 'Scanned papers, sorted and searchable',
  signIn: [
    {
      kind: 'password',
      label: 'Sign in once',
      account: {
        label: 'Username',
        placeholder: 'mara',
        help: 'The name you sign in to Paperless-ngx with.',
      },
      secondFactor: 'asked',
      creates:
        'Your account’s API token (Paperless keeps one per account, so Whombat uses the same one). Paperless can’t limit it, so Whombat keeps it to the level you choose.',
      serviceLimits: false,
    },
    {
      kind: 'token',
      label: 'API token',
      auth: { type: 'header', name: 'Authorization', template: 'Token {secret}' },
      secretLabel: 'API token',
      secretHelp: 'Create one in Paperless-ngx: your profile (top right) → My Profile → API Auth Token.',
      steps: [
        { text: 'In Paperless-ngx, open your profile (top right) → My Profile.' },
        {
          text: 'Under API Auth Token, copy the token (or create one with the refresh button) and paste it here.',
        },
      ],
      paste: [{ target: 'secret', pattern: '\\b([0-9a-f]{40})\\b' }],
    },
  ],
  fields: [urlField('http://paperless.local:8000', 'Your Paperless-ngx’s address.')],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/api/documents/?page_size=1' },
  tools: [],
  request: { prefixes: ['/api/'] },
  guide:
    'Paperless-ngx’s REST API under /api/. GET /api/documents/?query=<words> searches the full text (also ?text=, ?correspondent__id=, ?tags__id__all=, ?created__date__gt=); GET /api/documents/<id>/ reads one with its OCR text; /download/, /preview/ and /thumb/ give the file. GET /api/tags/, /api/correspondents/, /api/document_types/ and /api/storage_paths/ list the vocabulary (names to ids). PATCH /api/documents/<id>/ changes title, tags, correspondent or type; POST /api/documents/bulk_edit/ changes many. POST /api/documents/post_document/ uploads (multipart) and answers a task id: GET /api/tasks/?task_id=<id> follows it. Lists page with page and page_size and answer {count, next, results}.',
  sensitive: [DELETES_ASK],
  docsUrl: 'https://docs.paperless-ngx.com/api/',
  tokenUrl: null,
  handle: 'paperless',
  access: {
    read: 'The agent can search and read your documents, and change nothing.',
    manage: 'The agent can also tag, file and upload documents. Deleting asks you first.',
  },
  discovery: {
    targets: [{ port: 8000, scheme: 'http' }],
    probes: [
      { path: '/accounts/login/', status: [200], bodyPattern: 'Paperless-ngx project and contributors' },
    ],
  },
} satisfies CatalogEntryInput;
