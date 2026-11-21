import { type CatalogEntryInput, FILES_TOOLS, REQUEST_TOOL_NAME } from './shared.js';

export const entry = {
  id: 'dropbox',
  name: 'Dropbox',
  category: 'files',
  description: 'Files and folders in your Dropbox.',
  signIn: [
    {
      kind: 'app_oauth',
      label: 'Sign in with Dropbox',
      authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
      tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      revokeUrl: 'https://api.dropboxapi.com/2/auth/token/revoke',
      scopes: [
        'account_info.read',
        'files.metadata.read',
        'files.metadata.write',
        'files.content.read',
        'files.content.write',
      ],
      authorizeParams: { token_access_type: 'offline' },
      clientSecretOptional: true,
      consoleUrl: 'https://www.dropbox.com/developers/apps',
    },
  ],
  fields: [],
  transport: 'rest',
  baseUrl: 'https://api.dropboxapi.com',
  mcpPath: null,
  mcpMissingHint: null,
  check: {
    kind: 'request',
    method: 'POST',
    path: '/2/users/get_current_account',
    body: 'null',
    headers: { 'Content-Type': 'application/json' },
  },
  tools: [...FILES_TOOLS],
  request: {
    prefixes: ['/2/'],
    methods: ['POST'],
    readMethods: [],
    readPaths: [
      {
        method: 'POST',
        path: '^/2/(files/(list_folder(/continue)?|get_metadata|search_v2|search/continue_v2|download|get_temporary_link|get_thumbnail_v2|list_revisions)|users/(get_current_account|get_space_usage)|sharing/list_shared_links)$',
      },
    ],
    allowedHeaders: ['Dropbox-API-Arg'],
    bases: { content: 'https://content.dropboxapi.com' },
  },
  guide:
    'Dropbox API v2. The files_* tools cover most work (paths start with /). With request every call is a POST with a JSON body. On the default base: /2/files/list_folder {path} ("" is the root), /2/files/list_folder/continue {cursor}, /2/files/search_v2 {query}, /2/files/get_metadata {path}, /2/files/get_temporary_link {path} (a link for 4 hours), /2/files/create_folder_v2, /2/files/move_v2 {from_path, to_path}, /2/files/delete_v2 (asks a person). Downloads and uploads use base “content”: /2/files/download and /2/files/upload take their arguments as JSON in the Dropbox-API-Arg header (non-ASCII escaped as \\uXXXX), the file as the body. Listing, searching, metadata and downloads count as reads. Errors answer 409 with an error_summary.',
  sensitive: [
    {
      tools: [REQUEST_TOOL_NAME],
      path: '^/2/files/(delete(_v2|_batch)?|permanently_delete)$',
      reason: 'Deletes files',
    },
  ],
  docsUrl: 'https://docs.dropboxapi.com',
  tokenUrl: null,
  handle: 'dropbox',
  access: {
    read: 'The agent can browse and read your files, and change nothing.',
    manage: 'The agent can also add, change and move files. Deleting asks you first.',
  },
} satisfies CatalogEntryInput;
