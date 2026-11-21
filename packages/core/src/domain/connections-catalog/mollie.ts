import { BEARER, type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME } from './shared.js';

export const entry = {
  id: 'mollie',
  name: 'Mollie',
  category: 'business',
  description: 'Payments, refunds and customers in Mollie.',
  signIn: [
    // SG-20 (0.111, CT-748): Mollie's own MCP server, which any client registers with; the key or token second.
    { kind: 'mcp_oauth', label: 'Sign in with Mollie', mcpUrl: 'https://mcp.mollie.com/mcp' },
    {
      kind: 'token',
      label: 'API key',
      transport: 'rest',
      auth: BEARER,
      secretLabel: 'API key or access token',
      secretPlaceholder: 'live_…, test_… or access_…',
      secretHelp:
        'Make one in the Mollie Dashboard → Developers → API keys → + Create access token. A test key is a safe way to start.',
      // SG-12 (0.111, CT-743): API keys and access tokens are made on one page, and shown once.
      steps: [
        { text: 'In the Mollie Dashboard, open Developers → API keys and click + Create access token.' },
        {
          text: 'To manage, choose Standard API key and pick the website profile (Test or Live). To look only, choose Advanced access token and tick only read permissions.',
        },
        { text: 'Copy it right away (Mollie shows it once) and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b((?:live|test)_\\w{30,}|access_\\w+)' }],
    },
  ],
  fields: [],
  transport: 'mcp',
  baseUrl: 'https://api.mollie.com',
  mcpPath: null,
  mcpMissingHint: null,
  // An API key reads its profile's methods; an access token (advanced or OAuth) may lack payments.read or a profile,
  // so it reads what it was granted, which needs no permission (SG-12, CT-736).
  check: {
    kind: 'request',
    method: 'GET',
    path: '/v2/methods',
    forSecret: [{ pattern: '^access_', method: 'GET', path: '/v2/permissions' }],
  },
  tools: [],
  request: { prefixes: ['/v2/'] },
  guide:
    'Mollie. Signed in with Mollie, use its own tools. With a key or token, Mollie API v2 under /v2/. GET /v2/payments (?limit=, ?from= for the next page) and /v2/payments/<id> read payments; POST /v2/payments {"amount": {"currency": "EUR", "value": "10.00"}, "description", "redirectUrl"} creates a payment. GET /v2/refunds and /v2/payments/<id>/refunds list refunds; POST /v2/payments/<id>/refunds refunds. Also /v2/customers, /v2/customers/<id>/subscriptions and /v2/methods. Amounts are strings with two decimals. A test_ key works in test mode; balances and settlements need an organization access token. Lists answer _embedded and _links.next. Creating payments, refunds and anything that moves money always asks a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PATCH'],
      path: '^/v2/(payments|refunds|chargebacks|settlements|balances|payouts|orders/[^/]+/refunds|payments/[^/]+/refunds|customers/[^/]+/payments|customers/[^/]+/mandates|customers/[^/]+/subscriptions)',
      reason: 'Moves money',
    },
  ],
  docsUrl: 'https://docs.mollie.com/reference/overview',
  tokenUrl: 'https://my.mollie.com/dashboard/developers/api-access-tokens',
  handle: 'mollie',
  access: {
    read: 'The agent can see payments, refunds and customers, and change nothing.',
    manage: 'The agent can also create payments and payment links. Anything that moves money asks you first.',
  },
} satisfies CatalogEntryInput;
