import { BEARER, type CatalogEntryInput, DELETES_ASK } from './shared.js';

/**
 * The Notion API version Whombat sends with a token connection's requests (checked 2026-10-05: 2026-03-11 is current;
 * databases hold data sources since 2025-09-03, CT-268).
 */
export const NOTION_VERSION = '2026-03-11';

export const entry = {
  id: 'notion',
  name: 'Notion',
  category: 'productivity',
  description: 'Pages, databases and notes in your Notion workspace.',
  signIn: [
    { kind: 'mcp_oauth', label: 'Sign in with Notion', mcpUrl: 'https://mcp.notion.com/mcp' },
    {
      kind: 'token',
      label: 'Access token',
      transport: 'rest',
      auth: BEARER,
      secretLabel: 'Access token',
      secretPlaceholder: 'ntn_…',
      secretHelp:
        'Create a personal access token or an internal connection in Notion’s developer settings, then share the pages the agent may use with it.',
    },
  ],
  fields: [],
  transport: 'mcp',
  baseUrl: 'https://api.notion.com',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/v1/users/me' },
  tools: [],
  request: {
    prefixes: ['/v1/'],
    readPaths: [
      { method: 'POST', path: '^/v1/search$' },
      { method: 'POST', path: '^/v1/databases/[^/]+/query$' },
      { method: 'POST', path: '^/v1/data_sources/[^/]+/query$' },
    ],
    headers: { 'Notion-Version': NOTION_VERSION },
  },
  guide:
    'Notion. Signed in with Notion, its own tools (search, fetch, create and update pages) are the easiest way. With a token, use request on https://api.notion.com/v1/ (Whombat sends Notion-Version 2026-03-11): POST /v1/search {"query": "…"} finds pages and data sources shared with the integration; GET /v1/pages/<id> reads a page’s properties and GET /v1/pages/<id>/markdown its content; GET /v1/blocks/<id>/children lists blocks. A database holds data sources: GET /v1/databases/<id> lists them, POST /v1/data_sources/<id>/query {"filter": …, "sorts": …} queries one (search and queries are reads). POST /v1/pages creates a page (parent {"page_id"} or {"data_source_id"}), PATCH /v1/pages/<id> changes properties, PATCH /v1/pages/<id>/markdown or /v1/blocks/<id>/children adds content. Lists page with start_cursor and has_more. Pages nobody shared with the integration are invisible: say so instead of guessing.',
  sensitive: [DELETES_ASK],
  docsUrl: 'https://developers.notion.com/reference/intro',
  tokenUrl: 'https://www.notion.so/developers/tokens',
  handle: 'notion',
  access: {
    read: 'The agent can search and read the pages they were given, and change nothing.',
    manage: 'The agent can also write pages, databases and comments. Deleting asks you first.',
  },
} satisfies CatalogEntryInput;
