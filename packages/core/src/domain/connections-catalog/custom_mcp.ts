import { BEARER, type CatalogEntryInput, urlField } from './shared.js';

export const entry = {
  id: 'custom_mcp',
  name: 'MCP server',
  category: 'custom',
  description: 'Any remote MCP server, with or without sign-in.',
  signIn: [
    { kind: 'none', label: 'No sign-in' },
    {
      kind: 'token',
      label: 'Bearer token',
      auth: BEARER,
      secretLabel: 'Token',
      secretHelp: 'The token the server’s documentation tells you to send.',
    },
    {
      kind: 'token',
      label: 'Header',
      auth: { type: 'header', name: 'X-Api-Key', template: '{secret}' },
      secretLabel: 'Header value',
      secretHelp: 'The header’s name is yours to choose; the value is kept like a password.',
    },
    { kind: 'mcp_oauth', label: 'Sign in' },
  ],
  fields: [urlField('https://mcp.example.com/mcp', 'The server’s Streamable HTTP address.')],
  transport: 'mcp',
  baseUrl: '{url}',
  mcpPath: '',
  mcpMissingHint: null,
  check: { kind: 'mcp' },
  tools: [],
  request: null,
  guide:
    'An MCP server connected by hand. Its tools describe themselves: read each tool’s description before calling it, and ask the person what the server is for when that isn’t clear.',
  sensitive: [],
  docsUrl: 'https://modelcontextprotocol.io',
  tokenUrl: null,
  handle: 'mcp',
} satisfies CatalogEntryInput;
