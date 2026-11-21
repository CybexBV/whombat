import { BEARER, type CatalogEntryInput, DELETES_ASK } from './shared.js';

export const entry = {
  id: 'airtable',
  name: 'Airtable',
  category: 'productivity',
  description: 'Bases, tables and records in Airtable.',
  signIn: [
    // SG-20 (0.111, CT-748): Airtable's own MCP server, which any client registers with; the token second.
    { kind: 'mcp_oauth', label: 'Sign in with Airtable', mcpUrl: 'https://mcp.airtable.com/mcp' },
    {
      kind: 'token',
      label: 'Personal access token',
      transport: 'rest',
      auth: BEARER,
      secretLabel: 'Personal access token',
      secretPlaceholder: 'pat…',
      secretHelp:
        'Create one in Airtable’s Builder Hub (developer hub) → Personal access tokens, with the scopes and the bases the agent may use. On Enterprise plans an admin may limit how long tokens last: when it stops working, make a new one.',
      steps: [
        {
          text: 'Open the link (Builder Hub, also called developer hub → Personal access tokens) and click Create token.',
          values: [{ label: 'Name', value: 'Whombat' }],
        },
        {
          text: 'Add the scopes and the bases the agent may use. To look, the read ones; to manage, the write ones too.',
          values: [
            { label: 'To look', value: 'data.records:read data.recordComments:read schema.bases:read' },
            { label: 'To manage, also', value: 'data.records:write data.recordComments:write' },
          ],
        },
        { text: 'Click Create token, copy it (it’s shown once) and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b(pat[A-Za-z0-9]{14}\\.[A-Za-z0-9]+)' }],
    },
  ],
  fields: [],
  transport: 'mcp',
  baseUrl: 'https://api.airtable.com',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/v0/meta/whoami' },
  tools: [],
  request: {
    prefixes: ['/v0/'],
    readPaths: [{ method: 'POST', path: '^/v0/[^/]+/[^/]+/listRecords$' }],
  },
  guide:
    'Airtable. Signed in with Airtable, use its own tools. With a token, Airtable’s Web API under /v0/. Find ids first: GET /v0/meta/bases (id app…, name; ?offset= pages), GET /v0/meta/bases/<baseId>/tables (tables tbl…, fields fld…, views viw…). Records: GET /v0/<baseId>/<table id or name>?pageSize=100&view=…&filterByFormula=…&sort[0][field]=Name&sort[0][direction]=desc&fields[]=Name answers records [{id, createdTime, fields}] and an offset for the next page (maxRecords caps the total); a long formula goes to POST /v0/<baseId>/<table>/listRecords with the same parameters as JSON (a read). GET /v0/<baseId>/<table>/<recordId> reads one. Create: POST /v0/<baseId>/<table> {"records": [{"fields": {…}}], "typecast": true}; change: PATCH the same path {"records": [{"id", "fields"}]} (PUT empties every field left out; "performUpsert": {"fieldsToMergeOn": ["Email"]} upserts). At most 10 records per write. Comments: /v0/<baseId>/<table>/<recordId>/comments. Field names are case-sensitive; formulas name fields as {Field Name}. 5 requests a second per base: after a 429 wait 30 seconds. Errors are {"error": {"type", "message"}}; 403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND means the token lacks that base or scope. Deleting records, comments or webhooks always asks a person.',
  sensitive: [DELETES_ASK],
  docsUrl: 'https://airtable.com/developers/web/api/introduction',
  tokenUrl: 'https://airtable.com/create/tokens',
  handle: 'airtable',
  access: {
    read: 'The agent can read the bases you gave the token, and change nothing.',
    manage: 'The agent can also add and change records and comments. Deleting asks you first.',
  },
} satisfies CatalogEntryInput;
